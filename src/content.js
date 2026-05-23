// JSON Lens — content script scaffolding.
// Runs at document_start. Detects if the current document is raw JSON
// and stores a flag for later features (auto-detect/replace, tree view).
// This file is intentionally side-effect light; heavy DOM work lives in
// dedicated modules added in subsequent roadmap items.
(() => {
  "use strict";

  const STATE = {
    detected: false,
    contentType: null,
    url: location.href,
  };

  // Expose a tiny namespace for later modules to attach to without
  // polluting the page's window. Content scripts have an isolated world,
  // so this is only visible to other JSON Lens content modules.
  const ns = (globalThis.__jsonLens ||= {});
  ns.state = STATE;
  ns.version = "0.1.0";

  function looksLikeJsonDocument() {
    // Chrome exposes the response content-type via the <pre> wrapper it
    // injects for text/* responses. We use a few cheap heuristics:
    //   1) <pre> is the only element child of <body> (Chrome's raw view).
    //   2) The first non-whitespace char is { or [.
    // We do NOT parse here — that happens after document_idle in a later
    // roadmap item (auto-detect + replace).
    const body = document.body;
    if (!body) return false;
    const kids = body.children;
    if (kids.length !== 1) return false;
    const only = kids[0];
    if (only.tagName !== "PRE") return false;
    const text = (only.textContent || "").trimStart();
    if (!text) return false;
    const c = text.charCodeAt(0);
    return c === 0x7b /* { */ || c === 0x5b /* [ */;
  }

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  onReady(() => {
    try {
      if (looksLikeJsonDocument()) {
        STATE.detected = true;
        // Mark the document so later features (and CSS) can target it.
        document.documentElement.setAttribute("data-json-lens", "candidate");
      }
    } catch (err) {
      // Fail closed — never break the host page.
      console.debug("[json-lens] detection error", err);
    }
  });

  // Respond to popup/background queries about this tab's state.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "json-lens:ping") {
      sendResponse({
        ok: true,
        detected: STATE.detected,
        url: STATE.url,
        version: ns.version,
      });
      return true;
    }
  });
})();
