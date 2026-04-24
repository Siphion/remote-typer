// ---------- Tabs ----------
const tabs = document.querySelectorAll(".tab");
const panes = document.querySelectorAll(".pane");
tabs.forEach((t) => {
  t.addEventListener("click", () => {
    const name = t.dataset.tab;
    tabs.forEach((x) => x.classList.toggle("active", x === t));
    panes.forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
    chrome.storage.local.set({ activeTab: name });
  });
});
chrome.storage.local.get(["activeTab"], (res) => {
  const name = res?.activeTab;
  if (!name) return;
  tabs.forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  panes.forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
});

// ---------- Typer tab ----------
const textEl = document.getElementById("text");
const delayEl = document.getElementById("delay");
const typeBtn = document.getElementById("type");
const clearBtn = document.getElementById("clear");
const statusEl = document.getElementById("status");

const TYPER_KEY = "canvasClipState";

chrome.storage.local.get([TYPER_KEY], (res) => {
  const s = res?.[TYPER_KEY];
  if (s) {
    if (typeof s.text === "string") textEl.value = s.text;
    if (typeof s.delay === "number") delayEl.value = s.delay;
  }
});

function persistTyper() {
  chrome.storage.local.set({
    [TYPER_KEY]: { text: textEl.value, delay: Number(delayEl.value) || 40 },
  });
}
textEl.addEventListener("input", persistTyper);
delayEl.addEventListener("input", persistTyper);

function setTyperStatus(msg, cls = "") {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

clearBtn.addEventListener("click", () => {
  textEl.value = "";
  persistTyper();
  setTyperStatus("Cleared.", "");
  textEl.focus();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "canvasclip:progress") {
    setTyperStatus(`Typing... ${msg.done}/${msg.total} chars`, "typing");
  }
});

typeBtn.addEventListener("click", async () => {
  const text = textEl.value;
  const delay = Math.max(0, Number(delayEl.value) || 0);
  if (!text) return setTyperStatus("Nothing to type.", "error");

  typeBtn.disabled = true;
  setTyperStatus("Preparing...", "typing");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"],
      });
    } catch (_) {}

    setTyperStatus(`Typing... 0/${text.length} chars`, "typing");
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "canvasclip:type",
      text,
      delay,
    });

    if (response?.ok) setTyperStatus("✅ Done!", "done");
    else setTyperStatus("Error: " + (response?.error || "no response"), "error");
  } catch (err) {
    setTyperStatus("Error: " + err.message, "error");
  } finally {
    typeBtn.disabled = false;
  }
});

// ---------- OCR tab ----------
const ocrSelectBtn = document.getElementById("ocr-select");
const ocrCopyBtn = document.getElementById("ocr-copy");
const ocrClearBtn = document.getElementById("ocr-clear");
const ocrTextEl = document.getElementById("ocr-text");
const ocrStatusEl = document.getElementById("ocr-status");
const ocrProgressWrap = document.getElementById("ocr-progress-wrap");
const ocrProgressBar = document.getElementById("ocr-progress-bar");
const ocrLangEl = document.getElementById("ocr-lang");

const OCR_LANG_KEY = "ocrLang";
chrome.storage.local.get([OCR_LANG_KEY], (res) => {
  if (res?.[OCR_LANG_KEY]) ocrLangEl.value = res[OCR_LANG_KEY];
});
ocrLangEl.addEventListener("change", () => {
  chrome.storage.local.set({ [OCR_LANG_KEY]: ocrLangEl.value });
});

function setOcrStatus(msg, cls = "") {
  ocrStatusEl.textContent = msg;
  ocrStatusEl.className = cls;
}
function showProgress(show) {
  ocrProgressWrap.classList.toggle("visible", show);
}
function setProgress(pct) {
  ocrProgressBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
}

function renderStatus(status, result) {
  if (!status || status.state === "idle") {
    setOcrStatus("Ready.", "");
    showProgress(false);
    setProgress(0);
    ocrSelectBtn.disabled = false;
    return;
  }
  if (status.state === "capturing") {
    setOcrStatus("Capturing tab...", "working");
    showProgress(true);
    setProgress(0);
    ocrSelectBtn.disabled = true;
    return;
  }
  if (status.state === "processing") {
    const pct = typeof status.progress === "number" ? status.progress : 0;
    const stage = status.stage ? ` (${status.stage})` : "";
    setOcrStatus(`OCR... ${pct}%${stage}`, "working");
    showProgress(true);
    setProgress(pct);
    ocrSelectBtn.disabled = true;
    return;
  }
  if (status.state === "done") {
    setOcrStatus("✅ Done!", "done");
    showProgress(false);
    setProgress(100);
    ocrSelectBtn.disabled = false;
    if (result?.text != null) {
      ocrTextEl.value = result.text;
      ocrTextEl.focus();
      ocrTextEl.select();
    }
    return;
  }
  if (status.state === "error") {
    setOcrStatus("Error: " + (status.message || "unknown"), "error");
    showProgress(false);
    ocrSelectBtn.disabled = false;
    return;
  }
}

// Hydrate OCR pane from storage on popup open.
chrome.storage.session.get(["ocrStatus", "ocrResult"], (res) => {
  renderStatus(res?.ocrStatus, res?.ocrResult);
});

// Live updates while the popup is open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ocr:status") {
    chrome.storage.session.get(["ocrResult"], (res) => {
      renderStatus(msg.status, res?.ocrResult);
    });
  }
  if (msg?.type === "ocr:progress") {
    setOcrStatus(`OCR... ${msg.progress}%${msg.stage ? ` (${msg.stage})` : ""}`, "working");
    showProgress(true);
    setProgress(msg.progress);
  }
});

ocrSelectBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");

    // Reset previous result + stash chosen language for the background SW
    // to pick up when the overlay sends the rect.
    await chrome.storage.session.set({
      ocrStatus: { state: "idle" },
      ocrResult: null,
      ocrLang: ocrLangEl.value || "eng+ita",
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["overlay.js"],
    });

    window.close();
  } catch (err) {
    setOcrStatus("Error: " + err.message, "error");
  }
});

ocrCopyBtn.addEventListener("click", async () => {
  const text = ocrTextEl.value;
  if (!text) return setOcrStatus("Nothing to copy.", "error");
  try {
    await navigator.clipboard.writeText(text);
    setOcrStatus("✅ Copied to clipboard!", "done");
  } catch (err) {
    // Fallback for clipboard write failures: use a hidden textarea + execCommand.
    ocrTextEl.select();
    document.execCommand("copy");
    setOcrStatus("Copied (fallback).", "done");
  }
});

ocrClearBtn.addEventListener("click", () => {
  ocrTextEl.value = "";
  chrome.storage.session.set({ ocrResult: null, ocrStatus: { state: "idle" } });
  setOcrStatus("Ready.", "");
});
