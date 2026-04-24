# CanvasClip — Project Context

## Purpose
Chrome Extension (Manifest V3) for **canvas-based browser remote desktops** —
Apache Guacamole, noVNC, AWS WorkSpaces Web, Citrix HDX HTML5, Parsec Web, etc.
These clients render the remote screen into a `<canvas>` and typically run with
clipboard passthrough disabled (admin policy), so the host OS copy-paste does
not cross into the remote session. CanvasClip types text character by
character into the canvas by synthesizing real keyboard events that the client
library picks up and forwards over the wire.

The extension also has a second mode: **OCR selection tool** that screenshots a
user-drawn region of the tab and runs Tesseract.js on it to extract text. This
is the reverse direction — reading text *out* of the remote canvas when the
pixels can't be selected or copied normally.

## Architecture
No build step, no dependencies beyond vendored Tesseract.js.

### Typer path (content.js + popup)
- **manifest.json** declares a persistent `content_scripts` entry
  (`<all_urls>`, `all_frames: true`, `run_at: document_start`) so the focus
  tracker is running before the toolbar click. The popup also calls
  `chrome.scripting.executeScript` as an idempotent fallback (guarded by
  `window.__remoteTyperInstalled`) for pages that loaded before the extension
  was installed.
- **popup.js** (Typer tab) injects content.js defensively, sends a
  `canvasclip:type` message, and shows progress fed back from content.js
  via `chrome.runtime.sendMessage`. State persisted in `chrome.storage.local`.
- **content.js** — guarded by `window.__remoteTyperInstalled`. Installs a
  capturing `focusin` listener that records the last focused element into
  `lastFocused` — required because opening the action popup blurs the page
  and resets `document.activeElement` to `<body>`. Only the top frame
  responds to `canvasclip:type` messages. Target resolution priority:
  (1) `lastFocused` if still connected and editable, (2) current
  `document.activeElement` if editable, (3) same-origin iframe
  `activeElement` BFS, (4) **the largest visible `<canvas>` in the page or
  same-origin iframes** — this is the case that matters for browser-based
  remote desktops; events bubble to `document` and `window`, covering both
  "listener on canvas" and "listener on document" wiring styles, (5)
  `document.body` as a last resort. Dispatches `keydown` → `keypress` → (value
  mutation if target is editable) → `keyup` per character. Uses the native
  value setter from the prototype descriptor to bypass React's synthetic-event
  value tracker.

### OCR path (overlay + background + offscreen)
- **popup.js** (OCR tab) runs `scripting.executeScript` to inject `overlay.js`
  into the active tab, then calls `window.close()` so the popup gets out of
  the way. State (current OCR status and result) is stored in
  `chrome.storage.session` — survives popup close/reopen but clears when the
  browser session ends.
- **overlay.js** — guarded by `window.__remoteTyperOcrOverlay`. Full-viewport
  fixed-position div with `z-index: 999999`, `cursor: crosshair`, and
  `rgba(0,0,0,0.25)` backdrop. Click-drag draws a selection rectangle with a
  2px blue border and `rgba(0,120,255,0.15)` fill, plus a live
  "WxH @ x,y" readout. `mouseup` sends `{ type: "ocr:area", rect,
  devicePixelRatio, viewport }` to the background and removes itself. ESC
  cancels.
- **background.js** — service worker. On `ocr:area`:
  1. `chrome.tabs.captureVisibleTab(windowId, { format: "png" })` returns a
     data URL at the tab's **physical** resolution (DPR-scaled), which is why
     the offscreen doc multiplies the CSS-pixel rect by DPR before cropping.
  2. Ensures an offscreen document exists (`chrome.offscreen.createDocument`
     with reasons `["WORKERS", "BLOBS"]`).
  3. Sends `{ target: "offscreen", type: "ocr:run", dataUrl, rect, devicePixelRatio }`
     via `chrome.runtime.sendMessage`; the offscreen replies with
     `{ text }` or `{ error }`.
  4. Writes result to `chrome.storage.session.ocrResult` and status to
     `chrome.storage.session.ocrStatus`, closes the offscreen document to
     free the ~30MB Tesseract WASM heap.
- **offscreen.html / offscreen.js** — loads `vendor/tesseract.min.js`. On
  `ocr:run`: fetches the dataUrl into a Blob, creates an `ImageBitmap`, crops
  into an `OffscreenCanvas` (rect × DPR), runs
  `Tesseract.createWorker(["eng", "ita"], 1, { logger })`. The logger relays
  progress via `chrome.runtime.sendMessage({ type: "ocr:progress", progress, stage })`
  which the background pipes into `ocrStatus` and the popup picks up live via
  its own runtime.onMessage listener.

