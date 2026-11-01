# Perch

A Safari extension (macOS and iOS) for a calmer X:

- **Replies ranked by likes.** The thread author's own replies come first, then people you follow, then everyone else by likes. Blue-check replies need N× the likes to rank the same (set in the popup).
- **No ads.** Promoted posts are removed from the data before X renders it.
- **Following by default** on the home timeline.
- **Threads-style layout:** one centered column with no sidebar, Grok or Premium upsells, and muted blue checks.

## How it works

`extension/src/inject.js` runs in the page's own JavaScript world and wraps `fetch` and `XMLHttpRequest`. X's GraphQL responses (`/i/api/graphql/<hash>/<Operation>`) go through `extension/src/perch-core.js`, which strips promoted entries and, for `TweetDetail`, reorders the reply modules. X orders entries by their `sortIndex`, so the existing indexes are reassigned in Perch's order.

Styling lives in `extension/styles/perch.css`. It targets `data-testid`, `role` and `href`, not X's generated class names.

## Develop

```sh
node --test test/          # ranking and ad-removal logic
open Perch/Perch.xcodeproj # Xcode project; it references extension/ directly
```

### Run on the Mac (free Apple ID)

1. Build and run the **Perch (macOS)** scheme in Xcode.
2. In Safari, go to Settings → Advanced and turn on **Show features for web developers**.
3. Go to Settings → Developer and turn on **Allow unsigned extensions**. You need to do this again after every Safari restart until the app is signed with a paid account.
4. Go to Settings → Extensions, enable **Perch**, and allow it on x.com.

### Run on iPhone (paid Apple Developer account)

1. In Xcode, set your team under Signing & Capabilities for all four targets.
2. Run the **Perch (iOS)** scheme on your phone, or archive it and upload to TestFlight for internal testing.
3. On the iPhone, go to Settings → Apps → Safari → Extensions, turn on Perch, and allow it on x.com.

### Chrome and Firefox

```sh
node scripts/build.js   # → dist/chrome/, dist/firefox/, and a .zip of each
```

- **Chrome (or Edge, Brave):** open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick `dist/chrome`. It stays installed. After a rebuild, click the reload arrow on the Perch card.
- **Firefox:** release Firefox only permanently installs add-ons signed by Mozilla. Signing is free and needs no store listing. Create API keys at addons.mozilla.org (Developer Hub → Manage API Keys), then run `npx web-ext sign --source-dir dist/firefox --channel unlisted --api-key … --api-secret …` and open the `.xpi` it produces in Firefox. For quick tests, `about:debugging` → This Firefox → **Load Temporary Add-on** → `dist/firefox/manifest.json` works until Firefox restarts.

The build gives the page-world script its own copy of `defaults.js` (`defaults-page.js`). Chrome injects a given file only once per page across both worlds, and without the copy the content script ran with no settings.

## When X changes something

- Replies stop sorting or ads come back: check the Web Inspector console for `[perch]` warnings. Then compare a `TweetDetail` response in the Network tab against the field names in `perch-core.js`.
- The layout breaks: fix the selector in `perch.css`.
