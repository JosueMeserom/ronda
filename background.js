'use strict';

// How it works: Chromium won't let an extension write a tab's history, but
// chrome.tabs.duplicate() copies it. So when a tab is opened from a link, we
// duplicate its opener (history included), send the duplicate to the link's
// URL, put it where the new tab belongs and close the new tab.

// Duplicates we created ourselves, so their own onCreated is ignored.
const ownDuplicates = new Set();
// Last tab Ronda placed for each opener, so a run of links opened from the same
// page lines up left to right. Forgotten when the user switches tabs, as
// Chromium does.
const lastChild = new Map();
// Swaps run one at a time, in the order the tabs were opened. Run side by side
// they trip over each other's indexes and focus.
let queue = Promise.resolve();
// Activations caused by our own swaps mustn't count as the user switching tabs.
let swapping = false;
let quietUntil = 0;
// For the instant a copy sits in front, Chromium names it as the opener of any
// tab opened then. Remember who it was standing in for, and when.
const standIns = new Map();
// New tabs waiting for their first page to commit, by tab id.
const commitWaiters = new Map();

const isWebUrl = url => /^(https?|file):/i.test(url || '');
const urlOf = tab => isWebUrl(tab.pendingUrl || tab.url) ? tab.pendingUrl || tab.url : null;

// Don't touch a new tab until a web page has actually committed in it. A link
// that turns out to be a download never commits (Chromium closes the tab by
// itself, or a download manager takes over), so it stays entirely out of our
// way. Pages written by script after window.open() never commit either. Tabs
// that take too long keep working as normal tabs, just without the history.
function waitForCommit(tabId, timeout = 5000) {
	return new Promise(resolve => {
		const done = commit => {
			clearTimeout(timer);
			commitWaiters.delete(tabId);
			resolve(commit);
		};
		const timer = setTimeout(() => done(null), timeout);

		commitWaiters.set(tabId, done);
	});
}

async function isEnabled() {
	const { enabled = true } = await chrome.storage.local.get('enabled');
	return enabled;
}

async function updateAction(enabled) {
	await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
	await chrome.action.setBadgeBackgroundColor({ color: '#6b6b6b' });
	await chrome.action.setTitle({
		title: chrome.i18n.getMessage(enabled ? 'actionTitleOn' : 'actionTitleOff')
	});
}

async function duplicate(tabId) {
	const dup = await chrome.tabs.duplicate(tabId);

	if (dup) {
		ownDuplicates.add(dup.id);
	}

	return dup;
}

// The tab a new child of `opener` should go right after: the previous child
// from the same run if it's still beside it, otherwise the opener itself.
async function anchorFor(opener, newTabId) {
	const last = lastChild.get(opener.id);

	if (last === undefined || last === newTabId) {
		return opener.id;
	}

	try {
		const tab = await chrome.tabs.get(last);
		return tab.windowId === opener.windowId && tab.index > opener.index ? tab.id : opener.id;
	} catch {
		return opener.id;
	}
}

