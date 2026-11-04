'use strict';

// How it works: Chromium won't let an extension write a tab's history, but
// chrome.tabs.duplicate() copies it. So when you enter a tab opened from a link,
// we duplicate its opener (history included), send the duplicate to the link's
// URL, put it in the new tab's place and close the new tab. duplicate() always
// brings the copy to the front, which is fine by then: that's where you're going.
// Until then the tab is the browser's own, placed by its own rules.

// Duplicates we created ourselves, so their own onCreated is ignored.
const ownDuplicates = new Set();
// Everything runs one at a time, in the order it happened. Run side by side,
// swaps trip over each other's indexes and focus.
let queue = Promise.resolve();

const enqueue = task => {
	queue = queue.then(task).catch(() => {});
};
const isWebUrl = url => /^(https?|file):/i.test(url || '');
const urlOf = tab => isWebUrl(tab.pendingUrl || tab.url) ? tab.pendingUrl || tab.url : null;
// Tabs waiting to be entered. In session storage because Chromium stops this
// service worker long before you get to them.
const pendingKey = tabId => `pending:${tabId}`;

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

async function swap(tab, openerId) {
	const target = urlOf(tab);
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

	// duplicate() makes the browser forget which tab opened which in this window,
	// and that's what it uses to place the next link. Note them down to restore them.
	const before = await chrome.tabs.query({ windowId: tab.windowId });
	let dup;

	try {
		dup = await duplicate(opener.id);
	} catch {
		return;
	}

	if (!dup) {
		return;
	}

	// Re-read everything: indexes have shifted and the new tab's URL may have
	// moved on through redirects. If the new tab is already gone, so is the copy.
	let current, dupNow;

	try {
		[current, dupNow] = await Promise.all([
			chrome.tabs.get(tab.id),
			chrome.tabs.get(dup.id)
		]);
	} catch {
		await chrome.tabs.remove(dup.id).catch(() => {});
		return;
	}

	const openers = before
		.filter(t => t.openerTabId !== undefined && t.id !== current.id)
		.map(t => [t.id, t.openerTabId === current.id ? dup.id : t.openerTabId]);

	// Fired back to back: the browser runs them in order, and not waiting
	// between them keeps the swap down to a blink.
	await Promise.allSettled([
		chrome.tabs.update(dup.id, { url: urlOf(current) || target }),
		// Index as it'll be once the copy is lifted out of its spot.
		chrome.tabs.move(dup.id, { index: current.index - (dupNow.index < current.index ? 1 : 0) }),
		...[...openers, [dup.id, opener.id]].map(([id, openerTabId]) => chrome.tabs.update(id, { openerTabId })),
		chrome.tabs.remove(current.id)
	]);
}

// A tab is swapped once a web page has committed in it and you're in it. A link
// that turns out to be a download never commits (Chromium closes the tab by
// itself, or a download manager takes over), so it stays entirely out of our
// way. Pages written by script after window.open() never commit either.
async function swapIfReady(tabId) {
	const key = pendingKey(tabId);
	const { [key]: pending } = await chrome.storage.session.get(key);

	if (!pending?.committed) {
		return;
	}

	const tab = await chrome.tabs.get(tabId);

	if (!tab.active) {
		return;
	}

	await chrome.storage.session.remove(key);

	if (await isEnabled()) {
		await swap(tab, pending.openerId);
	}
}

chrome.action.onClicked.addListener(async () => {
	const enabled = !(await isEnabled());
	await chrome.storage.local.set({ enabled });
	await updateAction(enabled);
});

chrome.runtime.onStartup.addListener(async () => updateAction(await isEnabled()));
chrome.runtime.onInstalled.addListener(async () => updateAction(await isEnabled()));

chrome.tabs.onActivated.addListener(({ tabId }) => enqueue(() => swapIfReady(tabId)));

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url, transitionType }) => {
	if (frameId !== 0 || !isWebUrl(url)) {
		return;
	}

	enqueue(async () => {
		const key = pendingKey(tabId);
		const { [key]: pending } = await chrome.storage.session.get(key);

		if (!pending || pending.committed) {
			return;
		}

		// A submitted form can't be replayed: the copy would load it as a plain GET
		// and lose what was sent.
		if (transitionType === 'form_submit') {
			await chrome.storage.session.remove(key);
			return;
		}

		await chrome.storage.session.set({ [key]: { ...pending, committed: true } });
		await swapIfReady(tabId);
	});
});

chrome.tabs.onRemoved.addListener(tabId => {
	enqueue(async () => {
		ownDuplicates.delete(tabId);
		await chrome.storage.session.remove(pendingKey(tabId));
	});
});

chrome.tabs.onCreated.addListener(tab => {
	if (tab.openerTabId === undefined) {
		return;
	}

	enqueue(async () => {
		if (!ownDuplicates.has(tab.id) && await isEnabled()) {
			await chrome.storage.session.set({ [pendingKey(tab.id)]: { openerId: tab.openerTabId, committed: false } });
		}
	});
});
