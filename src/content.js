// JSON Lens — content script
// Auto-detects raw JSON responses and replaces Chrome's plain <pre>
// view with a liquid-glass JSON Lens shell containing a pretty-printed,
// syntax-highlighted document. Collapsible tree, filter, and schema
// features land in subsequent roadmap items.
(() => {
  "use strict";

  const STATE = {
    detected: false,
    replaced: false,
    parsed: null,
    rawText: "",
    bytes: 0,
    url: location.href,
  };

  const ns = (globalThis.__jsonLens ||= {});
  ns.state = STATE;
  ns.version = "0.1.0";

  // ---------- detection ----------
  function rawPreCandidate() {
    const body = document.body;
    if (!body) return null;
    const kids = body.children;
    if (kids.length !== 1) return null;
    const only = kids[0];
    if (only.tagName !== "PRE") return null;
    const text = (only.textContent || "").trimStart();
    if (!text) return null;
    const c = text.charCodeAt(0);
    if (c !== 0x7b /* { */ && c !== 0x5b /* [ */) return null;
    return only;
  }

  function tryParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  // ---------- escaping + highlight ----------
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderValue(v, indent, isKeyContext) {
    if (v === null) return `<span class="jl-null">null</span>`;
    const t = typeof v;
    if (t === "boolean") return `<span class="jl-bool">${v}</span>`;
    if (t === "number") return `<span class="jl-num">${v}</span>`;
    if (t === "string") return `<span class="jl-str">"${esc(v)}"</span>`;
    if (Array.isArray(v)) {
      if (v.length === 0) return `<span class="jl-punc">[]</span>`;
      const pad = "  ".repeat(indent + 1);
      const close = "  ".repeat(indent);
      const parts = v.map(
        (item) => `${pad}${renderValue(item, indent + 1, false)}`
      );
      return (
        `<span class="jl-punc">[</span>\n` +
        parts.join(`<span class="jl-punc">,</span>\n`) +
        `\n${close}<span class="jl-punc">]</span>`
      );
    }
    if (t === "object") {
      const keys = Object.keys(v);
      if (keys.length === 0) return `<span class="jl-punc">{}</span>`;
      const pad = "  ".repeat(indent + 1);
      const close = "  ".repeat(indent);
      const parts = keys.map((k) => {
        return (
          `${pad}<span class="jl-key">"${esc(k)}"</span>` +
          `<span class="jl-punc">: </span>` +
          renderValue(v[k], indent + 1, false)
        );
      });
      return (
        `<span class="jl-punc">{</span>\n` +
        parts.join(`<span class="jl-punc">,</span>\n`) +
        `\n${close}<span class="jl-punc">}</span>`
      );
    }
    return esc(String(v));
  }

  // ---------- summary ----------
  function summarize(v) {
    if (v === null) return { kind: "null", size: 0 };
    if (Array.isArray(v)) return { kind: "array", size: v.length };
    if (typeof v === "object") return { kind: "object", size: Object.keys(v).length };
    return { kind: typeof v, size: 0 };
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  // ---------- icons (phosphor-style inline SVG) ----------
  const ICONS = {
    lens: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>`,
    raw: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h9l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/></svg>`,
  };

  // ---------- replace view ----------
  function injectStylesheet() {
    const href = chrome.runtime.getURL("src/viewer.css");
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  function buildShell(parsed, rawText) {
    const root = document.createElement("div");
    root.id = "json-lens-root";
    root.setAttribute("data-theme", "dark");

    const sum = summarize(parsed);
    const sizeLabel = formatBytes(new Blob([rawText]).size);

    root.innerHTML = `
      <div class="jl-blobs" aria-hidden="true">
        <div class="jl-blob jl-blob-a"></div>
        <div class="jl-blob jl-blob-b"></div>
      </div>
      <header class="jl-chrome">
        <div class="jl-brand">
          <span class="jl-brand-icon">${ICONS.lens}</span>
          <span class="jl-brand-name">JSON Lens</span>
        </div>
        <div class="jl-stats">
          <span class="jl-badge jl-badge-kind" data-kind="${sum.kind}">${sum.kind}</span>
          <span class="jl-stat">${sum.size} ${sum.kind === "array" ? "items" : sum.kind === "object" ? "keys" : ""}</span>
          <span class="jl-dot"></span>
          <span class="jl-stat">${sizeLabel}</span>
        </div>
        <div class="jl-actions">
          <button class="jl-btn" data-action="copy" title="Copy JSON" aria-label="Copy JSON">${ICONS.copy}<span>Copy</span></button>
          <button class="jl-btn" data-action="download" title="Download JSON" aria-label="Download JSON">${ICONS.download}<span>Save</span></button>
          <button class="jl-btn jl-btn-ghost" data-action="raw" title="Toggle raw view" aria-label="Toggle raw view">${ICONS.raw}<span>Raw</span></button>
        </div>
      </header>
      <main class="jl-viewport">
        <pre class="jl-doc"><code id="jl-code"></code></pre>
      </main>
    `;

    const code = root.querySelector("#jl-code");
    code.innerHTML = renderValue(parsed, 0, false);

    // actions
    root.querySelector('[data-action="copy"]').addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(parsed, null, 2));
        flash(root, "Copied");
      } catch {
        flash(root, "Copy failed");
      }
    });
    root.querySelector('[data-action="download"]').addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(parsed, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const name = (location.pathname.split("/").pop() || "document").replace(/\.json$/i, "") || "document";
      a.download = `${name}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    root.querySelector('[data-action="raw"]').addEventListener("click", () => {
      root.classList.toggle("jl-raw-mode");
      const code = root.querySelector("#jl-code");
      if (root.classList.contains("jl-raw-mode")) {
        code.textContent = rawText;
      } else {
        code.innerHTML = renderValue(parsed, 0, false);
      }
    });

    return root;
  }

  function flash(root, text) {
    let t = root.querySelector(".jl-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "jl-toast";
      root.appendChild(t);
    }
    t.textContent = text;
    t.classList.add("jl-toast-show");
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => t.classList.remove("jl-toast-show"), 1400);
  }

  function replaceView(pre) {
    const rawText = pre.textContent || "";
    const parsed = tryParse(rawText);
    if (!parsed.ok) return false;

    STATE.parsed = parsed.value;
    STATE.rawText = rawText;
    STATE.bytes = rawText.length;

    injectStylesheet();
    const shell = buildShell(parsed.value, rawText);

    // Stash original pre for raw fallback in DOM, but hidden.
    pre.style.display = "none";
    pre.setAttribute("data-jl-original", "true");

    document.body.appendChild(shell);
    document.documentElement.setAttribute("data-json-lens", "active");
    STATE.replaced = true;
    return true;
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
      const pre = rawPreCandidate();
      if (!pre) return;
      STATE.detected = true;
      document.documentElement.setAttribute("data-json-lens", "candidate");
      // Defer replacement to next tick so we don't fight Chrome's
      // initial layout of the raw view.
      requestAnimationFrame(() => {
        try {
          replaceView(pre);
        } catch (err) {
          console.debug("[json-lens] replace error", err);
        }
      });
    } catch (err) {
      console.debug("[json-lens] detection error", err);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "json-lens:ping") {
      sendResponse({
        ok: true,
        detected: STATE.detected,
        replaced: STATE.replaced,
        url: STATE.url,
        version: ns.version,
      });
      return true;
    }
  });
})();