async function swap(tab, pendingCommit, createdAt) {
	if (ownDuplicates.has(tab.id) || !(await isEnabled())) {
		return;
	}

	const commit = await pendingCommit;

	// A submitted form can't be replayed: the copy would load it as a plain GET
	// and lose what was sent.
	if (!commit || commit.transitionType === 'form_submit') {
		return;
	}

	const target = commit.url;

	const standIn = standIns.get(tab.openerTabId);
	const openerId = standIn && createdAt >= standIn.since && createdAt <= standIn.until
		? standIn.forId
		: tab.openerTabId;

	let opener, win;

	try {
		[opener, win] = await Promise.all([
			chrome.tabs.get(openerId),
			chrome.windows.get(tab.windowId)
		]);
	} catch {
		return;
	}

	// Leave alone: real popups, tabs sent to another window, pages without a
	// web history behind them, and plain duplicates of the same page.
	if (win.type !== 'normal'
		|| opener.windowId !== tab.windowId
		|| opener.incognito !== tab.incognito
		|| !isWebUrl(opener.url)
		|| opener.url === target) {
		return;
	}

	// Read focus before duplicate() steals it: a target="_blank" link opens
	// its tab in the foreground, a middle click in the background.
	const [previouslyActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
	const newTabWasActive = previouslyActive?.id === tab.id;
	const anchorId = await anchorFor(opener, tab.id);
	const since = Date.now();

	let dup;

	try {
		dup = await duplicate(opener.id);
	} catch {
		return;
	}

	if (!dup) {
		return;
	}

	// duplicate() always focuses the copy. Give focus back straight away, before
	// anything else, so the jump is as short as it can be.
	const refocus = !newTabWasActive && previouslyActive
		? chrome.tabs.update(previouslyActive.id, { active: true }).catch(() => {})
		: null;

	// Re-read everything: indexes have shifted and the new tab's URL may have
	// moved on through redirects. If the new tab is already gone, so is the copy.
	let current, dupNow, anchor;

	try {
		[current, dupNow, anchor] = await Promise.all([
			chrome.tabs.get(tab.id),
			chrome.tabs.get(dup.id),
			chrome.tabs.get(anchorId).catch(() => null)
		]);
	} catch {
		await refocus;
		await chrome.tabs.remove(dup.id).catch(() => {});
		return;
	}

	// Indexes as they'll be once the copy is lifted out of its spot by move().
	const without = index => index - (dupNow.index < index ? 1 : 0);
	const index = anchor && anchor.windowId === current.windowId
		? without(anchor.index) + 1
		: without(current.index);

	// Fired back to back: the browser runs them in order, and not waiting
	// between them keeps the swap down to a blink.
	await Promise.allSettled([
		refocus,
		chrome.tabs.update(dup.id, { url: urlOf(current) || target }),
		chrome.tabs.move(dup.id, { index }),
		chrome.tabs.remove(current.id)
	]);

	// Links clicked meanwhile insert their tabs and shift every index, which can
	// leave the copy a slot off. Check it landed right after its anchor.
	for (let tries = 0; anchor && anchor.windowId === current.windowId && tries < 3; tries++) {
		let a, d;

		try {
			[a, d] = await Promise.all([chrome.tabs.get(anchorId), chrome.tabs.get(dup.id)]);
		} catch {
			break;
		}

		if (a.windowId !== d.windowId || d.index === a.index + 1) {
			break;
		}

		await chrome.tabs.move(dup.id, { index: d.index > a.index ? a.index + 1 : a.index }).catch(() => {});
	}

	if (refocus) {
		standIns.set(dup.id, { forId: previouslyActive.id, since, until: Date.now() + 100 });
	}

	lastChild.set(opener.id, dup.id);
}

chrome.action.onClicked.addListener(async () => {
	const enabled = !(await isEnabled());
	await chrome.storage.local.set({ enabled });
	await updateAction(enabled);
});

chrome.runtime.onStartup.addListener(async () => updateAction(await isEnabled()));
chrome.runtime.onInstalled.addListener(async () => updateAction(await isEnabled()));

chrome.tabs.onActivated.addListener(({ tabId }) => {
	if (swapping || Date.now() < quietUntil || ownDuplicates.has(tabId)) {
		return;
	}

	lastChild.clear();
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url, transitionType }) => {
	if (frameId === 0 && isWebUrl(url)) {
		commitWaiters.get(tabId)?.({ url, transitionType });
	}
});

chrome.tabs.onRemoved.addListener(tabId => {
	commitWaiters.get(tabId)?.(null);
	ownDuplicates.delete(tabId);
	lastChild.delete(tabId);
	standIns.delete(tabId);
});

chrome.tabs.onCreated.addListener(tab => {
	if (tab.openerTabId === undefined || ownDuplicates.has(tab.id)) {
		return;
	}

	const createdAt = Date.now();
	// Start waiting now, so a commit that lands while earlier tabs are still being
	// swapped isn't missed.
	const pendingCommit = waitForCommit(tab.id);

	queue = queue
		.then(async () => {
			swapping = true;

			try {
				await swap(tab, pendingCommit, createdAt);
			} finally {
				swapping = false;
				quietUntil = Date.now() + 300;
			}
		})
		.catch(() => {});
});
