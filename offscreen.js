// Runs inside an extension offscreen document so Tesseract.js can spawn a
// Web Worker and allocate a DOM Image for cropping — neither is available in
// the service worker. The whole Tesseract toolchain is vendored under
// vendor/ because MV3's CSP (`script-src 'self'`) applies transitively to
// the Worker that Tesseract spawns. Only language data comes from the CDN
// via fetch() (connect-src is unrestricted by default).

function log(...args) {
  try { console.log("[remote-typer-ocr]", ...args); } catch (_) {}
}
function logError(...args) {
  try { console.error("[remote-typer-ocr]", ...args); } catch (_) {}
}

// Surface any uncaught error back to the popup via session storage so the
// user sees something other than "stuck at 0%".
self.addEventListener("error", (e) => {
  logError("window error:", e.message, e.filename, e.lineno, e.colno, e.error);
  chrome.storage?.session?.set({
    ocrStatus: { state: "error", message: `offscreen: ${e.message}` },
  });
});
self.addEventListener("unhandledrejection", (e) => {
  logError("unhandled rejection:", e.reason);
  chrome.storage?.session?.set({
    ocrStatus: {
      state: "error",
      message: `offscreen promise: ${e.reason?.message || e.reason}`,
    },
  });
});

async function blobFromDataUrlRect(dataUrl, rect, devicePixelRatio) {
  const resp = await fetch(dataUrl);
  const imgBlob = await resp.blob();
  const bitmap = await createImageBitmap(imgBlob);

  const dpr = devicePixelRatio || 1;
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr));
  log(`cropping ${sw}x${sh} @ ${sx},${sy} (dpr ${dpr}) from ${bitmap.width}x${bitmap.height}`);

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return await canvas.convertToBlob({ type: "image/png" });
}

async function runOcr({ dataUrl, rect, devicePixelRatio, lang }) {
  log("runOcr start, lang:", lang);

  const cropped = await blobFromDataUrlRect(dataUrl, rect, devicePixelRatio);
  log("crop ok, bytes:", cropped.size);

  log("Tesseract present?", typeof Tesseract);
  const workerPath = chrome.runtime.getURL("vendor/worker.min.js");
  const corePath = chrome.runtime.getURL("vendor/");
  log("workerPath:", workerPath);
  log("corePath:", corePath);

  // Tesseract accepts either an array of language codes or a "+"-joined
  // string; the select values already use "+" (e.g. "eng+ita"), so pass as-is.
  const langs = (lang && typeof lang === "string" ? lang : "eng+ita")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  log("createWorker langs:", langs);

  const worker = await Tesseract.createWorker(langs, 1, {
    workerPath,
    corePath,
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    workerBlobURL: false,
    logger: (m) => {
      if (!m) return;
      const progress = typeof m.progress === "number" ? Math.round(m.progress * 100) : 0;
      log("tess:", m.status, `${progress}%`);
      chrome.runtime.sendMessage({
        type: "ocr:progress",
        progress,
        stage: m.status || "",
      }).catch(() => {});
    },
    errorHandler: (err) => {
      logError("tess errorHandler:", err);
    },
  });
  log("createWorker resolved");

  try {
    const { data } = await worker.recognize(cropped);
    log("recognize done, chars:", data?.text?.length);
    return { text: data?.text || "" };
  } finally {
    try { await worker.terminate(); } catch (_) {}
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "ocr:run") {
    runOcr(msg)
      .then((r) => sendResponse(r))
      .catch((err) => {
        logError("runOcr threw:", err);
        sendResponse({ error: err?.message || String(err) });
      });
    return true;
  }
});

log("offscreen.js loaded");
