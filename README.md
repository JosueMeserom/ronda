<p align="center">
  <img src="assets/icon.svg" width="120" alt="Ronda">
</p>

# 🌉 Ronda

*[Leer en español](README.es.md)*

An extension for Chromium browsers (Chrome, Brave, Edge and the others built on the same engine) that makes **tabs opened from a link inherit the whole history of the tab they come from**. You middle-click a link, press Back in the new tab and you are on the page you came from, as if you had browsed in the same tab all along.

The name comes from the [Puente Nuevo in Ronda](https://en.wikipedia.org/wiki/Puente_Nuevo), Spain: almost a hundred metres of stone over the Tajo gorge, joining the new part of the town to the old one. Ronda joins the new tab to the old one, so you always have a way back. It is a sister project of [Bayeux](https://github.com/JosueMeserom/bayeux) and [Segovia](https://github.com/JosueMeserom/segovia), two other projects of mine named after a place.

---

## 🤔 The problem

A tab opened with a middle click, with Ctrl+click or by a `target="_blank"` link (one the website itself sends to a new tab) starts with an empty history. The Back button is greyed out, and if you want to go back you have to find the tab you came from, if it is still open:

```
          normal tab                       Ronda
  ┌──────────────────────────┐   ┌──────────────────────────┐
  │ <- (grey)   the.new      │   │ <- active   the.new      │
  │ history: 1               │   │ history: origin + 1      │
  └──────────────────────────┘   └──────────────────────────┘
        no way back               Back takes you to the origin
```

Yandex Browser does this out of the box, from inside the browser. I stopped using it, but this was one of the features I liked, because it is quite useful. The other Chromium browsers have no such option, so I made Ronda.

---

## 🚀 How to use it

I haven't published it in any store yet, so you have to load it unpacked:

1. Download or clone this repository.
2. Open `chrome://extensions` (`brave://extensions`, `edge://extensions`…) and turn on **Developer mode**.
3. Click **Load unpacked** and choose the repository folder.

And that's it: open links as you always do. **Its icon turns it on and off**; when it is off, it shows `OFF`.

I have tested 0.4 in **Brave** and in Chromium (version 156); the earlier versions, in **Edge** too. It should work in any Chromium from version 110 on, but I haven't tested the others yet.

---

## ⚙️ How it works

Chromium doesn't let extensions write a tab's history, and it has no option to open a tab with one. The only thing that creates a tab with a history is duplicating another tab, so Ronda does a swap:

1. The new tab opens and Ronda **waits until a real page has loaded in it**.
2. It duplicates the tab you came from, with its whole history, and gives the focus back to where it was.
3. It sends the copy to the link's address, puts it where the new tab is and closes the new tab.

If you open several tabs in a row, it handles them one at a time, in the order you opened them, and each one ends up where the browser would have put it.

**What it leaves alone:**

| Case | Why |
|---|---|
| **Downloads** | They never load a page. The browser or your download manager gets them as usual (I have tested it with Free Download Manager) |
| **Forms** | The copy would request them without the data that was sent |
| **New tabs** (Ctrl+T) and the addresses you type in them | They don't come from a link |
| **Tabs opened from the Back and Forward buttons** | They already bring their own history |
| **Popup windows** | They are not normal tabs |
| **Tabs that go to another window** | The history can't be taken to another window with this method |
| **Internal browser pages** | There is no web history behind them |
| **Pages written by script** after `window.open()` | They have no address to send the copy to |
| **Pages that take more than 5 seconds to respond** | They stay as a normal tab, without the history, so they don't hold up the next ones |

---

## ⚠️ Limitations

They all come from doing this from an extension; they would only go away by doing it from inside the browser:

- **There is a flicker.** Duplicating always puts the copy in front, with no option to avoid it. Ronda gives the focus back straight away, but you will see a flash, especially with many tabs open.
- **Each link is requested twice**, once in the new tab and once in the copy. Normally you won't notice, but a **single-use link** (confirming an email, signing in without a password) can be used up by the first request and fail on the second. For those, turn Ronda off for a moment or open them in the same tab. The second request also goes without a `Referer` (the header that tells a website which page you are coming from), so the website doesn't know.
- **The page you came from is requested again too** when it is duplicated, if it isn't in the cache. The copy is sent somewhere else straight away, so it usually never gets shown.
- **The new tab inherits the `sessionStorage` of the one it came from** (what a website stores for that tab only), because it is a copy of it. It only matters when the link goes to the same website.
- **`window.opener` is lost** (the reference a tab uses to talk to the tab that opened it). A website that opens a tab with `window.open()` and then talks to it can no longer do so. This is the rarest one to run into, because sign-in flows usually use popup windows, and those are left alone. If a website stops working for you, try turning Ronda off.
- **The tab is replaced a moment after it opens**, when the page starts loading.

---

## 🔒 Privacy

Ronda doesn't connect to anything, has no accounts, analytics or ads, and only stores whether it is on or off.

These are the permissions it asks for:

| Permission | What for |
|---|---|
| `tabs` | To know which tab each one comes from and which address it is going to. Chromium describes it as "read your browsing history", but Ronda neither stores it nor sends it anywhere |
| `webNavigation` | To know when a page has really loaded, and whether it comes from a form |
| `storage` | To remember whether it is on |

It doesn't ask for access to the content of the pages.

I offer it as is, with no warranty (MIT license).

---

## 🧪 Development

```bash
npm test             # in Brave
npm test -- --edge   # in Edge
npm run check        # syntax and manifest
```

The tests have no dependencies. They open a real browser, headless and with a temporary profile, against a local server, and make real clicks. They cover the inherited history, downloads, forms, bursts of clicks, tab position, new tabs, pinned tabs and the extension turned off.

They need Node 20.10 or later, because they use the `WebSocket` that Node ships since that version to talk to the browser. For now they look for the browsers in the Windows paths; on other systems, give them the path with `RONDA_BROWSER` (and closing the browser uses `taskkill` only if it is available).

---

## 📄 License

MIT. You can read it in [LICENSE](LICENSE).

Ronda is not affiliated with, associated with, authorized by or endorsed by Google, Brave, Microsoft or Yandex. Their names and trademarks belong to their respective owners.
