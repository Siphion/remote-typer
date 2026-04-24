(() => {
  if (window.__canvasClipOcrOverlay) return;
  window.__canvasClipOcrOverlay = true;

  const overlay = document.createElement("div");
  overlay.id = "__canvasclip-ocr-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    background: "rgba(0,0,0,0.25)",
    zIndex: "999999",
    cursor: "crosshair",
    userSelect: "none",
    margin: "0",
  });

  const selection = document.createElement("div");
  Object.assign(selection.style, {
    position: "absolute",
    border: "2px solid rgb(0,120,255)",
    background: "rgba(0,120,255,0.15)",
    display: "none",
    pointerEvents: "none",
    boxSizing: "border-box",
  });
  overlay.appendChild(selection);

  const info = document.createElement("div");
  Object.assign(info.style, {
    position: "absolute",
    background: "rgba(0,0,0,0.85)",
    color: "white",
    padding: "3px 7px",
    font: "12px ui-monospace, Menlo, Consolas, monospace",
    borderRadius: "4px",
    pointerEvents: "none",
    display: "none",
    whiteSpace: "nowrap",
  });
  overlay.appendChild(info);

  const hint = document.createElement("div");
  hint.textContent = "Draw a rectangle to OCR · ESC to cancel";
  Object.assign(hint.style, {
    position: "absolute",
    top: "14px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.85)",
    color: "white",
    padding: "7px 14px",
    borderRadius: "6px",
    font: "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    pointerEvents: "none",
  });
  overlay.appendChild(hint);

  document.documentElement.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function updateRect(cx, cy) {
    const x = Math.min(startX, cx);
    const y = Math.min(startY, cy);
    const w = Math.abs(cx - startX);
    const h = Math.abs(cy - startY);
    selection.style.left = x + "px";
    selection.style.top = y + "px";
    selection.style.width = w + "px";
    selection.style.height = h + "px";
    info.textContent = `${Math.round(w)} × ${Math.round(h)}  @ ${Math.round(x)}, ${Math.round(y)}`;
    info.style.left = x + "px";
    info.style.top = (y > 25 ? y - 24 : y + h + 6) + "px";
    return { x, y, w, h };
  }

  function onDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    selection.style.display = "block";
    info.style.display = "block";
    hint.style.display = "none";
    updateRect(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    if (!dragging) return;
    updateRect(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const { x, y, w, h } = updateRect(e.clientX, e.clientY);
    cleanup();
    if (w < 5 || h < 5) {
      chrome.runtime.sendMessage({ type: "ocr:cancel" });
      return;
    }
    chrome.runtime.sendMessage({
      type: "ocr:area",
      rect: { x, y, width: w, height: h },
      devicePixelRatio: window.devicePixelRatio || 1,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    e.preventDefault();
    e.stopPropagation();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      cleanup();
      chrome.runtime.sendMessage({ type: "ocr:cancel" });
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function cleanup() {
    overlay.removeEventListener("mousedown", onDown, true);
    overlay.removeEventListener("mousemove", onMove, true);
    overlay.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
    window.__canvasClipOcrOverlay = false;
  }

  overlay.addEventListener("mousedown", onDown, true);
  overlay.addEventListener("mousemove", onMove, true);
  overlay.addEventListener("mouseup", onUp, true);
  window.addEventListener("keydown", onKey, true);
})();
