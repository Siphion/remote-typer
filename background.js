// Service worker: orchestrates OCR area capture. The overlay (injected into the
// active tab) sends us a rectangle; we capture the visible tab, hand the
// screenshot + rect to the offscreen document for cropping and OCR, then stash
// the result in chrome.storage.session so the popup can pick it up on open.

const OFFSCREEN_PATH = "offscreen.html";

async function hasOffscreenDocument() {
  if (chrome.offscreen?.hasDocument) {
    try { return await chrome.offscreen.hasDocument(); } catch (_) {}
  }
  // Fallback for older Chrome: query existing contexts.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS", "BLOBS"],
    justification: "Run Tesseract.js (Web Worker + Blob URLs) to OCR a captured tab region.",
  });
}

async function setStatus(status) {
  await chrome.storage.session.set({ ocrStatus: status });
  try {
    await chrome.runtime.sendMessage({ type: "ocr:status", status });
  } catch (_) {
    // popup may be closed, ignore
  }
}

async function handleArea(msg, sender) {
  const tab = sender.tab;
  if (!tab?.id || tab.windowId == null) {
    await setStatus({ state: "error", message: "No active tab." });
    return;
  }

  try {
    await setStatus({ state: "capturing" });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

    await setStatus({ state: "processing", progress: 0 });
    await ensureOffscreen();

    const { ocrLang } = await chrome.storage.session.get(["ocrLang"]);
    const lang = ocrLang || "eng+ita";

    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "ocr:run",
      dataUrl,
      rect: msg.rect,
      devicePixelRatio: msg.devicePixelRatio || 1,
      lang,
    });

    if (!result || result.error) {
      throw new Error(result?.error || "OCR failed");
    }

    const text = (result.text || "").trim();
    await chrome.storage.session.set({
      ocrResult: { text, timestamp: Date.now() },
    });
    await setStatus({ state: "done", hasResult: true });
  } catch (err) {
    await setStatus({ state: "error", message: err.message || String(err) });
  } finally {
    // Close offscreen document to free memory. Tesseract holds its WASM core
    // in worker memory; terminating and closing the doc reclaims ~30MB.
    try {
      if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    } catch (_) {}
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "ocr:area") {
    handleArea(msg, sender);
    return;
  }

  if (msg.type === "ocr:cancel") {
    setStatus({ state: "idle" });
    return;
  }

  // Progress pings from the offscreen document. Relay them into session
  // storage so the popup can read progress even if it was opened late.
  if (msg.type === "ocr:progress") {
    chrome.storage.session.set({
      ocrStatus: { state: "processing", progress: msg.progress, stage: msg.stage },
    });
    return;
  }
});
