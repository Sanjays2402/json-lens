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

  // ---------- diff ----------
  // JSON Patch (RFC 6902-ish) computed structurally. Order-preserving for arrays
  // by index. Used both to summarize and to render side-by-side overlays.
  function computeDiff(a, b, prefix) {
    const ops = [];
    const path = prefix || "";
    const ta = typeOf(a);
    const tb = typeOf(b);
    if (ta !== tb) {
      ops.push({ op: "replace", path: path || "/", from: a, to: b });
      return ops;
    }
    if (ta === "object") {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        const sub = path + "/" + escapeJsonPointer(k);
        const inA = Object.prototype.hasOwnProperty.call(a, k);
        const inB = Object.prototype.hasOwnProperty.call(b, k);
        if (inA && !inB) ops.push({ op: "remove", path: sub, from: a[k] });
        else if (!inA && inB) ops.push({ op: "add", path: sub, to: b[k] });
        else ops.push(...computeDiff(a[k], b[k], sub));
      }
      return ops;
    }
    if (ta === "array") {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        const sub = path + "/" + i;
        if (i >= a.length) ops.push({ op: "add", path: sub, to: b[i] });
        else if (i >= b.length) ops.push({ op: "remove", path: sub, from: a[i] });
        else ops.push(...computeDiff(a[i], b[i], sub));
      }
      return ops;
    }
    // primitives
    if (!Object.is(a, b)) ops.push({ op: "replace", path: path || "/", from: a, to: b });
    return ops;
  }
  function escapeJsonPointer(s) {
    return String(s).replace(/~/g, "~0").replace(/\//g, "~1");
  }

  // Render a JSON tree where lines are colorized based on op map.
  // status: "add" only present on B side, "remove" only on A, "replace" on both,
  // "context" otherwise. Container paths get "changed" if any descendant changed.
  function renderDiffPane(host, value, ops, side) {
    host.innerHTML = "";
    const opByPath = new Map();
    const changedAncestor = new Set();
    for (const o of ops) {
      opByPath.set(o.path, o.op);
      let p = o.path;
      while (p && p.lastIndexOf("/") > 0) {
        p = p.slice(0, p.lastIndexOf("/"));
        changedAncestor.add(p);
      }
      if (o.path !== "/") changedAncestor.add("");
    }
    const root = renderDiffNode("", value, opByPath, changedAncestor, side, true, null);
    if (root) host.appendChild(root);
  }

  function renderDiffNode(path, value, opByPath, changedAncestor, side, isRoot, key) {
    const op = opByPath.get(path);
    // On A side, hide pure adds (only exist on B); on B side, hide pure removes.
    if (op === "add" && side === "a") return placeholderDiffLine(key, isRoot);
    if (op === "remove" && side === "b") return placeholderDiffLine(key, isRoot);
    const t = typeOf(value);
    const wrap = document.createElement("div");
    wrap.className = "jl-diff-node";
    if (op) wrap.classList.add(`jl-diff-${op}`);
    else if (changedAncestor.has(path)) wrap.classList.add("jl-diff-changed");
    else wrap.classList.add("jl-diff-context");
    wrap.setAttribute("data-path", path || "/");

    const line = document.createElement("div");
    line.className = "jl-diff-line";
    if (key !== null) {
      const k = document.createElement("span");
      k.className = "jl-diff-key";
      k.textContent = JSON.stringify(key) + ": ";
      line.appendChild(k);
    }
    if (t === "object" || t === "array") {
      const open = document.createElement("span");
      open.className = "jl-diff-punc";
      open.textContent = t === "array" ? "[" : "{";
      line.appendChild(open);
      const count = t === "array" ? value.length : Object.keys(value).length;
      const meta = document.createElement("span");
      meta.className = "jl-diff-meta";
      meta.textContent = ` ${count} ${t === "array" ? "item" : "key"}${count === 1 ? "" : "s"} `;
      line.appendChild(meta);
      wrap.appendChild(line);
      const body = document.createElement("div");
      body.className = "jl-diff-children";
      const entries = t === "array"
        ? value.map((v, i) => [i, v])
        : Object.keys(value).map((k) => [k, value[k]]);
      for (const [k, v] of entries) {
        const sub = path + "/" + (t === "array" ? k : escapeJsonPointer(k));
        const child = renderDiffNode(sub, v, opByPath, changedAncestor, side, false, k);
        if (child) body.appendChild(child);
      }
      // Also surface adds/removes that only exist on the opposite side as ghost lines
      for (const [opPath, opKind] of opByPath) {
        if (!opPath.startsWith(path + "/")) continue;
        const rest = opPath.slice(path.length + 1);
        if (rest.includes("/")) continue;
        if (opKind === "add" && side === "a") body.appendChild(ghostLine(rest, "add"));
        if (opKind === "remove" && side === "b") body.appendChild(ghostLine(rest, "remove"));
      }
      wrap.appendChild(body);
      const close = document.createElement("div");
      close.className = "jl-diff-line jl-diff-close-line";
      const closeSpan = document.createElement("span");
      closeSpan.className = "jl-diff-punc";
      closeSpan.textContent = t === "array" ? "]" : "}";
      close.appendChild(closeSpan);
      wrap.appendChild(close);
    } else {
      const val = document.createElement("span");
      val.className = "jl-diff-val jl-diff-val-" + t;
      val.textContent = formatPrimitive(value);
      line.appendChild(val);
      wrap.appendChild(line);
    }
    return wrap;
  }
  function placeholderDiffLine(key, isRoot) {
    const wrap = document.createElement("div");
    wrap.className = "jl-diff-node jl-diff-absent";
    const line = document.createElement("div");
    line.className = "jl-diff-line";
    line.textContent = isRoot ? "—" : (key !== null ? `${JSON.stringify(key)}: —` : "—");
    wrap.appendChild(line);
    return wrap;
  }
  function ghostLine(key, kind) {
    const wrap = document.createElement("div");
    wrap.className = `jl-diff-node jl-diff-${kind} jl-diff-ghost`;
    const line = document.createElement("div");
    line.className = "jl-diff-line";
    line.textContent = `${JSON.stringify(decodeURIComponent(key.replace(/~1/g, "/").replace(/~0/g, "~")))}: …`;
    wrap.appendChild(line);
    return wrap;
  }
  function formatPrimitive(v) {
    const t = typeOf(v);
    if (t === "string") return JSON.stringify(v);
    if (t === "null") return "null";
    return String(v);
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
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/></svg>`,
    arrowUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6"/><path d="M6 12l6-6 6 6"/></svg>`,
    arrowDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v13"/><path d="M6 12l6 6 6-6"/></svg>`,
    expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a1 1 0 0 0-1 1v4"/><path d="M15 4h4a1 1 0 0 1 1 1v4"/><path d="M9 20H5a1 1 0 0 1-1-1v-4"/><path d="M15 20h4a1 1 0 0 0 1-1v-4"/></svg>`,
    collapse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4"/><path d="M20 9h-5V4"/><path d="M4 15h5v5"/><path d="M20 15h-5v5"/></svg>`,
    schema: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="7" height="6" rx="1.5"/><rect x="13.5" y="4" width="7" height="6" rx="1.5"/><rect x="3.5" y="14" width="7" height="6" rx="1.5"/><rect x="13.5" y="14" width="7" height="6" rx="1.5"/></svg>`,
    braces: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4c-2 0-3 1-3 3v3c0 1.5-1 2-2 2 1 0 2 .5 2 2v3c0 2 1 3 3 3"/><path d="M15 4c2 0 3 1 3 3v3c0 1.5 1 2 2 2-1 0-2 .5-2 2v3c0 2-1 3-3 3"/></svg>`,
    jsonSchema: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h9l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M15 4v5h5"/><path d="M10 13c-1 0-1.5.5-1.5 1.5S9 16 10 16M14 13c1 0 1.5.5 1.5 1.5S15 16 14 16"/></svg>`,
    minify: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14"/><path d="M7 12h10"/><path d="M9 16h6"/></svg>`,
    pretty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h6"/><path d="M4 10h10"/><path d="M4 14h8"/><path d="M4 18h12"/></svg>`,
    diff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v14"/><path d="M5 6l3-3 3 3"/><path d="M16 21V7"/><path d="M19 18l-3 3-3-3"/></svg>`,
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7"/><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9"/></svg>`,
    crumbSep: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6l6 6-6 6"/></svg>`,
    command: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></svg>`,
    sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8L16.5 18.5l1.8-.7z"/></svg>`,
    enterKey: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5a3 3 0 0 1-3 3H6"/><path d="M10 11l-4 4 4 4"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`,
    auto: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" opacity="0.5"/></svg>`,
  };

  // ---------- theme ----------
  const THEME_KEY = "json-lens:theme";
  const THEME_MODES = ["auto", "light", "dark"];
  let _themeMql = null;
  function readThemePref() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return THEME_MODES.includes(v) ? v : "auto";
    } catch { return "auto"; }
  }
  function resolvedTheme(pref) {
    if (pref === "light" || pref === "dark") return pref;
    try {
      if (!_themeMql) _themeMql = window.matchMedia("(prefers-color-scheme: light)");
      return _themeMql.matches ? "light" : "dark";
    } catch { return "dark"; }
  }
  function applyTheme(pref) {
    const resolved = resolvedTheme(pref);
    const html = document.documentElement;
    if (resolved === "light") html.setAttribute("data-jl-theme", "light");
    else html.removeAttribute("data-jl-theme");
  }
  function setThemePref(pref) {
    if (!THEME_MODES.includes(pref)) pref = "auto";
    try { localStorage.setItem(THEME_KEY, pref); } catch {}
    applyTheme(pref);
    // sync any switch UI in DOM
    document.querySelectorAll("#json-lens-root .jl-theme-switch button").forEach((b) => {
      b.setAttribute("aria-pressed", b.dataset.theme === pref ? "true" : "false");
    });
  }
  function bindThemeAutoListener() {
    if (!_themeMql) {
      try { _themeMql = window.matchMedia("(prefers-color-scheme: light)"); } catch { return; }
    }
    const onChange = () => {
      if (readThemePref() === "auto") applyTheme("auto");
    };
    if (_themeMql.addEventListener) _themeMql.addEventListener("change", onChange);
    else if (_themeMql.addListener) _themeMql.addListener(onChange);
  }

  // ---------- TypeScript interface generation ----------
  // Recursively walks a value and produces a deterministic TS source string.
  // Object shapes are merged across array elements so unions/optionals
  // emerge correctly. Identifier-safe keys stay bare, others are quoted.
  const TS_INDENT = "  ";
  const TS_ARRAY_SAMPLE = 500;

  function isIdentKey(k) {
    return /^[A-Za-z_$][\w$]*$/.test(String(k));
  }

  function tsNameFromKey(key, fallback) {
    if (key === null || key === undefined) return fallback || "Root";
    if (typeof key === "number") return "Item";
    const cleaned = String(key).replace(/[^A-Za-z0-9_$]+/g, "_");
    const trimmed = cleaned.replace(/^[^A-Za-z_$]+/, "").replace(/_+$/, "");
    const head = trimmed || "Node";
    return head.charAt(0).toUpperCase() + head.slice(1);
  }

  function shapeOf(obj) {
    const keys = Object.create(null);
    for (const k of Object.keys(obj)) keys[k] = { count: 1, samples: [obj[k]] };
    return { count: 1, keys };
  }

  function mergeShape(a, b) {
    a.count += b.count;
    for (const k of Object.keys(b.keys)) {
      if (a.keys[k]) {
        a.keys[k].count += b.keys[k].count;
        for (const s of b.keys[k].samples) a.keys[k].samples.push(s);
      } else {
        a.keys[k] = { count: b.keys[k].count, samples: b.keys[k].samples.slice() };
      }
    }
    return a;
  }

  function tsRenderShape(shape, indent) {
    const pad = TS_INDENT.repeat(indent + 1);
    const close = TS_INDENT.repeat(indent);
    const keys = Object.keys(shape.keys);
    if (!keys.length) return "{}";
    const lines = ["{"];
    for (const k of keys) {
      const info = shape.keys[k];
      const optional = info.count < shape.count;
      const keyTok = isIdentKey(k) ? k : JSON.stringify(k);
      const type = tsUnionFromSamples(info.samples, indent + 1);
      lines.push(`${pad}${keyTok}${optional ? "?" : ""}: ${type};`);
    }
    lines.push(`${close}}`);
    return lines.join("\n");
  }

  function tsUnionFromSamples(samples, indent) {
    const prims = new Set();
    let shape = null;
    let arrItems = null; // accumulated array element samples
    let sawEmptyArray = false;
    for (const s of samples) {
      const t = typeOf(s);
      if (t === "null") prims.add("null");
      else if (t === "string") prims.add("string");
      else if (t === "number") prims.add("number");
      else if (t === "boolean") prims.add("boolean");
      else if (t === "object") {
        const sh = shapeOf(s);
        shape = shape ? mergeShape(shape, sh) : sh;
      } else if (t === "array") {
        if (s.length === 0) sawEmptyArray = true;
        else {
          if (!arrItems) arrItems = [];
          for (let i = 0; i < s.length && arrItems.length < TS_ARRAY_SAMPLE; i++) arrItems.push(s[i]);
        }
      }
    }
    const parts = [];
    if (shape) parts.push(tsRenderShape(shape, indent));
    if (arrItems) {
      const inner = tsUnionFromSamples(arrItems, indent);
      parts.push(inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`);
    } else if (sawEmptyArray) {
      parts.push("unknown[]");
    }
    for (const p of prims) parts.push(p);
    if (parts.length === 0) return "unknown";
    if (parts.length === 1) return parts[0];
    // Keep declarations on a single line for unions; objects in unions stay block-formatted.
    return parts.join(" | ");
  }

  function generateTSInterface(value, name) {
    const t = typeOf(value);
    const header = `// JSON Lens — generated TypeScript interface for ${name}`;
    if (t === "object") {
      const body = tsRenderShape(shapeOf(value), 0);
      return `${header}\nexport interface ${name} ${body}\n`;
    }
    if (t === "array") {
      if (value.length === 0) {
        return `${header}\nexport type ${name} = unknown[];\n`;
      }
      // If all elements are objects, emit a singular Item interface + alias.
      let allObj = true;
      for (const v of value) if (typeOf(v) !== "object") { allObj = false; break; }
      if (allObj) {
        let agg = null;
        const limit = Math.min(value.length, TS_ARRAY_SAMPLE);
        for (let i = 0; i < limit; i++) {
          const sh = shapeOf(value[i]);
          agg = agg ? mergeShape(agg, sh) : sh;
        }
        let itemName;
        if (/s$/i.test(name) && name.length > 2) itemName = name.replace(/s$/i, "");
        else itemName = name + "Item";
        if (itemName === name) itemName = name + "Item";
        const body = tsRenderShape(agg, 0);
        return `${header}\nexport interface ${itemName} ${body}\n\nexport type ${name} = ${itemName}[];\n`;
      }
      const elt = tsUnionFromSamples(value.slice(0, TS_ARRAY_SAMPLE), 0);
      const arr = elt.includes(" | ") ? `(${elt})[]` : `${elt}[]`;
      return `${header}\nexport type ${name} = ${arr};\n`;
    }
    // primitive root
    const lit = tsUnionFromSamples([value], 0);
    return `${header}\nexport type ${name} = ${lit};\n`;
  }

  // Expose for testing/debugging.
  ns.generateTSInterface = generateTSInterface;

  // ---------- JSON Schema generation ----------
  // Walks the value and emits a draft-07 JSON Schema. Arrays of objects
  // merge shape across elements so `required` reflects keys present in
  // every observed sample. Mixed type observations collapse to type arrays
  // for primitives and to `anyOf` when complex types mix with primitives.
  const SCHEMA_ARRAY_SAMPLE = 500;
  const SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";

  function jsonSchemaForShape(shape) {
    const props = {};
    const required = [];
    for (const k of Object.keys(shape.keys)) {
      const info = shape.keys[k];
      props[k] = jsonSchemaFromSamples(info.samples);
      if (info.count === shape.count) required.push(k);
    }
    const out = { type: "object", properties: props };
    if (required.length) out.required = required;
    return out;
  }

  function jsonSchemaFromSamples(samples) {
    const prims = new Set();
    let shape = null;
    let arrItems = null;
    let sawEmptyArray = false;
    for (const s of samples) {
      const t = typeOf(s);
      if (t === "null") prims.add("null");
      else if (t === "string") prims.add("string");
      else if (t === "number") prims.add(Number.isInteger(s) ? "integer" : "number");
      else if (t === "boolean") prims.add("boolean");
      else if (t === "object") {
        const sh = shapeOf(s);
        shape = shape ? mergeShape(shape, sh) : sh;
      } else if (t === "array") {
        if (s.length === 0) sawEmptyArray = true;
        else {
          if (!arrItems) arrItems = [];
          for (let i = 0; i < s.length && arrItems.length < SCHEMA_ARRAY_SAMPLE; i++) arrItems.push(s[i]);
        }
      }
    }
    // integer is a refinement of number — if both seen, widen to number.
    if (prims.has("integer") && prims.has("number")) prims.delete("integer");

    const branches = [];
    if (shape) branches.push(jsonSchemaForShape(shape));
    if (arrItems) branches.push({ type: "array", items: jsonSchemaFromSamples(arrItems) });
    else if (sawEmptyArray) branches.push({ type: "array" });
    if (prims.size) {
      const arr = [...prims].sort();
      branches.push({ type: arr.length === 1 ? arr[0] : arr });
    }
    if (branches.length === 0) return {};
    if (branches.length === 1) return branches[0];
    return { anyOf: branches };
  }

  function generateJSONSchema(value, title) {
    const body = jsonSchemaFromSamples([value]);
    const out = { $schema: SCHEMA_DRAFT };
    if (title) out.title = title;
    Object.assign(out, body);
    return out;
  }

  ns.generateJSONSchema = generateJSONSchema;

  // ---------- schema inference ----------
  // Walks the parsed value and produces a tree of nodes keyed by a
  // canonical "shape path" (arrays collapse to [] so siblings unify).
  // Each node tracks:
  //   types: Map<type, count>   distinct JSON types observed
  //   count: total occurrences across the dataset
  //   parentSize: total occurrences of the parent container (for coverage %)
  //   children: ordered Map of objectKey -> node
  //   items:   single node aggregating all array elements (when applicable)
  function emptyNode() {
    return {
      types: new Map(),
      count: 0,
      children: new Map(),
      items: null,
      itemsTotal: 0, // total array elements observed across all parent arrays
    };
  }

  function inferSchema(root) {
    const top = emptyNode();
    visitSchema(root, top);
    return top;
  }

  function visitSchema(value, node) {
    const t = typeOf(value);
    node.count += 1;
    node.types.set(t, (node.types.get(t) || 0) + 1);
    if (t === "object") {
      const keys = Object.keys(value);
      for (const k of keys) {
        let child = node.children.get(k);
        if (!child) {
          child = emptyNode();
          node.children.set(k, child);
        }
        visitSchema(value[k], child);
      }
    } else if (t === "array") {
      if (!node.items) node.items = emptyNode();
      node.itemsTotal += value.length;
      for (const item of value) visitSchema(item, node.items);
    }
  }

  function schemaTypeLabel(node) {
    // Stable order: object, array, string, number, boolean, null
    const order = ["object", "array", "string", "number", "boolean", "null"];
    const present = order.filter((t) => node.types.has(t));
    return present;
  }

  function fmtPct(num, denom) {
    if (!denom) return "";
    const p = (num / denom) * 100;
    if (p >= 99.95) return "100%";
    if (p >= 10) return `${p.toFixed(0)}%`;
    return `${p.toFixed(1)}%`;
  }

  function fmtNum(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  function buildSchemaTree(rootNode) {
    const wrap = document.createElement("div");
    wrap.className = "jl-schema-tree";
    wrap.setAttribute("role", "tree");
    wrap.appendChild(buildSchemaNode("$", rootNode, 0, true, 0, "root"));
    return wrap;
  }

  // parentCount: total occurrences of the parent (denom for coverage).
  // kind: "root" | "key" (object key) | "items" (array element node).
  function buildSchemaNode(label, node, depth, isRoot, parentCount, kind) {
    const el = document.createElement("div");
    el.className = "jl-schema-node";
    el.setAttribute("data-depth", String(depth));

    const row = document.createElement("div");
    row.className = "jl-schema-row";

    const hasChildren = node.children.size > 0 || node.items;
    if (hasChildren) {
      const tog = document.createElement("button");
      tog.className = "jl-schema-toggle";
      tog.type = "button";
      tog.setAttribute("aria-expanded", "true");
      tog.setAttribute("aria-label", "Toggle");
      tog.innerHTML = ICONS.caret;
      row.appendChild(tog);
    } else {
      const sp = document.createElement("span");
      sp.className = "jl-schema-toggle jl-schema-toggle-leaf";
      sp.setAttribute("aria-hidden", "true");
      row.appendChild(sp);
    }

    const keyEl = document.createElement("span");
    keyEl.className = "jl-schema-key";
    if (isRoot) keyEl.classList.add("jl-schema-root");
    keyEl.textContent = label;
    row.appendChild(keyEl);

    const types = schemaTypeLabel(node);
    const typeWrap = document.createElement("span");
    typeWrap.className = "jl-schema-types";
    types.forEach((t) => {
      const b = document.createElement("span");
      b.className = "jl-schema-badge";
      b.setAttribute("data-type", t);
      b.textContent = t;
      typeWrap.appendChild(b);
    });
    row.appendChild(typeWrap);

    // Coverage: present-in-parent ratio for object keys; element count for arrays.
    const meta = document.createElement("span");
    meta.className = "jl-schema-meta";
    const parts = [];
    if (kind === "key" && parentCount > 0) {
      const cov = fmtPct(node.count, parentCount);
      if (cov && cov !== "100%") parts.push(`${cov}`);
    }
    parts.push(`${fmtNum(node.count)}\u00d7`);
    meta.textContent = parts.join(" · ");
    row.appendChild(meta);

    el.appendChild(row);

    if (hasChildren) {
      const kids = document.createElement("div");
      kids.className = "jl-schema-children";
      if (node.items) {
        kids.appendChild(buildSchemaNode("[ ]", node.items, depth + 1, false, node.itemsTotal, "items"));
      }
      // Sort keys by coverage desc then name for stable, scannable order.
      const entries = Array.from(node.children.entries()).sort((a, b) => {
        const ca = a[1].count, cb = b[1].count;
        if (ca !== cb) return cb - ca;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
      const parentObjCount = node.types.get("object") || node.count;
      entries.forEach(([k, child]) => {
        kids.appendChild(buildSchemaNode(k, child, depth + 1, false, parentObjCount, "key"));
      });
      el.appendChild(kids);
      // Auto-collapse beyond depth 2 to keep panel digestible.
      if (depth >= 2) {
        el.classList.add("jl-schema-collapsed");
        row.querySelector(".jl-schema-toggle").setAttribute("aria-expanded", "false");
      }
    }

    return el;
  }

  function schemaSummary(rootNode) {
    let objects = 0;
    let arrays = 0;
    let leaves = 0;
    let keys = 0;
    const walk = (n) => {
      if (n.types.has("object")) objects += n.types.get("object");
      if (n.types.has("array")) arrays += n.types.get("array");
      for (const t of ["string", "number", "boolean", "null"]) {
        if (n.types.has(t)) leaves += n.types.get(t);
      }
      for (const child of n.children.values()) { keys++; walk(child); }
      if (n.items) walk(n.items);
    };
    walk(rootNode);
    return { objects, arrays, leaves, keys };
  }

  // ---------- tree rendering ----------
  // Auto-collapse depth threshold for very large containers.
  const AUTO_COLLAPSE_DEPTH = 2;
  const AUTO_COLLAPSE_BIG = 50;

  // ---------- performance mode ----------
  // For documents above this raw byte threshold the tree is materialized
  // lazily: only the root's direct children are built up-front; deeper
  // containers render their children the first time they are expanded.
  // This keeps initial paint cheap for multi-MB payloads where a full
  // recursive DOM build would otherwise stall the page.
  const PERF_BYTE_THRESHOLD = 10 * 1024 * 1024;
  let PERF_MODE = false;
  const LAZY_VALUES = new WeakMap();

  function materializeNode(node) {
    if (!node || node.getAttribute("data-lazy") !== "pending") return false;
    const info = LAZY_VALUES.get(node);
    if (!info) return false;
    const { value, pathStr, depth } = info;
    const children = node.querySelector(":scope > .jl-children");
    if (!children) return false;
    const t = typeOf(value);
    const entries = t === "array"
      ? value.map((it, i) => [i, it])
      : Object.entries(value);
    const frag = document.createDocumentFragment();
    entries.forEach(([k, val], i) => {
      const last = i === entries.length - 1;
      const childKey = t === "array" ? Number(k) : k;
      frag.appendChild(buildNode(childKey, val, depth + 1, last, pathStr, { lazy: PERF_MODE }));
    });
    children.appendChild(frag);
    node.setAttribute("data-lazy", "done");
    LAZY_VALUES.delete(node);
    return true;
  }

  function materializeAll(tree) {
    // Drain lazy queue. Newly-materialized nodes may expose more lazy
    // descendants, so loop until none remain.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pending = tree.querySelectorAll('.jl-node[data-lazy="pending"]');
      if (pending.length === 0) return;
      pending.forEach(materializeNode);
    }
  }

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

  function buildNode(key, value, depth, isLast, parentPath, opts) {
    const t = typeOf(v(value));
    const isContainer = t === "object" || t === "array";
    const pathStr = parentPath === undefined ? "$" : joinPath(parentPath, key);
    const lazy = !!(opts && opts.lazy);

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

    // Per-row actions (hover-revealed). Only useful on containers right now.
    if (isContainer) {
      const actions = document.createElement("span");
      actions.className = "jl-row-actions";
      const tsBtn = document.createElement("button");
      tsBtn.type = "button";
      tsBtn.className = "jl-row-action jl-row-action-ts";
      tsBtn.setAttribute("data-action", "copy-ts");
      tsBtn.setAttribute("title", "Copy as TypeScript interface");
      tsBtn.setAttribute("aria-label", "Copy as TypeScript interface");
      tsBtn.innerHTML = `${ICONS.braces}<span class="jl-row-action-label">TS</span>`;
      actions.appendChild(tsBtn);
      const jsBtn = document.createElement("button");
      jsBtn.type = "button";
      jsBtn.className = "jl-row-action jl-row-action-schema";
      jsBtn.setAttribute("data-action", "copy-jsonschema");
      jsBtn.setAttribute("title", "Copy as JSON Schema");
      jsBtn.setAttribute("aria-label", "Copy as JSON Schema");
      jsBtn.innerHTML = `${ICONS.jsonSchema}<span class="jl-row-action-label">Schema</span>`;
      actions.appendChild(jsBtn);
      row.appendChild(actions);
    }

    node.appendChild(row);

    // children container
    if (isContainer) {
      const children = document.createElement("div");
      children.className = "jl-children";
      children.setAttribute("role", "group");
      node.appendChild(children);

      const entries = t === "array"
        ? value.map((it, i) => [i, it])
        : Object.entries(value);

      if (lazy && entries.length > 0) {
        // Defer child construction until the first expand.
        node.setAttribute("data-lazy", "pending");
        node.classList.add("jl-lazy");
        LAZY_VALUES.set(node, { value, pathStr, depth });
        node.classList.add("jl-collapsed");
        row.querySelector(".jl-toggle").setAttribute("aria-expanded", "false");
      } else {
        entries.forEach(([k, val], i) => {
          const last = i === entries.length - 1;
          const childKey = t === "array" ? Number(k) : k;
          children.appendChild(buildNode(childKey, val, depth + 1, last, pathStr, { lazy: PERF_MODE }));
        });

        // auto-collapse heuristic: deep nodes or large containers
        const shouldCollapse =
          depth >= AUTO_COLLAPSE_DEPTH && entries.length > 0 &&
          (entries.length >= AUTO_COLLAPSE_BIG || depth >= AUTO_COLLAPSE_DEPTH + 1);
        if (shouldCollapse) {
          node.classList.add("jl-collapsed");
          row.querySelector(".jl-toggle").setAttribute("aria-expanded", "false");
        }
      }
    }

    return node;
  }

  // wrapper to keep typeOf-on-value clean above; identity passthrough.
  function v(x) { return x; }

  // Resolve a JSON Lens path string ("$", ".key", "[N]", '["key"]' segments) to a
  // value inside the parsed root. Returns { ok, value } or { ok: false }.
  const PATH_TOKEN_RE = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["((?:\\.|[^"\\])*)"\]/g;
  function resolvePath(root, pathStr) {
    if (!pathStr || pathStr === "$") return { ok: true, value: root };
    let cur = root;
    let i = 1; // skip the leading "$"
    PATH_TOKEN_RE.lastIndex = i;
    let m;
    let consumed = 1;
    while ((m = PATH_TOKEN_RE.exec(pathStr)) !== null) {
      if (m.index !== consumed) return { ok: false };
      if (cur === null || typeof cur !== "object") return { ok: false };
      if (m[1] !== undefined) {
        cur = cur[m[1]];
      } else if (m[2] !== undefined) {
        cur = cur[Number(m[2])];
      } else {
        const key = m[3].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
        cur = cur[key];
      }
      consumed = PATH_TOKEN_RE.lastIndex;
    }
    if (consumed !== pathStr.length) return { ok: false };
    return { ok: true, value: cur };
  }

  // Derive a PascalCase interface name from a path string + the value's shape.
  function tsNameForPath(pathStr, value) {
    if (!pathStr || pathStr === "$") return "Root";
    // last identifier segment, else "Item" for array elements
    let last = null;
    PATH_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = PATH_TOKEN_RE.exec(pathStr)) !== null) {
      if (m[1] !== undefined) last = m[1];
      else if (m[3] !== undefined) last = m[3];
      else last = null; // numeric index resets — element of an array
    }
    if (!last) return Array.isArray(value) ? "Items" : "Item";
    return tsNameFromKey(last);
  }

  function buildTree(root) {
    const tree = document.createElement("div");
    tree.className = "jl-tree";
    tree.setAttribute("role", "tree");
    if (PERF_MODE) tree.classList.add("jl-tree-perf");
    // Root itself is built eagerly so its direct children are visible on
    // first paint; perf mode then defers everything below that level.
    tree.appendChild(buildNode(null, root, 0, true, undefined, { lazy: false }));
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

  // ---------- search (keys + values) ----------
  const SEARCH_TARGETS = ".jl-key, .jl-key-index, .jl-str, .jl-num, .jl-bool, .jl-null";

  function escRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function clearSearch(tree) {
    tree.classList.remove("jl-searching");
    tree.querySelectorAll(SEARCH_TARGETS).forEach((el) => {
      if (el.dataset.jlOrig != null) {
        el.textContent = el.dataset.jlOrig;
      }
    });
  }

  function highlightInto(el, rx) {
    if (el.dataset.jlOrig == null) el.dataset.jlOrig = el.textContent || "";
    const text = el.dataset.jlOrig;
    rx.lastIndex = 0;
    let last = 0;
    let m;
    let hits = 0;
    const frag = document.createDocumentFragment();
    while ((m = rx.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.className = "jl-hit";
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
      hits++;
      if (m[0].length === 0) rx.lastIndex++; // guard against zero-width
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (hits > 0) {
      el.textContent = "";
      el.appendChild(frag);
    }
    return hits;
  }

  function applySearch(tree, query) {
    const q = String(query || "");
    if (!q) {
      clearSearch(tree);
      return { matches: [], empty: true };
    }
    // Search must consider the whole document, even nodes whose DOM has
    // not been materialized yet in perf mode.
    if (PERF_MODE) materializeAll(tree);
    const rx = new RegExp(escRegex(q), "gi");
    clearSearch(tree);
    tree.classList.add("jl-searching");
    const targets = tree.querySelectorAll(SEARCH_TARGETS);
    const matches = [];
    targets.forEach((el) => {
      const hits = highlightInto(el, rx);
      if (hits > 0) {
        el.querySelectorAll(":scope > mark.jl-hit").forEach((m) => matches.push(m));
      }
    });
    return { matches };
  }

  function expandAncestorsOf(el, treeRoot) {
    let cur = el.closest(".jl-node");
    while (cur && cur !== treeRoot) {
      if (cur.classList.contains("jl-collapsed")) setCollapsed(cur, false);
      const parent = cur.parentElement;
      cur = parent ? parent.closest(".jl-node") : null;
    }
  }

  // ---------- path filter ----------
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
    // Path filter operates on `data-path` attrs — materialize everything
    // in perf mode so deferred nodes participate.
    if (PERF_MODE) materializeAll(tree);
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
    // Expanding a lazy node materializes its children on first reveal.
    if (!next && node.getAttribute("data-lazy") === "pending") {
      materializeNode(node);
    }
    node.classList.toggle("jl-collapsed", next);
    const tog = node.querySelector(":scope > .jl-row > .jl-toggle");
    if (tog) tog.setAttribute("aria-expanded", String(!next));
  }

  function setAllCollapsed(treeRoot, collapsed) {
    // Expand-all in perf mode forces full materialization so every container
    // can be revealed; the user explicitly opted into the cost.
    if (collapsed === false) materializeAll(treeRoot);
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
            ${PERF_MODE ? `<span class="jl-dot"></span><span class="jl-badge jl-badge-perf" title="Large document — deeper nodes load on expand">perf</span>` : ""}
          </div>
          <div class="jl-actions">
            <button class="jl-btn jl-btn-ghost" data-action="expand" title="Expand all" aria-label="Expand all">${ICONS.expand}</button>
            <button class="jl-btn jl-btn-ghost" data-action="collapse" title="Collapse all" aria-label="Collapse all">${ICONS.collapse}</button>
            <button class="jl-btn jl-btn-ghost" data-action="format" title="Toggle pretty / minify" aria-label="Toggle pretty or minify" aria-pressed="false"><span class="jl-format-icon">${ICONS.pretty}</span><span class="jl-format-label">Pretty</span></button>
            <button class="jl-btn" data-action="copy" title="Copy JSON" aria-label="Copy JSON">${ICONS.copy}<span>Copy</span></button>
            <button class="jl-btn" data-action="download" title="Download JSON" aria-label="Download JSON">${ICONS.download}<span>Save</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="schema" title="Inferred schema" aria-label="Inferred schema" aria-pressed="false">${ICONS.schema}<span>Schema</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="diff" title="Diff against another JSON URL" aria-label="Diff against another JSON URL" aria-pressed="false">${ICONS.diff}<span>Diff</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="palette" title="Command palette (⌘⇧P)" aria-label="Command palette">${ICONS.command}<span>Actions</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="raw" title="Toggle raw view" aria-label="Toggle raw view">${ICONS.raw}<span>Raw</span></button>
            <div class="jl-theme-switch" role="group" aria-label="Theme">
              <button type="button" data-theme="auto" title="Auto theme" aria-label="Auto theme" aria-pressed="false">${ICONS.auto}</button>
              <button type="button" data-theme="light" title="Light theme" aria-label="Light theme" aria-pressed="false">${ICONS.sun}</button>
              <button type="button" data-theme="dark" title="Dark theme" aria-label="Dark theme" aria-pressed="false">${ICONS.moon}</button>
            </div>
          </div>
        </div>
        <div class="jl-chrome-filter" role="search">
          <span class="jl-filter-icon" aria-hidden="true">${ICONS.filter}</span>
          <input class="jl-filter-input" type="text" spellcheck="false" autocomplete="off"
                 placeholder="Filter by path — .items[].name, ..id, .users[0]"
                 aria-label="Filter by jq-style path" />
          <span class="jl-filter-status" aria-live="polite"></span>
          <div class="jl-filter-export" role="group" aria-label="Export filtered subtree" hidden>
            <button class="jl-btn jl-btn-ghost jl-filter-copy" type="button" title="Copy filtered subtree" aria-label="Copy filtered subtree">${ICONS.copy}<span>Copy</span></button>
            <button class="jl-btn jl-btn-ghost jl-filter-save" type="button" title="Download filtered subtree" aria-label="Download filtered subtree">${ICONS.download}<span>Save</span></button>
          </div>
          <button class="jl-filter-clear" type="button" title="Clear filter" aria-label="Clear filter" hidden>${ICONS.close}</button>
        </div>
        <div class="jl-chrome-search" role="search">
          <span class="jl-search-icon" aria-hidden="true">${ICONS.search}</span>
          <input class="jl-search-input" type="text" spellcheck="false" autocomplete="off"
                 placeholder="Search keys & values — ⌘K"
                 aria-label="Search keys and values" />
          <span class="jl-search-status" aria-live="polite"></span>
          <div class="jl-search-nav" role="group" aria-label="Search navigation">
            <button class="jl-search-prev" type="button" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled>${ICONS.arrowUp}</button>
            <button class="jl-search-next" type="button" title="Next match (Enter)" aria-label="Next match" disabled>${ICONS.arrowDown}</button>
          </div>
          <button class="jl-search-clear" type="button" title="Clear search (Esc)" aria-label="Clear search" hidden>${ICONS.close}</button>
        </div>
      </header>
      <main class="jl-viewport">
        <div class="jl-tree-host"></div>
        <pre class="jl-raw" hidden><code></code></pre>
        <aside class="jl-schema-panel" hidden aria-label="Inferred schema">
          <div class="jl-schema-header">
            <div class="jl-schema-title">
              <span class="jl-schema-icon" aria-hidden="true">${ICONS.schema}</span>
              <span>Inferred schema</span>
            </div>
            <div class="jl-schema-summary" aria-live="polite"></div>
            <div class="jl-schema-tools">
              <button class="jl-btn jl-btn-ghost jl-schema-copy" type="button" title="Copy schema as JSON" aria-label="Copy schema as JSON">${ICONS.copy}<span>Copy</span></button>
              <button class="jl-btn jl-btn-ghost jl-schema-close" type="button" title="Close schema" aria-label="Close schema">${ICONS.close}</button>
            </div>
          </div>
          <div class="jl-schema-body"></div>
        </aside>
        <section class="jl-diff-panel" hidden aria-label="JSON diff">
          <div class="jl-diff-header">
            <div class="jl-diff-title">
              <span class="jl-diff-icon" aria-hidden="true">${ICONS.diff}</span>
              <span>Diff against another JSON URL</span>
            </div>
            <div class="jl-diff-summary" aria-live="polite"></div>
            <div class="jl-diff-tools">
              <button class="jl-btn jl-btn-ghost jl-diff-swap" type="button" title="Swap A and B" aria-label="Swap A and B">${ICONS.diff}<span>Swap</span></button>
              <button class="jl-btn jl-btn-ghost jl-diff-copy" type="button" title="Copy diff as JSON Patch" aria-label="Copy diff as JSON Patch">${ICONS.copy}<span>Patch</span></button>
              <button class="jl-btn jl-btn-ghost jl-diff-close" type="button" title="Close diff" aria-label="Close diff">${ICONS.close}</button>
            </div>
          </div>
          <form class="jl-diff-form" autocomplete="off">
            <label class="jl-diff-field">
              <span class="jl-diff-label">A</span>
              <input class="jl-diff-input-a" type="text" spellcheck="false" placeholder="Current page URL" />
            </label>
            <label class="jl-diff-field">
              <span class="jl-diff-label">B</span>
              <input class="jl-diff-input-b" type="text" spellcheck="false" placeholder="https://example.com/other.json" />
            </label>
            <button class="jl-btn jl-diff-run" type="submit">${ICONS.diff}<span>Run diff</span></button>
          </form>
          <div class="jl-diff-status" aria-live="polite"></div>
          <div class="jl-diff-body">
            <div class="jl-diff-pane jl-diff-pane-a">
              <div class="jl-diff-pane-header"><span class="jl-diff-tag" data-side="a">A</span><span class="jl-diff-pane-meta"></span></div>
              <div class="jl-diff-pane-body"></div>
            </div>
            <div class="jl-diff-pane jl-diff-pane-b">
              <div class="jl-diff-pane-header"><span class="jl-diff-tag" data-side="b">B</span><span class="jl-diff-pane-meta"></span></div>
              <div class="jl-diff-pane-body"></div>
            </div>
          </div>
        </section>
        <div class="jl-breadcrumb" hidden role="status" aria-label="JSON path of hovered node">
          <div class="jl-crumbs" role="list"></div>
          <button class="jl-crumb-copy" type="button" title="Copy path" aria-label="Copy path">${ICONS.copy}</button>
        </div>
        <div class="jl-palette-backdrop" hidden aria-hidden="true"></div>
        <div class="jl-palette" hidden role="dialog" aria-modal="true" aria-label="Command palette">
          <div class="jl-palette-search">
            <span class="jl-palette-search-icon" aria-hidden="true">${ICONS.sparkle}</span>
            <input class="jl-palette-input" type="text" spellcheck="false" autocomplete="off" placeholder="Run a command — type to filter" aria-label="Command palette" />
            <kbd class="jl-palette-kbd">esc</kbd>
          </div>
          <div class="jl-palette-list" role="listbox" aria-label="Available commands"></div>
          <div class="jl-palette-empty" hidden>
            <span class="jl-palette-empty-icon" aria-hidden="true">${ICONS.sparkle}</span>
            <span>No matching commands</span>
          </div>
          <div class="jl-palette-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> run</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        </div>
      </main>
    `;

    const treeHost = root.querySelector(".jl-tree-host");
    const tree = buildTree(parsed);
    treeHost.appendChild(tree);

    // tree click delegation
    tree.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const actionBtn = target.closest(".jl-row-action");
      if (actionBtn) {
        ev.stopPropagation();
        const action = actionBtn.getAttribute("data-action");
        const node = actionBtn.closest(".jl-node");
        if (!node) return;
        const pathStr = node.getAttribute("data-path") || "$";
        if (action === "copy-ts") {
          const resolved = resolvePath(parsed, pathStr);
          if (!resolved.ok) { flash(root, "Copy failed"); return; }
          const name = tsNameForPath(pathStr, resolved.value);
          const src = generateTSInterface(resolved.value, name);
          (async () => {
            try {
              await navigator.clipboard.writeText(src);
              flash(root, `Copied ${name} as TS`);
            } catch {
              flash(root, "Copy failed");
            }
          })();
        } else if (action === "copy-jsonschema") {
          const resolved = resolvePath(parsed, pathStr);
          if (!resolved.ok) { flash(root, "Copy failed"); return; }
          const name = tsNameForPath(pathStr, resolved.value);
          const schema = generateJSONSchema(resolved.value, name);
          const src = JSON.stringify(schema, null, 2) + "\n";
          (async () => {
            try {
              await navigator.clipboard.writeText(src);
              flash(root, `Copied ${name} as JSON Schema`);
            } catch {
              flash(root, "Copy failed");
            }
          })();
        }
        return;
      }
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
    // ---------- pretty / minify toggle ----------
    // `compact === false` => pretty-printed with 2-space indent (default).
    // `compact === true`  => single-line minified output.
    // Affects: raw view, Copy, Download. Tree view is unaffected.
    let compact = false;
    const serialize = () => compact ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
    const formatBtn = root.querySelector('[data-action="format"]');
    const formatIcon = formatBtn.querySelector('.jl-format-icon');
    const formatLabel = formatBtn.querySelector('.jl-format-label');
    const refreshFormatBtn = () => {
      // The label/icon show the action you'd take next, not the current state.
      formatIcon.innerHTML = compact ? ICONS.pretty : ICONS.minify;
      formatLabel.textContent = compact ? "Pretty" : "Minify";
      formatBtn.setAttribute("aria-pressed", String(compact));
      formatBtn.setAttribute("title", compact ? "Switch to pretty-printed" : "Switch to minified");
      root.classList.toggle("jl-compact", compact);
    };
    refreshFormatBtn();
    formatBtn.addEventListener("click", () => {
      compact = !compact;
      refreshFormatBtn();
      // If raw view is open, refresh its content immediately.
      if (root.classList.contains("jl-raw-mode")) {
        root.querySelector(".jl-raw code").textContent = serialize();
      }
      flash(root, compact ? "Minified" : "Pretty-printed");
    });

    root.querySelector('[data-action="copy"]').addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(serialize());
        flash(root, compact ? "Copied (minified)" : "Copied");
      } catch {
        flash(root, "Copy failed");
      }
    });
    root.querySelector('[data-action="download"]').addEventListener("click", () => {
      const blob = new Blob([serialize()], { type: "application/json" });
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
    // ---------- theme switch wiring ----------
    const themeSwitch = root.querySelector(".jl-theme-switch");
    if (themeSwitch) {
      const current = readThemePref();
      themeSwitch.querySelectorAll("button").forEach((b) => {
        b.setAttribute("aria-pressed", b.dataset.theme === current ? "true" : "false");
      });
      themeSwitch.addEventListener("click", (ev) => {
        const btn = ev.target.closest("button[data-theme]");
        if (!btn) return;
        const next = btn.dataset.theme;
        setThemePref(next);
        flash(root, next === "auto" ? "Theme: auto" : next === "light" ? "Theme: light" : "Theme: dark");
      });
    }
    // ---------- filter wiring ----------
    const filterInput = root.querySelector(".jl-filter-input");
    const filterStatus = root.querySelector(".jl-filter-status");
    const filterClear = root.querySelector(".jl-filter-clear");
    const filterRow = root.querySelector(".jl-chrome-filter");
    const filterExport = root.querySelector(".jl-filter-export");
    const filterCopyBtn = root.querySelector(".jl-filter-copy");
    const filterSaveBtn = root.querySelector(".jl-filter-save");

    // Collect the values matched by the current filter from the DOM. Returns
    // a value the user would expect to export: a single value when the filter
    // matched exactly once, otherwise an array of values in document order.
    // Unresolvable paths are silently dropped.
    const collectFilteredSubtree = () => {
      const matchedNodes = Array.from(tree.querySelectorAll(".jl-node.jl-match"));
      const values = [];
      const paths = [];
      for (const n of matchedNodes) {
        const p = n.getAttribute("data-path") || "$";
        const resolved = resolvePath(parsed, p);
        if (resolved.ok) {
          values.push(resolved.value);
          paths.push(p);
        }
      }
      if (values.length === 0) return { ok: false };
      const value = values.length === 1 ? values[0] : values;
      return { ok: true, value, paths, count: values.length };
    };

    const exportFilename = (count) => {
      const base = (location.pathname.split("/").pop() || "document").replace(/\.json$/i, "") || "document";
      return `${base}.filtered${count > 1 ? `.${count}` : ""}.json`;
    };

    let filterTimer = 0;
    const runFilter = (value) => {
      const has = value.trim().length > 0;
      filterClear.hidden = !has;
      filterRow.classList.toggle("jl-filter-active", has);
      filterRow.classList.remove("jl-filter-error");
      if (!has) {
        clearFilterClasses(tree);
        filterStatus.textContent = "";
        filterExport.hidden = true;
        return;
      }
      const res = applyFilter(tree, value);
      if (res.error) {
        filterRow.classList.add("jl-filter-error");
        filterStatus.textContent = res.error;
        filterExport.hidden = true;
        return;
      }
      filterStatus.textContent = res.matches === 0
        ? "no matches"
        : `${res.matches} ${res.matches === 1 ? "match" : "matches"}`;
      filterExport.hidden = res.matches === 0;
    };

    filterCopyBtn.addEventListener("click", async () => {
      const got = collectFilteredSubtree();
      if (!got.ok) { flash(root, "No matches to copy"); return; }
      const text = compact ? JSON.stringify(got.value) : JSON.stringify(got.value, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        flash(root, got.count === 1 ? "Copied filtered subtree" : `Copied ${got.count} matches`);
      } catch {
        flash(root, "Copy failed");
      }
    });
    filterSaveBtn.addEventListener("click", () => {
      const got = collectFilteredSubtree();
      if (!got.ok) { flash(root, "No matches to save"); return; }
      const text = compact ? JSON.stringify(got.value) : JSON.stringify(got.value, null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFilename(got.count);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash(root, got.count === 1 ? "Saved filtered subtree" : `Saved ${got.count} matches`);
    });

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

    // ---------- search wiring ----------
    const searchInput = root.querySelector(".jl-search-input");
    const searchStatus = root.querySelector(".jl-search-status");
    const searchClear = root.querySelector(".jl-search-clear");
    const searchPrev = root.querySelector(".jl-search-prev");
    const searchNext = root.querySelector(".jl-search-next");
    const searchRow = root.querySelector(".jl-chrome-search");
    let searchMatches = [];
    let searchIdx = -1;
    let searchTimer = 0;

    const setActiveMatch = (next) => {
      if (!searchMatches.length) {
        searchIdx = -1;
        searchStatus.textContent = "";
        return;
      }
      // remove old active
      const prevActive = tree.querySelector(".jl-hit.jl-hit-active");
      if (prevActive) prevActive.classList.remove("jl-hit-active");
      const n = searchMatches.length;
      searchIdx = ((next % n) + n) % n;
      const cur = searchMatches[searchIdx];
      cur.classList.add("jl-hit-active");
      expandAncestorsOf(cur, tree);
      cur.scrollIntoView({ block: "center", behavior: "smooth" });
      searchStatus.textContent = `${searchIdx + 1} / ${n}`;
    };

    const runSearch = (value) => {
      const has = value.length > 0;
      searchClear.hidden = !has;
      searchRow.classList.toggle("jl-search-active", has);
      if (!has) {
        clearSearch(tree);
        searchMatches = [];
        searchIdx = -1;
        searchStatus.textContent = "";
        searchPrev.disabled = true;
        searchNext.disabled = true;
        searchRow.classList.remove("jl-search-empty");
        return;
      }
      const { matches } = applySearch(tree, value);
      searchMatches = matches;
      searchPrev.disabled = matches.length < 2;
      searchNext.disabled = matches.length < 2;
      searchRow.classList.toggle("jl-search-empty", matches.length === 0);
      if (matches.length === 0) {
        searchIdx = -1;
        searchStatus.textContent = "no matches";
        return;
      }
      setActiveMatch(0);
    };

    searchInput.addEventListener("input", () => {
      const val = searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(val), 80);
    });
    searchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        searchInput.value = "";
        runSearch("");
        ev.preventDefault();
        return;
      }
      if (ev.key === "Enter") {
        if (!searchMatches.length) return;
        setActiveMatch(searchIdx + (ev.shiftKey ? -1 : 1));
        ev.preventDefault();
      }
    });
    searchPrev.addEventListener("click", () => {
      if (searchMatches.length) setActiveMatch(searchIdx - 1);
    });
    searchNext.addEventListener("click", () => {
      if (searchMatches.length) setActiveMatch(searchIdx + 1);
    });
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      runSearch("");
      searchInput.focus();
    });
    // ⌘K / Ctrl+K focuses search
    document.addEventListener("keydown", (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && (ev.key === "k" || ev.key === "K")) {
        searchInput.focus();
        searchInput.select();
        ev.preventDefault();
      }
    });

    // ---------- schema panel ----------
    let schemaModel = null;
    let schemaRendered = false;
    const schemaBtn = root.querySelector('[data-action="schema"]');
    const schemaPanel = root.querySelector(".jl-schema-panel");
    const schemaBody = root.querySelector(".jl-schema-body");
    const schemaSummaryEl = root.querySelector(".jl-schema-summary");
    const schemaCloseBtn = root.querySelector(".jl-schema-close");
    const schemaCopyBtn = root.querySelector(".jl-schema-copy");

    function schemaToJSON(node) {
      const out = {};
      const types = schemaTypeLabel(node);
      out.type = types.length === 1 ? types[0] : types;
      out.count = node.count;
      if (node.children.size) {
        out.properties = {};
        for (const [k, child] of node.children) out.properties[k] = schemaToJSON(child);
      }
      if (node.items) out.items = schemaToJSON(node.items);
      return out;
    }

    function ensureSchemaRendered() {
      if (schemaRendered) return;
      schemaModel = inferSchema(parsed);
      const tree = buildSchemaTree(schemaModel);
      schemaBody.innerHTML = "";
      schemaBody.appendChild(tree);
      const s = schemaSummary(schemaModel);
      schemaSummaryEl.textContent = `${s.keys} ${s.keys === 1 ? "key" : "keys"} · ${s.objects} obj · ${s.arrays} arr · ${s.leaves} leaves`;
      // toggle delegation
      tree.addEventListener("click", (ev) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        const tog = target.closest(".jl-schema-toggle");
        if (tog && !tog.classList.contains("jl-schema-toggle-leaf")) {
          const node = tog.closest(".jl-schema-node");
          if (node) {
            const c = node.classList.toggle("jl-schema-collapsed");
            tog.setAttribute("aria-expanded", String(!c));
          }
        }
      });
      schemaRendered = true;
    }

    function setSchemaOpen(open) {
      if (open) ensureSchemaRendered();
      schemaPanel.hidden = !open;
      root.classList.toggle("jl-schema-open", open);
      schemaBtn.setAttribute("aria-pressed", String(open));
    }

    schemaBtn.addEventListener("click", () => {
      setSchemaOpen(schemaPanel.hidden);
    });
    schemaCloseBtn.addEventListener("click", () => setSchemaOpen(false));
    schemaCopyBtn.addEventListener("click", async () => {
      ensureSchemaRendered();
      try {
        await navigator.clipboard.writeText(JSON.stringify(schemaToJSON(schemaModel), null, 2));
        flash(root, "Schema copied");
      } catch {
        flash(root, "Copy failed");
      }
    });

    // Expose for debugging/testing without leaking into globals
    ns.inferSchema = (val) => inferSchema(val);

    // ---------- diff panel ----------
    const diffBtn = root.querySelector('[data-action="diff"]');
    const diffPanel = root.querySelector(".jl-diff-panel");
    const diffForm = root.querySelector(".jl-diff-form");
    const diffInputA = root.querySelector(".jl-diff-input-a");
    const diffInputB = root.querySelector(".jl-diff-input-b");
    const diffStatus = root.querySelector(".jl-diff-status");
    const diffSummary = root.querySelector(".jl-diff-summary");
    const diffPaneA = root.querySelector(".jl-diff-pane-a .jl-diff-pane-body");
    const diffPaneB = root.querySelector(".jl-diff-pane-b .jl-diff-pane-body");
    const diffMetaA = root.querySelector(".jl-diff-pane-a .jl-diff-pane-meta");
    const diffMetaB = root.querySelector(".jl-diff-pane-b .jl-diff-pane-meta");
    const diffCloseBtn = root.querySelector(".jl-diff-close");
    const diffSwapBtn = root.querySelector(".jl-diff-swap");
    const diffCopyBtn = root.querySelector(".jl-diff-copy");
    let diffOps = [];
    let diffSideA = parsed;
    let diffSideB = null;
    diffInputA.value = location.href;

    function setDiffOpen(open) {
      diffPanel.hidden = !open;
      root.classList.toggle("jl-diff-open", open);
      diffBtn.setAttribute("aria-pressed", String(open));
      if (open) setTimeout(() => diffInputB.focus(), 60);
    }
    diffBtn.addEventListener("click", () => setDiffOpen(diffPanel.hidden));
    diffCloseBtn.addEventListener("click", () => setDiffOpen(false));
    diffSwapBtn.addEventListener("click", () => {
      const a = diffInputA.value;
      diffInputA.value = diffInputB.value;
      diffInputB.value = a;
    });
    diffCopyBtn.addEventListener("click", async () => {
      if (!diffOps.length) { flash(root, "No diff yet"); return; }
      try {
        await navigator.clipboard.writeText(JSON.stringify(diffOps, null, 2));
        flash(root, "Patch copied");
      } catch { flash(root, "Copy failed"); }
    });

    async function loadJsonURL(url) {
      if (!url) throw new Error("URL required");
      // Use background fetch so host_permissions handle cross-origin.
      const res = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "json-lens:fetch", url }, (r) => {
            if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
            else resolve(r || { ok: false, error: "no response" });
          });
        } catch (err) { resolve({ ok: false, error: String(err && err.message || err) }); }
      });
      if (!res || res.ok === false) throw new Error(res && res.error ? res.error : `Fetch failed${res && res.status ? " (" + res.status + ")" : ""}`);
      try { return { value: JSON.parse(res.text), bytes: res.text.length }; }
      catch (e) { throw new Error("Response was not valid JSON"); }
    }

    diffForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      diffStatus.textContent = "";
      diffPaneA.innerHTML = "";
      diffPaneB.innerHTML = "";
      diffSummary.textContent = "";
      const urlA = diffInputA.value.trim();
      const urlB = diffInputB.value.trim();
      if (!urlB) { diffStatus.textContent = "Enter URL B to diff against"; return; }
      diffStatus.textContent = "Fetching…";
      diffPanel.classList.add("jl-diff-loading");
      try {
        const useCurrentForA = urlA === location.href || urlA === "";
        const a = useCurrentForA ? { value: parsed, bytes: STATE.bytes } : await loadJsonURL(urlA);
        const b = await loadJsonURL(urlB);
        diffSideA = a.value;
        diffSideB = b.value;
        diffMetaA.textContent = `${formatBytes(a.bytes)}`;
        diffMetaB.textContent = `${formatBytes(b.bytes)}`;
        diffOps = computeDiff(a.value, b.value);
        const counts = { add: 0, remove: 0, replace: 0 };
        diffOps.forEach((o) => { counts[o.op] = (counts[o.op] || 0) + 1; });
        diffSummary.textContent = diffOps.length === 0
          ? "identical"
          : `${diffOps.length} change${diffOps.length === 1 ? "" : "s"} · +${counts.add} −${counts.remove} ~${counts.replace}`;
        renderDiffPane(diffPaneA, a.value, diffOps, "a");
        renderDiffPane(diffPaneB, b.value, diffOps, "b");
        diffStatus.textContent = "";
      } catch (err) {
        diffStatus.textContent = err && err.message ? err.message : "Diff failed";
      } finally {
        diffPanel.classList.remove("jl-diff-loading");
      }
    });

    // Expose for debugging/tests
    ns.computeDiff = computeDiff;

    // ---------- path breadcrumb on hover ----------
    // Floats at the bottom of the viewer when hovering (or keyboard-focusing)
    // any tree row. Each segment is clickable to jump+expand to that ancestor.
    const crumbBar = root.querySelector(".jl-breadcrumb");
    const crumbList = root.querySelector(".jl-crumbs");
    const crumbCopyBtn = root.querySelector(".jl-crumb-copy");
    let crumbHideTimer = 0;
    let crumbCurrentPath = "";

    function parsePathSegments(pathStr) {
      const segs = [{ kind: "root", path: "$", label: "$" }];
      if (!pathStr || pathStr === "$") return segs;
      let consumed = 1;
      PATH_TOKEN_RE.lastIndex = consumed;
      let m;
      while ((m = PATH_TOKEN_RE.exec(pathStr)) !== null) {
        if (m.index !== consumed) break;
        consumed = PATH_TOKEN_RE.lastIndex;
        const subPath = pathStr.slice(0, consumed);
        if (m[1] !== undefined) {
          segs.push({ kind: "key", path: subPath, label: m[1] });
        } else if (m[2] !== undefined) {
          segs.push({ kind: "index", path: subPath, label: m[2] });
        } else {
          const key = m[3].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          segs.push({ kind: "key", path: subPath, label: key, quoted: true });
        }
      }
      return segs;
    }

    function renderBreadcrumb(pathStr) {
      crumbCurrentPath = pathStr || "$";
      const segs = parsePathSegments(crumbCurrentPath);
      crumbList.innerHTML = "";
      segs.forEach((seg, i) => {
        if (i > 0) {
          const sep = document.createElement("span");
          sep.className = "jl-crumb-sep";
          sep.setAttribute("aria-hidden", "true");
          sep.innerHTML = ICONS.crumbSep;
          crumbList.appendChild(sep);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "jl-crumb";
        btn.setAttribute("data-kind", seg.kind);
        btn.setAttribute("data-path", seg.path);
        btn.setAttribute("role", "listitem");
        btn.title = `Jump to ${seg.path}`;
        if (i === segs.length - 1) btn.classList.add("jl-crumb-current");
        if (seg.kind === "root") {
          btn.innerHTML = `<span class="jl-crumb-icon" aria-hidden="true">${ICONS.home}</span><span class="jl-crumb-label">root</span>`;
        } else if (seg.kind === "index") {
          btn.innerHTML = `<span class="jl-crumb-bracket">[</span><span class="jl-crumb-label jl-crumb-index">${seg.label}</span><span class="jl-crumb-bracket">]</span>`;
        } else {
          const safe = String(seg.label).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          btn.innerHTML = `<span class="jl-crumb-label">${safe}</span>`;
        }
        crumbList.appendChild(btn);
      });
    }

    function showBreadcrumb(pathStr) {
      clearTimeout(crumbHideTimer);
      if (!pathStr) return;
      renderBreadcrumb(pathStr);
      if (crumbBar.hidden) {
        crumbBar.hidden = false;
        // force reflow so the transition fires
        // eslint-disable-next-line no-unused-expressions
        crumbBar.offsetWidth;
      }
      crumbBar.classList.add("jl-breadcrumb-show");
    }

    function hideBreadcrumb(immediate) {
      clearTimeout(crumbHideTimer);
      const finish = () => {
        crumbBar.classList.remove("jl-breadcrumb-show");
        crumbHideTimer = setTimeout(() => { crumbBar.hidden = true; }, 220);
      };
      if (immediate) finish();
      else crumbHideTimer = setTimeout(finish, 140);
    }

    function pathFromEvent(target) {
      if (!(target instanceof Element)) return null;
      const node = target.closest(".jl-node");
      if (!node || !tree.contains(node)) return null;
      return node.getAttribute("data-path") || "$";
    }

    tree.addEventListener("mouseover", (ev) => {
      const p = pathFromEvent(ev.target);
      if (p) showBreadcrumb(p);
    });
    tree.addEventListener("mouseleave", () => hideBreadcrumb(false));
    tree.addEventListener("focusin", (ev) => {
      const p = pathFromEvent(ev.target);
      if (p) showBreadcrumb(p);
    });
    crumbBar.addEventListener("mouseenter", () => { clearTimeout(crumbHideTimer); });
    crumbBar.addEventListener("mouseleave", () => hideBreadcrumb(false));

    crumbList.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest(".jl-crumb") : null;
      if (!btn) return;
      const path = btn.getAttribute("data-path") || "$";
      const node = tree.querySelector(`.jl-node[data-path="${cssEscape(path)}"]`);
      if (!node) { flash(root, "Path not in view"); return; }
      expandAncestorsOf(node, tree);
      if (node.classList.contains("jl-collapsed")) setCollapsed(node, false);
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      const row = node.querySelector(":scope > .jl-row");
      if (row) {
        row.classList.add("jl-row-ping");
        setTimeout(() => row.classList.remove("jl-row-ping"), 900);
      }
    });

    crumbCopyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(crumbCurrentPath || "$");
        flash(root, `Copied ${crumbCurrentPath || "$"}`);
      } catch { flash(root, "Copy failed"); }
    });

    function cssEscape(s) {
      if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
      return String(s).replace(/["\\]/g, "\\$&");
    }

    // ---------- command palette ----------
    const paletteBtn = root.querySelector('[data-action="palette"]');
    const palette = root.querySelector(".jl-palette");
    const paletteBack = root.querySelector(".jl-palette-backdrop");
    const paletteInput = root.querySelector(".jl-palette-input");
    const paletteList = root.querySelector(".jl-palette-list");
    const paletteEmpty = root.querySelector(".jl-palette-empty");
    let paletteActiveIdx = 0;
    let paletteVisible = [];

    function paletteCommands() {
      const inRaw = root.classList.contains("jl-raw-mode");
      const compact = formatBtn && formatBtn.getAttribute("aria-pressed") === "true";
      return [
        { id: "expand", label: "Expand all nodes", hint: "Tree", icon: ICONS.expand, run: () => root.querySelector('[data-action="expand"]').click() },
        { id: "collapse", label: "Collapse all nodes", hint: "Tree", icon: ICONS.collapse, run: () => root.querySelector('[data-action="collapse"]').click() },
        { id: "format", label: compact ? "Pretty-print JSON" : "Minify JSON", hint: "Format", icon: compact ? ICONS.pretty : ICONS.minify, run: () => formatBtn.click() },
        { id: "copy", label: "Copy JSON to clipboard", hint: "Clipboard", icon: ICONS.copy, run: () => root.querySelector('[data-action="copy"]').click() },
        { id: "download", label: "Download JSON", hint: "File", icon: ICONS.download, run: () => root.querySelector('[data-action="download"]').click() },
        { id: "schema", label: "Toggle inferred schema panel", hint: "Panel", icon: ICONS.schema, run: () => root.querySelector('[data-action="schema"]').click() },
        { id: "diff", label: "Toggle diff against another URL", hint: "Panel", icon: ICONS.diff, run: () => root.querySelector('[data-action="diff"]').click() },
        { id: "raw", label: inRaw ? "Show interactive tree" : "Show raw JSON text", hint: "View", icon: ICONS.raw, run: () => root.querySelector('[data-action="raw"]').click() },
        { id: "focus-search", label: "Focus search bar", hint: "⌘K", icon: ICONS.search, run: () => { setPaletteOpen(false); searchInput.focus(); searchInput.select(); } },
        { id: "focus-filter", label: "Focus jq-style path filter", hint: "/", icon: ICONS.filter, run: () => { setPaletteOpen(false); filterInput.focus(); filterInput.select(); } },
      ];
    }

    function fuzzyScore(text, query) {
      if (!query) return 1;
      const t = text.toLowerCase();
      const q = query.toLowerCase();
      if (t.includes(q)) return 100 - (t.indexOf(q));
      // subsequence match
      let ti = 0, qi = 0, score = 0, streak = 0;
      while (ti < t.length && qi < q.length) {
        if (t[ti] === q[qi]) { qi++; streak++; score += 2 + streak; }
        else streak = 0;
        ti++;
      }
      return qi === q.length ? score : 0;
    }

    function renderPaletteList() {
      const query = paletteInput.value.trim();
      const cmds = paletteCommands()
        .map((c) => ({ c, s: fuzzyScore(c.label + " " + c.hint, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c);
      paletteVisible = cmds;
      paletteList.innerHTML = "";
      if (!cmds.length) {
        paletteEmpty.hidden = false;
        paletteList.hidden = true;
        return;
      }
      paletteEmpty.hidden = true;
      paletteList.hidden = false;
      const frag = document.createDocumentFragment();
      cmds.forEach((c, i) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "jl-palette-item" + (i === paletteActiveIdx ? " jl-palette-item-active" : "");
        item.setAttribute("role", "option");
        item.setAttribute("data-idx", String(i));
        const iconSpan = document.createElement("span"); iconSpan.className = "jl-palette-item-icon"; iconSpan.innerHTML = c.icon;
        const labelSpan = document.createElement("span"); labelSpan.className = "jl-palette-item-label"; labelSpan.textContent = c.label;
        const hintSpan = document.createElement("span"); hintSpan.className = "jl-palette-item-hint"; hintSpan.textContent = c.hint;
        item.appendChild(iconSpan); item.appendChild(labelSpan); item.appendChild(hintSpan);
        frag.appendChild(item);
      });
      paletteList.appendChild(frag);
    }

    function setPaletteActive(i) {
      if (!paletteVisible.length) return;
      const n = paletteVisible.length;
      paletteActiveIdx = ((i % n) + n) % n;
      const items = paletteList.querySelectorAll(".jl-palette-item");
      items.forEach((el, k) => el.classList.toggle("jl-palette-item-active", k === paletteActiveIdx));
      const active = items[paletteActiveIdx];
      if (active) active.scrollIntoView({ block: "nearest" });
    }

    function setPaletteOpen(open) {
      palette.hidden = !open;
      paletteBack.hidden = !open;
      root.classList.toggle("jl-palette-open", open);
      paletteBtn.setAttribute("aria-pressed", String(open));
      if (open) {
        paletteInput.value = "";
        paletteActiveIdx = 0;
        renderPaletteList();
        requestAnimationFrame(() => paletteInput.focus());
      }
    }

    paletteBtn.addEventListener("click", () => setPaletteOpen(palette.hidden));
    paletteBack.addEventListener("click", () => setPaletteOpen(false));
    paletteInput.addEventListener("input", () => { paletteActiveIdx = 0; renderPaletteList(); });
    paletteInput.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") { ev.preventDefault(); setPaletteActive(paletteActiveIdx + 1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); setPaletteActive(paletteActiveIdx - 1); }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        const cmd = paletteVisible[paletteActiveIdx];
        if (cmd) { setPaletteOpen(false); try { cmd.run(); } catch (err) { console.debug("[json-lens] palette cmd error", err); } }
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        setPaletteOpen(false);
      }
    });
    paletteList.addEventListener("click", (ev) => {
      const item = ev.target.closest(".jl-palette-item");
      if (!item) return;
      const idx = Number(item.getAttribute("data-idx"));
      const cmd = paletteVisible[idx];
      if (cmd) { setPaletteOpen(false); try { cmd.run(); } catch (err) { console.debug("[json-lens] palette cmd error", err); } }
    });
    paletteList.addEventListener("mousemove", (ev) => {
      const item = ev.target.closest(".jl-palette-item");
      if (!item) return;
      const idx = Number(item.getAttribute("data-idx"));
      if (!Number.isNaN(idx)) setPaletteActive(idx);
    });
    document.addEventListener("keydown", (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.shiftKey && (ev.key === "p" || ev.key === "P")) {
        ev.preventDefault();
        setPaletteOpen(palette.hidden);
      } else if (!palette.hidden && ev.key === "Escape") {
        ev.preventDefault();
        setPaletteOpen(false);
      }
    });

    root.querySelector('[data-action="raw"]').addEventListener("click", () => {
      const inRaw = root.classList.toggle("jl-raw-mode");
      const rawEl = root.querySelector(".jl-raw");
      const host = root.querySelector(".jl-tree-host");
      if (inRaw) {
        hideBreadcrumb(true);
        rawEl.querySelector("code").textContent = serialize();
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
    PERF_MODE = rawText.length >= PERF_BYTE_THRESHOLD;
    STATE.perfMode = PERF_MODE;

    injectStylesheet();
    applyTheme(readThemePref());
    bindThemeAutoListener();
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
