// JSON Lens — content script
// Auto-detects raw JSON responses and replaces Chrome's plain <pre>
// view with a liquid-glass JSON Lens shell. Renders a collapsible
// tree with type badges. Raw view remains available via toggle.
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

  // ---------- helpers ----------
  function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v; // object, string, number, boolean
  }

  function summarize(v) {
    const t = typeOf(v);
    if (t === "array") return { kind: "array", size: v.length };
    if (t === "object") return { kind: "object", size: Object.keys(v).length };
    return { kind: t, size: 0 };
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function previewPrimitive(v) {
    const t = typeOf(v);
    const span = document.createElement("span");
    if (t === "string") {
      span.className = "jl-str";
      const s = v.length > 120 ? v.slice(0, 117) + "…" : v;
      span.textContent = `"${s}"`;
    } else if (t === "number") {
      span.className = "jl-num";
      span.textContent = String(v);
    } else if (t === "boolean") {
      span.className = "jl-bool";
      span.textContent = String(v);
    } else if (t === "null") {
      span.className = "jl-null";
      span.textContent = "null";
    } else {
      span.textContent = String(v);
    }
    return span;
  }

  // ---------- icons ----------
  const ICONS = {
    lens: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>`,
    raw: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h9l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v6h6"/></svg>`,
    caret: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`,
    filter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12"/><path d="M18 6l-12 12"/></svg>`,
    expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a1 1 0 0 0-1 1v4"/><path d="M15 4h4a1 1 0 0 1 1 1v4"/><path d="M9 20H5a1 1 0 0 1-1-1v-4"/><path d="M15 20h4a1 1 0 0 0 1-1v-4"/></svg>`,
    collapse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4"/><path d="M20 9h-5V4"/><path d="M4 15h5v5"/><path d="M20 15h-5v5"/></svg>`,
  };

  // ---------- tree rendering ----------
  // Auto-collapse depth threshold for very large containers.
  const AUTO_COLLAPSE_DEPTH = 2;
  const AUTO_COLLAPSE_BIG = 50;

  // Safe-identifier check for path notation.
  const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
  function joinPath(parent, key) {
    if (parent === null) return "$";
    if (typeof key === "number") return `${parent}[${key}]`;
    if (IDENT_RE.test(key)) return `${parent}.${key}`;
    // bracket-quoted, escape backslash + quote
    const esc = String(key).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${parent}["${esc}"]`;
  }

  function buildNode(key, value, depth, isLast, parentPath) {
    const t = typeOf(v(value));
    const isContainer = t === "object" || t === "array";
    const pathStr = parentPath === undefined ? "$" : joinPath(parentPath, key);

    const node = document.createElement("div");
    node.className = "jl-node";
    node.setAttribute("data-type", t);
    node.setAttribute("data-path", pathStr);

    const row = document.createElement("div");
    row.className = "jl-row";
    row.setAttribute("role", "treeitem");

    // toggle (chevron) or spacer
    if (isContainer) {
      const tog = document.createElement("button");
      tog.className = "jl-toggle";
      tog.type = "button";
      tog.setAttribute("aria-expanded", "true");
      tog.setAttribute("aria-label", "Toggle");
      tog.innerHTML = ICONS.caret;
      row.appendChild(tog);
    } else {
      const sp = document.createElement("span");
      sp.className = "jl-toggle jl-toggle-leaf";
      sp.setAttribute("aria-hidden", "true");
      row.appendChild(sp);
    }

    // key label (if any)
    if (key !== null) {
      const keyEl = document.createElement("span");
      keyEl.className = "jl-key";
      // numeric array index vs object key
      if (typeof key === "number") {
        keyEl.classList.add("jl-key-index");
        keyEl.textContent = String(key);
      } else {
        keyEl.textContent = `"${key}"`;
      }
      row.appendChild(keyEl);

      const colon = document.createElement("span");
      colon.className = "jl-punc jl-colon";
      colon.textContent = ":";
      row.appendChild(colon);
    }

    // type badge
    const badge = document.createElement("span");
    badge.className = "jl-type";
    badge.setAttribute("data-type", t);
    badge.textContent = t;
    row.appendChild(badge);

    // value preview
    const preview = document.createElement("span");
    preview.className = "jl-preview";
    if (t === "array") {
      const n = value.length;
      preview.innerHTML = `<span class="jl-punc">[</span><span class="jl-count">${n} ${n === 1 ? "item" : "items"}</span><span class="jl-punc">]</span>`;
    } else if (t === "object") {
      const n = Object.keys(value).length;
      preview.innerHTML = `<span class="jl-punc">{</span><span class="jl-count">${n} ${n === 1 ? "key" : "keys"}</span><span class="jl-punc">}</span>`;
    } else {
      preview.appendChild(previewPrimitive(value));
    }
    row.appendChild(preview);

    if (!isLast && depth > 0) {
      const trailing = document.createElement("span");
      trailing.className = "jl-punc jl-trailing";
      trailing.textContent = ",";
      row.appendChild(trailing);
    }

    node.appendChild(row);

    // children container
    if (isContainer) {
      const children = document.createElement("div");
      children.className = "jl-children";
      children.setAttribute("role", "group");

      const entries = t === "array"
        ? value.map((it, i) => [i, it])
        : Object.entries(value);

      entries.forEach(([k, val], i) => {
        const last = i === entries.length - 1;
        const childKey = t === "array" ? Number(k) : k;
        children.appendChild(buildNode(childKey, val, depth + 1, last, pathStr));
      });
      node.appendChild(children);

      // auto-collapse heuristic: deep nodes or large containers
      const shouldCollapse =
        depth >= AUTO_COLLAPSE_DEPTH && entries.length > 0 &&
        (entries.length >= AUTO_COLLAPSE_BIG || depth >= AUTO_COLLAPSE_DEPTH + 1);
      if (shouldCollapse) {
        node.classList.add("jl-collapsed");
        row.querySelector(".jl-toggle").setAttribute("aria-expanded", "false");
      }
    }

    return node;
  }

  // wrapper to keep typeOf-on-value clean above; identity passthrough.
  function v(x) { return x; }

  function buildTree(root) {
    const tree = document.createElement("div");
    tree.className = "jl-tree";
    tree.setAttribute("role", "tree");
    tree.appendChild(buildNode(null, root, 0, true, undefined));
    return tree;
  }

  // ---------- filter ----------
  // Compiles a jq-style path pattern into a RegExp that matches the prefix
  // of a node's data-path string (which always starts with "$").
  // Supported syntax:
  //   .key          object child by identifier
  //   .*            any object child
  //   [N]           array index
  //   [] or [*]     any array element
  //   ..key         recursive descent to first occurrence of key
  //   chains, e.g. .items[].name, ..id, .users[0].email
  function compileFilter(input) {
    const raw = String(input || "").trim();
    if (!raw) return { empty: true };

    // Normalize: strip a leading "$", ensure first token starts cleanly.
    let s = raw;
    if (s.startsWith("$")) s = s.slice(1);
    if (s && s[0] !== "." && s[0] !== "[") s = "." + s;

    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "." && s[i + 1] === ".") {
        // ..ident  (recursive descent)
        i += 2;
        const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
        if (!m) return { error: "expected identifier after '..'" };
        tokens.push({ kind: "rdesc", name: m[0] });
        i += m[0].length;
      } else if (ch === ".") {
        i++;
        if (s[i] === "*") {
          tokens.push({ kind: "anykey" });
          i++;
        } else {
          const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
          if (!m) return { error: "expected identifier after '.'" };
          tokens.push({ kind: "key", name: m[0] });
          i += m[0].length;
        }
      } else if (ch === "[") {
        const end = s.indexOf("]", i);
        if (end < 0) return { error: "missing ']'" };
        const inner = s.slice(i + 1, end).trim();
        if (inner === "" || inner === "*") {
          tokens.push({ kind: "anyidx" });
        } else if (/^\d+$/.test(inner)) {
          tokens.push({ kind: "idx", value: inner });
        } else if (/^"[^"]*"$/.test(inner) || /^'[^']*'$/.test(inner)) {
          const key = inner.slice(1, -1);
          tokens.push({ kind: "qkey", name: key });
        } else {
          return { error: "bad bracket: " + inner };
        }
        i = end + 1;
      } else {
        return { error: "unexpected '" + ch + "'" };
      }
    }

    if (!tokens.length) return { empty: true };

    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // path segment patterns:
    //   identifier key     : \.<name>
    //   any object key     : \.[A-Za-z_$][\w$]*
    //   quoted key (any)   : (?:\.<name>|\["<escaped>"\])  (we render as bracket form to match safely)
    //   numeric index      : \[N\]
    //   any index          : \[\d+\]
    //   recursive descent  : (?:\.[A-Za-z_$][\w$]*|\[\d+\]|\["[^"]*"\])*\.<name>
    let body = "^\\$";
    for (const tk of tokens) {
      if (tk.kind === "key") {
        body += "\\." + esc(tk.name) + "(?![\\w$])";
      } else if (tk.kind === "anykey") {
        body += "\\.[A-Za-z_$][\\w$]*";
      } else if (tk.kind === "qkey") {
        // match either dot-form (if identifier-safe) or bracket-quoted form
        if (IDENT_RE.test(tk.name)) {
          body += "(?:\\." + esc(tk.name) + "(?![\\w$])|\\[\"" + esc(tk.name) + "\"\\])";
        } else {
          body += "\\[\"" + esc(tk.name) + "\"\\]";
        }
      } else if (tk.kind === "idx") {
        body += "\\[" + tk.value + "\\]";
      } else if (tk.kind === "anyidx") {
        body += "\\[\\d+\\]";
      } else if (tk.kind === "rdesc") {
        body += "(?:\\.[A-Za-z_$][\\w$]*|\\[\\d+\\]|\\[\"[^\"]*\"\\])*\\." + esc(tk.name) + "(?![\\w$])";
      }
    }
    try {
      return { regex: new RegExp(body) };
    } catch (err) {
      return { error: "invalid pattern" };
    }
  }

  function clearFilterClasses(tree) {
    tree.classList.remove("jl-filtering");
    tree.querySelectorAll(".jl-filter-hide,.jl-match,.jl-match-ancestor").forEach((el) => {
      el.classList.remove("jl-filter-hide", "jl-match", "jl-match-ancestor");
    });
  }

  function applyFilter(tree, pattern) {
    const result = compileFilter(pattern);
    if (result.empty) {
      clearFilterClasses(tree);
      return { matches: 0, empty: true };
    }
    if (result.error) {
      clearFilterClasses(tree);
      tree.classList.add("jl-filtering");
      return { matches: 0, error: result.error };
    }
    const rx = result.regex;
    const allNodes = tree.querySelectorAll(".jl-node");
    const matchSet = new Set();
    const keepSet = new Set();
    allNodes.forEach((n) => {
      const p = n.getAttribute("data-path");
      if (p && rx.test(p)) {
        matchSet.add(n);
        keepSet.add(n);
        // descendants visible too
        n.querySelectorAll(".jl-node").forEach((d) => keepSet.add(d));
        // ancestors visible (and auto-expanded)
        let cur = n.parentElement;
        while (cur && cur !== tree) {
          if (cur.classList && cur.classList.contains("jl-node")) {
            keepSet.add(cur);
            if (cur.classList.contains("jl-collapsed")) setCollapsed(cur, false);
          }
          cur = cur.parentElement;
        }
      }
    });

    tree.classList.add("jl-filtering");
    allNodes.forEach((n) => {
      n.classList.toggle("jl-filter-hide", !keepSet.has(n));
      n.classList.toggle("jl-match", matchSet.has(n));
      n.classList.toggle("jl-match-ancestor", keepSet.has(n) && !matchSet.has(n));
    });
    return { matches: matchSet.size };
  }

  // setCollapsed(node, true) collapses; setCollapsed(node) toggles.
  function setCollapsed(node, collapsed) {
    const isCollapsed = node.classList.contains("jl-collapsed");
    const next = typeof collapsed === "boolean" ? collapsed : !isCollapsed;
    node.classList.toggle("jl-collapsed", next);
    const tog = node.querySelector(":scope > .jl-row > .jl-toggle");
    if (tog) tog.setAttribute("aria-expanded", String(!next));
  }

  function setAllCollapsed(treeRoot, collapsed) {
    const nodes = treeRoot.querySelectorAll(".jl-node[data-type='object'], .jl-node[data-type='array']");
    nodes.forEach((n) => setCollapsed(n, collapsed));
  }

  // ---------- view ----------
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
        <div class="jl-chrome-top">
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
            <button class="jl-btn jl-btn-ghost" data-action="expand" title="Expand all" aria-label="Expand all">${ICONS.expand}</button>
            <button class="jl-btn jl-btn-ghost" data-action="collapse" title="Collapse all" aria-label="Collapse all">${ICONS.collapse}</button>
            <button class="jl-btn" data-action="copy" title="Copy JSON" aria-label="Copy JSON">${ICONS.copy}<span>Copy</span></button>
            <button class="jl-btn" data-action="download" title="Download JSON" aria-label="Download JSON">${ICONS.download}<span>Save</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="raw" title="Toggle raw view" aria-label="Toggle raw view">${ICONS.raw}<span>Raw</span></button>
          </div>
        </div>
        <div class="jl-chrome-filter" role="search">
          <span class="jl-filter-icon" aria-hidden="true">${ICONS.filter}</span>
          <input class="jl-filter-input" type="text" spellcheck="false" autocomplete="off"
                 placeholder="Filter by path — .items[].name, ..id, .users[0]"
                 aria-label="Filter by jq-style path" />
          <span class="jl-filter-status" aria-live="polite"></span>
          <button class="jl-filter-clear" type="button" title="Clear filter" aria-label="Clear filter" hidden>${ICONS.close}</button>
        </div>
      </header>
      <main class="jl-viewport">
        <div class="jl-tree-host"></div>
        <pre class="jl-raw" hidden><code></code></pre>
      </main>
    `;

    const treeHost = root.querySelector(".jl-tree-host");
    const tree = buildTree(parsed);
    treeHost.appendChild(tree);

    // tree click delegation
    tree.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const tog = target.closest(".jl-toggle");
      if (tog && !tog.classList.contains("jl-toggle-leaf")) {
        const node = tog.closest(".jl-node");
        if (node) setCollapsed(node);
        ev.stopPropagation();
        return;
      }
      // alt-click on a container row toggles too
      const row = target.closest(".jl-row");
      if (row && (ev.altKey || ev.metaKey)) {
        const node = row.closest(".jl-node");
        if (node && node.querySelector(":scope > .jl-children")) setCollapsed(node);
      }
    });

    // keyboard: enter/space on toggle
    tree.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const target = ev.target;
      if (target instanceof Element && target.classList.contains("jl-toggle") && !target.classList.contains("jl-toggle-leaf")) {
        const node = target.closest(".jl-node");
        if (node) {
          setCollapsed(node);
          ev.preventDefault();
        }
      }
    });

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
    root.querySelector('[data-action="expand"]').addEventListener("click", () => {
      setAllCollapsed(tree, false);
      flash(root, "Expanded");
    });
    root.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      setAllCollapsed(tree, true);
      flash(root, "Collapsed");
    });
    // ---------- filter wiring ----------
    const filterInput = root.querySelector(".jl-filter-input");
    const filterStatus = root.querySelector(".jl-filter-status");
    const filterClear = root.querySelector(".jl-filter-clear");
    const filterRow = root.querySelector(".jl-chrome-filter");

    let filterTimer = 0;
    const runFilter = (value) => {
      const has = value.trim().length > 0;
      filterClear.hidden = !has;
      filterRow.classList.toggle("jl-filter-active", has);
      filterRow.classList.remove("jl-filter-error");
      if (!has) {
        clearFilterClasses(tree);
        filterStatus.textContent = "";
        return;
      }
      const res = applyFilter(tree, value);
      if (res.error) {
        filterRow.classList.add("jl-filter-error");
        filterStatus.textContent = res.error;
        return;
      }
      filterStatus.textContent = res.matches === 0
        ? "no matches"
        : `${res.matches} ${res.matches === 1 ? "match" : "matches"}`;
    };

    filterInput.addEventListener("input", () => {
      const val = filterInput.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => runFilter(val), 90);
    });
    filterInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        filterInput.value = "";
        runFilter("");
        ev.preventDefault();
      }
    });
    filterClear.addEventListener("click", () => {
      filterInput.value = "";
      runFilter("");
      filterInput.focus();
    });
    // Slash to focus filter, like Linear/GitHub.
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "/" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const target = ev.target;
        const tag = target && target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || (target && target.isContentEditable)) return;
        filterInput.focus();
        filterInput.select();
        ev.preventDefault();
      }
    });

    root.querySelector('[data-action="raw"]').addEventListener("click", () => {
      const inRaw = root.classList.toggle("jl-raw-mode");
      const rawEl = root.querySelector(".jl-raw");
      const host = root.querySelector(".jl-tree-host");
      if (inRaw) {
        rawEl.querySelector("code").textContent = rawText;
        rawEl.hidden = false;
        host.hidden = true;
      } else {
        rawEl.hidden = true;
        host.hidden = false;
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
