# CanvasClip

Chrome extension (Manifest V3). A **clipboard bridge for browser-based remote desktops** that render the session into an HTML `<canvas>` — Apache Guacamole, noVNC, AWS WorkSpaces Web, Citrix HDX in-browser, Parsec web client, and similar. These tools run the remote screen as pixels painted on a canvas: there's no DOM input to target, no text to select, and the browser's clipboard is usually **not** forwarded into the remote session. Copy-paste between the host OS and the remote machine simply doesn't work.

CanvasClip fixes this in both directions:

- **Paste-in (Typer tab)** — synthesizes real keyboard events that the canvas-based client picks up and forwards over the wire, the same way it forwards real keystrokes from your physical keyboard.
- **Copy-out (OCR tab)** — screenshots a user-drawn rectangle of the tab and runs Tesseract.js on it, so you can extract text rendered as pixels in the remote session.

## Why this exists

If you've used a browser-based remote desktop for any length of time, you know the drill:

- You need to type a 40-character password or an API key into the remote session.
- You copy it on your host OS.
- You paste into the remote canvas — nothing happens, because the canvas isn't an input field and the remote protocol (RDP/VNC/PCoIP) has clipboard passthrough disabled by admin policy.
- You end up typing it by hand, character by character, hoping you don't mistype.

Or the reverse: an error dialog, a long filename, a UUID rendered in the remote session. You can see it but not select it. You re-type it into a local text file while squinting at the screen.

CanvasClip automates both of those by dispatching real `KeyboardEvent`s into the canvas (or into `document` / `window` as a fallback, which is where most canvas-based clients install their keyboard handlers) for outgoing text, and by running Tesseract.js locally on a screenshot of the region for incoming text.

## Privacy

**Nothing leaves your browser.** There's no server, no telemetry, no error reporting. The only external request the extension makes is a one-time download of Tesseract's language data files (`eng.traineddata.gz`, `ita.traineddata.gz`, etc. — a few MB each) from `tessdata.projectnaptha.com`, which are static binary weights cached by the browser after the first use. No text you type or OCR is ever transmitted anywhere.

## What works

**Typer tab:**
- Canvas-based remote desktops: Guacamole, noVNC, AWS WorkSpaces Web, Citrix HDX HTML5, Parsec Web, etc. Click into the session canvas once to give it focus, then open CanvasClip and Type It.
- Plain HTML forms: `<input>`, `<textarea>`, `contenteditable`. Works with React-controlled inputs — the native value setter is used to bypass React's synthetic-event value tracker, so controlled components see the change.
- Same-origin nested iframes.
- `Enter` → `keyCode: 13`; `Tab` → `keyCode: 9`.
- Configurable per-character delay (default 40ms). Raise it if the remote is laggy or throttling input.

**OCR tab:**
- Draw a rectangle on the current tab, extract text with Tesseract.js.
- Language selector — English + Italian by default, plus Spanish, French, German, Portuguese, Dutch, Russian, Japanese, Chinese (Simplified / Traditional), Korean, Arabic, and a few English-paired combos.
- One-click copy to clipboard.

## Limits

- **Cross-origin iframes** are unreachable by browser security policy. If your remote desktop webapp embeds the session canvas in a cross-origin iframe, CanvasClip can't type into it without a broader host-permissions model.
- **Modifier-key combos** (Ctrl+C, Shift+Tab, Alt+F4, etc.) are not supported — the Typer handles printable characters, `Enter`, and `Tab` only. The goal is pasting text, not scripting keyboard shortcuts.
- **Some canvas clients install their keyboard listener on a very specific element**. If Type It reports Done but nothing appears in the remote session, click directly into the canvas first and try again. Raising the delay helps with clients that throttle rapid keystrokes.
- **OCR language data** is fetched from the Tesseract.js CDN on first use of each language (~5–10MB). One-time cost per language, then cached by the browser.
- **OCR accuracy** is Tesseract-level — good for clean rendered text, flaky for small fonts, antialiased subpixel text, or unusual color schemes. Zoom the remote session before selecting, or raise the DPI of the remote display, if the text is small.

## Install (unpacked)

1. Download the latest zip from the [Releases](../../releases) page, or grab the build artifact from the [Actions](../../actions) tab.
2. Unzip it somewhere.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick the unzipped folder.

## Usage — Typer

1. Open your browser-based remote desktop tab and **click into the session canvas** to give it focus.
2. Click the CanvasClip toolbar icon.
3. Paste the text, tune the delay if needed (40ms default; try 80–120ms for laggy remotes), click **Type It**.
4. The popup stays open during typing and shows live progress.

## Usage — OCR

1. Open the CanvasClip popup and switch to the **📷 OCR** tab.
2. Pick a language (or combo), click **Select Area**. The popup closes and a crosshair overlay appears.
3. Click-drag a rectangle around the text you want. Release — the overlay disappears, the tab is screenshotted, and the cropped region is sent to Tesseract.
4. Reopen the popup to see the extracted text. A progress bar shows OCR % while processing.
5. Click **Copy** to put the text into your clipboard.

## Files

- `manifest.json` — MV3, permissions: `activeTab`, `scripting`, `tabs`, `storage`, `offscreen`, `clipboardWrite`. CSP adds `'wasm-unsafe-eval'` so Tesseract's WASM can instantiate.
- `popup.html` / `popup.js` — UI with two tabs (Typer / OCR) and the language selector.
- `content.js` — injected on every page with `all_frames: true` at `document_start`; runs the focus tracker and does the actual typing.
- `background.js` — service worker; handles `captureVisibleTab` and orchestrates the offscreen document.
- `overlay.js` — injected on demand into the active tab; draws the selection rectangle.
- `offscreen.html` / `offscreen.js` — runs Tesseract.js in an offscreen document (service workers can't spawn Web Workers or use the Image API).
- `vendor/` — Tesseract.js v5 bits vendored locally: `tesseract.min.js` (~65KB wrapper), `worker.min.js` (~120KB internal worker), `tesseract-core-simd-lstm.wasm.js` (~3.8MB, SIMD+LSTM core with WASM inlined). Vendored because MV3's `script-src 'self'` CSP applies transitively to spawned Workers. Only language data is fetched from `tessdata.projectnaptha.com` at runtime (via `fetch()`, which falls under the unrestricted `connect-src`).
- `icons/` — toolbar icons (16 / 48 / 128 px) plus a Pillow script (`build_icons.py`) to regenerate them.

## License

MIT.
