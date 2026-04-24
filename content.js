(() => {
  if (window.__canvasClipInstalled) return;
  window.__canvasClipInstalled = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Track the last focused element so that when the extension popup steals focus,
  // we still know where the user was typing.
  let lastFocused = null;
  const onFocusIn = (e) => {
    const t = e.target;
    if (!t || t === document.body || t === document.documentElement) return;
    lastFocused = t;
  };
  document.addEventListener("focusin", onFocusIn, true);
  // Seed with whatever is focused at script install time.
  if (document.activeElement && document.activeElement !== document.body) {
    lastFocused = document.activeElement;
  }

  function isEditable(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function keyInfoFor(ch) {
    if (ch === "\n" || ch === "\r") {
      return { key: "Enter", code: "Enter", keyCode: 13, which: 13, isEnter: true };
    }
    if (ch === "\t") {
      return { key: "Tab", code: "Tab", keyCode: 9, which: 9, isEnter: false };
    }
    const upper = ch.toUpperCase();
    const code = /[A-Z]/.test(upper)
      ? "Key" + upper
      : /[0-9]/.test(ch)
      ? "Digit" + ch
      : ch === " "
      ? "Space"
      : "";
    return {
      key: ch,
      code,
      keyCode: ch.charCodeAt(0),
      which: ch.charCodeAt(0),
      isEnter: false,
    };
  }

  function dispatchKey(target, type, info) {
    const ev = new KeyboardEvent(type, {
      key: info.key,
      code: info.code,
      keyCode: info.keyCode,
      which: info.which,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    try {
      Object.defineProperty(ev, "keyCode", { get: () => info.keyCode });
      Object.defineProperty(ev, "which", { get: () => info.which });
    } catch (_) {}
    return target.dispatchEvent(ev);
  }

  function insertIntoEditable(target, ch, info) {
    if (!isEditable(target)) return;
    const win = target.ownerDocument?.defaultView || window;

    if (info.isEnter) {
      if (target.tagName === "TEXTAREA") {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")?.set;
        const newVal = target.value.slice(0, start) + "\n" + target.value.slice(end);
        if (setter) setter.call(target, newVal); else target.value = newVal;
        try { target.selectionStart = target.selectionEnd = start + 1; } catch (_) {}
        target.dispatchEvent(new InputEvent("input", { data: "\n", inputType: "insertLineBreak", bubbles: true }));
        return;
      }
      if (target.isContentEditable) {
        target.ownerDocument.execCommand("insertLineBreak");
      }
      return;
    }

    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const proto = target.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const newVal = target.value.slice(0, start) + ch + target.value.slice(end);
      if (setter) setter.call(target, newVal); else target.value = newVal;
      try { target.selectionStart = target.selectionEnd = start + ch.length; } catch (_) {}
      target.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
      return;
    }

    if (target.isContentEditable) {
      target.ownerDocument.execCommand("insertText", false, ch);
    }
  }

  function drillIntoIframe(el) {
    // If the element is an <iframe>, recurse into its document's activeElement.
    // Repeats so nested iframes get unwrapped in one shot.
    while (el && el.tagName === "IFRAME") {
      let doc;
      try { doc = el.contentDocument; } catch (_) { return el; }
      if (!doc) return el;
      const inner = doc.activeElement;
      if (!inner || inner === doc.body) return el;
      el = inner;
    }
    return el;
  }

  function findLargeCanvas() {
    // Canvas-based remote desktops (Guacamole, noVNC, AWS WorkSpaces Web, etc.)
    // render the session into a canvas and attach their keyboard handler
    // either to the canvas itself or to document/window. Pick the largest
    // visible canvas as the dispatch surface — events bubble up to document
    // and window, covering both wiring styles.
    const all = Array.from(document.querySelectorAll("canvas"));
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const doc = f.contentDocument;
        if (doc) all.push(...doc.querySelectorAll("canvas"));
      } catch (_) {}
    }
    let best = null;
    let bestArea = 0;
    for (const c of all) {
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width >= 200 && r.height >= 150) {
        best = c;
        bestArea = area;
      }
    }
    return best;
  }

  function resolveTarget() {
    // 1. Element we tracked right before the popup stole focus — most reliable,
    //    because by the time the popup opens, document.activeElement has
    //    usually fallen back to <body>.
    if (lastFocused && lastFocused.isConnected) {
      const t = drillIntoIframe(lastFocused);
      if (isEditable(t)) return t;
    }

    // 2. Current activeElement, if it is still an editable target.
    if (document.activeElement && document.activeElement !== document.body) {
      const t = drillIntoIframe(document.activeElement);
      if (isEditable(t)) return t;
    }

    // 3. Sweep same-origin iframes for a focused editable.
    const queue = Array.from(document.querySelectorAll("iframe"));
    while (queue.length) {
      const f = queue.shift();
      let doc;
      try { doc = f.contentDocument; } catch (_) { continue; }
      if (!doc) continue;
      const active = doc.activeElement;
      if (active && active !== doc.body) {
        const t = drillIntoIframe(active);
        if (isEditable(t)) return t;
      }
      queue.push(...doc.querySelectorAll("iframe"));
    }

    // 4. Canvas-based remote desktop: dispatch on the canvas. Events bubble up
    //    to document and window, so listeners wired at any of those levels fire.
    const canvas = findLargeCanvas();
    if (canvas) return canvas;

    // 5. Last-resort page-level fallback — dispatch on document.body.
    return document.body;
  }

  async function typeText(text, delay, onProgress) {
    const target = resolveTarget();
    const total = text.length;
    for (let i = 0; i < total; i++) {
      const ch = text[i];
      const info = keyInfoFor(ch);

      const preventedDown = !dispatchKey(target, "keydown", info);
      const isPrintable = !/[\x00-\x1f]/.test(ch) || info.isEnter;
      const preventedPress = isPrintable ? !dispatchKey(target, "keypress", info) : false;

      if (!preventedDown && !preventedPress && isEditable(target)) {
        insertIntoEditable(target, ch, info);
      }

      dispatchKey(target, "keyup", info);

      onProgress(i + 1, total);
      if (delay > 0 && i < total - 1) await sleep(delay);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "canvasclip:type") return;
    // Only the top frame responds. Child frames' focus trackers are still
    // useful because the top frame drills into same-origin iframes during
    // resolveTarget, but having multiple frames respond would duplicate
    // keystrokes.
    if (window.top !== window) return;

    (async () => {
      try {
        await typeText(msg.text, Math.max(0, msg.delay || 0), (done, total) => {
          chrome.runtime.sendMessage({ type: "canvasclip:progress", done, total }).catch(() => {});
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  });
})();
