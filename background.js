'use strict';

// How it works: Chromium won't let an extension write a tab's history, but
// chrome.tabs.duplicate() copies it. So when a tab is opened from a link, we
// duplicate its opener (history included), send the duplicate to the link's
// URL, put it where the new tab belongs and close the new tab.

// Duplicates we created ourselves, so their own onCreated is ignored.
const ownDuplicates = new Set();
// Swaps run one at a time, in the order the tabs were opened. Run side by side
// they trip over each other's indexes and focus.
let queue = Promise.resolve();
// Tabs in the queue, with the tab each was opened from. While a swap runs,
// they are its own tab and the ones opened after it.
const waiting = new Map();
// For the instant a copy sits in front, Chromium names it as the opener of any
// tab opened then, and puts the tab beside it. Remember who it was standing in
// for, and when.
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

async function swap(tab, pendingCommit, createdAt) {
	if (ownDuplicates.has(tab.id) || !(await isEnabled())) {
		return;
	}

	const commit = await pendingCommit;

	// Only links. A new tab (Ctrl+T) has an opener too, but what's typed in it
	// is no link; a submitted form can't be replayed, the copy would load it as
	// a plain GET; and a tab opened from the Back button brings its own history.
	if (commit?.transitionType !== 'link' || commit.transitionQualifiers.includes('forward_back')) {
		return;
	}

	const target = commit.url;
	const standIn = standIns.get(tab.openerTabId);
	const misplaced = standIn && createdAt >= standIn.since && createdAt <= standIn.until;
	const openerId = misplaced ? standIn.forId : tab.openerTabId;

	let opener, win, before;

	try {
		[opener, win, before] = await Promise.all([
			chrome.tabs.get(openerId),
			chrome.windows.get(tab.windowId),
			chrome.tabs.query({ windowId: tab.windowId })
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

	// A target="_blank" link opens its tab in the foreground, a middle click in
	// the background.
	const previouslyActive = before.find(t => t.active);
	const newTabWasActive = previouslyActive?.id === tab.id;
	const since = Date.now();

	// duplicate() always focuses the copy, and makes the browser forget which tab
	// opened which in this window, which is what it places the next link by. Ask
	// for both back in the same breath, without waiting for the copy: the browser
	// runs it all back to back. Tabs opened a moment ago may be missing from
	// `before`, or already forgotten in it: those go by what they said when created.
	const openers = new Map([
		...waiting,
		...before.filter(t => t.openerTabId !== undefined).map(t => [t.id, t.openerTabId])
	]);
	const duplicating = duplicate(opener.id);
	const refocus = !newTabWasActive && previouslyActive
		? chrome.tabs.update(previouslyActive.id, { active: true }).catch(() => {})
		: null;
	const relinked = [...openers].map(([id, openerTabId]) => chrome.tabs.update(id, { openerTabId }).catch(() => {}));
	let dup;

	try {
		dup = await duplicating;
	} catch {
		return;
	}

	if (!dup) {
		return;
	}

	// Re-read everything: indexes have shifted and the new tab's URL may have
	// moved on through redirects. If the new tab is already gone, so is the copy.
	let current, now;

	try {
		[current, now] = await Promise.all([
			chrome.tabs.get(tab.id),
			chrome.tabs.query({ windowId: tab.windowId })
		]);
	} catch {
		await refocus;
		await chrome.tabs.remove(dup.id).catch(() => {});
		return;
	}

	now.sort((a, b) => a.index - b.index);
	const others = now.filter(t => t.id !== dup.id && t.id !== current.id);
	// The copy goes where the browser put the new tab: right after the tab on its
	// left. A tab opened while a copy sat in front was put beside that copy, so
	// it goes where the browser would have put it: after the last tab opened
	// before it, directly or not, from the same one.
	let left = others.filter(t => t.index < current.index).at(-1);
	const openerNow = others.find(t => t.id === opener.id);

	if (misplaced && openerNow) {
		const family = new Set([opener.id]);
		left = openerNow;

		for (const t of others.filter(t => t.index > openerNow.index)) {
			if (t.pinned || (waiting.has(t.id) && !ownDuplicates.has(t.id))) {
				continue;
			}

			if (!family.has(t.openerTabId)) {
				break;
			}

			family.add(t.id);
			left = t;
		}
	}

	// Index as it'll be once the copy is lifted out of its spot by move().
	const dupIndex = now.find(t => t.id === dup.id)?.index ?? Infinity;
	const after = t => t.index + 1 - (dupIndex < t.index ? 1 : 0);

	// Fired back to back: the browser runs them in order, and not waiting
	// between them keeps the swap down to a blink.
	await Promise.allSettled([
		refocus,
		...relinked,
		chrome.tabs.update(dup.id, { url: urlOf(current) || target }),
		// The copy is pinned if its original is; the new tab says whether it should be.
		chrome.tabs.update(dup.id, { pinned: current.pinned, openerTabId: opener.id }),
		chrome.tabs.move(dup.id, { index: left ? after(left) : 0 }),
		...before.filter(t => t.openerTabId === tab.id).map(t => chrome.tabs.update(t.id, { openerTabId: dup.id })),
		chrome.tabs.remove(current.id)
	]);

	// Links clicked meanwhile insert their tabs and shift every index, which can
	// leave the copy a slot off. Check it landed right after the tab on its left.
	for (let tries = 0; left && tries < 3; tries++) {
		let l, d;

		try {
			[l, d] = await Promise.all([chrome.tabs.get(left.id), chrome.tabs.get(dup.id)]);
		} catch {
			break;
		}

		if (l.windowId !== d.windowId || d.index === l.index + 1) {
			break;
		}

		await chrome.tabs.move(dup.id, { index: d.index > l.index ? l.index + 1 : l.index }).catch(() => {});
	}

	if (refocus) {
		standIns.set(dup.id, { forId: previouslyActive.id, since, until: Date.now() + 100 });
	}
}

chrome.action.onClicked.addListener(async () => {
	const enabled = !(await isEnabled());
	await chrome.storage.local.set({ enabled });
	await updateAction(enabled);
});

chrome.runtime.onStartup.addListener(async () => updateAction(await isEnabled()));
chrome.runtime.onInstalled.addListener(async () => updateAction(await isEnabled()));

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url, transitionType, transitionQualifiers }) => {
	// about:blank may be a window.open() still waiting for its address. Any other
	// page that isn't a web page, like the new tab page, settles it: not a link.
	if (frameId === 0 && url !== 'about:blank') {
		commitWaiters.get(tabId)?.(isWebUrl(url) ? { url, transitionType, transitionQualifiers } : null);
	}
});

chrome.tabs.onRemoved.addListener(tabId => {
	commitWaiters.get(tabId)?.(null);
	ownDuplicates.delete(tabId);
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

	// A swap under way may have made the browser forget this tab's opener before
	// we even heard of the tab. Say it again.
	if (waiting.size) {
		chrome.tabs.update(tab.id, { openerTabId: tab.openerTabId }).catch(() => {});
	}

	waiting.set(tab.id, tab.openerTabId);
	queue = queue
		.then(() => swap(tab, pendingCommit, createdAt))
		.catch(() => {})
		.then(() => waiting.delete(tab.id));
});