### Why an offscreen document
Tesseract.js needs:
- The DOM (for image decoding via `Image` or `createImageBitmap`).
- The Web Worker API (it spawns an internal worker for OCR).
Service workers have neither. An offscreen document is the MV3-sanctioned way
to get a DOM-capable context out of a service-worker-based extension.

## Things that look wrong but are intentional

- **`vendor/tesseract.min.js` + `vendor/worker.min.js` + `vendor/tesseract-core-simd-lstm.wasm.js` are committed to the repo.**
  MV3 extension pages (popup, offscreen) **cannot load remote scripts** — the
  CSP `script-src 'self'` is unrelaxable, and this applies transitively: the
  Web Worker that Tesseract spawns inherits the parent page's CSP, so its
  `importScripts()` calls are also locked to `'self'`. The original attempt
  to point `corePath` at jsdelivr produced
  `NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope'`.
  The fix is to vendor the whole toolchain: the main wrapper (~65KB), the
  worker script (~120KB), and the combined SIMD+LSTM core (~3.8MB — has the
  WASM binary inlined as base64). `createWorker` is configured with
  `workerPath`, `corePath`, and `workerBlobURL: false` to keep every JS load
  on the extension origin. Only **language data** (eng.traineddata.gz,
  ita.traineddata.gz — ~10MB combined) still comes from the CDN, because
  those are fetched via `fetch()` not scripts, so they fall under
  `connect-src` (unrestricted by default).
- **DPR scaling for OCR crop.** `captureVisibleTab` returns pixels at physical
  resolution (on retina/HiDPI, 2x the CSS viewport). The overlay reports
  coordinates in CSS pixels. Forgetting to multiply by `devicePixelRatio`
  crops the wrong region on HiDPI displays.
- **Only top frame responds to `canvasclip:type`.** `chrome.tabs.sendMessage`
  broadcasts to all frames; without this guard every frame's content script
  would attempt to type, producing 2x–Nx keystrokes.
- **Persistent focus tracker.** Tracking `lastFocused` on every `focusin` in
  every frame is the only way to know where the user was typing before the
  popup stole focus. `document.activeElement` at message-delivery time is
  almost always `<body>`.
- **Canvas priority in `resolveTarget`.** For canvas-based remote desktops
  there's no editable element; dispatching on the canvas directly (which
  bubbles to document/window) is the reliable surface for all common
  library wiring styles.
- **Manual `Object.defineProperty` on `keyCode`/`which`.** Some Chromium
  versions silently ignore these in the `KeyboardEvent` constructor; the
  defineProperty override makes legacy listeners that read `e.keyCode`
  actually see the intended value.
- **Native value setter via prototype descriptor.** React overrides the
  `value` setter on input elements. Writing through
  `HTMLInputElement.prototype`'s setter bypasses that and then the
  dispatched `input` event makes React re-read the value.

## Message flow summary
```
Typer:
  popup  --(executeScript fallback)-->  content.js (all frames)
  popup  --(tabs.sendMessage)---------> content.js (top frame acts)
                                        resolveTarget() → lastFocused / activeElement / canvas / body
                                        for ch: keydown → keypress → insert → keyup
                                        runtime.sendMessage("progress") ---> popup

OCR:
  popup  --(executeScript)-----> overlay.js
  popup.close()
  overlay --(runtime.sendMessage "ocr:area")--> background
  background --(tabs.captureVisibleTab)--> dataUrl (PNG, physical px)
  background --(offscreen.createDocument)--> offscreen.html
  background --(runtime.sendMessage "ocr:run")--> offscreen
                                                   crop via OffscreenCanvas
                                                   Tesseract.createWorker(["eng","ita"])
                                                   runtime.sendMessage("ocr:progress") ---> background ---> storage ---> popup
  background <--(sendResponse { text })-- offscreen
  background --> storage.session.ocrResult
  background --(offscreen.closeDocument)-->
  user reopens popup --> storage.session.get --> shows text
```

## Release / packaging
`.github/workflows/build.yml` zips the extension on every push to `main` and
uploads the zip as a workflow artifact. On tag push (`v*`) it also creates a
GitHub Release with the zip attached.

## Not in scope
- Chrome Web Store publishing.
- Firefox / Edge (MV3 APIs used are portable but untested; `chrome.offscreen`
  is Chrome-only as of now).
- Cross-origin iframe support.
- Modifier-key combos (Shift/Ctrl/Alt).
- Additional OCR languages beyond `eng` + `ita` (trivial to add in
  `offscreen.js`'s `createWorker` call).
