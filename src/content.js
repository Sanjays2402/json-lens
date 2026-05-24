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

  // ---------- GraphQL detection ----------
  // A GraphQL response is a JSON object containing at least one of `data` or
  // `errors`, optionally `extensions`, and no other top-level keys (spec §7).
  // Heuristic mirrors graphql-spec/draft to avoid false positives on shapes
  // that merely happen to use `data`.
  const GQL_ALLOWED_KEYS = new Set(["data", "errors", "extensions"]);
  function isGraphQLResponse(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const keys = Object.keys(v);
    if (!keys.length) return false;
    const hasData = Object.prototype.hasOwnProperty.call(v, "data");
    const hasErrors = Array.isArray(v.errors);
    if (!hasData && !hasErrors) return false;
    for (const k of keys) if (!GQL_ALLOWED_KEYS.has(k)) return false;
    if (hasErrors) {
      // errors[] entries must be objects with a `message` string per spec.
      const sample = v.errors.slice(0, 5);
      for (const e of sample) {
        if (!e || typeof e !== "object" || Array.isArray(e)) return false;
        if (typeof e.message !== "string") return false;
      }
    }
    return true;
  }

  // Extract a path JSON-pointer-ish for the tree from a GraphQL error.path
  // (array of segments — strings for field names, numbers for list indices).
  function gqlErrorPathToTreePath(errPath) {
    if (!Array.isArray(errPath) || !errPath.length) return "$.data";
    let out = "$.data";
    for (const seg of errPath) {
      if (typeof seg === "number") {
        out += "[" + seg + "]";
      } else {
        const s = String(seg);
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) out += "." + s;
        else out += '["' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]';
      }
    }
    return out;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  // ---------- smart number formatting ----------
  // Returns { primary, hint } where `primary` is the displayed number text
  // (with thousands separators when appropriate) and `hint` is an optional
  // contextual annotation (timestamp, byte size, duration).
  const TIME_KEY_RE = /(^|_|-|\.)(time|date|ts|timestamp|created|updated|modified|expires?|expiry|deleted|seen|started|ended|issued|iat|exp|nbf|published)(_at)?($|_|-|\.)/i;
  const MS_KEY_RE   = /(^|_|-|\.)(ms|millis|milliseconds)($|_|-|\.)/i;
  const BYTES_KEY_RE = /(^|_|-|\.)(bytes?|size|length|filesize|content[-_]?length|byte[-_]?count)($|_|-|\.)/i;
  const DURATION_KEY_RE = /(^|_|-|\.)(duration|elapsed|latency|response[-_]?time|took|runtime|uptime|age|ttl)($|_|-|\.)/i;
  function formatDurationMs(ms) {
    const abs = Math.abs(ms);
    if (abs < 1000) return `${ms} ms`;
    if (abs < 60_000) return `${(ms / 1000).toFixed(abs < 10_000 ? 2 : 1)} s`;
    if (abs < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
    if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
    return `${(ms / 86_400_000).toFixed(1)} d`;
  }
  function formatRelTime(d) {
    const now = Date.now();
    const diff = d.getTime() - now;
    const abs = Math.abs(diff);
    const sign = diff < 0 ? "ago" : "from now";
    let n, unit;
    if (abs < 60_000) { n = Math.round(abs / 1000); unit = "s"; }
    else if (abs < 3_600_000) { n = Math.round(abs / 60_000); unit = "m"; }
    else if (abs < 86_400_000) { n = Math.round(abs / 3_600_000); unit = "h"; }
    else if (abs < 30 * 86_400_000) { n = Math.round(abs / 86_400_000); unit = "d"; }
    else if (abs < 365 * 86_400_000) { n = Math.round(abs / (30 * 86_400_000)); unit = "mo"; }
    else { n = Math.round(abs / (365 * 86_400_000)); unit = "y"; }
    return `${n}${unit} ${sign}`;
  }
  function smartNumberHint(v, keyHint) {
    if (!Number.isFinite(v) || !Number.isInteger(v)) return null;
    const abs = Math.abs(v);
    const key = keyHint == null ? "" : String(keyHint);
    const keyLooksLikeTime = TIME_KEY_RE.test(key);
    const keyLooksLikeMs = MS_KEY_RE.test(key);
    const keyLooksLikeBytes = BYTES_KEY_RE.test(key);
    const keyLooksLikeDuration = DURATION_KEY_RE.test(key);

    // Timestamps. Range gates avoid false positives. Unix seconds: 1e9..2e10
    // (2001..2603). Unix milliseconds: 1e12..2e13.
    if (abs >= 1e12 && abs <= 2e13 && (keyLooksLikeTime || keyLooksLikeMs || (abs >= 1e12 && abs <= 4e12))) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        try { return { label: `${d.toISOString().slice(0,19).replace("T"," ")}Z · ${formatRelTime(d)}`, kind: "time" }; } catch (_) {}
      }
    }
    if (abs >= 1e9 && abs <= 2e10 && !keyLooksLikeMs && (keyLooksLikeTime || (abs >= 1e9 && abs <= 4e9))) {
      const d = new Date(v * 1000);
      if (!Number.isNaN(d.getTime())) {
        try { return { label: `${d.toISOString().slice(0,19).replace("T"," ")}Z · ${formatRelTime(d)}`, kind: "time" }; } catch (_) {}
      }
    }

    // Byte sizes — only when the key hints at a size measurement.
    if (keyLooksLikeBytes && abs >= 1024) {
      return { label: formatBytes(abs), kind: "bytes" };
    }

    // Durations — only when the key hints at a duration. Assume ms by default.
    if (keyLooksLikeDuration && abs >= 1000) {
      return { label: formatDurationMs(v), kind: "duration" };
    }
    return null;
  }
  function formatNumberPrimary(v) {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v) && Math.abs(v) >= 10_000) {
      try { return v.toLocaleString("en-US"); } catch (_) { return String(v); }
    }
    return String(v);
  }

  // ---------- embedded encoded-string detection (base64/JWT/UUID) ----------
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // Conservative URL/email/IP detection. We only chip a string when the whole
  // value (trimmed) is the link — never substring matches inside a sentence.
  const URL_RE = /^https?:\/\/[^\s<>"']{3,2048}$/i;
  const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
  const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
  // Loose but bounded IPv6: at least one colon, only hex/colon, length plausible.
  const IPV6_RE = /^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;
  // Standard base64 (with optional padding). Length must be multiple of 4 once padded.
  const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
  // base64url for JWT segments (no padding, - and _).
  const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
  const JWT_RE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

  function b64urlToB64(s) {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = t.length % 4;
    if (pad) t += "=".repeat(4 - pad);
    return t;
  }
  function tryAtob(s) {
    try { return atob(s); } catch { return null; }
  }
  function bytesToUtf8(bin) {
    if (bin == null) return null;
    try {
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
      // TextDecoder with fatal=true throws on invalid sequences.
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch { return null; }
  }
  function isMostlyPrintable(s) {
    if (!s || !s.length) return false;
    let ok = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xa0) ok++;
    }
    return ok / s.length >= 0.92;
  }
  function uuidVersion(s) {
    const m = /^[0-9a-f]{8}-[0-9a-f]{4}-([1-5])[0-9a-f]{3}-([89ab])[0-9a-f]{3}-[0-9a-f]{12}$/i.exec(s);
    return m ? Number(m[1]) : null;
  }
  function decodeJwt(s) {
    const m = JWT_RE.exec(s);
    if (!m) return null;
    const [, h, p, _sig] = m;
    const hdr = tryAtob(b64urlToB64(h));
    const pl  = tryAtob(b64urlToB64(p));
    if (hdr == null || pl == null) return null;
    const hdrTxt = bytesToUtf8(hdr);
    const plTxt  = bytesToUtf8(pl);
    if (!hdrTxt || !plTxt) return null;
    let header, payload;
    try { header = JSON.parse(hdrTxt); } catch { return null; }
    try { payload = JSON.parse(plTxt); } catch { return null; }
    if (!header || typeof header !== "object") return null;
    if (!payload || typeof payload !== "object") return null;
    return { header, payload };
  }
  function smartStringHint(v) {
    if (typeof v !== "string") return null;
    const len = v.length;
    if (len < 8 || len > 8192) return null;

    // UUID — exact match.
    if (len === 36 && UUID_RE.test(v)) {
      const ver = uuidVersion(v);
      return {
        kind: "uuid",
        label: ver ? `UUID v${ver}` : "UUID",
        title: "Click to inspect",
        decoded: v.toLowerCase(),
        meta: ver ? `Version ${ver}` : "UUID",
        source: v,
      };
    }

    // JWT — three base64url segments separated by dots, both header/payload
    // decode to JSON objects.
    if (v.indexOf(".") !== -1 && JWT_RE.test(v)) {
      const jwt = decodeJwt(v);
      if (jwt) {
        const alg = (jwt.header && (jwt.header.alg || jwt.header.typ)) || "JWT";
        return {
          kind: "jwt",
          label: `JWT · ${String(alg).slice(0, 16)}`,
          title: "Click to inspect decoded payload",
          decoded: JSON.stringify({ header: jwt.header, payload: jwt.payload }, null, 2),
          meta: "Signed JSON Web Token",
          source: v,
        };
      }
    }

    // base64 — standard or url-safe. Must decode to UTF-8 printable text or
    // recognised JSON. We avoid hex strings, plain ASCII words, and common
    // tokens that happen to fit the alphabet.
    if (len >= 16 && len <= 4096) {
      let candidate = null;
      if (BASE64_RE.test(v) && len % 4 === 0) candidate = v;
      else if (BASE64URL_RE.test(v) && !/^[A-Za-z]+$/.test(v) && !/^[0-9]+$/.test(v) && v.indexOf("-") + v.indexOf("_") > -2) {
        candidate = b64urlToB64(v);
      }
      if (candidate) {
        const bin = tryAtob(candidate);
        if (bin && bin.length >= 4) {
          const txt = bytesToUtf8(bin);
          if (txt && isMostlyPrintable(txt) && txt !== v) {
            // Pretty-print if it decodes to JSON.
            let decoded = txt;
            try { decoded = JSON.stringify(JSON.parse(txt), null, 2); } catch { /* keep raw */ }
            return {
              kind: "base64",
              label: `base64 · ${bin.length}B`,
              title: "Click to inspect decoded text",
              decoded,
              meta: `${bin.length} bytes decoded`,
              source: v,
            };
          }
        }
      }
    }

    return null;
  }

  let _jlOpenPopover = null;
  function closeDecodedPopover() {
    if (_jlOpenPopover && _jlOpenPopover.parentNode) _jlOpenPopover.parentNode.removeChild(_jlOpenPopover);
    _jlOpenPopover = null;
    document.removeEventListener("keydown", _popKey, true);
    document.removeEventListener("mousedown", _popDoc, true);
  }
  function _popKey(e) { if (e.key === "Escape") { e.stopPropagation(); closeDecodedPopover(); } }
  function _popDoc(e) { if (_jlOpenPopover && !_jlOpenPopover.contains(e.target)) closeDecodedPopover(); }
  function openDecodedPopover(anchor, hint) {
    closeDecodedPopover();
    const pop = document.createElement("div");
    pop.className = `jl-decoded-pop jl-decoded-pop-${hint.kind}`;
    const head = document.createElement("div");
    head.className = "jl-decoded-head";
    const title = document.createElement("span");
    title.className = "jl-decoded-kind";
    title.textContent = hint.label;
    head.appendChild(title);
    const meta = document.createElement("span");
    meta.className = "jl-decoded-meta";
    meta.textContent = hint.meta || "";
    head.appendChild(meta);
    const btns = document.createElement("div");
    btns.className = "jl-decoded-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "jl-decoded-btn";
    copy.textContent = "Copy";
    copy.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(hint.decoded); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1100); }
      catch { copy.textContent = "Failed"; setTimeout(() => { copy.textContent = "Copy"; }, 1100); }
    });
    btns.appendChild(copy);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "jl-decoded-btn jl-decoded-close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = ICONS.close;
    close.addEventListener("click", (e) => { e.stopPropagation(); closeDecodedPopover(); });
    btns.appendChild(close);
    head.appendChild(btns);
    pop.appendChild(head);

    const body = document.createElement("pre");
    body.className = "jl-decoded-body";
    body.textContent = hint.decoded;
    pop.appendChild(body);

    document.body.appendChild(pop);
    // Position near anchor.
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = r.left + window.scrollX;
    let top  = r.bottom + window.scrollY + 6;
    const maxLeft = window.scrollX + window.innerWidth - pr.width - 12;
    if (left > maxLeft) left = Math.max(window.scrollX + 12, maxLeft);
    if (top + pr.height > window.scrollY + window.innerHeight - 12) {
      top = r.top + window.scrollY - pr.height - 6;
    }
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top  = `${Math.max(8, top)}px`;

    _jlOpenPopover = pop;
    setTimeout(() => {
      document.addEventListener("keydown", _popKey, true);
      document.addEventListener("mousedown", _popDoc, true);
    }, 0);
  }

  function previewPrimitive(v, keyHint) {
    const t = typeOf(v);
    const span = document.createElement("span");
    if (t === "string") {
      span.className = "jl-str";
      const s = v.length > 120 ? v.slice(0, 117) + "…" : v;
      span.textContent = `"${s}"`;
      const link = smartLinkHint(v);
      if (link) {
        const wrap = document.createElement("span");
        wrap.className = "jl-str-wrap jl-link-wrap";
        wrap.appendChild(span);
        const chip = document.createElement("a");
        chip.className = `jl-link-chip jl-link-chip-${link.kind}`;
        chip.setAttribute("data-kind", link.kind);
        chip.setAttribute("href", link.href);
        chip.setAttribute("title", link.title);
        if (link.kind === "url" || link.kind === "ip") {
          chip.setAttribute("target", "_blank");
          chip.setAttribute("rel", "noopener noreferrer");
        }
        // Stop the row's click handlers (toggle, focus, etc.) from firing when
        // the user is clearly aiming at the link. The anchor's default
        // navigation still fires for the actual click.
        chip.addEventListener("click", (e) => { e.stopPropagation(); });
        chip.addEventListener("mousedown", (e) => { e.stopPropagation(); });
        chip.innerHTML = `${ICONS[link.icon] || ICONS.externalLink}<span class="jl-link-chip-label">${link.label}</span>`;
        wrap.appendChild(chip);
        return wrap;
      }
    } else if (t === "number") {
      span.className = "jl-num";
      span.textContent = formatNumberPrimary(v);
      const hint = smartNumberHint(v, keyHint);
      if (hint) {
        const wrap = document.createElement("span");
        wrap.className = "jl-num-wrap";
        wrap.appendChild(span);
        const tag = document.createElement("span");
        tag.className = `jl-num-hint jl-num-hint-${hint.kind}`;
        tag.setAttribute("data-kind", hint.kind);
        tag.setAttribute("aria-hidden", "true");
        tag.textContent = hint.label;
        wrap.appendChild(tag);
        return wrap;
      }
      const sHint = smartStringHint(v);
      if (sHint) {
        const wrap = document.createElement("span");
        wrap.className = "jl-str-wrap";
        wrap.appendChild(span);
        const tag = document.createElement("button");
        tag.type = "button";
        tag.className = `jl-str-hint jl-str-hint-${sHint.kind}`;
        tag.setAttribute("data-kind", sHint.kind);
        tag.title = sHint.title || sHint.label;
        tag.textContent = sHint.label;
        tag.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          openDecodedPopover(tag, sHint);
        });
        wrap.appendChild(tag);
        return wrap;
      }
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
    bookmark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.6L6 21z"/></svg>`,
    bookmarkFilled: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.6L6 21z"/></svg>`,
    tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12l-7.5 7.5a2 2 0 0 1-2.83 0L3 12V4h8z"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1z"/><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
    externalLink: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>`,
    pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg>`,
    jsonpath: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4"/><path d="M20 6h-3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h3"/><path d="M9 14l2 4 2-8 2 4"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14l11-7z"/></svg>`,
    undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v0a6 6 0 0 1-6 6h-3"/></svg>`,
    patch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l8-3 8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9z"/><path d="M9 12l2 2 4-4"/></svg>`,
    terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2"/><path d="M13 14h4"/></svg>`,
    history: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3.5 2"/></svg>`,
    diffArrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>`,
    csv: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17"/><path d="M3.5 14.5h17"/><path d="M9 9.5v10"/><path d="M15 9.5v10"/></svg>`,
    graphql: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8.66 5v8L12 21l-8.66-5V8z"/><path d="M12 3l8.66 13H3.34z" opacity="0.55"/><circle cx="12" cy="3" r="1.6" fill="currentColor" stroke="none"/><circle cx="20.66" cy="8" r="1.6" fill="currentColor" stroke="none"/><circle cx="20.66" cy="16" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="21" r="1.6" fill="currentColor" stroke="none"/><circle cx="3.34" cy="16" r="1.6" fill="currentColor" stroke="none"/><circle cx="3.34" cy="8" r="1.6" fill="currentColor" stroke="none"/></svg>`,
    warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v5"/><circle cx="12" cy="17.5" r="0.6" fill="currentColor" stroke="none"/></svg>`,
    pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3l7 7-3 1-4 4 1 4-3-1-5 5-1-4-4-1 5-5-1-3 4-4z"/></svg>`,
    pinFilled: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M14 3l7 7-3 1-4 4 1 4-3-1-5 5-1-4-4-1 5-5-1-3 4-4z"/></svg>`,
    grip: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>`,
    note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h10l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M15 4v4h4"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>`,
    noteFilled: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"><path d="M5 4h10l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" opacity="0.92"/><path d="M15 4v4h4" fill="none" stroke="none"/><path d="M8 13h8M8 17h5" stroke="#0b0b10" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`,
    globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M3 12h18"/><path d="M12 4c2.5 2.5 4 5 4 8s-1.5 5.5-4 8c-2.5-2.5-4-5-4-8s1.5-5.5 4-8z"/></svg>`,
    at: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.5"/><path d="M15.5 12V13.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.6 6.9"/></svg>`,
    network: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="5" rx="1.2"/><rect x="3" y="16" width="7" height="5" rx="1.2"/><rect x="14" y="16" width="7" height="5" rx="1.2"/><path d="M12 8v4M6.5 16v-2h11v2"/></svg>`,
    share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/><path d="M12 4v12"/><path d="M7 9l5-5 5 5"/></svg>`,
    flame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c1.5 3 4.5 4.5 4.5 8a4.5 4.5 0 1 1-9 0c0-1.8 1-3 1-4.5 0 1.2 1 2 2 2 0-2 .5-3.5 1.5-5.5z"/><path d="M10.5 16.5c.5 1 1 1.5 1.5 1.5s1-.5 1.5-1.5"/></svg>`,
    chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v15a1 1 0 0 0 1 1h15"/><path d="M7 15l4-5 3 3 5-7"/><circle cx="7" cy="15" r="1" fill="currentColor" stroke="none"/><circle cx="11" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="6" r="1" fill="currentColor" stroke="none"/></svg>`,
    queries: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h10l4 4v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M14 5v5h5"/><path d="M8 13h6"/><path d="M8 17h4"/><circle cx="16.5" cy="16.5" r="2.4"/><path d="M18.4 18.4L20 20"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.86l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.86-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.86.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.86l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.86-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.1.5.4.94.86 1.24.3.2.66.3 1.03.3H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"/></svg>`,
    palette: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2 0-.6-.2-1-.6-1.4-.4-.4-.6-.8-.6-1.4 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4 8 8 0 0 0-9-7.4z"/><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="17" cy="11" r="1" fill="currentColor" stroke="none"/></svg>`,
    type: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7V5h14v2"/><path d="M12 5v15"/><path d="M9 20h6"/></svg>`,
    indent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M10 12h10"/><path d="M10 18h10"/><path d="M4 10l3 2-3 2"/></svg>`,
  };

  // ---------- history (snapshots per URL) ----------
  // Persisted in chrome.storage.local under HISTORY_KEY. Each url maps to an
  // array of snapshots (latest first), capped at HISTORY_PER_URL. We skip
  // storing the raw text for very large payloads to keep extension storage
  // under quota; metadata (size, hash, ts) is always kept.
  const HISTORY_KEY = "json-lens:history";
  const HISTORY_PER_URL = 20;
  const HISTORY_MAX_URLS = 80;
  const HISTORY_RAW_LIMIT = 768 * 1024; // bytes

  function historyStorage() {
    try { return chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
    catch { return null; }
  }

  function loadHistoryAll() {
    return new Promise((resolve) => {
      const s = historyStorage();
      if (!s) { resolve({}); return; }
      try {
        s.get(HISTORY_KEY, (obj) => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve({}); return; }
          const v = obj && obj[HISTORY_KEY];
          resolve(v && typeof v === "object" ? v : {});
        });
      } catch { resolve({}); }
    });
  }

  function saveHistoryAll(map) {
    return new Promise((resolve) => {
      const s = historyStorage();
      if (!s) { resolve(false); return; }
      try {
        s.set({ [HISTORY_KEY]: map }, () => resolve(!(chrome.runtime && chrome.runtime.lastError)));
      } catch { resolve(false); }
    });
  }

  // Fast 32-bit FNV-1a hash for snapshot fingerprinting / dedupe.
  function jlFastHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function trimHistoryMap(map) {
    // If we exceed HISTORY_MAX_URLS, drop the URLs whose most recent snapshot
    // is oldest. Keeps storage bounded across many visited endpoints.
    const keys = Object.keys(map);
    if (keys.length <= HISTORY_MAX_URLS) return map;
    keys.sort((a, b) => {
      const ta = (map[a] && map[a][0] && map[a][0].ts) || 0;
      const tb = (map[b] && map[b][0] && map[b][0].ts) || 0;
      return tb - ta;
    });
    const next = {};
    for (const k of keys.slice(0, HISTORY_MAX_URLS)) next[k] = map[k];
    return next;
  }

  async function recordSnapshot(url, rawText) {
    if (!url || typeof rawText !== "string") return;
    const size = rawText.length;
    const hash = jlFastHash(rawText);
    const map = await loadHistoryAll();
    const list = Array.isArray(map[url]) ? map[url] : [];
    if (list.length && list[0].hash === hash) {
      // No change — bump ts of the latest entry so recency reflects this visit.
      list[0].ts = Date.now();
    } else {
      list.unshift({
        id: cryptoIdish().replace(/^bm_/, "hs_"),
        ts: Date.now(),
        size,
        hash,
        raw: size <= HISTORY_RAW_LIMIT ? rawText : null,
      });
      if (list.length > HISTORY_PER_URL) list.length = HISTORY_PER_URL;
    }
    map[url] = list;
    await saveHistoryAll(trimHistoryMap(map));
  }

  // ---------- bookmarks ----------
  // Persisted in chrome.storage.local under BOOKMARKS_KEY so they survive page
  // reloads and follow the user across JSON endpoints they visit. Each entry:
  //   { id, url, name, tags: string[], addedAt, lastOpenedAt }
  const BOOKMARKS_KEY = "json-lens:bookmarks";
  const BOOKMARK_MAX = 500;

  function bookmarksStorage() {
    try { return chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
    catch { return null; }
  }

  function loadBookmarks() {
    return new Promise((resolve) => {
      const s = bookmarksStorage();
      if (!s) { resolve([]); return; }
      try {
        s.get(BOOKMARKS_KEY, (obj) => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve([]); return; }
          const arr = obj && Array.isArray(obj[BOOKMARKS_KEY]) ? obj[BOOKMARKS_KEY] : [];
          // basic shape coercion
          const clean = arr.filter((b) => b && typeof b.url === "string" && b.url).map((b) => ({
            id: String(b.id || cryptoIdish()),
            url: String(b.url),
            name: String(b.name || deriveBookmarkName(b.url)),
            tags: Array.isArray(b.tags) ? b.tags.map(String).filter(Boolean).slice(0, 16) : [],
            addedAt: Number(b.addedAt) || Date.now(),
            lastOpenedAt: Number(b.lastOpenedAt) || 0,
          }));
          resolve(clean);
        });
      } catch { resolve([]); }
    });
  }

  function saveBookmarks(list) {
    return new Promise((resolve) => {
      const s = bookmarksStorage();
      if (!s) { resolve(false); return; }
      try {
        s.set({ [BOOKMARKS_KEY]: list.slice(0, BOOKMARK_MAX) }, () => resolve(!(chrome.runtime && chrome.runtime.lastError)));
      } catch { resolve(false); }
    });
  }

  function cryptoIdish() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch {}
    return "bm_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function deriveBookmarkName(url) {
    try {
      const u = new URL(url);
      const last = (u.pathname.split("/").filter(Boolean).pop() || u.hostname).replace(/\.json$/i, "");
      return decodeURIComponent(last) || u.hostname || url;
    } catch { return url.slice(0, 60); }
  }

  function parseTagInput(s) {
    return String(s || "")
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean)
      .slice(0, 16);
  }

  function relativeTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  function escapeHTML(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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

  // ---------- settings (font, indent width, accent color) ----------
  // Persisted in localStorage as a single JSON blob; applied as CSS variables
  // on `#json-lens-root` so existing styling inherits without per-element work.
  const SETTINGS_KEY = "json-lens:settings";
  const FONT_STACKS = {
    jetbrains: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    sf:        '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
    menlo:     'Menlo, ui-monospace, "SF Mono", Consolas, monospace',
    fira:      '"Fira Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    cascadia:  '"Cascadia Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    system:    'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  };
  const INDENT_CHOICES = [2, 3, 4, 8];
  const FONT_SIZE_MIN = 11;
  const FONT_SIZE_MAX = 18;
  const SETTINGS_DEFAULTS = {
    font: "jetbrains",
    fontSize: 13,
    indent: 2,
    accent: "#f6b352",
  };
  const HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
  function normalizeSettings(raw) {
    const s = { ...SETTINGS_DEFAULTS };
    if (raw && typeof raw === "object") {
      if (typeof raw.font === "string" && FONT_STACKS[raw.font]) s.font = raw.font;
      if (Number.isFinite(raw.fontSize)) s.fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(raw.fontSize)));
      if (INDENT_CHOICES.includes(raw.indent)) s.indent = raw.indent;
      if (typeof raw.accent === "string" && HEX_RE.test(raw.accent)) {
        s.accent = raw.accent.length === 4
          ? "#" + raw.accent.slice(1).split("").map((c) => c + c).join("")
          : raw.accent.toLowerCase();
      }
    }
    return s;
  }
  function readSettings() {
    try { return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null")); }
    catch { return { ...SETTINGS_DEFAULTS }; }
  }
  function writeSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
  }
  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbaFromHex(hex, a) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  function applySettings(s) {
    ns.settings = s;
    const root = document.getElementById("json-lens-root");
    const targets = root ? [root] : [document.documentElement];
    for (const el of targets) {
      el.style.setProperty("--jl-mono", FONT_STACKS[s.font] || FONT_STACKS.jetbrains);
      el.style.setProperty("--jl-mono-size", `${s.fontSize}px`);
      el.style.setProperty("--jl-indent", `${s.indent * 4}px`);
      el.style.setProperty("--jl-indent-spaces", String(s.indent));
      el.style.setProperty("--accent", s.accent);
      el.style.setProperty("--accent-soft", rgbaFromHex(s.accent, 0.16));
    }
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

  // ---------- CSV generation (tabular arrays) ----------
  // A value is "tabular" when it is a non-empty array whose elements are
  // plain objects (not arrays). Nested objects/arrays inside cells are
  // stringified as JSON so the row stays a single CSV record. Column order
  // is the union of keys in first-appearance order across sampled rows.
  const CSV_SAMPLE = 5000;
  function isTabularArray(value) {
    if (!Array.isArray(value) || value.length === 0) return false;
    let objCount = 0;
    const limit = Math.min(value.length, 50);
    for (let i = 0; i < limit; i++) {
      const v = value[i];
      if (v && typeof v === "object" && !Array.isArray(v)) objCount++;
    }
    // At least half the sampled rows must be plain objects to call it tabular.
    return objCount >= Math.max(1, Math.ceil(limit / 2));
  }
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    let s;
    if (typeof v === "string") s = v;
    else if (typeof v === "number" || typeof v === "boolean") s = String(v);
    else { try { s = JSON.stringify(v); } catch { s = String(v); } }
    // Quote when the cell contains a comma, quote, CR or LF; double inner quotes.
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function generateCSV(value) {
    if (!Array.isArray(value)) return "";
    const rows = value.slice(0, CSV_SAMPLE);
    const cols = [];
    const seen = new Set();
    for (const row of rows) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        for (const k of Object.keys(row)) {
          if (!seen.has(k)) { seen.add(k); cols.push(k); }
        }
      }
    }
    if (cols.length === 0) return "";
    const lines = [cols.map(csvCell).join(",")];
    for (const row of rows) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        lines.push(cols.map((c) => csvCell(row[c])).join(","));
      } else {
        // Non-object row: place its stringified value in the first column.
        const cells = new Array(cols.length).fill("");
        cells[0] = csvCell(row);
        lines.push(cells.join(","));
      }
    }
    // CRLF line endings per RFC 4180.
    return lines.join("\r\n") + "\r\n";
  }
  ns.isTabularArray = isTabularArray;
  ns.generateCSV = generateCSV;

  // ---------- time-series detection ----------
  // A value is a "time series" when it is an array of plain objects (≥2 rows)
  // with one key whose values consistently parse as timestamps and another
  // key whose values are finite numbers. Common key names get a score bonus
  // so {timestamp,value}, {ts,count}, {date,price} all win cleanly even when
  // other numeric/timestamp-shaped columns exist.
  const TS_KEY_HINTS = ["timestamp","time","ts","datetime","date","at","createdat","created_at","updatedat","updated_at","t","x"];
  const VAL_KEY_HINTS = ["value","val","y","count","amount","price","close","open","high","low","total","qty","volume"];
  const TS_DETECT_MAX = 5000;
  function parseTimestampLoose(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      // Heuristic: ms epoch in (~2001..~3236) range; seconds epoch in (~2001..~3236)
      if (v >= 1e12 && v < 4e13) return v;
      if (v >= 1e9 && v < 4e10) return v * 1000;
      return null;
    }
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseTimestampLoose(Number(s));
      // Be conservative: require an ISO-ish date prefix or year-month-day
      if (/^\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d|$)/.test(s) || /^\d{4}\/\d{1,2}\/\d{1,2}/.test(s)) {
        const t = Date.parse(s);
        return Number.isFinite(t) ? t : null;
      }
      return null;
    }
    return null;
  }
  function detectTimeSeries(arr) {
    if (!Array.isArray(arr) || arr.length < 2 || arr.length > TS_DETECT_MAX) return null;
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    }
    const keys = [];
    const seen = new Set();
    for (const r of arr) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    const tsCandidates = [];
    const valCandidates = [];
    for (const k of keys) {
      let tsOk = 0, valOk = 0, total = 0;
      for (const r of arr) {
        if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
        total++;
        const x = r[k];
        if (parseTimestampLoose(x) !== null) tsOk++;
        if (typeof x === "number" && Number.isFinite(x)) valOk++;
      }
      if (total !== arr.length) continue;
      const kl = k.toLowerCase();
      const tsHint = TS_KEY_HINTS.indexOf(kl) >= 0 ? 1000 : 0;
      const valHint = VAL_KEY_HINTS.indexOf(kl) >= 0 ? 1000 : 0;
      if (tsOk >= Math.ceil(arr.length * 0.9)) tsCandidates.push({ k, score: tsOk + tsHint });
      if (valOk >= Math.ceil(arr.length * 0.9)) valCandidates.push({ k, score: valOk + valHint });
    }
    if (!tsCandidates.length || !valCandidates.length) return null;
    tsCandidates.sort((a, b) => b.score - a.score);
    valCandidates.sort((a, b) => b.score - a.score);
    const tsKey = tsCandidates[0].k;
    const valC = valCandidates.find((c) => c.k !== tsKey);
    if (!valC) return null;
    const points = [];
    for (const r of arr) {
      const t = parseTimestampLoose(r[tsKey]);
      const v = r[valC.k];
      if (t !== null && typeof v === "number" && Number.isFinite(v)) points.push({ t, v });
    }
    if (points.length < 2) return null;
    points.sort((a, b) => a.t - b.t);
    return { tsKey, valKey: valC.k, points };
  }
  function isTimeSeriesArray(value) { return detectTimeSeries(value) !== null; }
  ns.detectTimeSeries = detectTimeSeries;
  ns.isTimeSeriesArray = isTimeSeriesArray;

  // Build a compact SVG line chart for a detected time series. No external
  // libraries, no network calls — just hand-rolled paths so the snapshot can
  // ship anywhere.
  function fmtChartTick(t, span) {
    const d = new Date(t);
    if (!Number.isFinite(d.getTime())) return "";
    if (span <= 2 * 60 * 60 * 1000) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    if (span <= 2 * 24 * 60 * 60 * 1000) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (span <= 60 * 24 * 60 * 60 * 1000) {
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    return d.toLocaleDateString([], { year: "numeric", month: "short" });
  }
  function fmtChartValue(v) {
    if (!Number.isFinite(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-2)) return v.toExponential(2);
    if (Number.isInteger(v) && a < 1e6) return v.toLocaleString();
    return (Math.round(v * 1000) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
  function buildTimeSeriesChart(series) {
    const W = 720, H = 240;
    const PAD_L = 64, PAD_R = 16, PAD_T = 18, PAD_B = 34;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;
    const pts = series.points;
    let tMin = pts[0].t, tMax = pts[0].t, vMin = pts[0].v, vMax = pts[0].v;
    for (const p of pts) {
      if (p.t < tMin) tMin = p.t; if (p.t > tMax) tMax = p.t;
      if (p.v < vMin) vMin = p.v; if (p.v > vMax) vMax = p.v;
    }
    const tSpan = Math.max(1, tMax - tMin);
    let vSpan = vMax - vMin;
    if (vSpan === 0) { vSpan = Math.max(1, Math.abs(vMax) || 1); vMin -= vSpan / 2; vMax += vSpan / 2; vSpan = vMax - vMin; }
    const pad = vSpan * 0.08;
    vMin -= pad; vMax += pad;
    const xOf = (t) => PAD_L + ((t - tMin) / tSpan) * innerW;
    const yOf = (v) => PAD_T + (1 - (v - vMin) / (vMax - vMin)) * innerH;

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "jl-chart-svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Time series chart of ${pts.length} points`);

    // gridlines + y ticks
    const TICKS_Y = 4;
    for (let i = 0; i <= TICKS_Y; i++) {
      const frac = i / TICKS_Y;
      const yVal = vMax - frac * (vMax - vMin);
      const y = PAD_T + frac * innerH;
      const grid = document.createElementNS(NS, "line");
      grid.setAttribute("class", "jl-chart-grid");
      grid.setAttribute("x1", String(PAD_L)); grid.setAttribute("x2", String(W - PAD_R));
      grid.setAttribute("y1", String(y)); grid.setAttribute("y2", String(y));
      svg.appendChild(grid);
      const lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("class", "jl-chart-tick jl-chart-tick-y");
      lbl.setAttribute("x", String(PAD_L - 8));
      lbl.setAttribute("y", String(y + 4));
      lbl.setAttribute("text-anchor", "end");
      lbl.textContent = fmtChartValue(yVal);
      svg.appendChild(lbl);
    }

    // x ticks (~5)
    const TICKS_X = Math.min(5, pts.length);
    for (let i = 0; i < TICKS_X; i++) {
      const frac = TICKS_X === 1 ? 0.5 : i / (TICKS_X - 1);
      const t = tMin + frac * tSpan;
      const x = PAD_L + frac * innerW;
      const tick = document.createElementNS(NS, "line");
      tick.setAttribute("class", "jl-chart-tick-line");
      tick.setAttribute("x1", String(x)); tick.setAttribute("x2", String(x));
      tick.setAttribute("y1", String(PAD_T + innerH)); tick.setAttribute("y2", String(PAD_T + innerH + 4));
      svg.appendChild(tick);
      const lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("class", "jl-chart-tick jl-chart-tick-x");
      lbl.setAttribute("x", String(x));
      lbl.setAttribute("y", String(PAD_T + innerH + 18));
      lbl.setAttribute("text-anchor", i === 0 ? "start" : i === TICKS_X - 1 ? "end" : "middle");
      lbl.textContent = fmtChartTick(t, tSpan);
      svg.appendChild(lbl);
    }

    // axis baseline
    const axis = document.createElementNS(NS, "line");
    axis.setAttribute("class", "jl-chart-axis");
    axis.setAttribute("x1", String(PAD_L)); axis.setAttribute("x2", String(W - PAD_R));
    axis.setAttribute("y1", String(PAD_T + innerH)); axis.setAttribute("y2", String(PAD_T + innerH));
    svg.appendChild(axis);
    const yAxis = document.createElementNS(NS, "line");
    yAxis.setAttribute("class", "jl-chart-axis");
    yAxis.setAttribute("x1", String(PAD_L)); yAxis.setAttribute("x2", String(PAD_L));
    yAxis.setAttribute("y1", String(PAD_T)); yAxis.setAttribute("y2", String(PAD_T + innerH));
    svg.appendChild(yAxis);

    // area fill under the line
    let areaD = "";
    for (let i = 0; i < pts.length; i++) {
      const cmd = i === 0 ? "M" : "L";
      areaD += `${cmd}${xOf(pts[i].t).toFixed(2)},${yOf(pts[i].v).toFixed(2)}`;
    }
    areaD += `L${xOf(pts[pts.length - 1].t).toFixed(2)},${(PAD_T + innerH).toFixed(2)}`;
    areaD += `L${xOf(pts[0].t).toFixed(2)},${(PAD_T + innerH).toFixed(2)}Z`;
    const area = document.createElementNS(NS, "path");
    area.setAttribute("class", "jl-chart-area");
    area.setAttribute("d", areaD);
    svg.appendChild(area);

    // line
    let lineD = "";
    for (let i = 0; i < pts.length; i++) {
      const cmd = i === 0 ? "M" : "L";
      lineD += `${cmd}${xOf(pts[i].t).toFixed(2)},${yOf(pts[i].v).toFixed(2)}`;
    }
    const line = document.createElementNS(NS, "path");
    line.setAttribute("class", "jl-chart-line");
    line.setAttribute("d", lineD);
    svg.appendChild(line);

    // dots when not too dense
    if (pts.length <= 120) {
      for (const p of pts) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("class", "jl-chart-dot");
        c.setAttribute("cx", String(xOf(p.t).toFixed(2)));
        c.setAttribute("cy", String(yOf(p.v).toFixed(2)));
        c.setAttribute("r", "2.4");
        const title = document.createElementNS(NS, "title");
        title.textContent = `${new Date(p.t).toISOString()}  •  ${fmtChartValue(p.v)}`;
        c.appendChild(title);
        svg.appendChild(c);
      }
    }

    // hover crosshair group (built once, positioned on pointermove)
    const hover = document.createElementNS(NS, "g");
    hover.setAttribute("class", "jl-chart-hover");
    hover.setAttribute("opacity", "0");
    const vline = document.createElementNS(NS, "line");
    vline.setAttribute("class", "jl-chart-crosshair");
    vline.setAttribute("y1", String(PAD_T));
    vline.setAttribute("y2", String(PAD_T + innerH));
    hover.appendChild(vline);
    const hdot = document.createElementNS(NS, "circle");
    hdot.setAttribute("class", "jl-chart-hover-dot");
    hdot.setAttribute("r", "3.6");
    hover.appendChild(hdot);
    svg.appendChild(hover);

    return { svg, hover, vline, hdot, xOf, yOf, pts, tMin, tSpan, PAD_L, PAD_R, PAD_T, innerW, innerH, W };
  }

  // ---------- standalone HTML snapshot ----------
  // Build a fully self-contained HTML document that embeds the current JSON
  // and renders an interactive collapsible tree. No network calls, no external
  // assets; safe to share by email/Slack/Drive. The JSON is embedded inside a
  // <script type="application/json"> block so it's not interpreted as JS.
  function escapeForScriptJson(s) {
    // Prevent premature </script> closing inside the embedded payload.
    return String(s)
      .replace(/<\/(script)/gi, "<\\/$1")
      .replace(/<!--/g, "<\\!--")
      .replace(/-->/g, "--\\>")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }
  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function buildStandaloneSnapshot({ value, sourceUrl, title }) {
    const ts = new Date();
    const isoTs = ts.toISOString();
    const human = ts.toLocaleString();
    const safeTitle = escapeHTML(title || "JSON Lens snapshot");
    const safeUrl = escapeHTML(sourceUrl || "");
    let jsonText;
    try { jsonText = JSON.stringify(value, null, 2); }
    catch { jsonText = "\"<unserializable>\""; }
    const bytes = new Blob([jsonText]).size;
    const sizeLabel = bytes < 1024 ? `${bytes} B` :
      bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` :
      `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    const embedded = escapeForScriptJson(jsonText);
    // Inline viewer kept intentionally compact and dependency-free.
    return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="JSON Lens snapshot" />
<meta name="snapshot-source" content="${safeUrl}" />
<meta name="snapshot-timestamp" content="${escapeHTML(isoTs)}" />
<title>${safeTitle}</title>
<style>
  :root {
    --bg: #f7f7f9;
    --bg-elev: rgba(255,255,255,0.72);
    --border: rgba(15,15,20,0.08);
    --fg: #0f0f14;
    --muted: rgba(15,15,20,0.56);
    --accent: #7a5cff;
    --string: #167e5b;
    --number: #b25400;
    --boolean: #6a3fa3;
    --null: rgba(15,15,20,0.45);
    --key: #2a3957;
    --row-hover: rgba(122,92,255,0.06);
    --blob-a: radial-gradient(circle at 18% 12%, rgba(122,92,255,0.22), transparent 55%);
    --blob-b: radial-gradient(circle at 82% 88%, rgba(80,180,255,0.18), transparent 60%);
    color-scheme: light dark;
  }
  html[data-theme="dark"], html[data-theme="auto"] {
    color-scheme: dark light;
  }
  @media (prefers-color-scheme: dark) {
    html[data-theme="auto"] {
      --bg: #0c0c11;
      --bg-elev: rgba(22,22,30,0.72);
      --border: rgba(255,255,255,0.08);
      --fg: #f4f4f7;
      --muted: rgba(244,244,247,0.55);
      --accent: #9a82ff;
      --string: #6dd3a8;
      --number: #ffb472;
      --boolean: #c8a8ff;
      --null: rgba(244,244,247,0.42);
      --key: #b6c1dc;
      --row-hover: rgba(154,130,255,0.10);
      --blob-a: radial-gradient(circle at 18% 12%, rgba(154,130,255,0.28), transparent 55%);
      --blob-b: radial-gradient(circle at 82% 88%, rgba(80,180,255,0.18), transparent 60%);
    }
  }
  html[data-theme="dark"] {
    --bg: #0c0c11;
    --bg-elev: rgba(22,22,30,0.72);
    --border: rgba(255,255,255,0.08);
    --fg: #f4f4f7;
    --muted: rgba(244,244,247,0.55);
    --accent: #9a82ff;
    --string: #6dd3a8;
    --number: #ffb472;
    --boolean: #c8a8ff;
    --null: rgba(244,244,247,0.42);
    --key: #b6c1dc;
    --row-hover: rgba(154,130,255,0.10);
    --blob-a: radial-gradient(circle at 18% 12%, rgba(154,130,255,0.28), transparent 55%);
    --blob-b: radial-gradient(circle at 82% 88%, rgba(80,180,255,0.18), transparent 60%);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    font-family: "Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: -0.01em;
    line-height: 1.45;
    min-height: 100vh;
    position: relative;
    overflow-x: hidden;
  }
  body::before, body::after {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background: var(--blob-a), var(--blob-b);
    filter: blur(40px);
  }
  .wrap { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 24px 24px 64px; }
  header.card {
    background: var(--bg-elev);
    backdrop-filter: blur(22px) saturate(1.4);
    -webkit-backdrop-filter: blur(22px) saturate(1.4);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 16px 20px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 40px rgba(15,15,20,0.06);
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 14px; }
  .brand svg { width: 18px; height: 18px; color: var(--accent); }
  .meta { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 200px; }
  .meta .src { font-size: 13px; color: var(--fg); word-break: break-all; }
  .meta .sub { font-size: 12px; color: var(--muted); }
  .controls { display: flex; gap: 8px; align-items: center; }
  .controls button, .controls a {
    appearance: none; border: 1px solid var(--border); background: var(--bg-elev);
    color: var(--fg); font: inherit; font-size: 12.5px; border-radius: 10px;
    padding: 8px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    text-decoration: none;
    transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), border-color 180ms, background 180ms;
  }
  .controls button:hover, .controls a:hover { border-color: rgba(122,92,255,0.45); transform: translateY(-1px); }
  .controls button:focus-visible, .controls a:focus-visible { outline: 2px solid color-mix(in oklab, var(--accent), transparent 40%); outline-offset: 2px; }
  .controls svg { width: 15px; height: 15px; }
  .stats { display: flex; gap: 12px; align-items: center; font-size: 12px; color: var(--muted); }
  .stats .pill {
    padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--bg-elev); color: var(--fg);
  }
  main.card {
    margin-top: 16px;
    background: var(--bg-elev);
    backdrop-filter: blur(22px) saturate(1.4);
    -webkit-backdrop-filter: blur(22px) saturate(1.4);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 16px 20px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 40px rgba(15,15,20,0.06);
  }
  .tree { font-family: "JetBrains Mono", "SF Mono", ui-monospace, "Menlo", monospace; font-size: 13px; line-height: 1.55; }
  .node { padding-left: 18px; position: relative; }
  .row { padding: 1px 4px; border-radius: 6px; cursor: default; display: block; white-space: pre-wrap; word-break: break-word; }
  .row:hover { background: var(--row-hover); }
  .caret { display: inline-block; width: 14px; text-align: center; cursor: pointer; color: var(--muted); transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1); user-select: none; }
  .caret.open { transform: rotate(90deg); }
  .key { color: var(--key); }
  .str { color: var(--string); }
  .num { color: var(--number); }
  .bool { color: var(--boolean); }
  .nul { color: var(--null); font-style: italic; }
  .meta-count { color: var(--muted); font-size: 11.5px; margin-left: 6px; }
  .children { padding-left: 14px; border-left: 1px solid var(--border); margin-left: 4px; }
  .children.collapsed { display: none; }
  .footer { margin-top: 18px; font-size: 11.5px; color: var(--muted); text-align: center; }
  .footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
  <div class="wrap">
    <header class="card">
      <div class="brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></svg>
        <span>JSON Lens</span>
      </div>
      <div class="meta">
        <div class="src">${safeUrl || "&lt;no source URL&gt;"}</div>
        <div class="sub">Snapshot captured ${escapeHTML(human)}</div>
      </div>
      <div class="stats">
        <span class="pill">${escapeHTML(sizeLabel)}</span>
      </div>
      <div class="controls">
        <button type="button" id="expandAll" title="Expand all">Expand</button>
        <button type="button" id="collapseAll" title="Collapse all">Collapse</button>
        <button type="button" id="copyJson" title="Copy JSON">Copy JSON</button>
        <button type="button" id="themeToggle" title="Toggle theme">Theme</button>
      </div>
    </header>
    <main class="card">
      <div id="tree" class="tree"></div>
    </main>
    <div class="footer">Generated by <a href="https://github.com/Sanjays2402" rel="noreferrer">JSON Lens</a> · standalone snapshot · no network calls</div>
  </div>
  <script id="payload" type="application/json">${embedded}</script>
  <script>
  (function () {
    var payload;
    try { payload = JSON.parse(document.getElementById("payload").textContent); }
    catch (e) { document.getElementById("tree").textContent = "Failed to parse embedded JSON."; return; }
    function esc(s) { return String(s).replace(/[&<>\"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    function fmtVal(v) {
      if (v === null) return '<span class="nul">null</span>';
      switch (typeof v) {
        case "string": return '<span class="str">"' + esc(v) + '"</span>';
        case "number": return '<span class="num">' + v + '</span>';
        case "boolean": return '<span class="bool">' + v + '</span>';
      }
      return esc(String(v));
    }
    function render(parent, key, value, depth) {
      var node = document.createElement("div");
      node.className = "node";
      var row = document.createElement("div");
      row.className = "row";
      var isObj = value && typeof value === "object";
      var isArr = Array.isArray(value);
      var entries = isObj ? (isArr ? value.map(function (v, i) { return [i, v]; }) : Object.keys(value).map(function (k) { return [k, value[k]]; })) : null;
      var keyPart = (key !== null) ? '<span class="key">' + (isArr ? key : '"' + esc(key) + '"') + '</span>: ' : "";
      if (isObj) {
        var open = depth < 2;
        row.innerHTML = '<span class="caret' + (open ? " open" : "") + '">▸</span>' + keyPart +
          (isArr ? "[" : "{") + '<span class="meta-count">' + entries.length + (isArr ? " items" : " keys") + '</span>' + (entries.length ? "" : (isArr ? "]" : "}"));
        node.appendChild(row);
        if (entries.length) {
          var kids = document.createElement("div");
          kids.className = "children" + (open ? "" : " collapsed");
          for (var i = 0; i < entries.length; i++) render(kids, entries[i][0], entries[i][1], depth + 1);
          var closer = document.createElement("div");
          closer.className = "row";
          closer.textContent = isArr ? "]" : "}";
          node.appendChild(kids);
          node.appendChild(closer);
          var caret = row.querySelector(".caret");
          caret.addEventListener("click", function () {
            var collapsed = kids.classList.toggle("collapsed");
            caret.classList.toggle("open", !collapsed);
          });
        }
      } else {
        row.innerHTML = keyPart + fmtVal(value);
        node.appendChild(row);
      }
      parent.appendChild(node);
    }
    var tree = document.getElementById("tree");
    render(tree, null, payload, 0);
    function setAll(open) {
      var carets = tree.querySelectorAll(".caret");
      var kids = tree.querySelectorAll(".children");
      carets.forEach(function (c) { c.classList.toggle("open", open); });
      kids.forEach(function (k) { k.classList.toggle("collapsed", !open); });
    }
    document.getElementById("expandAll").addEventListener("click", function () { setAll(true); });
    document.getElementById("collapseAll").addEventListener("click", function () { setAll(false); });
    document.getElementById("copyJson").addEventListener("click", function () {
      var text = JSON.stringify(payload, null, 2);
      try {
        navigator.clipboard.writeText(text).then(function () {
          var b = document.getElementById("copyJson");
          var prev = b.textContent; b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = prev; }, 1200);
        });
      } catch (e) {}
    });
    var t = document.getElementById("themeToggle");
    t.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") || "auto";
      var next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
      document.documentElement.setAttribute("data-theme", next);
      t.textContent = "Theme: " + next;
    });
  })();
  </script>
</body>
</html>
`;
  }
  ns.buildStandaloneSnapshot = buildStandaloneSnapshot;

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

  // ---------- schema comparison ----------
  // Walks two inferred-schema trees (from inferSchema()) in parallel and
  // emits a flat list of structural differences:
  //   - added:        key/path exists only in B
  //   - removed:      key/path exists only in A
  //   - type-changed: same path, different type-set
  //   - optional-changed: same path, presence ratio (count/parent) shifted
  //                       meaningfully between A and B (>= 25pp)
  // Output rows carry the path in JSONPath-ish form so the user can copy
  // and feed them straight into the JSONPath evaluator.
  function jpJoin(base, key) {
    if (/^[A-Za-z_$][\w$]*$/.test(key)) return base + "." + key;
    return base + "[" + JSON.stringify(key) + "]";
  }

  function compareSchemas(a, b, path, out, parentA, parentB) {
    path = path || "$";
    out = out || [];
    if (a && !b) { out.push({ path, kind: "removed", aTypes: schemaTypeLabel(a), aCount: a.count, parentACount: parentA ? parentA.count : a.count }); return out; }
    if (!a && b) { out.push({ path, kind: "added", bTypes: schemaTypeLabel(b), bCount: b.count, parentBCount: parentB ? parentB.count : b.count }); return out; }
    if (!a && !b) return out;
    const aTypes = schemaTypeLabel(a);
    const bTypes = schemaTypeLabel(b);
    const aKey = aTypes.slice().sort().join("|");
    const bKey = bTypes.slice().sort().join("|");
    if (aKey !== bKey) {
      out.push({ path, kind: "type-changed", aTypes, bTypes, aCount: a.count, bCount: b.count });
    } else if (parentA && parentB && parentA.count && parentB.count) {
      // Optionality / coverage shift on a shared key.
      const ra = a.count / parentA.count;
      const rb = b.count / parentB.count;
      if (Math.abs(ra - rb) >= 0.25 && !(ra === 1 && rb === 1)) {
        out.push({ path, kind: "optional-changed", aRatio: ra, bRatio: rb, aCount: a.count, bCount: b.count, parentACount: parentA.count, parentBCount: parentB.count });
      }
    }
    const keys = new Set();
    for (const k of a.children.keys()) keys.add(k);
    for (const k of b.children.keys()) keys.add(k);
    const ordered = Array.from(keys).sort();
    for (const k of ordered) {
      compareSchemas(a.children.get(k) || null, b.children.get(k) || null, jpJoin(path, k), out, a, b);
    }
    if (a.items || b.items) {
      compareSchemas(a.items || null, b.items || null, path + "[*]", out, a, b);
    }
    return out;
  }

  ns.compareSchemas = (av, bv) => compareSchemas(inferSchema(av), inferSchema(bv));

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
    if (key !== undefined && key !== null) node.setAttribute("data-key", String(key));

    const row = document.createElement("div");
    row.className = "jl-row";
    row.setAttribute("role", "treeitem");
    if (pathStr) row.setAttribute("draggable", "true");

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
      preview.appendChild(previewPrimitive(value, key));
    }
    row.appendChild(preview);

    if (!isLast && depth > 0) {
      const trailing = document.createElement("span");
      trailing.className = "jl-punc jl-trailing";
      trailing.textContent = ",";
      row.appendChild(trailing);
    }

    // Per-row actions (hover-revealed). Containers get TS/Schema copy; primitives
    // get inline editing with revert. Edits never leave the page — see EDITS map
    // and the copy-as-curl-PATCH action in the chrome.
    const actions = document.createElement("span");
    actions.className = "jl-row-actions";
    // Pin (applies to every addressable node, container or primitive).
    if (pathStr) {
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "jl-row-action jl-row-action-pin";
      pinBtn.setAttribute("data-action", "toggle-pin");
      pinBtn.setAttribute("title", "Pin node");
      pinBtn.setAttribute("aria-label", "Pin node");
      pinBtn.setAttribute("draggable", "true");
      pinBtn.innerHTML = `${ICONS.pin}<span class="jl-row-action-label">Pin</span>`;
      actions.appendChild(pinBtn);
      const noteBtn = document.createElement("button");
      noteBtn.type = "button";
      noteBtn.className = "jl-row-action jl-row-action-note";
      noteBtn.setAttribute("data-action", "toggle-note");
      noteBtn.setAttribute("title", "Add a note");
      noteBtn.setAttribute("aria-label", "Add a note to this node");
      noteBtn.innerHTML = `${ICONS.note}<span class="jl-row-action-label">Note</span>`;
      actions.appendChild(noteBtn);
    }
    if (isContainer) {
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
      if (isTabularArray(value)) {
        const csvBtn = document.createElement("button");
        csvBtn.type = "button";
        csvBtn.className = "jl-row-action jl-row-action-csv";
        csvBtn.setAttribute("data-action", "copy-csv");
        csvBtn.setAttribute("title", "Copy as CSV");
        csvBtn.setAttribute("aria-label", "Copy as CSV");
        csvBtn.innerHTML = `${ICONS.csv}<span class="jl-row-action-label">CSV</span>`;
        actions.appendChild(csvBtn);
      }
      if (t === "array" && isTimeSeriesArray(value)) {
        const chartBtn = document.createElement("button");
        chartBtn.type = "button";
        chartBtn.className = "jl-row-action jl-row-action-chart";
        chartBtn.setAttribute("data-action", "toggle-chart");
        chartBtn.setAttribute("title", "Chart this time series");
        chartBtn.setAttribute("aria-label", "Chart this time series");
        chartBtn.setAttribute("aria-pressed", "false");
        chartBtn.innerHTML = `${ICONS.chart}<span class="jl-row-action-label">Chart</span>`;
        actions.appendChild(chartBtn);
      }
    } else if (pathStr && pathStr !== "$") {
      // Only editable when this primitive sits under a parent we can address.
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "jl-row-action jl-row-action-edit";
      editBtn.setAttribute("data-action", "edit-value");
      editBtn.setAttribute("title", "Edit value");
      editBtn.setAttribute("aria-label", "Edit value");
      editBtn.innerHTML = `${ICONS.pencil}<span class="jl-row-action-label">Edit</span>`;
      actions.appendChild(editBtn);
      const revBtn = document.createElement("button");
      revBtn.type = "button";
      revBtn.className = "jl-row-action jl-row-action-revert";
      revBtn.setAttribute("data-action", "revert-value");
      revBtn.setAttribute("title", "Revert to original");
      revBtn.setAttribute("aria-label", "Revert to original");
      revBtn.innerHTML = `${ICONS.undo}<span class="jl-row-action-label">Revert</span>`;
      actions.appendChild(revBtn);
    }
    if (actions.childElementCount) row.appendChild(actions);

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

  // Convert a JSON Lens path ($.a[0]["b"]) into an RFC6901 JSON Pointer. The
  // root path becomes the empty string — standard JSON Pointer for the document.
  function pathToPointer(pathStr) {
    if (!pathStr || pathStr === "$") return "";
    let out = "";
    let consumed = 1;
    PATH_TOKEN_RE.lastIndex = consumed;
    let m;
    while ((m = PATH_TOKEN_RE.exec(pathStr)) !== null) {
      if (m.index !== consumed) return out;
      consumed = PATH_TOKEN_RE.lastIndex;
      let seg;
      if (m[1] !== undefined) seg = m[1];
      else if (m[2] !== undefined) seg = m[2];
      else seg = m[3].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      out += "/" + seg.replace(/~/g, "~0").replace(/\//g, "~1");
    }
    return out;
  }

  // Resolve up to (but not including) the last segment of a path. Returns the
  // parent container and the last key/index when the path is two or more
  // segments deep. Used by inline edits which mutate a value in place.
  function resolveParent(root, pathStr) {
    if (!pathStr || pathStr === "$") return { ok: false };
    const tokens = [];
    let consumed = 1;
    PATH_TOKEN_RE.lastIndex = consumed;
    let m;
    while ((m = PATH_TOKEN_RE.exec(pathStr)) !== null) {
      if (m.index !== consumed) return { ok: false };
      consumed = PATH_TOKEN_RE.lastIndex;
      if (m[1] !== undefined) tokens.push({ key: m[1] });
      else if (m[2] !== undefined) tokens.push({ key: Number(m[2]) });
      else tokens.push({ key: m[3].replace(/\\"/g, '"').replace(/\\\\/g, "\\") });
    }
    if (consumed !== pathStr.length || tokens.length === 0) return { ok: false };
    let cur = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (cur === null || typeof cur !== "object") return { ok: false };
      cur = cur[tokens[i].key];
    }
    if (cur === null || typeof cur !== "object") return { ok: false };
    return { ok: true, parent: cur, last: tokens[tokens.length - 1].key };
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
    tree.setAttribute("tabindex", "0");
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

  // Tokenize a regex source into highlightable chunks for the mirror overlay.
  // Best-effort lexer — produces visually coherent groupings even for partial
  // / in-progress patterns. Not a validator (compilation handles validation).
  function tokenizeRegex(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        const next = i + 1 < n ? src[i + 1] : "";
        out.push({ t: "esc", s: next ? src.slice(i, i + 2) : c });
        i += next ? 2 : 1;
        continue;
      }
      if (c === "[") {
        let j = i + 1;
        if (src[j] === "^") j++;
        if (src[j] === "]") j++; // literal ] at start
        while (j < n && src[j] !== "]") {
          if (src[j] === "\\" && j + 1 < n) j += 2;
          else j++;
        }
        if (j < n) j++; // include closing ]
        out.push({ t: "class", s: src.slice(i, j) });
        i = j;
        continue;
      }
      if (c === "(") {
        let s = "(";
        let j = i + 1;
        if (src[j] === "?") {
          const k = src[j + 1];
          if (k === ":" || k === "=" || k === "!") {
            s = src.slice(i, j + 2);
            j += 2;
          } else if (k === "<") {
            const k2 = src[j + 2];
            if (k2 === "=" || k2 === "!") { s = src.slice(i, j + 3); j += 3; }
            else {
              let m = j + 2;
              while (m < n && src[m] !== ">") m++;
              if (m < n) m++;
              s = src.slice(i, m);
              j = m;
            }
          } else { s = src.slice(i, j + 1); j += 1; }
        }
        out.push({ t: "group", s });
        i = j > i ? j : i + 1;
        continue;
      }
      if (c === ")" || c === "|") { out.push({ t: "group", s: c }); i++; continue; }
      if (c === "*" || c === "+" || c === "?") { out.push({ t: "quant", s: c }); i++; continue; }
      if (c === "{") {
        let j = i + 1;
        while (j < n && src[j] !== "}") j++;
        if (j < n) j++;
        out.push({ t: "quant", s: src.slice(i, j) });
        i = j;
        continue;
      }
      if (c === "^" || c === "$" || c === ".") { out.push({ t: "anchor", s: c }); i++; continue; }
      // Accumulate consecutive literal characters into a single span.
      let j = i;
      while (j < n && !"\\[](){}|*+?.^$".includes(src[j])) j++;
      out.push({ t: "lit", s: src.slice(i, j) });
      i = j;
    }
    return out;
  }

  function renderRegexMirror(mirror, src) {
    if (!mirror) return;
    mirror.textContent = "";
    if (!src) return;
    const toks = tokenizeRegex(src);
    for (const tok of toks) {
      const sp = document.createElement("span");
      sp.className = `jl-rx-${tok.t}`;
      sp.textContent = tok.s;
      mirror.appendChild(sp);
    }
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

  function applySearch(tree, query, opts) {
    const q = String(query || "");
    const regexMode = !!(opts && opts.regex);
    if (!q) {
      clearSearch(tree);
      return { matches: [], empty: true };
    }
    // Search must consider the whole document, even nodes whose DOM has
    // not been materialized yet in perf mode.
    if (PERF_MODE) materializeAll(tree);
    let rx;
    if (regexMode) {
      try { rx = new RegExp(q, "gi"); }
      catch (err) {
        clearSearch(tree);
        tree.classList.add("jl-searching");
        return { matches: [], error: (err && err.message) || "invalid regex" };
      }
    } else {
      rx = new RegExp(escRegex(q), "gi");
    }
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
    const isGQL = isGraphQLResponse(parsed);
    const gqlErrorCount = isGQL && Array.isArray(parsed.errors) ? parsed.errors.length : 0;

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
            ${isGQL ? `<span class="jl-dot"></span><span class="jl-badge jl-badge-graphql" title="GraphQL response detected">GraphQL${gqlErrorCount ? ` · ${gqlErrorCount} err${gqlErrorCount === 1 ? "" : "s"}` : ""}</span>` : ""}
          </div>
          <div class="jl-actions">
            <button class="jl-btn jl-btn-ghost" data-action="expand" title="Expand all" aria-label="Expand all">${ICONS.expand}</button>
            <button class="jl-btn jl-btn-ghost" data-action="collapse" title="Collapse all" aria-label="Collapse all">${ICONS.collapse}</button>
            <button class="jl-btn jl-btn-ghost" data-action="format" title="Toggle pretty / minify" aria-label="Toggle pretty or minify" aria-pressed="false"><span class="jl-format-icon">${ICONS.pretty}</span><span class="jl-format-label">Pretty</span></button>
            <button class="jl-btn" data-action="copy" title="Copy JSON" aria-label="Copy JSON">${ICONS.copy}<span>Copy</span></button>
            <button class="jl-btn" data-action="download" title="Download JSON" aria-label="Download JSON">${ICONS.download}<span>Save</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="snapshot" title="Export standalone shareable HTML snapshot" aria-label="Export standalone HTML snapshot">${ICONS.share}<span>Snapshot</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="heatmap" title="Heatmap — colorize numeric leaves by magnitude within their array" aria-label="Toggle heatmap mode" aria-pressed="false">${ICONS.flame}<span>Heatmap</span></button>
            <button class="jl-btn jl-btn-ghost jl-btn-curl" data-action="copy-curl-patch" title="Copy edits as curl PATCH" aria-label="Copy edits as curl PATCH" disabled aria-disabled="true">${ICONS.patch}<span>cURL PATCH</span><span class="jl-curl-count" aria-hidden="true"></span></button>
            <button class="jl-btn jl-btn-ghost" data-action="schema" title="Inferred schema" aria-label="Inferred schema" aria-pressed="false">${ICONS.schema}<span>Schema</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="diff" title="Diff against another JSON URL" aria-label="Diff against another JSON URL" aria-pressed="false">${ICONS.diff}<span>Diff</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="jsonpath" title="JSONPath evaluator" aria-label="JSONPath evaluator" aria-pressed="false">${ICONS.jsonpath}<span>JSONPath</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="queries" title="Saved queries for this domain (Q)" aria-label="Saved query workspace" aria-pressed="false">${ICONS.queries}<span>Queries</span><span class="jl-q-count" aria-hidden="true"></span></button>
            <button class="jl-btn jl-btn-ghost" data-action="graphql" title="GraphQL operation & variables" aria-label="GraphQL panel" aria-pressed="false"${isGQL ? "" : " hidden"}>${ICONS.graphql}<span>GraphQL</span>${gqlErrorCount ? `<span class="jl-gql-count" aria-hidden="true">${gqlErrorCount}</span>` : ""}</button>
            <button class="jl-btn jl-btn-ghost" data-action="bookmarks" title="Bookmarks (B)" aria-label="Bookmarks" aria-pressed="false">${ICONS.bookmark}<span>Bookmarks</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="pins" title="Pinned nodes (P) — drag any row here to pin" aria-label="Pinned nodes" aria-pressed="false">${ICONS.pin}<span>Pins</span><span class="jl-pin-count" aria-hidden="true"></span></button>
            <button class="jl-btn jl-btn-ghost" data-action="history" title="History (H)" aria-label="History timeline" aria-pressed="false">${ICONS.history}<span>History</span><span class="jl-hist-count" aria-hidden="true"></span></button>
            <button class="jl-btn jl-btn-ghost" data-action="palette" title="Command palette (⌘K)" aria-label="Command palette">${ICONS.command}<span>Actions</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="raw" title="Toggle raw view" aria-label="Toggle raw view">${ICONS.raw}<span>Raw</span></button>
            <button class="jl-btn jl-btn-ghost" data-action="settings" title="Settings — theme, font, indent, accent" aria-label="Settings" aria-pressed="false">${ICONS.gear}<span>Settings</span></button>
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
          <div class="jl-search-input-wrap">
            <div class="jl-search-mirror" aria-hidden="true"></div>
            <input class="jl-search-input" type="text" spellcheck="false" autocomplete="off"
                   placeholder="Search keys & values — ⌘⇧K"
                   aria-label="Search keys and values" />
          </div>
          <button class="jl-search-regex" type="button" role="switch" aria-checked="false"
                  title="Toggle regex mode" aria-label="Toggle regex search"><span aria-hidden="true">.*</span></button>
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
              <div class="jl-diff-mode" role="group" aria-label="Diff mode">
                <button type="button" class="jl-diff-mode-btn jl-diff-mode-active" data-diff-mode="values" aria-pressed="true" title="Compare raw values">${ICONS.diff}<span>Values</span></button>
                <button type="button" class="jl-diff-mode-btn" data-diff-mode="schemas" aria-pressed="false" title="Compare inferred schemas — added, removed, type-changed paths">${ICONS.schema}<span>Schemas</span></button>
              </div>
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
          <div class="jl-diff-schema-body" role="list" aria-label="Schema differences" hidden></div>
          <div class="jl-diff-schema-empty" hidden>
            <svg class="jl-diff-schema-empty-art" viewBox="0 0 160 110" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="24" y="30" width="48" height="50" rx="6"/>
              <rect x="88" y="30" width="48" height="50" rx="6"/>
              <path d="M72 55h16" opacity="0.6"/>
              <path d="M34 44h28M34 56h22M34 68h26" opacity="0.55"/>
              <path d="M98 44h28M98 56h22M98 68h26" opacity="0.55"/>
              <path d="M118 22l4 4 8-8" opacity="0.8"/>
            </svg>
            <div class="jl-diff-schema-empty-title">Schemas match</div>
            <div class="jl-diff-schema-empty-hint">Both endpoints inferred to the same shape — same keys, same types, same optionality.</div>
          </div>
        </section>
        <section class="jl-jsonpath-panel" hidden aria-label="JSONPath evaluator">
          <div class="jl-jp-header">
            <div class="jl-jp-title">
              <span class="jl-jp-title-icon" aria-hidden="true">${ICONS.jsonpath}</span>
              <span>JSONPath evaluator</span>
            </div>
            <div class="jl-jp-summary" aria-live="polite"></div>
            <div class="jl-jp-tools">
              <button class="jl-btn jl-btn-ghost jl-jp-copy" type="button" title="Copy matches as JSON" aria-label="Copy matches as JSON">${ICONS.copy}<span>Copy</span></button>
              <button class="jl-btn jl-btn-ghost jl-jp-close" type="button" title="Close JSONPath" aria-label="Close JSONPath evaluator">${ICONS.close}</button>
            </div>
          </div>
          <form class="jl-jp-form" autocomplete="off">
            <span class="jl-jp-prefix" aria-hidden="true">${ICONS.jsonpath}</span>
            <input class="jl-jp-input" type="text" spellcheck="false" autocomplete="off"
                   placeholder="JSONPath — $.store.book[*].author, $..price, $.items[?(@.qty>0)].id"
                   aria-label="JSONPath expression" />
            <button class="jl-btn jl-jp-run" type="submit" title="Evaluate (Enter)" aria-label="Evaluate expression">${ICONS.play}<span>Run</span></button>
          </form>
          <div class="jl-jp-status" aria-live="polite"></div>
          <div class="jl-jp-examples" aria-label="Examples">
            <span class="jl-jp-examples-label">Try</span>
            <button class="jl-jp-chip" type="button" data-jp="$.*">$.*</button>
            <button class="jl-jp-chip" type="button" data-jp="$..*">$..*</button>
            <button class="jl-jp-chip" type="button" data-jp="$[0]">$[0]</button>
            <button class="jl-jp-chip" type="button" data-jp="$..id">$..id</button>
          </div>
          <div class="jl-jp-body" role="list"></div>
          <div class="jl-jp-empty" hidden>
            <svg class="jl-jp-empty-art" viewBox="0 0 160 110" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M30 86c8-14 18-24 30-30s24-8 36-6" opacity="0.45"/>
              <circle cx="96" cy="50" r="22"/>
              <path d="M112 66l14 14"/>
              <path d="M88 50h16M96 42v16" opacity="0.6"/>
            </svg>
            <div class="jl-jp-empty-title">No matches</div>
            <div class="jl-jp-empty-hint">Try <code>$..id</code> for recursive descent or <code>$.items[?(@.qty&gt;0)]</code> with a filter expression.</div>
          </div>
        </section>
        <section class="jl-graphql-panel" hidden aria-label="GraphQL response details">
          <div class="jl-gql-header">
            <div class="jl-gql-title">
              <span class="jl-gql-title-icon" aria-hidden="true">${ICONS.graphql}</span>
              <span>GraphQL response</span>
            </div>
            <div class="jl-gql-summary" aria-live="polite"></div>
            <div class="jl-gql-tools">
              <button class="jl-btn jl-btn-ghost jl-gql-copy-op" type="button" title="Copy operation" aria-label="Copy operation">${ICONS.copy}<span>Op</span></button>
              <button class="jl-btn jl-btn-ghost jl-gql-copy-vars" type="button" title="Copy variables JSON" aria-label="Copy variables JSON">${ICONS.copy}<span>Vars</span></button>
              <button class="jl-btn jl-btn-ghost jl-gql-close" type="button" title="Close GraphQL panel" aria-label="Close GraphQL panel">${ICONS.close}</button>
            </div>
          </div>
          <div class="jl-gql-tabs" role="tablist">
            <button type="button" class="jl-gql-tab jl-gql-tab-active" role="tab" data-tab="op" aria-selected="true">Operation</button>
            <button type="button" class="jl-gql-tab" role="tab" data-tab="vars" aria-selected="false">Variables</button>
            <button type="button" class="jl-gql-tab" role="tab" data-tab="errors" aria-selected="false">Errors<span class="jl-gql-tab-count" hidden></span></button>
            <button type="button" class="jl-gql-tab" role="tab" data-tab="ext" aria-selected="false">Extensions</button>
          </div>
          <div class="jl-gql-body">
            <div class="jl-gql-pane jl-gql-pane-op" role="tabpanel">
              <div class="jl-gql-meta"></div>
              <pre class="jl-gql-pre jl-gql-op"><code></code></pre>
            </div>
            <div class="jl-gql-pane jl-gql-pane-vars" role="tabpanel" hidden>
              <pre class="jl-gql-pre jl-gql-vars"><code></code></pre>
            </div>
            <div class="jl-gql-pane jl-gql-pane-errors" role="tabpanel" hidden>
              <div class="jl-gql-errors" role="list"></div>
            </div>
            <div class="jl-gql-pane jl-gql-pane-ext" role="tabpanel" hidden>
              <pre class="jl-gql-pre jl-gql-ext"><code></code></pre>
            </div>
          </div>
          <div class="jl-gql-empty" hidden>
            <svg class="jl-gql-empty-art" viewBox="0 0 160 110" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M80 18l52 30v14L80 92 28 62V48z"/>
              <path d="M80 18l52 44H28z" opacity="0.45"/>
              <circle cx="80" cy="18" r="3"/>
              <circle cx="132" cy="48" r="3"/>
              <circle cx="132" cy="62" r="3"/>
              <circle cx="80" cy="92" r="3"/>
              <circle cx="28" cy="62" r="3"/>
              <circle cx="28" cy="48" r="3"/>
            </svg>
            <div class="jl-gql-empty-title">Nothing here</div>
            <div class="jl-gql-empty-hint">The response did not include this section.</div>
          </div>
        </section>
        <div class="jl-breadcrumb" hidden role="status" aria-label="JSON path of hovered node">
          <div class="jl-crumbs" role="list"></div>
          <button class="jl-crumb-copy" type="button" title="Copy path" aria-label="Copy path">${ICONS.copy}</button>
        </div>
        <aside class="jl-bookmarks-panel" hidden aria-label="Bookmarked JSON endpoints">
          <div class="jl-bm-header">
            <div class="jl-bm-title">
              <span class="jl-bm-title-icon" aria-hidden="true">${ICONS.bookmark}</span>
              <span>Bookmarks</span>
            </div>
            <div class="jl-bm-summary" aria-live="polite"></div>
            <div class="jl-bm-tools">
              <button class="jl-btn jl-bm-add" type="button" title="Bookmark current URL" aria-label="Bookmark current URL">${ICONS.plus}<span>Add</span></button>
              <button class="jl-btn jl-btn-ghost jl-bm-close" type="button" title="Close bookmarks" aria-label="Close bookmarks">${ICONS.close}</button>
            </div>
          </div>
          <div class="jl-bm-search" role="search">
            <span class="jl-bm-search-icon" aria-hidden="true">${ICONS.search}</span>
            <input class="jl-bm-search-input" type="text" spellcheck="false" autocomplete="off"
                   placeholder="Search bookmarks — name, url, #tag" aria-label="Search bookmarks" />
          </div>
          <div class="jl-bm-tagbar" role="toolbar" aria-label="Filter by tag" hidden></div>
          <div class="jl-bm-body" role="list"></div>
          <div class="jl-bm-empty" hidden>
            <svg class="jl-bm-empty-art" viewBox="0 0 160 110" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M30 18c-4 6-6 14-4 24 2 11 8 22 18 32 9 9 20 14 31 14 9 0 16-3 21-9" opacity="0.45"/>
              <path d="M58 22h44a6 6 0 0 1 6 6v62l-28-14-28 14V28a6 6 0 0 1 6-6z"/>
              <path d="M70 38h20" opacity="0.7"/>
              <path d="M70 50h28" opacity="0.5"/>
              <circle cx="122" cy="30" r="3" opacity="0.6"/>
              <circle cx="42" cy="82" r="2" opacity="0.6"/>
              <path d="M132 70l3 6 6 1-4.5 4.5 1 6.5-5.5-3-5.5 3 1-6.5L123 77l6-1z" opacity="0.7"/>
            </svg>
            <div class="jl-bm-empty-title">No bookmarks yet</div>
            <div class="jl-bm-empty-hint">Save this JSON endpoint to find it again — tag it for groups like <code>#auth</code> or <code>#staging</code>.</div>
            <button class="jl-btn jl-bm-empty-add" type="button">${ICONS.plus}<span>Bookmark this URL</span></button>
          </div>
          <form class="jl-bm-edit" hidden autocomplete="off">
            <div class="jl-bm-edit-title"></div>
            <label class="jl-bm-edit-field">
              <span>Name</span>
              <input class="jl-bm-edit-name" type="text" spellcheck="false" maxlength="120" />
            </label>
            <label class="jl-bm-edit-field">
              <span>Tags</span>
              <input class="jl-bm-edit-tags" type="text" spellcheck="false" placeholder="comma or space separated, e.g. auth, staging" />
            </label>
            <div class="jl-bm-edit-url"></div>
            <div class="jl-bm-edit-actions">
              <button type="button" class="jl-btn jl-btn-ghost jl-bm-edit-cancel">Cancel</button>
              <button type="submit" class="jl-btn jl-bm-edit-save">Save</button>
            </div>
          </form>
        </aside>
        <aside class="jl-pins-panel" hidden aria-label="Pinned JSON nodes">
          <div class="jl-pins-header">
            <div class="jl-pins-title">
              <span class="jl-pins-title-icon" aria-hidden="true">${ICONS.pin}</span>
              <span>Pinned nodes</span>
            </div>
            <div class="jl-pins-summary" aria-live="polite"></div>
            <div class="jl-pins-tools">
              <button class="jl-btn jl-btn-ghost jl-pins-copy" type="button" title="Copy pinned values as JSON" aria-label="Copy pinned values as JSON">${ICONS.copy}<span>Copy</span></button>
              <button class="jl-btn jl-btn-ghost jl-pins-clear" type="button" title="Unpin all" aria-label="Unpin all">${ICONS.trash}<span>Clear</span></button>
              <button class="jl-btn jl-btn-ghost jl-pins-close" type="button" title="Close pins" aria-label="Close pinned nodes">${ICONS.close}</button>
            </div>
          </div>
          <div class="jl-pins-dropzone" aria-label="Drop tree rows here to pin">
            <span class="jl-pins-dropzone-icon" aria-hidden="true">${ICONS.pin}</span>
            <span class="jl-pins-dropzone-text">Drop any row here — or click <span class="jl-pins-pinkey">pin</span> on a row</span>
          </div>
          <div class="jl-pins-body" role="list"></div>
          <div class="jl-pins-empty" hidden>
            <svg class="jl-pins-empty-art" viewBox="0 0 160 110" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 30c8-12 24-18 40-16" opacity="0.4"/>
              <path d="M86 16l28 28-10 4-14 14 4 14-10-4-22 22-4-14-14-4 22-22-4-10 14-14z"/>
              <circle cx="36" cy="82" r="2" opacity="0.5"/>
              <circle cx="128" cy="24" r="2.5" opacity="0.5"/>
              <path d="M122 70l3 6 6 1-4.5 4.5 1 6.5-5.5-3-5.5 3 1-6.5L113 77l6-1z" opacity="0.65"/>
            </svg>
            <div class="jl-pins-empty-title">Nothing pinned yet</div>
            <div class="jl-pins-empty-hint">Drag any tree row into this panel for quick cross-reference, or hit <code>p</code> with a row focused.</div>
          </div>
        </aside>
        <aside class="jl-history-panel" hidden aria-label="JSON snapshot history for this URL">
          <div class="jl-hist-header">
            <div class="jl-hist-title">
              <span class="jl-hist-title-icon" aria-hidden="true">${ICONS.history}</span>
              <span>History</span>
            </div>
            <div class="jl-hist-summary" aria-live="polite"></div>
            <div class="jl-hist-tools">
              <button class="jl-btn jl-btn-ghost jl-hist-clear" type="button" title="Clear history for this URL" aria-label="Clear history for this URL">${ICONS.trash}<span>Clear</span></button>
              <button class="jl-btn jl-btn-ghost jl-hist-close" type="button" title="Close history" aria-label="Close history">${ICONS.close}</button>
            </div>
          </div>
          <div class="jl-hist-url" title=""></div>
          <div class="jl-hist-body" role="list"></div>
          <div class="jl-hist-empty" hidden>
            <svg class="jl-hist-empty-art" viewBox="0 0 160 110" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="80" cy="55" r="34"/>
              <path d="M80 36v19l13 8"/>
              <path d="M40 55a40 40 0 1 1 14 30" opacity="0.45"/>
              <path d="M40 45v10h10" opacity="0.6"/>
              <circle cx="122" cy="24" r="2.5" opacity="0.5"/>
              <circle cx="30" cy="86" r="2" opacity="0.5"/>
            </svg>
            <div class="jl-hist-empty-title">No snapshots yet</div>
            <div class="jl-hist-empty-hint">Each time you load this JSON endpoint, a snapshot is captured automatically. We keep the last <strong>20</strong> per URL.</div>
          </div>
          <div class="jl-hist-viewer" hidden role="dialog" aria-modal="true" aria-label="Snapshot raw view">
            <div class="jl-hist-viewer-head">
              <div class="jl-hist-viewer-title"></div>
              <div class="jl-hist-viewer-tools">
                <button type="button" class="jl-btn jl-btn-ghost jl-hist-vw-copy" title="Copy snapshot JSON" aria-label="Copy snapshot JSON">${ICONS.copy}<span>Copy</span></button>
                <button type="button" class="jl-btn jl-btn-ghost jl-hist-vw-download" title="Download snapshot JSON" aria-label="Download snapshot JSON">${ICONS.download}<span>Save</span></button>
                <button type="button" class="jl-btn jl-btn-ghost jl-hist-vw-close" title="Close snapshot view" aria-label="Close snapshot view">${ICONS.close}</button>
              </div>
            </div>
            <pre class="jl-hist-viewer-pre"><code></code></pre>
          </div>
        </aside>
        <aside class="jl-queries-panel" hidden aria-label="Saved query workspace">
          <div class="jl-q-header">
            <div class="jl-q-title">
              <span class="jl-q-title-icon" aria-hidden="true">${ICONS.queries}</span>
              <span>Saved queries</span>
            </div>
            <div class="jl-q-summary" aria-live="polite"></div>
            <div class="jl-q-tools">
              <button class="jl-btn jl-q-add" type="button" title="Save current filter as a named query" aria-label="Save current filter as a named query">${ICONS.plus}<span>Save</span></button>
              <button class="jl-btn jl-btn-ghost jl-q-close" type="button" title="Close saved queries" aria-label="Close saved queries">${ICONS.close}</button>
            </div>
          </div>
          <div class="jl-q-domain">
            <span class="jl-q-domain-icon" aria-hidden="true">${ICONS.globe}</span>
            <span class="jl-q-domain-label">Domain</span>
            <span class="jl-q-domain-host"></span>
          </div>
          <div class="jl-q-search" role="search">
            <span class="jl-q-search-icon" aria-hidden="true">${ICONS.search}</span>
            <input class="jl-q-search-input" type="text" spellcheck="false" autocomplete="off"
                   placeholder="Search queries — name, expression, #tag" aria-label="Search saved queries" />
          </div>
          <div class="jl-q-body" role="list"></div>
          <div class="jl-q-empty" hidden>
            <svg class="jl-q-empty-art" viewBox="0 0 160 110" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M28 24c12-6 32-8 50-2" opacity="0.4"/>
              <rect x="40" y="24" width="68" height="60" rx="6"/>
              <path d="M50 38h40M50 50h44M50 62h28" opacity="0.65"/>
              <circle cx="112" cy="78" r="12"/>
              <path d="M120 86l8 8" />
              <path d="M132 28l3 7 7 1-5 4 1 7-6-3-6 3 1-7-5-4 7-1z" opacity="0.6"/>
            </svg>
            <div class="jl-q-empty-title">No saved queries yet</div>
            <div class="jl-q-empty-hint">Type a jq path or JSONPath expression, then click <strong>Save</strong> to name it. Queries are kept per domain so you can reuse them across endpoints on the same API.</div>
            <button class="jl-btn jl-q-empty-add" type="button">${ICONS.plus}<span>Save current query</span></button>
          </div>
          <form class="jl-q-edit" hidden autocomplete="off">
            <div class="jl-q-edit-title"></div>
            <label class="jl-q-edit-field">
              <span>Name</span>
              <input class="jl-q-edit-name" type="text" spellcheck="false" maxlength="120" placeholder="e.g. orders with errors" />
            </label>
            <label class="jl-q-edit-field">
              <span>Kind</span>
              <div class="jl-q-edit-kind" role="radiogroup" aria-label="Query kind">
                <label class="jl-q-edit-kindopt"><input type="radio" name="jl-q-kind" value="jq" /><span>jq path</span></label>
                <label class="jl-q-edit-kindopt"><input type="radio" name="jl-q-kind" value="jsonpath" /><span>JSONPath</span></label>
              </div>
            </label>
            <label class="jl-q-edit-field">
              <span>Expression</span>
              <input class="jl-q-edit-expr" type="text" spellcheck="false" placeholder=".items[].name  or  $..price" />
            </label>
            <label class="jl-q-edit-field">
              <span>Tags</span>
              <input class="jl-q-edit-tags" type="text" spellcheck="false" placeholder="comma or space separated, e.g. orders, errors" />
            </label>
            <div class="jl-q-edit-actions">
              <button type="button" class="jl-btn jl-btn-ghost jl-q-edit-cancel">Cancel</button>
              <button type="submit" class="jl-btn jl-q-edit-save">Save</button>
            </div>
          </form>
        </aside>
        <aside class="jl-settings-panel" hidden aria-label="JSON Lens settings">
          <div class="jl-set-header">
            <div class="jl-set-title">
              <span class="jl-set-title-icon" aria-hidden="true">${ICONS.gear}</span>
              <span>Settings</span>
            </div>
            <div class="jl-set-summary" aria-live="polite">Theme, font, indent, accent</div>
            <div class="jl-set-tools">
              <button class="jl-btn jl-btn-ghost jl-set-reset" type="button" title="Reset all settings to defaults" aria-label="Reset all settings">${ICONS.undo}<span>Reset</span></button>
              <button class="jl-btn jl-btn-ghost jl-set-close" type="button" title="Close settings" aria-label="Close settings">${ICONS.close}</button>
            </div>
          </div>
          <div class="jl-set-body">
            <section class="jl-set-section">
              <header class="jl-set-section-head">
                <span class="jl-set-section-icon" aria-hidden="true">${ICONS.sun}</span>
                <div class="jl-set-section-titles">
                  <div class="jl-set-section-title">Theme</div>
                  <div class="jl-set-section-hint">Auto follows your OS preference.</div>
                </div>
              </header>
              <div class="jl-set-row jl-set-theme" role="radiogroup" aria-label="Theme">
                <button type="button" class="jl-set-chip" data-set-theme="auto" aria-pressed="false"><span class="jl-set-chip-icon">${ICONS.auto}</span><span>Auto</span></button>
                <button type="button" class="jl-set-chip" data-set-theme="light" aria-pressed="false"><span class="jl-set-chip-icon">${ICONS.sun}</span><span>Light</span></button>
                <button type="button" class="jl-set-chip" data-set-theme="dark" aria-pressed="false"><span class="jl-set-chip-icon">${ICONS.moon}</span><span>Dark</span></button>
              </div>
            </section>
            <section class="jl-set-section">
              <header class="jl-set-section-head">
                <span class="jl-set-section-icon" aria-hidden="true">${ICONS.type}</span>
                <div class="jl-set-section-titles">
                  <div class="jl-set-section-title">Monospace font</div>
                  <div class="jl-set-section-hint">Used for the tree, raw view, diff, and search.</div>
                </div>
              </header>
              <div class="jl-set-row jl-set-font" role="radiogroup" aria-label="Monospace font">
                <button type="button" class="jl-set-chip jl-set-font-chip" data-set-font="jetbrains" aria-pressed="false" style="font-family: 'JetBrains Mono', ui-monospace, monospace;"><span>JetBrains</span></button>
                <button type="button" class="jl-set-chip jl-set-font-chip" data-set-font="sf" aria-pressed="false" style="font-family: 'SF Mono', ui-monospace, monospace;"><span>SF Mono</span></button>
                <button type="button" class="jl-set-chip jl-set-font-chip" data-set-font="menlo" aria-pressed="false" style="font-family: Menlo, monospace;"><span>Menlo</span></button>
                <button type="button" class="jl-set-chip jl-set-font-chip" data-set-font="fira" aria-pressed="false" style="font-family: 'Fira Code', ui-monospace, monospace;"><span>Fira Code</span></button>
                <button type="button" class="jl-set-chip jl-set-font-chip" data-set-font="cascadia" aria-pressed="false" style="font-family: 'Cascadia Code', ui-monospace, monospace;"><span>Cascadia</span></button>
                <button type="button" class="jl-set-chip jl-set-font-chip" data-set-font="system" aria-pressed="false" style="font-family: ui-monospace, monospace;"><span>System</span></button>
              </div>
              <div class="jl-set-row jl-set-fontsize">
                <label class="jl-set-label" for="jl-set-fontsize">Font size <span class="jl-set-fontsize-val" aria-live="polite">13px</span></label>
                <input id="jl-set-fontsize" class="jl-set-range" type="range" min="11" max="18" step="1" value="13" aria-label="Monospace font size" />
              </div>
            </section>
            <section class="jl-set-section">
              <header class="jl-set-section-head">
                <span class="jl-set-section-icon" aria-hidden="true">${ICONS.indent}</span>
                <div class="jl-set-section-titles">
                  <div class="jl-set-section-title">Indent width</div>
                  <div class="jl-set-section-hint">Tree nesting depth and pretty-printed JSON indentation.</div>
                </div>
              </header>
              <div class="jl-set-row jl-set-indent" role="radiogroup" aria-label="Indent width">
                <button type="button" class="jl-set-chip" data-set-indent="2" aria-pressed="false"><span>2 sp</span></button>
                <button type="button" class="jl-set-chip" data-set-indent="3" aria-pressed="false"><span>3 sp</span></button>
                <button type="button" class="jl-set-chip" data-set-indent="4" aria-pressed="false"><span>4 sp</span></button>
                <button type="button" class="jl-set-chip" data-set-indent="8" aria-pressed="false"><span>8 sp</span></button>
              </div>
            </section>
            <section class="jl-set-section">
              <header class="jl-set-section-head">
                <span class="jl-set-section-icon" aria-hidden="true">${ICONS.palette}</span>
                <div class="jl-set-section-titles">
                  <div class="jl-set-section-title">Accent color</div>
                  <div class="jl-set-section-hint">Focus rings, badges, key highlights, action chips.</div>
                </div>
              </header>
              <div class="jl-set-row jl-set-accent" role="radiogroup" aria-label="Accent color">
                <button type="button" class="jl-set-swatch" data-set-accent="#f6b352" style="--sw:#f6b352" aria-pressed="false" title="Amber" aria-label="Amber"></button>
                <button type="button" class="jl-set-swatch" data-set-accent="#7aa2ff" style="--sw:#7aa2ff" aria-pressed="false" title="Sky" aria-label="Sky"></button>
                <button type="button" class="jl-set-swatch" data-set-accent="#7a5cff" style="--sw:#7a5cff" aria-pressed="false" title="Violet" aria-label="Violet"></button>
                <button type="button" class="jl-set-swatch" data-set-accent="#3ecf8e" style="--sw:#3ecf8e" aria-pressed="false" title="Mint" aria-label="Mint"></button>
                <button type="button" class="jl-set-swatch" data-set-accent="#ff7a90" style="--sw:#ff7a90" aria-pressed="false" title="Rose" aria-label="Rose"></button>
                <button type="button" class="jl-set-swatch" data-set-accent="#ff9466" style="--sw:#ff9466" aria-pressed="false" title="Coral" aria-label="Coral"></button>
                <button type="button" class="jl-set-swatch" data-set-accent="#5cc8ff" style="--sw:#5cc8ff" aria-pressed="false" title="Cyan" aria-label="Cyan"></button>
                <label class="jl-set-swatch jl-set-swatch-custom" title="Custom color">
                  <input class="jl-set-accent-custom" type="color" value="#f6b352" aria-label="Custom accent color" />
                  <span class="jl-set-swatch-plus" aria-hidden="true">${ICONS.plus}</span>
                </label>
              </div>
            </section>
          </div>
          <div class="jl-set-foot">
            <span class="jl-set-foot-kbd">Settings persist locally on this device.</span>
          </div>
        </aside>
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

    // Inline edits: track per-path original + current values so a row can be
            // reverted and the set can be exported as a JSON Patch / curl command.
            const EDITS = new Map(); // pathStr -> { original, current }

            function refreshEditsBtn() {
              const btn = root.querySelector('[data-action="copy-curl-patch"]');
              if (!btn) return;
              const n = EDITS.size;
              const label = btn.querySelector('.jl-curl-count');
              if (label) label.textContent = n ? String(n) : "";
              btn.classList.toggle("jl-has-edits", n > 0);
              btn.disabled = n === 0;
              btn.setAttribute("aria-disabled", String(n === 0));
            }

            function rerenderPreview(node, value) {
              const row = node.querySelector(":scope > .jl-row");
              if (!row) return;
              const preview = row.querySelector(".jl-preview");
              if (!preview) return;
              preview.innerHTML = "";
              const keyHint = node.getAttribute("data-key");
              preview.appendChild(previewPrimitive(value, keyHint));
            }

            function applyEdit(node, pathStr, newValue) {
              const parent = resolveParent(parsed, pathStr);
              if (!parent.ok) { flash(root, "Edit failed"); return false; }
              const original = EDITS.has(pathStr) ? EDITS.get(pathStr).original : parent.parent[parent.last];
              parent.parent[parent.last] = newValue;
              if (Object.is(original, newValue)) {
                EDITS.delete(pathStr);
                node.classList.remove("jl-edited");
              } else {
                EDITS.set(pathStr, { original, current: newValue });
                node.classList.add("jl-edited");
              }
              rerenderPreview(node, newValue);
              refreshEditsBtn();
              return true;
            }

            function startEdit(node, pathStr) {
              if (node.classList.contains("jl-editing")) return;
              const row = node.querySelector(":scope > .jl-row");
              if (!row) return;
              const preview = row.querySelector(".jl-preview");
              if (!preview) return;
              const t = node.getAttribute("data-type");
              const parent = resolveParent(parsed, pathStr);
              if (!parent.ok) { flash(root, "Cannot edit root"); return; }
              const current = parent.parent[parent.last];
              node.classList.add("jl-editing");
              const editor = document.createElement("span");
              editor.className = "jl-edit-shell";
              const input = document.createElement("input");
              input.type = "text";
              input.className = "jl-edit-input";
              input.spellcheck = false;
              input.autocomplete = "off";
              // Pre-fill with a JSON literal so users see the type they're editing.
              input.value = t === "string" ? JSON.stringify(current) : (current === null ? "null" : String(current));
              const hint = document.createElement("span");
              hint.className = "jl-edit-hint";
              hint.textContent = "⏎ save · esc cancel · JSON literal";
              const err = document.createElement("span");
              err.className = "jl-edit-err";
              editor.appendChild(input);
              editor.appendChild(hint);
              editor.appendChild(err);
              preview.style.display = "none";
              row.insertBefore(editor, preview.nextSibling);
              input.focus();
              input.select();
              const finish = () => {
                node.classList.remove("jl-editing");
                editor.remove();
                preview.style.display = "";
              };
              input.addEventListener("keydown", (ev) => {
                if (ev.key === "Escape") { ev.preventDefault(); finish(); return; }
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  const raw = input.value.trim();
                  let parsedVal;
                  try { parsedVal = JSON.parse(raw); }
                  catch (e) { err.textContent = "Invalid JSON literal"; input.classList.add("jl-edit-bad"); return; }
                  const newType = typeOf(parsedVal);
                  if (newType === "object" || newType === "array") {
                    err.textContent = "Use container nodes for objects / arrays";
                    input.classList.add("jl-edit-bad");
                    return;
                  }
                  if (!applyEdit(node, pathStr, parsedVal)) { err.textContent = "Apply failed"; return; }
                  // Re-stamp type badge in case the literal changed type.
                  node.setAttribute("data-type", newType);
                  const badge = row.querySelector(".jl-type");
                  if (badge) { badge.setAttribute("data-type", newType); badge.textContent = newType; }
                  flash(root, "Edited " + pathStr);
                  finish();
                }
              });
              input.addEventListener("blur", () => {
                // Defer so an Enter handler runs first.
                setTimeout(() => { if (document.body.contains(editor)) finish(); }, 0);
              });
            }

            function revertEdit(node, pathStr) {
              if (!EDITS.has(pathStr)) { flash(root, "Not edited"); return; }
              const { original } = EDITS.get(pathStr);
              const parent = resolveParent(parsed, pathStr);
              if (!parent.ok) return;
              parent.parent[parent.last] = original;
              EDITS.delete(pathStr);
              node.classList.remove("jl-edited");
              const newType = typeOf(original);
              node.setAttribute("data-type", newType);
              const badge = node.querySelector(":scope > .jl-row .jl-type");
              if (badge) { badge.setAttribute("data-type", newType); badge.textContent = newType; }
              rerenderPreview(node, original);
              refreshEditsBtn();
              flash(root, "Reverted " + pathStr);
            }

            function buildCurlPatch() {
              if (EDITS.size === 0) return "";
              const ops = [];
              for (const [p, { current }] of EDITS) {
                ops.push({ op: "replace", path: pathToPointer(p), value: current });
              }
              const body = JSON.stringify(ops);
              // Escape single quotes for shell-safe interpolation inside '...'.
              const safe = body.replace(/'/g, "'\\''");
              const url = location.href.replace(/'/g, "'\\''");
              return [
                "curl -X PATCH '" + url + "' \\",
                "  -H 'Content-Type: application/json-patch+json' \\",
                "  -d '" + safe + "'",
              ].join("\n");
            }

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
        } else if (action === "copy-csv") {
          const resolved = resolvePath(parsed, pathStr);
          if (!resolved.ok) { flash(root, "Copy failed"); return; }
          const src = generateCSV(resolved.value);
          if (!src) { flash(root, "Not tabular"); return; }
          const rowCount = Math.min(resolved.value.length, CSV_SAMPLE);
          (async () => {
            try {
              await navigator.clipboard.writeText(src);
              flash(root, `Copied ${rowCount} ${rowCount === 1 ? "row" : "rows"} as CSV`);
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
        } else if (action === "edit-value") {
          startEdit(node, pathStr);
        } else if (action === "revert-value") {
          revertEdit(node, pathStr);
        } else if (action === "toggle-pin") {
          togglePin(pathStr);
        } else if (action === "toggle-note") {
          openNoteEditor(node, pathStr);
        } else if (action === "toggle-chart") {
          toggleTimeSeriesChart(node, pathStr, actionBtn);
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

    // ---------- vim-style navigation (j/k/h/l) ----------
    // j: next visible row, k: previous visible row,
    // h: collapse (or go to parent if already collapsed/leaf),
    // l: expand (or go to first child if already expanded).
    // gg/G jump to first/last visible node. Focused node gets `.jl-focused`
    // ring; scrollIntoView keeps it in view.
    let _focusedNode = null;
    let _lastG = 0;
    function visibleNodes() {
      const out = [];
      const walk = (parent) => {
        const kids = parent.children;
        for (let i = 0; i < kids.length; i++) {
          const el = kids[i];
          if (!(el instanceof Element)) continue;
          if (el.classList.contains("jl-node")) {
            if (el.classList.contains("jl-filter-hide")) continue;
            out.push(el);
            if (!el.classList.contains("jl-collapsed")) {
              const children = el.querySelector(":scope > .jl-children");
              if (children) walk(children);
            }
          } else {
            walk(el);
          }
        }
      };
      walk(tree);
      return out;
    }
    function setFocusedNode(node, opts) {
      if (!node) return;
      if (_focusedNode && _focusedNode !== node) _focusedNode.classList.remove("jl-focused");
      _focusedNode = node;
      node.classList.add("jl-focused");
      const row = node.querySelector(":scope > .jl-row");
      if (row && (!opts || opts.scroll !== false)) {
        try { row.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
      }
    }
    function hasChildren(node) {
      return !!node.querySelector(":scope > .jl-children > .jl-node");
    }
    function parentNode(node) {
      const p = node.parentElement && node.parentElement.closest(".jl-node");
      return p && tree.contains(p) ? p : null;
    }
    tree.addEventListener("focus", () => {
      if (_focusedNode && tree.contains(_focusedNode)) return;
      const all = visibleNodes();
      if (all.length) setFocusedNode(all[0], { scroll: false });
    });
    tree.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const node = target.closest(".jl-node");
      if (node && tree.contains(node)) setFocusedNode(node, { scroll: false });
    }, true);
    document.addEventListener("keydown", (ev) => {
      // Ignore when typing into inputs/textareas/contenteditable.
      const t = ev.target;
      if (t instanceof Element) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const key = ev.key;
      if (key !== "j" && key !== "k" && key !== "h" && key !== "l" && key !== "g" && key !== "G") return;
      const all = visibleNodes();
      if (!all.length) return;
      let cur = _focusedNode && tree.contains(_focusedNode) && all.indexOf(_focusedNode) >= 0
        ? _focusedNode
        : all[0];
      let idx = all.indexOf(cur);
      if (key === "j") {
        ev.preventDefault();
        setFocusedNode(all[Math.min(all.length - 1, idx + 1)]);
      } else if (key === "k") {
        ev.preventDefault();
        setFocusedNode(all[Math.max(0, idx - 1)]);
      } else if (key === "l") {
        ev.preventDefault();
        if (hasChildren(cur) && cur.classList.contains("jl-collapsed")) {
          setCollapsed(cur, false);
        } else if (hasChildren(cur)) {
          const first = cur.querySelector(":scope > .jl-children > .jl-node");
          if (first) setFocusedNode(first);
        }
      } else if (key === "h") {
        ev.preventDefault();
        if (hasChildren(cur) && !cur.classList.contains("jl-collapsed")) {
          setCollapsed(cur, true);
        } else {
          const p = parentNode(cur);
          if (p) setFocusedNode(p);
        }
      } else if (key === "G") {
        ev.preventDefault();
        setFocusedNode(all[all.length - 1]);
      } else if (key === "g") {
        ev.preventDefault();
        const now = Date.now();
        if (now - _lastG < 500) {
          setFocusedNode(all[0]);
          _lastG = 0;
        } else {
          _lastG = now;
        }
      }
    }, true);

    // actions
    // ---------- pretty / minify toggle ----------
    // `compact === false` => pretty-printed with 2-space indent (default).
    // `compact === true`  => single-line minified output.
    // Affects: raw view, Copy, Download. Tree view is unaffected.
    let compact = false;
    const indentSize = () => (ns.settings && ns.settings.indent) || SETTINGS_DEFAULTS.indent;
    const serialize = () => compact ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indentSize());
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
    root.querySelector('[data-action="snapshot"]').addEventListener("click", () => {
      try {
        const base = (location.pathname.split("/").pop() || "document").replace(/\.json$/i, "") || "document";
        const html = buildStandaloneSnapshot({
          value: parsed,
          sourceUrl: location.href,
          title: `${base} — JSON Lens snapshot`,
        });
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${base}.snapshot.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        flash(root, "Snapshot saved");
      } catch (err) {
        flash(root, "Snapshot failed");
      }
    });
    const curlBtn = root.querySelector('[data-action="copy-curl-patch"]');
    if (curlBtn) {
      curlBtn.addEventListener("click", async () => {
        if (EDITS.size === 0) { flash(root, "No edits to PATCH"); return; }
        const cmd = buildCurlPatch();
        try {
          await navigator.clipboard.writeText(cmd);
          flash(root, `Copied curl PATCH (${EDITS.size})`);
        } catch {
          flash(root, "Copy failed");
        }
      });
    }
    refreshEditsBtn();
    root.querySelector('[data-action="expand"]').addEventListener("click", () => {
      setAllCollapsed(tree, false);
      flash(root, "Expanded");
    });
    root.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      setAllCollapsed(tree, true);
      flash(root, "Collapsed");
    });
    // ---------- heatmap wiring ----------
    // Walk parsed JSON. For each array, group numeric leaves either by
    // "" (when items are numbers directly) or by relative path within each
    // item object. Within each group, normalize values to [0,1] using min/max
    // and tag the matching DOM node so CSS can paint a magnitude pill.
    const heatBtn = root.querySelector('[data-action="heatmap"]');
    if (heatBtn) {
      const computeHeatmap = (rootVal) => {
        const heat = new Map();
        const segFor = (k) => {
          if (typeof k === "number") return `[${k}]`;
          return IDENT_RE.test(k) ? "." + k : `["${String(k).replace(/\\/g,"\\\\").replace(/"/g,'\\"')}"]`;
        };
        const collectLeaves = (obj, basePath, relPrefix, groups) => {
          for (const k of Object.keys(obj)) {
            const val = obj[k];
            const rel = relPrefix + segFor(k);
            if (typeof val === "number" && Number.isFinite(val)) {
              if (!groups.has(rel)) groups.set(rel, []);
              groups.get(rel).push({ path: basePath + rel, val });
            } else if (val && typeof val === "object" && !Array.isArray(val)) {
              collectLeaves(val, basePath, rel, groups);
            }
          }
        };
        const walk = (value, pathStr) => {
          if (Array.isArray(value)) {
            const groups = new Map();
            for (let i = 0; i < value.length; i++) {
              const item = value[i];
              const itemPath = pathStr + "[" + i + "]";
              if (typeof item === "number" && Number.isFinite(item)) {
                if (!groups.has("")) groups.set("", []);
                groups.get("").push({ path: itemPath, val: item });
              } else if (item && typeof item === "object" && !Array.isArray(item)) {
                collectLeaves(item, itemPath, "", groups);
              }
              walk(item, itemPath);
            }
            for (const [, arr] of groups) {
              if (arr.length < 2) continue;
              let min = Infinity, max = -Infinity;
              for (const e of arr) { if (e.val < min) min = e.val; if (e.val > max) max = e.val; }
              const range = max - min;
              for (const e of arr) {
                heat.set(e.path, range === 0 ? 0.5 : (e.val - min) / range);
              }
            }
          } else if (value && typeof value === "object") {
            for (const k of Object.keys(value)) {
              walk(value[k], joinPath(pathStr, k));
            }
          }
        };
        walk(rootVal, "$");
        return heat;
      };
      const applyHeatmap = (heat) => {
        const nodes = tree.querySelectorAll('.jl-node[data-type="number"]');
        let painted = 0;
        nodes.forEach((n) => {
          const p = n.getAttribute("data-path");
          const h = p ? heat.get(p) : undefined;
          const numEl = n.querySelector(":scope > .jl-row .jl-preview .jl-num");
          if (!numEl) return;
          if (h === undefined) {
            numEl.classList.remove("jl-heat-val");
            numEl.style.removeProperty("--jl-heat");
          } else {
            numEl.classList.add("jl-heat-val");
            numEl.style.setProperty("--jl-heat", h.toFixed(4));
            painted++;
          }
        });
        return painted;
      };
      const clearHeatmap = () => {
        tree.querySelectorAll(".jl-num.jl-heat-val").forEach((el) => {
          el.classList.remove("jl-heat-val");
          el.style.removeProperty("--jl-heat");
        });
      };
      heatBtn.addEventListener("click", () => {
        const on = root.classList.toggle("jl-heatmap");
        heatBtn.setAttribute("aria-pressed", String(on));
        if (on) {
          // Heatmap needs the full tree in DOM; drain perf-mode lazy nodes
          // so deeper numeric leaves get painted too.
          if (PERF_MODE) materializeAll(tree);
          const heat = computeHeatmap(parsed);
          const painted = applyHeatmap(heat);
          flash(root, painted > 0 ? `Heatmap on — ${painted} value${painted === 1 ? "" : "s"}` : "Heatmap on — no comparable arrays");
        } else {
          clearHeatmap();
          flash(root, "Heatmap off");
        }
      });
    }
    // ---------- inline time-series chart wiring ----------
    // Each container row exposing a Chart action toggles a small inline panel
    // hosting a hand-rolled SVG line chart. Hover/move snaps to the nearest
    // point, showing timestamp + value in a floating tooltip.
    function toggleTimeSeriesChart(node, pathStr, btn) {
      const existing = node.querySelector(":scope > .jl-chart");
      if (existing) {
        existing.remove();
        if (btn) btn.setAttribute("aria-pressed", "false");
        flash(root, "Chart hidden");
        return;
      }
      const resolved = resolvePath(parsed, pathStr);
      if (!resolved.ok || !Array.isArray(resolved.value)) { flash(root, "Chart unavailable"); return; }
      const series = detectTimeSeries(resolved.value);
      if (!series) { flash(root, "Not a time series"); return; }
      const chart = buildTimeSeriesChart(series);
      const wrap = document.createElement("div");
      wrap.className = "jl-chart";
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", `Time series chart — ${series.points.length} points, ${escapeHTML(series.valKey)} over ${escapeHTML(series.tsKey)}`);
      const head = document.createElement("div");
      head.className = "jl-chart-head";
      head.innerHTML = `
        <span class="jl-chart-icon" aria-hidden="true">${ICONS.chart}</span>
        <span class="jl-chart-title"><code>${escapeHTML(series.valKey)}</code> over <code>${escapeHTML(series.tsKey)}</code></span>
        <span class="jl-chart-meta"><span class="jl-chart-points">${series.points.length} points</span></span>
        <button type="button" class="jl-icon-btn jl-chart-close" title="Close chart" aria-label="Close chart">${ICONS.close}</button>
      `;
      wrap.appendChild(head);
      const body = document.createElement("div");
      body.className = "jl-chart-body";
      body.appendChild(chart.svg);
      const tip = document.createElement("div");
      tip.className = "jl-chart-tip";
      tip.hidden = true;
      tip.innerHTML = `<span class="jl-chart-tip-t"></span><span class="jl-chart-tip-v"></span>`;
      body.appendChild(tip);
      wrap.appendChild(body);
      node.appendChild(wrap);

      const tipT = tip.querySelector(".jl-chart-tip-t");
      const tipV = tip.querySelector(".jl-chart-tip-v");
      const findNearestIdx = (xPx) => {
        const pts = chart.pts;
        let lo = 0, hi = pts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (chart.xOf(pts[mid].t) < xPx) lo = mid + 1; else hi = mid;
        }
        if (lo > 0 && Math.abs(chart.xOf(pts[lo - 1].t) - xPx) < Math.abs(chart.xOf(pts[lo].t) - xPx)) lo--;
        return lo;
      };
      const showHover = (clientX) => {
        const rect = chart.svg.getBoundingClientRect();
        const ratio = chart.W / rect.width;
        const xPx = (clientX - rect.left) * ratio;
        if (xPx < chart.PAD_L || xPx > chart.W - chart.PAD_R) { hideHover(); return; }
        const idx = findNearestIdx(xPx);
        const p = chart.pts[idx];
        const cx = chart.xOf(p.t);
        const cy = chart.yOf(p.v);
        chart.vline.setAttribute("x1", String(cx));
        chart.vline.setAttribute("x2", String(cx));
        chart.hdot.setAttribute("cx", String(cx));
        chart.hdot.setAttribute("cy", String(cy));
        chart.hover.setAttribute("opacity", "1");
        tip.hidden = false;
        tipT.textContent = new Date(p.t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
        tipV.textContent = fmtChartValue(p.v);
        const xPct = (cx / chart.W) * 100;
        tip.style.left = xPct.toFixed(2) + "%";
        tip.style.top = ((chart.PAD_T - 4) / 240 * 100).toFixed(2) + "%";
        tip.classList.toggle("jl-chart-tip-right", xPct > 60);
      };
      const hideHover = () => {
        chart.hover.setAttribute("opacity", "0");
        tip.hidden = true;
      };
      chart.svg.addEventListener("pointermove", (ev) => showHover(ev.clientX));
      chart.svg.addEventListener("pointerleave", hideHover);
      head.querySelector(".jl-chart-close").addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleTimeSeriesChart(node, pathStr, btn);
      });
      if (btn) btn.setAttribute("aria-pressed", "true");
      if (node.classList.contains("jl-collapsed")) setCollapsed(node, false);
      flash(root, `Chart on — ${series.points.length} points`);
    }
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
    // ---------- settings panel wiring ----------
    const setBtn = root.querySelector('[data-action="settings"]');
    const setPanel = root.querySelector(".jl-settings-panel");
    const setCloseBtn = root.querySelector(".jl-set-close");
    const setResetBtn = root.querySelector(".jl-set-reset");
    const setThemeRow = root.querySelector(".jl-set-theme");
    const setFontRow = root.querySelector(".jl-set-font");
    const setFontSize = root.querySelector("#jl-set-fontsize");
    const setFontSizeVal = root.querySelector(".jl-set-fontsize-val");
    const setIndentRow = root.querySelector(".jl-set-indent");
    const setAccentRow = root.querySelector(".jl-set-accent");
    const setAccentCustom = root.querySelector(".jl-set-accent-custom");

    function refreshSettingsUI() {
      const s = ns.settings || readSettings();
      // theme chips reflect current theme pref
      const themePref = readThemePref();
      setThemeRow.querySelectorAll("button[data-set-theme]").forEach((b) => {
        b.setAttribute("aria-pressed", b.dataset.setTheme === themePref ? "true" : "false");
      });
      setFontRow.querySelectorAll("button[data-set-font]").forEach((b) => {
        b.setAttribute("aria-pressed", b.dataset.setFont === s.font ? "true" : "false");
      });
      setFontSize.value = String(s.fontSize);
      setFontSizeVal.textContent = `${s.fontSize}px`;
      setIndentRow.querySelectorAll("button[data-set-indent]").forEach((b) => {
        b.setAttribute("aria-pressed", Number(b.dataset.setIndent) === s.indent ? "true" : "false");
      });
      let matchedSwatch = false;
      setAccentRow.querySelectorAll("button[data-set-accent]").forEach((b) => {
        const match = b.dataset.setAccent.toLowerCase() === s.accent.toLowerCase();
        b.setAttribute("aria-pressed", match ? "true" : "false");
        if (match) matchedSwatch = true;
      });
      setAccentCustom.value = s.accent;
      setAccentCustom.closest(".jl-set-swatch-custom").style.setProperty("--sw", s.accent);
      setAccentCustom.closest(".jl-set-swatch-custom").classList.toggle("jl-set-swatch-active", !matchedSwatch);
    }

    function updateSettings(patch, opts) {
      const next = normalizeSettings({ ...(ns.settings || readSettings()), ...patch });
      writeSettings(next);
      applySettings(next);
      refreshSettingsUI();
      if (opts && opts.flash) flash(root, opts.flash);
    }

    function setSettingsOpen(open) {
      setPanel.hidden = !open;
      setBtn.setAttribute("aria-pressed", String(!!open));
      root.classList.toggle("jl-settings-open", !!open);
      if (open) refreshSettingsUI();
    }

    if (setBtn) setBtn.addEventListener("click", () => setSettingsOpen(setPanel.hidden));
    setCloseBtn.addEventListener("click", () => setSettingsOpen(false));
    setResetBtn.addEventListener("click", () => {
      writeSettings(SETTINGS_DEFAULTS);
      applySettings({ ...SETTINGS_DEFAULTS });
      refreshSettingsUI();
      flash(root, "Settings reset to defaults");
    });

    setThemeRow.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-set-theme]");
      if (!btn) return;
      setThemePref(btn.dataset.setTheme);
      refreshSettingsUI();
    });
    setFontRow.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-set-font]");
      if (!btn) return;
      updateSettings({ font: btn.dataset.setFont });
    });
    setFontSize.addEventListener("input", () => {
      setFontSizeVal.textContent = `${setFontSize.value}px`;
      updateSettings({ fontSize: Number(setFontSize.value) });
    });
    setIndentRow.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-set-indent]");
      if (!btn) return;
      const next = Number(btn.dataset.setIndent);
      updateSettings({ indent: next });
      if (root.classList.contains("jl-raw-mode")) {
        root.querySelector(".jl-raw code").textContent = serialize();
      }
    });
    setAccentRow.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-set-accent]");
      if (!btn) return;
      updateSettings({ accent: btn.dataset.setAccent });
    });
    setAccentCustom.addEventListener("input", () => {
      if (HEX_RE.test(setAccentCustom.value)) updateSettings({ accent: setAccentCustom.value });
    });
    refreshSettingsUI();
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
    const searchMirror = root.querySelector(".jl-search-mirror");
    const searchRegexBtn = root.querySelector(".jl-search-regex");
    let searchMatches = [];
    let searchIdx = -1;
    let searchTimer = 0;
    let searchRegexMode = false;

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
      if (searchRegexMode) renderRegexMirror(searchMirror, value);
      else searchMirror.textContent = "";
      if (!has) {
        clearSearch(tree);
        searchMatches = [];
        searchIdx = -1;
        searchStatus.textContent = "";
        searchPrev.disabled = true;
        searchNext.disabled = true;
        searchRow.classList.remove("jl-search-empty", "jl-search-error");
        return;
      }
      const result = applySearch(tree, value, { regex: searchRegexMode });
      if (result.error) {
        searchMatches = [];
        searchIdx = -1;
        searchPrev.disabled = true;
        searchNext.disabled = true;
        searchRow.classList.add("jl-search-error");
        searchRow.classList.remove("jl-search-empty");
        searchStatus.textContent = result.error;
        return;
      }
      searchRow.classList.remove("jl-search-error");
      const matches = result.matches;
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
      // Keep the highlighted mirror in lock-step with typing (no debounce).
      if (searchRegexMode) renderRegexMirror(searchMirror, val);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(val), 80);
    });
    searchInput.addEventListener("scroll", () => {
      // Keep mirror aligned when the input scrolls horizontally.
      searchMirror.scrollLeft = searchInput.scrollLeft;
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
    // Regex-mode toggle — lights up the input with token highlighting.
    searchRegexBtn.addEventListener("click", () => {
      searchRegexMode = !searchRegexMode;
      searchRegexBtn.setAttribute("aria-checked", searchRegexMode ? "true" : "false");
      searchRegexBtn.classList.toggle("jl-search-regex-on", searchRegexMode);
      searchRow.classList.toggle("jl-search-regex-mode", searchRegexMode);
      runSearch(searchInput.value);
      searchInput.focus();
    });
    // ⌘⇧K / Ctrl+⇧K focuses search (⌘K is reserved for the command palette)
    document.addEventListener("keydown", (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.shiftKey && (ev.key === "k" || ev.key === "K")) {
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
    const diffBody = root.querySelector(".jl-diff-body");
    const diffSchemaBody = root.querySelector(".jl-diff-schema-body");
    const diffSchemaEmpty = root.querySelector(".jl-diff-schema-empty");
    const diffModeBtns = root.querySelectorAll(".jl-diff-mode-btn");
    let diffMode = "values"; // "values" | "schemas"
    let diffSchemaRows = [];
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
      if (diffMode === "schemas") {
        if (!diffSchemaRows.length) { flash(root, "No schema diff yet"); return; }
        try {
          await navigator.clipboard.writeText(JSON.stringify(diffSchemaRows, null, 2));
          flash(root, "Schema diff copied");
        } catch { flash(root, "Copy failed"); }
        return;
      }
      if (!diffOps.length) { flash(root, "No diff yet"); return; }
      try {
        await navigator.clipboard.writeText(JSON.stringify(diffOps, null, 2));
        flash(root, "Patch copied");
      } catch { flash(root, "Copy failed"); }
    });

    function setDiffMode(next) {
      if (next !== "values" && next !== "schemas") return;
      diffMode = next;
      diffModeBtns.forEach((b) => {
        const on = b.getAttribute("data-diff-mode") === next;
        b.classList.toggle("jl-diff-mode-active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      diffPanel.classList.toggle("jl-diff-mode-schemas", next === "schemas");
      diffBody.hidden = next === "schemas";
      diffSchemaBody.hidden = next !== "schemas";
      diffSchemaEmpty.hidden = true;
      diffCopyBtn.title = next === "schemas" ? "Copy schema diff as JSON" : "Copy diff as JSON Patch";
      diffCopyBtn.setAttribute("aria-label", diffCopyBtn.title);
      const label = diffCopyBtn.querySelector("span");
      if (label) label.textContent = next === "schemas" ? "JSON" : "Patch";
      // Re-render existing data on mode switch if we have both sides loaded.
      if (diffSideB !== null) renderDiffResult();
      else { diffSummary.textContent = ""; }
    }
    diffModeBtns.forEach((b) => {
      b.addEventListener("click", () => setDiffMode(b.getAttribute("data-diff-mode")));
    });

    function renderSchemaDiff(rows) {
      diffSchemaBody.innerHTML = "";
      if (!rows.length) {
        diffSchemaEmpty.hidden = false;
        return;
      }
      diffSchemaEmpty.hidden = true;
      // Group by kind for tidy presentation.
      const order = ["added", "removed", "type-changed", "optional-changed"];
      const kindLabel = {
        added: "Added in B",
        removed: "Removed in B",
        "type-changed": "Type changed",
        "optional-changed": "Optionality changed",
      };
      const groups = new Map();
      for (const k of order) groups.set(k, []);
      for (const r of rows) {
        if (!groups.has(r.kind)) groups.set(r.kind, []);
        groups.get(r.kind).push(r);
      }
      const frag = document.createDocumentFragment();
      for (const [kind, list] of groups) {
        if (!list.length) continue;
        const sect = document.createElement("section");
        sect.className = "jl-sd-group jl-sd-group-" + kind;
        const head = document.createElement("div");
        head.className = "jl-sd-group-head";
        const badge = document.createElement("span");
        badge.className = "jl-sd-kind jl-sd-kind-" + kind;
        badge.textContent = kindLabel[kind] || kind;
        head.appendChild(badge);
        const count = document.createElement("span");
        count.className = "jl-sd-count";
        count.textContent = `${list.length} ${list.length === 1 ? "path" : "paths"}`;
        head.appendChild(count);
        sect.appendChild(head);
        const ul = document.createElement("div");
        ul.className = "jl-sd-rows";
        for (const r of list) {
          const row = document.createElement("div");
          row.className = "jl-sd-row";
          row.setAttribute("role", "listitem");
          const pathEl = document.createElement("button");
          pathEl.type = "button";
          pathEl.className = "jl-sd-path";
          pathEl.title = "Copy path";
          pathEl.textContent = r.path;
          pathEl.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(r.path); flash(root, "Path copied"); }
            catch { flash(root, "Copy failed"); }
          });
          row.appendChild(pathEl);
          const detail = document.createElement("span");
          detail.className = "jl-sd-detail";
          if (kind === "added") {
            detail.innerHTML = renderTypeBadges(r.bTypes, "b") + ` <span class="jl-sd-meta">${r.bCount}×</span>`;
          } else if (kind === "removed") {
            detail.innerHTML = renderTypeBadges(r.aTypes, "a") + ` <span class="jl-sd-meta">${r.aCount}×</span>`;
          } else if (kind === "type-changed") {
            detail.innerHTML = renderTypeBadges(r.aTypes, "a") + ` <span class="jl-sd-arrow" aria-hidden="true">${ICONS.diffArrow}</span> ` + renderTypeBadges(r.bTypes, "b");
          } else if (kind === "optional-changed") {
            const pa = Math.round(r.aRatio * 100);
            const pb = Math.round(r.bRatio * 100);
            detail.innerHTML = `<span class="jl-sd-pct jl-sd-pct-a">${pa}%</span> <span class="jl-sd-arrow" aria-hidden="true">${ICONS.diffArrow}</span> <span class="jl-sd-pct jl-sd-pct-b">${pb}%</span>`;
          }
          row.appendChild(detail);
          ul.appendChild(row);
        }
        sect.appendChild(ul);
        frag.appendChild(sect);
      }
      diffSchemaBody.appendChild(frag);
    }

    function renderTypeBadges(types, side) {
      if (!types || !types.length) return `<span class="jl-sd-type jl-sd-type-absent">—</span>`;
      return types.map((t) => `<span class="jl-sd-type jl-sd-type-${t} jl-sd-side-${side}">${t}</span>`).join("");
    }

    function renderDiffResult() {
      if (diffSideB === null) return;
      if (diffMode === "schemas") {
        const schemaA = inferSchema(diffSideA);
        const schemaB = inferSchema(diffSideB);
        diffSchemaRows = compareSchemas(schemaA, schemaB);
        const counts = { added: 0, removed: 0, "type-changed": 0, "optional-changed": 0 };
        for (const r of diffSchemaRows) counts[r.kind] = (counts[r.kind] || 0) + 1;
        diffSummary.textContent = diffSchemaRows.length === 0
          ? "schemas match"
          : `${diffSchemaRows.length} schema diff${diffSchemaRows.length === 1 ? "" : "s"} · +${counts.added} −${counts.removed} ⇄${counts["type-changed"]} ?${counts["optional-changed"]}`;
        renderSchemaDiff(diffSchemaRows);
      } else {
        diffOps = computeDiff(diffSideA, diffSideB);
        const counts = { add: 0, remove: 0, replace: 0 };
        diffOps.forEach((o) => { counts[o.op] = (counts[o.op] || 0) + 1; });
        diffSummary.textContent = diffOps.length === 0
          ? "identical"
          : `${diffOps.length} change${diffOps.length === 1 ? "" : "s"} · +${counts.add} −${counts.remove} ~${counts.replace}`;
        diffPaneA.innerHTML = "";
        diffPaneB.innerHTML = "";
        renderDiffPane(diffPaneA, diffSideA, diffOps, "a");
        renderDiffPane(diffPaneB, diffSideB, diffOps, "b");
      }
    }

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
      diffSchemaBody.innerHTML = "";
      diffSchemaEmpty.hidden = true;
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
        renderDiffResult();
        diffStatus.textContent = "";
      } catch (err) {
        diffStatus.textContent = err && err.message ? err.message : "Diff failed";
      } finally {
        diffPanel.classList.remove("jl-diff-loading");
      }
    });

    // Expose for debugging/tests
    ns.computeDiff = computeDiff;

    // ---------- JSONPath evaluator ----------
    // A subset of Stefan Gössner's JSONPath spec, enough to be useful without
    // pulling a dependency or eval-ing arbitrary JS:
    //   $              root
    //   .key  ['key']  child (dot or bracket-quoted)
    //   .*    [*]      wildcard (all children / elements)
    //   ..key  ..*     recursive descent
    //   [N]            array index (negative ok)
    //   [a,b,c]        union of indices/keys
    //   [start:end:step] slice
    //   [?(<expr>)]    filter; expr supports @.<key> / @['k'] / @, numeric &
    //                  string literals, ==, !=, <, <=, >, >=, &&, ||, !, parens
    function jpTokenize(input) {
      const s = String(input || "").trim();
      if (!s) return { error: "empty expression" };
      let i = 0;
      if (s[i] === "$") i++;
      else if (s[i] !== "." && s[i] !== "[") return { error: "must start with $" };
      const tokens = [{ kind: "root" }];
      while (i < s.length) {
        const ch = s[i];
        if (ch === "." && s[i + 1] === ".") {
          i += 2;
          if (s[i] === "*") { tokens.push({ kind: "rdesc", wildcard: true }); i++; }
          else if (s[i] === "[") {
            // ..[ — recurse then bracket; emit rdesc-all marker then bracket
            tokens.push({ kind: "rdesc", wildcard: true });
            // re-process bracket on next iter
          } else {
            const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
            if (!m) return { error: "expected identifier after '..'" };
            tokens.push({ kind: "rdesc", name: m[0] });
            i += m[0].length;
          }
        } else if (ch === ".") {
          i++;
          if (s[i] === "*") { tokens.push({ kind: "wildcard" }); i++; }
          else {
            const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
            if (!m) return { error: "expected identifier after '.'" };
            tokens.push({ kind: "key", name: m[0] });
            i += m[0].length;
          }
        } else if (ch === "[") {
          // find matching ']' — respect quoted strings
          let j = i + 1, depth = 1, inStr = null;
          while (j < s.length && depth) {
            const c = s[j];
            if (inStr) {
              if (c === "\\") j += 2;
              else { if (c === inStr) inStr = null; j++; }
            } else if (c === "'" || c === '"') { inStr = c; j++; }
            else if (c === "[") { depth++; j++; }
            else if (c === "]") { depth--; if (!depth) break; j++; }
            else j++;
          }
          if (depth) return { error: "missing ']'" };
          const inner = s.slice(i + 1, j).trim();
          i = j + 1;
          if (inner === "*") tokens.push({ kind: "wildcard" });
          else if (/^-?\d+$/.test(inner)) tokens.push({ kind: "index", value: Number(inner) });
          else if (inner.startsWith("?")) {
            // [?(<expr>)] or [?<expr>]
            let expr = inner.slice(1).trim();
            if (expr.startsWith("(") && expr.endsWith(")")) expr = expr.slice(1, -1);
            tokens.push({ kind: "filter", expr });
          } else if (inner.includes(":") && !/^['"]/.test(inner)) {
            const parts = inner.split(":").map((p) => p.trim());
            const toN = (p) => p === "" ? undefined : Number(p);
            const start = toN(parts[0]); const end = toN(parts[1]); const step = toN(parts[2]);
            if ([start, end, step].some((v) => v !== undefined && Number.isNaN(v))) return { error: "bad slice" };
            tokens.push({ kind: "slice", start, end, step });
          } else if (inner.includes(",")) {
            const parts = splitUnion(inner);
            if (!parts) return { error: "bad union" };
            tokens.push({ kind: "union", parts });
          } else if (/^['"]/.test(inner)) {
            const q = inner[0];
            if (!inner.endsWith(q) || inner.length < 2) return { error: "bad quoted key" };
            tokens.push({ kind: "key", name: unquote(inner) });
          } else return { error: "bad bracket: " + inner };
        } else {
          return { error: "unexpected '" + ch + "'" };
        }
      }
      return { tokens };
    }
    function splitUnion(inner) {
      const out = [];
      let i = 0, buf = "", inStr = null;
      while (i < inner.length) {
        const c = inner[i];
        if (inStr) { buf += c; if (c === "\\") { buf += inner[i + 1] || ""; i += 2; continue; } if (c === inStr) inStr = null; i++; continue; }
        if (c === "'" || c === '"') { inStr = c; buf += c; i++; continue; }
        if (c === ",") { out.push(buf.trim()); buf = ""; i++; continue; }
        buf += c; i++;
      }
      if (inStr) return null;
      if (buf.trim() !== "") out.push(buf.trim());
      return out.map((p) => {
        if (/^-?\d+$/.test(p)) return { kind: "index", value: Number(p) };
        if (/^['"]/.test(p)) return { kind: "key", name: unquote(p) };
        return { kind: "key", name: p };
      });
    }
    function unquote(p) {
      const q = p[0];
      return p.slice(1, -1).replace(new RegExp("\\\\" + q, "g"), q).replace(/\\\\/g, "\\");
    }

    // Filter expression parser — produces a predicate (ctx) => boolean.
    function compileFilterExpr(src) {
      const toks = [];
      let i = 0;
      const s = String(src);
      while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === "@") { toks.push({ t: "cur" }); i++; continue; }
        if (c === "(" || c === ")") { toks.push({ t: c }); i++; continue; }
        if (c === "!" && s[i + 1] !== "=") { toks.push({ t: "!" }); i++; continue; }
        if (c === "&" && s[i + 1] === "&") { toks.push({ t: "&&" }); i += 2; continue; }
        if (c === "|" && s[i + 1] === "|") { toks.push({ t: "||" }); i += 2; continue; }
        if (c === "=" && s[i + 1] === "=") { toks.push({ t: "cmp", v: "==" }); i += 2; continue; }
        if (c === "!" && s[i + 1] === "=") { toks.push({ t: "cmp", v: "!=" }); i += 2; continue; }
        if ((c === "<" || c === ">") && s[i + 1] === "=") { toks.push({ t: "cmp", v: c + "=" }); i += 2; continue; }
        if (c === "<" || c === ">") { toks.push({ t: "cmp", v: c }); i++; continue; }
        if (c === "." && toks.length && toks[toks.length - 1].t === "cur") {
          // @.identifier  / @.* not supported here; consume identifier as accessor on prev cur node
          i++;
          const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
          if (!m) return { error: "expected identifier after '@.'" };
          const prev = toks[toks.length - 1];
          prev.path = (prev.path || []).concat([m[0]]);
          i += m[0].length;
          continue;
        }
        if (c === "[" && toks.length && toks[toks.length - 1].t === "cur") {
          const end = s.indexOf("]", i);
          if (end < 0) return { error: "missing ']' in @[…]" };
          const inside = s.slice(i + 1, end).trim();
          let key;
          if (/^['"]/.test(inside)) key = unquote(inside);
          else if (/^-?\d+$/.test(inside)) key = Number(inside);
          else return { error: "unsupported @[…]" };
          const prev = toks[toks.length - 1];
          prev.path = (prev.path || []).concat([key]);
          i = end + 1;
          continue;
        }
        if (c === "'" || c === '"') {
          let j = i + 1;
          while (j < s.length && s[j] !== c) { if (s[j] === "\\") j++; j++; }
          if (j >= s.length) return { error: "unterminated string" };
          toks.push({ t: "lit", v: s.slice(i + 1, j).replace(/\\(.)/g, "$1") });
          i = j + 1; continue;
        }
        if (/[-0-9.]/.test(c)) {
          const m = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
          if (m) { toks.push({ t: "lit", v: Number(m[0]) }); i += m[0].length; continue; }
        }
        if (/[A-Za-z_]/.test(c)) {
          const m = /^[A-Za-z_][\w]*/.exec(s.slice(i));
          const word = m[0]; i += word.length;
          if (word === "true") toks.push({ t: "lit", v: true });
          else if (word === "false") toks.push({ t: "lit", v: false });
          else if (word === "null") toks.push({ t: "lit", v: null });
          else return { error: "unknown identifier '" + word + "'" };
          continue;
        }
        return { error: "unexpected '" + c + "'" };
      }
      // Pratt-ish recursive descent: or > and > not > cmp > primary
      let p = 0;
      function peek() { return toks[p]; }
      function eat(t, v) { const tk = toks[p]; if (!tk) return null; if (tk.t === t && (v === undefined || tk.v === v)) { p++; return tk; } return null; }
      function getCur(node, accessors) {
        if (!accessors || !accessors.length) return node;
        let cur = node;
        for (const a of accessors) {
          if (cur == null) return undefined;
          cur = cur[a];
        }
        return cur;
      }
      function parsePrimary() {
        const tk = toks[p];
        if (!tk) return { error: "unexpected end" };
        if (tk.t === "(") { p++; const e = parseOr(); if (e.error) return e; if (!eat(")")) return { error: "missing ')'" }; return e; }
        if (tk.t === "!") { p++; const e = parsePrimary(); if (e.error) return e; return { fn: (n) => !e.fn(n) }; }
        if (tk.t === "lit") { p++; return { fn: () => tk.v, isLit: true, val: tk.v }; }
        if (tk.t === "cur") { p++; const acc = tk.path || []; return { fn: (n) => getCur(n, acc), isCur: true }; }
        return { error: "unexpected token" };
      }
      function parseCmp() {
        const left = parsePrimary(); if (left.error) return left;
        const tk = peek();
        if (tk && tk.t === "cmp") {
          p++;
          const right = parsePrimary(); if (right.error) return right;
          const op = tk.v;
          return { fn: (n) => {
            const a = left.fn(n), b = right.fn(n);
            switch (op) {
              case "==": return a == b;
              case "!=": return a != b;
              case "<": return a < b;
              case "<=": return a <= b;
              case ">": return a > b;
              case ">=": return a >= b;
            }
            return false;
          }};
        }
        // truthy fallback (e.g. ?(@.flag))
        return { fn: (n) => Boolean(left.fn(n)) };
      }
      function parseAnd() {
        let left = parseCmp(); if (left.error) return left;
        while (peek() && peek().t === "&&") { p++; const r = parseCmp(); if (r.error) return r; const L = left; left = { fn: (n) => L.fn(n) && r.fn(n) }; }
        return left;
      }
      function parseOr() {
        let left = parseAnd(); if (left.error) return left;
        while (peek() && peek().t === "||") { p++; const r = parseAnd(); if (r.error) return r; const L = left; left = { fn: (n) => L.fn(n) || r.fn(n) }; }
        return left;
      }
      const out = parseOr();
      if (out.error) return out;
      if (p !== toks.length) return { error: "trailing tokens at " + p };
      return { predicate: (n) => Boolean(out.fn(n)) };
    }

    function evalJsonPath(rootVal, expr) {
      const tk = jpTokenize(expr);
      if (tk.error) return { error: tk.error };
      // Each result item: { value, path: string (e.g. $.a[0].b) }
      let current = [{ value: rootVal, path: "$" }];
      for (const t of tk.tokens) {
        if (t.kind === "root") continue;
        const next = [];
        if (t.kind === "key") {
          for (const c of current) {
            const v = c.value;
            if (v && typeof v === "object" && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, t.name)) {
              next.push({ value: v[t.name], path: joinPath(c.path, t.name) });
            }
          }
        } else if (t.kind === "wildcard") {
          for (const c of current) {
            const v = c.value;
            if (Array.isArray(v)) v.forEach((x, i) => next.push({ value: x, path: joinPath(c.path, i) }));
            else if (v && typeof v === "object") Object.keys(v).forEach((k) => next.push({ value: v[k], path: joinPath(c.path, k) }));
          }
        } else if (t.kind === "rdesc") {
          // collect this and all descendants; if t.name, keep only those whose last segment matches
          const visit = (val, path) => {
            if (t.wildcard) {
              if (path !== current[0].path) next.push({ value: val, path });
            }
            if (Array.isArray(val)) val.forEach((x, i) => {
              const np = joinPath(path, i);
              if (t.name === undefined) { /* wildcard handled above */ } 
              visit(x, np);
            });
            else if (val && typeof val === "object") Object.keys(val).forEach((k) => {
              const np = joinPath(path, k);
              if (t.name !== undefined && k === t.name) next.push({ value: val[k], path: np });
              visit(val[k], np);
            });
          };
          for (const c of current) visit(c.value, c.path);
        } else if (t.kind === "index") {
          for (const c of current) {
            const v = c.value;
            if (Array.isArray(v)) {
              const idx = t.value < 0 ? v.length + t.value : t.value;
              if (idx >= 0 && idx < v.length) next.push({ value: v[idx], path: joinPath(c.path, idx) });
            }
          }
        } else if (t.kind === "slice") {
          for (const c of current) {
            const v = c.value;
            if (!Array.isArray(v)) continue;
            const len = v.length;
            const step = t.step === undefined ? 1 : t.step;
            if (step === 0) return { error: "slice step cannot be 0" };
            let start = t.start === undefined ? (step > 0 ? 0 : len - 1) : t.start;
            let end = t.end === undefined ? (step > 0 ? len : -len - 1) : t.end;
            if (start < 0) start += len;
            if (end < 0) end += len;
            if (step > 0) {
              for (let k = Math.max(0, start); k < Math.min(len, end); k += step) next.push({ value: v[k], path: joinPath(c.path, k) });
            } else {
              for (let k = Math.min(len - 1, start); k > Math.max(-1, end); k += step) next.push({ value: v[k], path: joinPath(c.path, k) });
            }
          }
        } else if (t.kind === "union") {
          for (const c of current) {
            const v = c.value;
            for (const p of t.parts) {
              if (p.kind === "index" && Array.isArray(v)) {
                const idx = p.value < 0 ? v.length + p.value : p.value;
                if (idx >= 0 && idx < v.length) next.push({ value: v[idx], path: joinPath(c.path, idx) });
              } else if (p.kind === "key" && v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, p.name)) {
                next.push({ value: v[p.name], path: joinPath(c.path, p.name) });
              }
            }
          }
        } else if (t.kind === "filter") {
          const compiled = compileFilterExpr(t.expr);
          if (compiled.error) return { error: "filter: " + compiled.error };
          for (const c of current) {
            const v = c.value;
            if (Array.isArray(v)) v.forEach((x, i) => { try { if (compiled.predicate(x)) next.push({ value: x, path: joinPath(c.path, i) }); } catch {} });
            else if (v && typeof v === "object") Object.keys(v).forEach((k) => { try { if (compiled.predicate(v[k])) next.push({ value: v[k], path: joinPath(c.path, k) }); } catch {} });
          }
        }
        current = next;
        if (!current.length) break;
      }
      return { results: current };
    }

    ns.evalJsonPath = (val, expr) => evalJsonPath(val, expr);

    // ---------- JSONPath panel wiring ----------
    const jpBtn = root.querySelector('[data-action="jsonpath"]');
    const jpPanel = root.querySelector(".jl-jsonpath-panel");
    const jpForm = root.querySelector(".jl-jp-form");
    const jpInput = root.querySelector(".jl-jp-input");
    const jpStatus = root.querySelector(".jl-jp-status");
    const jpSummary = root.querySelector(".jl-jp-summary");
    const jpBody = root.querySelector(".jl-jp-body");
    const jpEmpty = root.querySelector(".jl-jp-empty");
    const jpCloseBtn = root.querySelector(".jl-jp-close");
    const jpCopyBtn = root.querySelector(".jl-jp-copy");
    const jpExamples = root.querySelector(".jl-jp-examples");
    let jpResults = [];

    function setJsonPathOpen(open) {
      jpPanel.hidden = !open;
      root.classList.toggle("jl-jsonpath-open", open);
      jpBtn.setAttribute("aria-pressed", String(open));
      if (open) setTimeout(() => jpInput.focus(), 60);
    }
    jpBtn.addEventListener("click", () => setJsonPathOpen(jpPanel.hidden));
    jpCloseBtn.addEventListener("click", () => setJsonPathOpen(false));

    function renderJsonPathResults(results) {
      jpBody.innerHTML = "";
      jpEmpty.hidden = results.length > 0;
      if (!results.length) return;
      const frag = document.createDocumentFragment();
      const max = 500;
      const slice = results.slice(0, max);
      slice.forEach((r) => {
        const card = document.createElement("div");
        card.className = "jl-jp-card";
        card.setAttribute("role", "listitem");
        const head = document.createElement("div");
        head.className = "jl-jp-card-head";
        const pathBtn = document.createElement("button");
        pathBtn.type = "button";
        pathBtn.className = "jl-jp-card-path";
        pathBtn.title = "Jump to " + r.path;
        pathBtn.setAttribute("data-path", r.path);
        pathBtn.textContent = r.path;
        const kind = typeOf(r.value);
        const badge = document.createElement("span");
        badge.className = "jl-badge jl-badge-kind";
        badge.setAttribute("data-kind", kind);
        badge.textContent = kind;
        head.appendChild(pathBtn);
        head.appendChild(badge);
        const body = document.createElement("pre");
        body.className = "jl-jp-card-body";
        let txt;
        try { txt = JSON.stringify(r.value, null, 2); } catch { txt = String(r.value); }
        if (txt && txt.length > 600) txt = txt.slice(0, 600) + "\u2026";
        body.textContent = txt;
        card.appendChild(head);
        card.appendChild(body);
        frag.appendChild(card);
      });
      jpBody.appendChild(frag);
      if (results.length > max) {
        const more = document.createElement("div");
        more.className = "jl-jp-more";
        more.textContent = `+${results.length - max} more match${results.length - max === 1 ? "" : "es"} not shown`;
        jpBody.appendChild(more);
      }
    }

    function runJsonPath() {
      jpStatus.textContent = "";
      jpPanel.classList.remove("jl-jp-error");
      const expr = jpInput.value.trim();
      if (!expr) { jpResults = []; renderJsonPathResults([]); jpSummary.textContent = ""; return; }
      const out = evalJsonPath(parsed, expr);
      if (out.error) {
        jpPanel.classList.add("jl-jp-error");
        jpStatus.textContent = out.error;
        jpResults = [];
        renderJsonPathResults([]);
        jpSummary.textContent = "";
        return;
      }
      jpResults = out.results;
      renderJsonPathResults(jpResults);
      jpSummary.textContent = jpResults.length === 0
        ? "no matches"
        : `${jpResults.length} match${jpResults.length === 1 ? "" : "es"}`;
    }

    jpForm.addEventListener("submit", (ev) => { ev.preventDefault(); runJsonPath(); });
    let jpInputTimer = 0;
    jpInput.addEventListener("input", () => {
      clearTimeout(jpInputTimer);
      jpInputTimer = setTimeout(runJsonPath, 180);
    });
    jpInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); setJsonPathOpen(false); }
    });
    jpExamples.addEventListener("click", (ev) => {
      const chip = ev.target instanceof Element ? ev.target.closest(".jl-jp-chip") : null;
      if (!chip) return;
      jpInput.value = chip.getAttribute("data-jp") || "";
      runJsonPath();
      jpInput.focus();
    });
    jpBody.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest(".jl-jp-card-path") : null;
      if (!btn) return;
      const path = btn.getAttribute("data-path") || "$";
      const node = tree.querySelector(`.jl-node[data-path="${cssEscape(path)}"]`);
      if (!node) { flash(root, "Path not in tree"); return; }
      expandAncestorsOf(node, tree);
      if (node.classList.contains("jl-collapsed")) setCollapsed(node, false);
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      const row = node.querySelector(":scope > .jl-row");
      if (row) { row.classList.add("jl-row-ping"); setTimeout(() => row.classList.remove("jl-row-ping"), 700); }
    });
    jpCopyBtn.addEventListener("click", async () => {
      if (!jpResults.length) { flash(root, "No matches"); return; }
      try {
        const payload = jpResults.length === 1 ? jpResults[0].value : jpResults.map((r) => r.value);
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        flash(root, jpResults.length === 1 ? "Match copied" : "Matches copied");
      } catch { flash(root, "Copy failed"); }
    });

    // ---------- GraphQL panel ----------
    const gqlBtn = root.querySelector('[data-action="graphql"]');
    const gqlPanel = root.querySelector('.jl-graphql-panel');
    const isGqlResp = isGraphQLResponse(parsed);
    if (gqlBtn) {
      const gqlSummaryEl = gqlPanel.querySelector('.jl-gql-summary');
      const gqlMeta = gqlPanel.querySelector('.jl-gql-meta');
      const gqlOpPre = gqlPanel.querySelector('.jl-gql-op code');
      const gqlVarsPre = gqlPanel.querySelector('.jl-gql-vars code');
      const gqlExtPre = gqlPanel.querySelector('.jl-gql-ext code');
      const gqlErrorsList = gqlPanel.querySelector('.jl-gql-errors');
      const gqlTabs = gqlPanel.querySelectorAll('.jl-gql-tab');
      const gqlPanes = {
        op: gqlPanel.querySelector('.jl-gql-pane-op'),
        vars: gqlPanel.querySelector('.jl-gql-pane-vars'),
        errors: gqlPanel.querySelector('.jl-gql-pane-errors'),
        ext: gqlPanel.querySelector('.jl-gql-pane-ext'),
      };
      const gqlTabCount = gqlPanel.querySelector('.jl-gql-tab[data-tab="errors"] .jl-gql-tab-count');
      const gqlCloseBtn = gqlPanel.querySelector('.jl-gql-close');
      const gqlCopyOp = gqlPanel.querySelector('.jl-gql-copy-op');
      const gqlCopyVars = gqlPanel.querySelector('.jl-gql-copy-vars');

      // ---- discover operation & variables ----
      // GraphQL request fields aren't part of the response body. We attempt
      // best-effort recovery from (1) URL query params (?query=&variables=)
      // which apollo/relay/graphql-yoga commonly use for GETs, then (2)
      // sessionStorage/localStorage keys that some devtools/loggers stash.
      // None of this calls the network — read-only inspection of the page.
      function discoverOpFromURL() {
        try {
          const u = new URL(location.href);
          const q = u.searchParams.get('query');
          const vars = u.searchParams.get('variables');
          const opName = u.searchParams.get('operationName');
          if (!q && !vars && !opName) return null;
          let parsedVars = null;
          if (vars) { try { parsedVars = JSON.parse(vars); } catch {} }
          return { source: 'URL params', query: q || '', variables: parsedVars, operationName: opName || '' };
        } catch { return null; }
      }

      function inferOperationName(queryText) {
        if (!queryText) return '';
        const m = queryText.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
        return m ? m[2] : '';
      }
      function inferOperationKind(queryText) {
        if (!queryText) return '';
        const m = queryText.match(/^\s*(query|mutation|subscription)\b/);
        if (m) return m[1];
        // Bare selection set is shorthand for `query`.
        if (/^\s*\{/.test(queryText)) return 'query';
        return '';
      }

      const op = discoverOpFromURL();
      const gqlData = parsed && typeof parsed === 'object' ? parsed.data : undefined;
      const gqlErrors = Array.isArray(parsed && parsed.errors) ? parsed.errors : [];
      const gqlExt = parsed && typeof parsed === 'object' ? parsed.extensions : undefined;

      const opQuery = op && op.query ? String(op.query) : '';
      const opVars = op && op.variables !== undefined ? op.variables : null;
      const opName = (op && op.operationName) || inferOperationName(opQuery);
      const opKind = inferOperationKind(opQuery);

      // Populate fields.
      if (opQuery) {
        gqlOpPre.textContent = opQuery;
      } else {
        gqlOpPre.textContent = '// Operation source not on this page.\n// JSON Lens looks at ?query=&variables= URL params for GET-style GraphQL endpoints.';
        gqlPanes.op.classList.add('jl-gql-empty-state');
      }
      const metaParts = [];
      if (opKind) metaParts.push(`<span class="jl-gql-kind jl-gql-kind-${opKind}">${opKind}</span>`);
      if (opName) metaParts.push(`<span class="jl-gql-opname">${opName.replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</span>`);
      if (op && op.source) metaParts.push(`<span class="jl-gql-source">via ${op.source}</span>`);
      if (!opQuery && !metaParts.length) metaParts.push('<span class="jl-gql-source">no operation recovered</span>');
      gqlMeta.innerHTML = metaParts.join('<span class="jl-gql-meta-sep" aria-hidden="true">·</span>');

      if (opVars && typeof opVars === 'object') {
        try { gqlVarsPre.textContent = JSON.stringify(opVars, null, 2); }
        catch { gqlVarsPre.textContent = String(opVars); }
      } else {
        gqlVarsPre.textContent = '// No variables found.';
        gqlPanes.vars.classList.add('jl-gql-empty-state');
      }

      if (gqlExt !== undefined) {
        try { gqlExtPre.textContent = JSON.stringify(gqlExt, null, 2); }
        catch { gqlExtPre.textContent = String(gqlExt); }
      } else {
        gqlExtPre.textContent = '// Response had no `extensions`.';
        gqlPanes.ext.classList.add('jl-gql-empty-state');
      }

      // Errors list with jump-to-path.
      function renderGqlErrors() {
        gqlErrorsList.innerHTML = '';
        if (!gqlErrors.length) {
          const ok = document.createElement('div');
          ok.className = 'jl-gql-no-errors';
          ok.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg><span>No errors</span>';
          gqlErrorsList.appendChild(ok);
          return;
        }
        for (const err of gqlErrors) {
          const card = document.createElement('div');
          card.className = 'jl-gql-err';
          card.setAttribute('role', 'listitem');
          const head = document.createElement('div');
          head.className = 'jl-gql-err-head';
          const icon = document.createElement('span');
          icon.className = 'jl-gql-err-icon';
          icon.innerHTML = ICONS.warn;
          const msg = document.createElement('div');
          msg.className = 'jl-gql-err-msg';
          msg.textContent = String(err.message || '(no message)');
          head.appendChild(icon);
          head.appendChild(msg);
          card.appendChild(head);
          if (Array.isArray(err.locations) && err.locations.length) {
            const locs = document.createElement('div');
            locs.className = 'jl-gql-err-locs';
            locs.textContent = err.locations.map((l) => `line ${l.line || '?'}, col ${l.column || '?'}`).join('  ·  ');
            card.appendChild(locs);
          }
          if (Array.isArray(err.path) && err.path.length) {
            const pathRow = document.createElement('div');
            pathRow.className = 'jl-gql-err-path-row';
            const label = document.createElement('span');
            label.className = 'jl-gql-err-path-label';
            label.textContent = 'path';
            const treePath = gqlErrorPathToTreePath(err.path);
            const jump = document.createElement('button');
            jump.type = 'button';
            jump.className = 'jl-gql-err-jump';
            jump.setAttribute('data-path', treePath);
            jump.title = 'Jump to ' + treePath;
            jump.innerHTML = `<code>${treePath.replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</code>${ICONS.diffArrow}`;
            pathRow.appendChild(label);
            pathRow.appendChild(jump);
            card.appendChild(pathRow);
          }
          if (err.extensions && typeof err.extensions === 'object') {
            const det = document.createElement('details');
            det.className = 'jl-gql-err-ext';
            const sm = document.createElement('summary');
            sm.textContent = 'extensions';
            det.appendChild(sm);
            const pre = document.createElement('pre');
            try { pre.textContent = JSON.stringify(err.extensions, null, 2); }
            catch { pre.textContent = String(err.extensions); }
            det.appendChild(pre);
            card.appendChild(det);
          }
          gqlErrorsList.appendChild(card);
        }
      }
      renderGqlErrors();

      if (gqlErrors.length) {
        gqlTabCount.hidden = false;
        gqlTabCount.textContent = String(gqlErrors.length);
      }

      const dataKind = gqlData === undefined ? 'no data' : (gqlData === null ? 'null data' : (Array.isArray(gqlData) ? 'array data' : (typeof gqlData)));
      const opLabel = opKind ? `${opKind}${opName ? ' ' + opName : ''}` : (opName || 'operation');
      gqlSummaryEl.textContent = `${gqlErrors.length ? gqlErrors.length + ' error' + (gqlErrors.length === 1 ? '' : 's') : 'ok'} · ${dataKind} · ${opLabel}`;

      function activateGqlTab(name) {
        gqlTabs.forEach((t) => {
          const active = t.getAttribute('data-tab') === name;
          t.classList.toggle('jl-gql-tab-active', active);
          t.setAttribute('aria-selected', String(active));
        });
        for (const k of Object.keys(gqlPanes)) gqlPanes[k].hidden = (k !== name);
      }
      gqlTabs.forEach((t) => t.addEventListener('click', () => activateGqlTab(t.getAttribute('data-tab'))));
      // Auto-open errors tab if any
      if (gqlErrors.length) activateGqlTab('errors');

      function setGqlOpen(open) {
        gqlPanel.hidden = !open;
        root.classList.toggle('jl-graphql-open', open);
        gqlBtn.setAttribute('aria-pressed', String(open));
      }
      gqlBtn.addEventListener('click', () => setGqlOpen(gqlPanel.hidden));
      gqlCloseBtn.addEventListener('click', () => setGqlOpen(false));
      gqlCopyOp.addEventListener('click', async () => {
        if (!opQuery) { flash(root, 'No operation to copy'); return; }
        try { await navigator.clipboard.writeText(opQuery); flash(root, 'Operation copied'); }
        catch { flash(root, 'Copy failed'); }
      });
      gqlCopyVars.addEventListener('click', async () => {
        if (!opVars || typeof opVars !== 'object') { flash(root, 'No variables to copy'); return; }
        try { await navigator.clipboard.writeText(JSON.stringify(opVars, null, 2)); flash(root, 'Variables copied'); }
        catch { flash(root, 'Copy failed'); }
      });
      gqlErrorsList.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('.jl-gql-err-jump') : null;
        if (!btn) return;
        const path = btn.getAttribute('data-path') || '$.data';
        const node = tree.querySelector(`.jl-node[data-path="${cssEscape(path)}"]`);
        if (!node) { flash(root, 'Path not in tree'); return; }
        expandAncestorsOf(node, tree);
        if (node.classList.contains('jl-collapsed')) setCollapsed(node, false);
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const row = node.querySelector(':scope > .jl-row');
        if (row) { row.classList.add('jl-row-ping'); setTimeout(() => row.classList.remove('jl-row-ping'), 700); }
      });
      ns.isGraphQLResponse = isGraphQLResponse;
    }

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

    // ---------- bookmarks panel ----------
    const bmBtn = root.querySelector('[data-action="bookmarks"]');
    const bmPanel = root.querySelector(".jl-bookmarks-panel");
    const bmBody = root.querySelector(".jl-bm-body");
    const bmEmpty = root.querySelector(".jl-bm-empty");
    const bmEmptyAdd = root.querySelector(".jl-bm-empty-add");
    const bmAddBtn = root.querySelector(".jl-bm-add");
    const bmCloseBtn = root.querySelector(".jl-bm-close");
    const bmSearchInput = root.querySelector(".jl-bm-search-input");
    const bmTagbar = root.querySelector(".jl-bm-tagbar");
    const bmSummary = root.querySelector(".jl-bm-summary");
    const bmEditForm = root.querySelector(".jl-bm-edit");
    const bmEditName = root.querySelector(".jl-bm-edit-name");
    const bmEditTags = root.querySelector(".jl-bm-edit-tags");
    const bmEditUrl = root.querySelector(".jl-bm-edit-url");
    const bmEditTitleEl = root.querySelector(".jl-bm-edit-title");
    const bmEditCancel = root.querySelector(".jl-bm-edit-cancel");

    let bookmarks = [];
    let bmActiveTag = "";
    let bmEditingId = null;

    function refreshAddBtnState() {
      const exists = bookmarks.some((b) => b.url === location.href);
      const icon = exists ? ICONS.bookmarkFilled : ICONS.bookmark;
      bmBtn.innerHTML = `${icon}<span>Bookmarks</span>`;
      bmBtn.classList.toggle("jl-bm-active", exists);
      bmBtn.setAttribute("title", exists ? "Bookmarked — click to manage" : "Bookmarks (B)");
    }

    function allTagsSorted() {
      const m = new Map();
      for (const b of bookmarks) for (const t of b.tags) m.set(t, (m.get(t) || 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }

    function renderBmTagbar() {
      const tags = allTagsSorted();
      if (!tags.length) { bmTagbar.hidden = true; bmTagbar.innerHTML = ""; return; }
      bmTagbar.hidden = false;
      const buttons = [`<button type="button" class="jl-bm-tagchip${bmActiveTag === "" ? " jl-bm-tagchip-on" : ""}" data-tag="">All</button>`];
      for (const [t, c] of tags) {
        const on = bmActiveTag === t ? " jl-bm-tagchip-on" : "";
        buttons.push(`<button type="button" class="jl-bm-tagchip${on}" data-tag="${escapeHTML(t)}"><span class="jl-bm-tagchip-hash">#</span>${escapeHTML(t)}<span class="jl-bm-tagchip-count">${c}</span></button>`);
      }
      bmTagbar.innerHTML = buttons.join("");
    }

    function bookmarkMatchesQuery(b, q) {
      if (!q) return true;
      const needle = q.toLowerCase();
      if (needle.startsWith("#")) {
        const tag = needle.slice(1);
        return b.tags.some((t) => t.toLowerCase().includes(tag));
      }
      return b.name.toLowerCase().includes(needle)
        || b.url.toLowerCase().includes(needle)
        || b.tags.some((t) => t.toLowerCase().includes(needle));
    }

    function renderBookmarks() {
      const q = bmSearchInput.value.trim();
      let list = bookmarks.slice();
      if (bmActiveTag) list = list.filter((b) => b.tags.includes(bmActiveTag));
      if (q) list = list.filter((b) => bookmarkMatchesQuery(b, q));
      list.sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
      bmSummary.textContent = bookmarks.length === 0
        ? ""
        : `${list.length} of ${bookmarks.length} · ${allTagsSorted().length} tag${allTagsSorted().length === 1 ? "" : "s"}`;
      renderBmTagbar();
      bmBody.innerHTML = "";
      if (bookmarks.length === 0) {
        bmEmpty.hidden = false;
        bmBody.hidden = true;
        return;
      }
      bmEmpty.hidden = true;
      bmBody.hidden = false;
      if (list.length === 0) {
        const note = document.createElement("div");
        note.className = "jl-bm-noresults";
        note.textContent = q || bmActiveTag ? "No bookmarks match this filter." : "";
        bmBody.appendChild(note);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const b of list) {
        const card = document.createElement("div");
        card.className = "jl-bm-card";
        card.setAttribute("role", "listitem");
        card.setAttribute("data-id", b.id);
        const isCurrent = b.url === location.href;
        if (isCurrent) card.classList.add("jl-bm-card-current");
        const tagsHTML = b.tags.length
          ? `<div class="jl-bm-card-tags">${b.tags.map((t) => `<button type="button" class="jl-bm-tagchip jl-bm-tagchip-sm" data-tag="${escapeHTML(t)}"><span class="jl-bm-tagchip-hash">#</span>${escapeHTML(t)}</button>`).join("")}</div>`
          : "";
        card.innerHTML = `
          <button type="button" class="jl-bm-card-main" data-act="open" title="Open ${escapeHTML(b.url)}">
            <div class="jl-bm-card-head">
              <span class="jl-bm-card-name">${escapeHTML(b.name)}</span>
              ${isCurrent ? `<span class="jl-bm-pill">current</span>` : ""}
            </div>
            <div class="jl-bm-card-url">${escapeHTML(b.url)}</div>
            ${tagsHTML}
            <div class="jl-bm-card-meta">Added ${relativeTime(b.addedAt) || "recently"}${b.lastOpenedAt ? ` · opened ${relativeTime(b.lastOpenedAt)}` : ""}</div>
          </button>
          <div class="jl-bm-card-actions">
            <button type="button" class="jl-bm-iconbtn" data-act="edit" title="Edit name and tags" aria-label="Edit bookmark">${ICONS.pencil}</button>
            <button type="button" class="jl-bm-iconbtn" data-act="open-new" title="Open in new tab" aria-label="Open in new tab">${ICONS.externalLink}</button>
            <button type="button" class="jl-bm-iconbtn jl-bm-iconbtn-danger" data-act="remove" title="Remove bookmark" aria-label="Remove bookmark">${ICONS.trash}</button>
          </div>`;
        frag.appendChild(card);
      }
      bmBody.appendChild(frag);
    }

    function openEditForm(b) {
      bmEditingId = b.id;
      bmEditTitleEl.textContent = b === pendingNew ? "New bookmark" : "Edit bookmark";
      bmEditName.value = b.name;
      bmEditTags.value = b.tags.join(", ");
      bmEditUrl.textContent = b.url;
      bmEditForm.hidden = false;
      bmBody.classList.add("jl-bm-body-dim");
      setTimeout(() => bmEditName.focus(), 30);
    }
    function closeEditForm() {
      bmEditingId = null;
      pendingNew = null;
      bmEditForm.hidden = true;
      bmBody.classList.remove("jl-bm-body-dim");
    }

    let pendingNew = null;

    async function persistBookmarks() {
      await saveBookmarks(bookmarks);
      refreshAddBtnState();
      renderBookmarks();
    }

    async function addCurrentAsBookmark() {
      const existing = bookmarks.find((b) => b.url === location.href);
      if (existing) { openEditForm(existing); return; }
      pendingNew = {
        id: cryptoIdish(),
        url: location.href,
        name: deriveBookmarkName(location.href),
        tags: [],
        addedAt: Date.now(),
        lastOpenedAt: 0,
      };
      openEditForm(pendingNew);
    }

    bmEditForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = bmEditName.value.trim() || deriveBookmarkName(bmEditUrl.textContent || location.href);
      const tags = parseTagInput(bmEditTags.value);
      if (pendingNew && bmEditingId === pendingNew.id) {
        pendingNew.name = name;
        pendingNew.tags = tags;
        bookmarks.unshift(pendingNew);
        flash(root, "Bookmark added");
      } else {
        const target = bookmarks.find((b) => b.id === bmEditingId);
        if (target) { target.name = name; target.tags = tags; flash(root, "Bookmark updated"); }
      }
      closeEditForm();
      await persistBookmarks();
    });
    bmEditCancel.addEventListener("click", () => closeEditForm());
    bmEditForm.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); closeEditForm(); }
    });

    bmAddBtn.addEventListener("click", addCurrentAsBookmark);
    bmEmptyAdd.addEventListener("click", addCurrentAsBookmark);
    bmCloseBtn.addEventListener("click", () => setBookmarksOpen(false));

    bmSearchInput.addEventListener("input", () => renderBookmarks());
    bmSearchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); bmSearchInput.value = ""; renderBookmarks(); }
    });

    bmTagbar.addEventListener("click", (ev) => {
      const chip = ev.target instanceof Element ? ev.target.closest(".jl-bm-tagchip") : null;
      if (!chip) return;
      bmActiveTag = chip.getAttribute("data-tag") || "";
      renderBookmarks();
    });

    bmBody.addEventListener("click", async (ev) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target) return;
      const tagChip = target.closest(".jl-bm-tagchip");
      if (tagChip && bmBody.contains(tagChip)) {
        ev.stopPropagation();
        bmActiveTag = tagChip.getAttribute("data-tag") || "";
        renderBookmarks();
        return;
      }
      const card = target.closest(".jl-bm-card");
      if (!card) return;
      const id = card.getAttribute("data-id");
      const b = bookmarks.find((x) => x.id === id);
      if (!b) return;
      const actBtn = target.closest("[data-act]");
      const act = actBtn ? actBtn.getAttribute("data-act") : null;
      if (act === "remove") {
        bookmarks = bookmarks.filter((x) => x.id !== id);
        flash(root, "Bookmark removed");
        await persistBookmarks();
        return;
      }
      if (act === "edit") { openEditForm(b); return; }
      if (act === "open-new") {
        try { window.open(b.url, "_blank", "noopener"); } catch {}
        b.lastOpenedAt = Date.now();
        await persistBookmarks();
        return;
      }
      // default = open in current tab
      b.lastOpenedAt = Date.now();
      await saveBookmarks(bookmarks);
      if (b.url === location.href) { setBookmarksOpen(false); return; }
      location.href = b.url;
    });

    function setBookmarksOpen(open) {
      bmPanel.hidden = !open;
      root.classList.toggle("jl-bookmarks-open", open);
      bmBtn.setAttribute("aria-pressed", String(open));
      if (open) {
        closeEditForm();
        renderBookmarks();
        setTimeout(() => bmSearchInput.focus(), 60);
      }
    }

    bmBtn.addEventListener("click", () => setBookmarksOpen(bmPanel.hidden));

    // 'B' key toggles bookmarks panel (when not typing in an input)
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "b" && ev.key !== "B") return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const target = ev.target;
      const tag = target && target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (target && target.isContentEditable)) return;
      ev.preventDefault();
      setBookmarksOpen(bmPanel.hidden);
    });

    // Live sync across tabs/views editing bookmarks at the same time.
    try {
      if (chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes[BOOKMARKS_KEY]) return;
          const next = changes[BOOKMARKS_KEY].newValue;
          if (!Array.isArray(next)) return;
          bookmarks = next;
          refreshAddBtnState();
          if (!bmPanel.hidden) renderBookmarks();
        });
      }
    } catch {}

    // Initial load.
    loadBookmarks().then((list) => {
      bookmarks = list;
      refreshAddBtnState();
      if (!bmPanel.hidden) renderBookmarks();
    });

    // Expose for tests
    ns.parseTagInput = parseTagInput;
    ns.deriveBookmarkName = deriveBookmarkName;

    // ---------- saved query workspace ----------
    // Per-domain (host) named jq/JSONPath expressions, persisted in
    // chrome.storage.local under QUERIES_KEY. Shape:
    //   { [host]: [ { id, name, kind: 'jq'|'jsonpath', expr, tags, addedAt, lastRunAt } ] }
    const QUERIES_KEY = "json-lens:queries";
    const QUERIES_PER_HOST = 200;

    function queriesStorage() {
      try { return chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
      catch { return null; }
    }
    function currentHost() {
      try { return new URL(location.href).host || location.hostname || ""; }
      catch { return location.hostname || ""; }
    }
    function coerceQuery(q) {
      if (!q || typeof q !== "object") return null;
      const expr = String(q.expr || "");
      if (!expr) return null;
      const kind = q.kind === "jsonpath" ? "jsonpath" : "jq";
      return {
        id: String(q.id || cryptoIdish()),
        name: String(q.name || expr).slice(0, 200),
        kind,
        expr,
        tags: Array.isArray(q.tags) ? q.tags.map(String).filter(Boolean).slice(0, 16) : [],
        addedAt: Number(q.addedAt) || Date.now(),
        lastRunAt: Number(q.lastRunAt) || 0,
      };
    }
    function loadAllQueries() {
      return new Promise((resolve) => {
        const s = queriesStorage();
        if (!s) { resolve({}); return; }
        try {
          s.get(QUERIES_KEY, (obj) => {
            if (chrome.runtime && chrome.runtime.lastError) { resolve({}); return; }
            const v = obj && obj[QUERIES_KEY];
            if (!v || typeof v !== "object") { resolve({}); return; }
            const out = {};
            for (const k of Object.keys(v)) {
              const arr = Array.isArray(v[k]) ? v[k].map(coerceQuery).filter(Boolean) : [];
              if (arr.length) out[k] = arr.slice(0, QUERIES_PER_HOST);
            }
            resolve(out);
          });
        } catch { resolve({}); }
      });
    }
    function saveAllQueries(map) {
      return new Promise((resolve) => {
        const s = queriesStorage();
        if (!s) { resolve(false); return; }
        try {
          s.set({ [QUERIES_KEY]: map }, () => resolve(!(chrome.runtime && chrome.runtime.lastError)));
        } catch { resolve(false); }
      });
    }
    function queryMatchesFilter(q, query) {
      if (!query) return true;
      const ql = query.toLowerCase();
      if (ql.startsWith("#")) {
        const t = ql.slice(1);
        return q.tags.some((tag) => tag.toLowerCase() === t);
      }
      return (
        q.name.toLowerCase().includes(ql) ||
        q.expr.toLowerCase().includes(ql) ||
        q.kind.toLowerCase().includes(ql) ||
        q.tags.some((t) => t.toLowerCase().includes(ql))
      );
    }
    function guessKindFromExpr(expr) {
      const s = String(expr || "").trim();
      if (!s) return "jq";
      if (s.startsWith("$")) return "jsonpath";
      return "jq";
    }

    const qBtn = root.querySelector('[data-action="queries"]');
    const qCountChip = qBtn.querySelector(".jl-q-count");
    const qPanel = root.querySelector(".jl-queries-panel");
    const qCloseBtn = root.querySelector(".jl-q-close");
    const qAddBtn = root.querySelector(".jl-q-add");
    const qEmpty = root.querySelector(".jl-q-empty");
    const qEmptyAdd = root.querySelector(".jl-q-empty-add");
    const qBody = root.querySelector(".jl-q-body");
    const qSummary = root.querySelector(".jl-q-summary");
    const qSearchInput = root.querySelector(".jl-q-search-input");
    const qDomainHost = root.querySelector(".jl-q-domain-host");
    const qEditForm = root.querySelector(".jl-q-edit");
    const qEditTitleEl = root.querySelector(".jl-q-edit-title");
    const qEditName = root.querySelector(".jl-q-edit-name");
    const qEditExpr = root.querySelector(".jl-q-edit-expr");
    const qEditTags = root.querySelector(".jl-q-edit-tags");
    const qEditCancel = root.querySelector(".jl-q-edit-cancel");
    const qEditKindRadios = Array.from(root.querySelectorAll('input[name="jl-q-kind"]'));

    const QUERY_HOST = currentHost() || "(local)";
    qDomainHost.textContent = QUERY_HOST;

    let queriesAll = {};
    let queriesForHost = [];
    let qEditingId = null;
    let qPendingNew = null;

    function refreshQueriesCount() {
      const n = queriesForHost.length;
      qCountChip.textContent = n > 0 ? String(n) : "";
    }

    function renderQueries() {
      const q = qSearchInput.value.trim();
      let list = queriesForHost.slice();
      if (q) list = list.filter((x) => queryMatchesFilter(x, q));
      list.sort((a, b) => (b.lastRunAt || b.addedAt) - (a.lastRunAt || a.addedAt));
      qSummary.textContent = queriesForHost.length === 0
        ? ""
        : `${list.length} of ${queriesForHost.length} · ${QUERY_HOST}`;
      qBody.innerHTML = "";
      if (queriesForHost.length === 0) {
        qEmpty.hidden = false;
        qBody.hidden = true;
        return;
      }
      qEmpty.hidden = true;
      qBody.hidden = false;
      if (list.length === 0) {
        const note = document.createElement("div");
        note.className = "jl-q-noresults";
        note.textContent = "No queries match this filter.";
        qBody.appendChild(note);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const it of list) {
        const card = document.createElement("div");
        card.className = "jl-q-card";
        card.setAttribute("role", "listitem");
        card.setAttribute("data-id", it.id);
        const tagsHTML = it.tags.length
          ? `<div class="jl-q-card-tags">${it.tags.map((t) => `<span class="jl-q-tagchip"><span class="jl-q-tagchip-hash">#</span>${escapeHTML(t)}</span>`).join("")}</div>`
          : "";
        card.innerHTML = `
          <button type="button" class="jl-q-card-main" data-act="run" title="Run ${escapeHTML(it.expr)}">
            <div class="jl-q-card-head">
              <span class="jl-q-card-name">${escapeHTML(it.name)}</span>
              <span class="jl-q-kind-pill jl-q-kind-${it.kind}">${it.kind === "jsonpath" ? "JSONPath" : "jq"}</span>
            </div>
            <div class="jl-q-card-expr"><code>${escapeHTML(it.expr)}</code></div>
            ${tagsHTML}
            <div class="jl-q-card-meta">Saved ${relativeTime(it.addedAt) || "recently"}${it.lastRunAt ? ` · ran ${relativeTime(it.lastRunAt)}` : ""}</div>
          </button>
          <div class="jl-q-card-actions">
            <button type="button" class="jl-q-iconbtn" data-act="copy" title="Copy expression" aria-label="Copy expression">${ICONS.copy}</button>
            <button type="button" class="jl-q-iconbtn" data-act="edit" title="Edit query" aria-label="Edit query">${ICONS.pencil}</button>
            <button type="button" class="jl-q-iconbtn jl-q-iconbtn-danger" data-act="remove" title="Delete query" aria-label="Delete query">${ICONS.trash}</button>
          </div>`;
        frag.appendChild(card);
      }
      qBody.appendChild(frag);
    }

    function setQueryKindRadio(kind) {
      for (const r of qEditKindRadios) r.checked = r.value === kind;
    }
    function getQueryKindRadio() {
      const r = qEditKindRadios.find((x) => x.checked);
      return r ? r.value : "jq";
    }

    function openQueryEdit(item) {
      qEditingId = item.id;
      qEditTitleEl.textContent = item === qPendingNew ? "Save new query" : "Edit query";
      qEditName.value = item.name;
      qEditExpr.value = item.expr;
      qEditTags.value = item.tags.join(", ");
      setQueryKindRadio(item.kind);
      qEditForm.hidden = false;
      qBody.classList.add("jl-q-body-dim");
      setTimeout(() => qEditName.focus(), 30);
    }
    function closeQueryEdit() {
      qEditingId = null;
      qPendingNew = null;
      qEditForm.hidden = true;
      qBody.classList.remove("jl-q-body-dim");
    }

    async function persistQueries() {
      queriesAll[QUERY_HOST] = queriesForHost.slice(0, QUERIES_PER_HOST);
      await saveAllQueries(queriesAll);
      refreshQueriesCount();
      if (!qPanel.hidden) renderQueries();
    }

    async function saveCurrentAsQuery() {
      const filterExpr = (filterInput.value || "").trim();
      const jpExpr = (jpInput.value || "").trim();
      let kind = "jq";
      let expr = "";
      if (filterExpr && !jpExpr) { kind = "jq"; expr = filterExpr; }
      else if (!filterExpr && jpExpr) { kind = "jsonpath"; expr = jpExpr; }
      else if (filterExpr && jpExpr) { kind = jpPanel && !jpPanel.hidden ? "jsonpath" : "jq"; expr = kind === "jq" ? filterExpr : jpExpr; }
      qPendingNew = {
        id: cryptoIdish(),
        name: expr || "Untitled query",
        kind,
        expr,
        tags: [],
        addedAt: Date.now(),
        lastRunAt: 0,
      };
      openQueryEdit(qPendingNew);
    }

    function applyQuery(item) {
      if (!item || !item.expr) return;
      if (item.kind === "jsonpath") {
        setJsonPathOpen(true);
        jpInput.value = item.expr;
        runJsonPath();
      } else {
        filterInput.value = item.expr;
        runFilter(item.expr);
        filterInput.focus();
      }
      item.lastRunAt = Date.now();
      // Persist usage timestamp without blocking the UI.
      persistQueries();
      flash(root, `Applied “${item.name}”`);
    }

    qEditForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = (qEditName.value || "").trim() || (qEditExpr.value || "").trim() || "Untitled query";
      const expr = (qEditExpr.value || "").trim();
      const kind = getQueryKindRadio();
      const tags = parseTagInput(qEditTags.value);
      if (!expr) { flash(root, "Expression required"); return; }
      if (qPendingNew && qEditingId === qPendingNew.id) {
        qPendingNew.name = name;
        qPendingNew.kind = kind;
        qPendingNew.expr = expr;
        qPendingNew.tags = tags;
        queriesForHost.unshift(qPendingNew);
        flash(root, "Query saved");
      } else {
        const target = queriesForHost.find((x) => x.id === qEditingId);
        if (target) { target.name = name; target.kind = kind; target.expr = expr; target.tags = tags; flash(root, "Query updated"); }
      }
      closeQueryEdit();
      await persistQueries();
    });
    qEditCancel.addEventListener("click", () => closeQueryEdit());
    qEditForm.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); closeQueryEdit(); }
    });

    qEditExpr.addEventListener("input", () => {
      // Auto-detect kind when user hasn't manually picked.
      const guessed = guessKindFromExpr(qEditExpr.value);
      // Only flip when current selection still matches the previous guess to
      // respect explicit user choice.
      setQueryKindRadio(guessed);
    });

    qAddBtn.addEventListener("click", saveCurrentAsQuery);
    qEmptyAdd.addEventListener("click", saveCurrentAsQuery);

    qSearchInput.addEventListener("input", () => renderQueries());
    qSearchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); qSearchInput.value = ""; renderQueries(); }
    });

    qBody.addEventListener("click", async (ev) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target) return;
      const card = target.closest(".jl-q-card");
      if (!card) return;
      const id = card.getAttribute("data-id");
      const it = queriesForHost.find((x) => x.id === id);
      if (!it) return;
      const actBtn = target.closest("[data-act]");
      const act = actBtn ? actBtn.getAttribute("data-act") : null;
      if (act === "remove") {
        queriesForHost = queriesForHost.filter((x) => x.id !== id);
        flash(root, "Query removed");
        await persistQueries();
        return;
      }
      if (act === "edit") { openQueryEdit(it); return; }
      if (act === "copy") {
        try { await navigator.clipboard.writeText(it.expr); flash(root, "Copied expression"); }
        catch { flash(root, "Copy failed"); }
        return;
      }
      // default = run
      applyQuery(it);
      setQueriesOpen(false);
    });

    function setQueriesOpen(open) {
      qPanel.hidden = !open;
      root.classList.toggle("jl-queries-open", open);
      qBtn.setAttribute("aria-pressed", String(open));
      if (open) {
        closeQueryEdit();
        renderQueries();
        setTimeout(() => qSearchInput.focus(), 60);
      }
    }
    qBtn.addEventListener("click", () => setQueriesOpen(qPanel.hidden));
    qCloseBtn.addEventListener("click", () => setQueriesOpen(false));

    // 'Q' toggles queries panel when not typing.
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "q" && ev.key !== "Q") return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t = ev.target;
      const tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
      ev.preventDefault();
      setQueriesOpen(qPanel.hidden);
    });

    // Cross-tab/view live sync.
    try {
      if (chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes[QUERIES_KEY]) return;
          const next = changes[QUERIES_KEY].newValue;
          if (!next || typeof next !== "object") return;
          queriesAll = next;
          queriesForHost = Array.isArray(queriesAll[QUERY_HOST]) ? queriesAll[QUERY_HOST].map(coerceQuery).filter(Boolean) : [];
          refreshQueriesCount();
          if (!qPanel.hidden) renderQueries();
        });
      }
    } catch {}

    loadAllQueries().then((map) => {
      queriesAll = map;
      queriesForHost = Array.isArray(queriesAll[QUERY_HOST]) ? queriesAll[QUERY_HOST] : [];
      refreshQueriesCount();
      if (!qPanel.hidden) renderQueries();
    });

    ns.queryMatchesFilter = queryMatchesFilter;
    ns.guessKindFromExpr = guessKindFromExpr;
    ns.coerceQuery = coerceQuery;

    // ---------- history panel ----------
    const histBtn = root.querySelector('[data-action="history"]');
    const histPanel = root.querySelector(".jl-history-panel");
    const histBody = root.querySelector(".jl-hist-body");
    const histEmpty = root.querySelector(".jl-hist-empty");
    const histSummary = root.querySelector(".jl-hist-summary");
    const histUrlEl = root.querySelector(".jl-hist-url");
    const histCloseBtn = root.querySelector(".jl-hist-close");
    const histClearBtn = root.querySelector(".jl-hist-clear");
    const histCountChip = histBtn.querySelector(".jl-hist-count");
    const histViewer = root.querySelector(".jl-hist-viewer");
    const histViewerTitle = root.querySelector(".jl-hist-viewer-title");
    const histViewerPre = root.querySelector(".jl-hist-viewer-pre code");
    const histVwCopy = root.querySelector(".jl-hist-vw-copy");
    const histVwDownload = root.querySelector(".jl-hist-vw-download");
    const histVwClose = root.querySelector(".jl-hist-vw-close");

    let histList = [];
    let histOpenSnap = null;

    function refreshHistCount() {
      const n = histList.length;
      if (!n) { histCountChip.hidden = true; histCountChip.textContent = ""; }
      else { histCountChip.hidden = false; histCountChip.textContent = String(n); }
    }

    function fmtAbsTime(ts) {
      try { return new Date(ts).toLocaleString(); } catch { return new Date(ts).toISOString(); }
    }

    function renderHistory() {
      histUrlEl.textContent = location.href;
      histUrlEl.title = location.href;
      if (!histList.length) {
        histEmpty.hidden = false;
        histBody.innerHTML = "";
        histSummary.textContent = "";
        histClearBtn.disabled = true;
        return;
      }
      histEmpty.hidden = true;
      histClearBtn.disabled = false;
      const newestHash = histList[0].hash;
      histSummary.textContent = `${histList.length} snapshot${histList.length === 1 ? "" : "s"} • latest ${relativeTime(histList[0].ts)}`;
      const frag = document.createDocumentFragment();
      histList.forEach((snap, idx) => {
        const prev = histList[idx + 1];
        const changed = !prev || prev.hash !== snap.hash;
        const card = document.createElement("div");
        card.className = "jl-hist-card" + (snap.hash === newestHash && idx === 0 ? " jl-hist-card-current" : "");
        card.setAttribute("role", "listitem");
        card.dataset.id = snap.id;
        const sizeStr = formatBytes(snap.size);
        const canView = typeof snap.raw === "string";
        const changeBadge = idx === 0
          ? `<span class="jl-hist-chip jl-hist-chip-current">latest</span>`
          : (changed ? `<span class="jl-hist-chip jl-hist-chip-changed">changed</span>` : `<span class="jl-hist-chip">same</span>`);
        card.innerHTML = `
          <button type="button" class="jl-hist-card-main" data-act="view" ${canView ? "" : "disabled aria-disabled=\"true\""}>
            <div class="jl-hist-card-head">
              <span class="jl-hist-card-time" title="${escapeHTML(fmtAbsTime(snap.ts))}">${escapeHTML(relativeTime(snap.ts) || "just now")}</span>
              ${changeBadge}
            </div>
            <div class="jl-hist-card-meta">
              <span class="jl-hist-meta-size">${escapeHTML(sizeStr)}</span>
              <span class="jl-hist-meta-sep">·</span>
              <code class="jl-hist-meta-hash">${escapeHTML(snap.hash)}</code>
              ${canView ? "" : `<span class="jl-hist-meta-sep">·</span><span class="jl-hist-meta-tag">metadata only</span>`}
            </div>
          </button>
          <div class="jl-hist-card-actions">
            <button type="button" class="jl-icon-btn jl-hist-act-copy" data-act="copy" title="Copy snapshot JSON" aria-label="Copy snapshot JSON" ${canView ? "" : "disabled aria-disabled=\"true\""}>${ICONS.copy}</button>
            <button type="button" class="jl-icon-btn jl-hist-act-download" data-act="download" title="Download snapshot JSON" aria-label="Download snapshot JSON" ${canView ? "" : "disabled aria-disabled=\"true\""}>${ICONS.download}</button>
            <button type="button" class="jl-icon-btn jl-hist-act-delete" data-act="delete" title="Delete snapshot" aria-label="Delete snapshot">${ICONS.trash}</button>
          </div>`;
        frag.appendChild(card);
      });
      histBody.innerHTML = "";
      histBody.appendChild(frag);
    }

    async function reloadHistoryForCurrent() {
      const map = await loadHistoryAll();
      histList = Array.isArray(map[location.href]) ? map[location.href] : [];
      refreshHistCount();
      if (!histPanel.hidden) renderHistory();
    }

    async function deleteHistoryEntry(id) {
      const map = await loadHistoryAll();
      const list = Array.isArray(map[location.href]) ? map[location.href] : [];
      const next = list.filter((s) => s.id !== id);
      if (next.length) map[location.href] = next; else delete map[location.href];
      await saveHistoryAll(map);
      histList = next;
      refreshHistCount();
      renderHistory();
    }

    async function clearHistoryForCurrent() {
      const map = await loadHistoryAll();
      delete map[location.href];
      await saveHistoryAll(map);
      histList = [];
      refreshHistCount();
      renderHistory();
      closeHistoryViewer();
    }

    function downloadText(filename, text, mime) {
      try {
        const blob = new Blob([text], { type: mime || "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { try { document.body.removeChild(a); } catch {} URL.revokeObjectURL(url); }, 0);
      } catch (err) { console.debug("[json-lens] download error", err); }
    }

    function openHistoryViewer(snap) {
      if (!snap || typeof snap.raw !== "string") {
        flash(root, "Snapshot body not stored (too large)");
        return;
      }
      histOpenSnap = snap;
      histViewer.hidden = false;
      histViewerTitle.textContent = `${fmtAbsTime(snap.ts)} • ${formatBytes(snap.size)} • #${snap.hash}`;
      // Pretty-print best-effort; fall back to raw text.
      let display = snap.raw;
      try { display = JSON.stringify(JSON.parse(snap.raw), null, 2); } catch {}
      histViewerPre.textContent = display;
    }

    function closeHistoryViewer() {
      histViewer.hidden = true;
      histOpenSnap = null;
    }

    function setHistoryOpen(open) {
      histPanel.hidden = !open;
      root.classList.toggle("jl-history-open", open);
      histBtn.setAttribute("aria-pressed", String(open));
      if (open) {
        closeHistoryViewer();
        renderHistory();
      }
    }

    histBtn.addEventListener("click", () => setHistoryOpen(histPanel.hidden));
    histCloseBtn.addEventListener("click", () => setHistoryOpen(false));
    histClearBtn.addEventListener("click", () => {
      if (!histList.length) return;
      clearHistoryForCurrent();
      flash(root, "History cleared for this URL");
    });

    histBody.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      const card = btn.closest(".jl-hist-card");
      if (!card) return;
      const id = card.dataset.id;
      const snap = histList.find((s) => s.id === id);
      if (!snap) return;
      const act = btn.dataset.act;
      if (act === "view") {
        openHistoryViewer(snap);
      } else if (act === "copy") {
        if (typeof snap.raw !== "string") { flash(root, "Snapshot body not stored"); return; }
        try { navigator.clipboard.writeText(snap.raw); flash(root, "Snapshot copied"); }
        catch { flash(root, "Copy failed"); }
      } else if (act === "download") {
        if (typeof snap.raw !== "string") { flash(root, "Snapshot body not stored"); return; }
        const stamp = new Date(snap.ts).toISOString().replace(/[:.]/g, "-");
        downloadText(`snapshot-${stamp}-${snap.hash}.json`, snap.raw);
      } else if (act === "delete") {
        deleteHistoryEntry(id);
        flash(root, "Snapshot removed");
      }
    });

    histVwClose.addEventListener("click", closeHistoryViewer);
    histVwCopy.addEventListener("click", () => {
      if (!histOpenSnap || typeof histOpenSnap.raw !== "string") return;
      try { navigator.clipboard.writeText(histOpenSnap.raw); flash(root, "Snapshot copied"); }
      catch { flash(root, "Copy failed"); }
    });
    histVwDownload.addEventListener("click", () => {
      if (!histOpenSnap || typeof histOpenSnap.raw !== "string") return;
      const stamp = new Date(histOpenSnap.ts).toISOString().replace(/[:.]/g, "-");
      downloadText(`snapshot-${stamp}-${histOpenSnap.hash}.json`, histOpenSnap.raw);
    });

    // Keyboard: 'H' toggles when not typing
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "h" && ev.key !== "H") return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const target = ev.target;
      const tag = target && target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (target && target.isContentEditable)) return;
      ev.preventDefault();
      setHistoryOpen(histPanel.hidden);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !histViewer.hidden) {
        ev.stopPropagation();
        closeHistoryViewer();
      }
    }, true);

    // Sync across tabs.
    try {
      if (chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes[HISTORY_KEY]) return;
          reloadHistoryForCurrent();
        });
      }
    } catch {}

    // Record this page load as a snapshot, then reload the list for UI.
    (async () => {
      try { await recordSnapshot(location.href, STATE.rawText || ""); } catch {}
      reloadHistoryForCurrent();
    })();

    ns.jlFastHash = jlFastHash;
    ns.recordSnapshot = recordSnapshot;

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
        { id: "snapshot", label: "Export standalone HTML snapshot", hint: "Share", icon: ICONS.share, run: () => root.querySelector('[data-action="snapshot"]').click() },
        { id: "heatmap", label: root.classList.contains("jl-heatmap") ? "Disable heatmap mode" : "Heatmap — colorize numeric leaves by magnitude", hint: "View", icon: ICONS.flame, run: () => root.querySelector('[data-action="heatmap"]').click() },
        ...(curlBtn && !curlBtn.disabled ? [
          { id: "copy-curl-patch", label: "Copy edits as cURL PATCH", hint: "Clipboard", icon: ICONS.patch, run: () => curlBtn.click() },
        ] : []),
        { id: "schema", label: "Toggle inferred schema panel", hint: "Panel", icon: ICONS.schema, run: () => root.querySelector('[data-action="schema"]').click() },
        { id: "diff", label: "Toggle diff against another URL", hint: "Panel", icon: ICONS.diff, run: () => root.querySelector('[data-action="diff"]').click() },
        { id: "jsonpath", label: "Toggle JSONPath evaluator panel", hint: "Panel", icon: ICONS.jsonpath, run: () => root.querySelector('[data-action="jsonpath"]').click() },
        { id: "queries", label: "Toggle saved queries workspace", hint: "Q", icon: ICONS.queries, run: () => root.querySelector('[data-action="queries"]').click() },
        { id: "queries-save", label: "Save current filter as a named query", hint: "Save", icon: ICONS.plus, run: () => { root.querySelector('[data-action="queries"]').click(); setTimeout(() => root.querySelector('.jl-q-add').click(), 60); } },
        ...(isGqlResp ? [
          { id: "graphql", label: "Toggle GraphQL operation & variables", hint: "Panel", icon: ICONS.graphql, run: () => root.querySelector('[data-action="graphql"]').click() },
        ] : []),
        { id: "bookmarks", label: "Toggle bookmarks panel", hint: "B", icon: ICONS.bookmark, run: () => root.querySelector('[data-action="bookmarks"]').click() },
        { id: "bookmark-add", label: "Bookmark this URL", hint: "Save", icon: ICONS.plus, run: () => { setBookmarksOpen(true); addCurrentAsBookmark(); } },
        { id: "pins", label: "Toggle pinned nodes panel", hint: "P", icon: ICONS.pin, run: () => setPinsOpen(pinsPanel.hidden) },
        { id: "pins-clear", label: "Unpin all nodes", hint: "Pins", icon: ICONS.trash, run: () => { if (pinsList.length) { pinsList = []; refreshPinUI(); persistPins(); flash(root, "All pins cleared"); } } },
        { id: "pins-copy", label: "Copy pinned values as JSON", hint: "Clipboard", icon: ICONS.copy, run: () => pinsCopy.click() },
        { id: "history", label: "Toggle history timeline", hint: "H", icon: ICONS.history, run: () => root.querySelector('[data-action="history"]').click() },
        { id: "history-clear", label: "Clear history for this URL", hint: "History", icon: ICONS.trash, run: () => { setHistoryOpen(true); clearHistoryForCurrent(); } },
        { id: "raw", label: inRaw ? "Show interactive tree" : "Show raw JSON text", hint: "View", icon: ICONS.raw, run: () => root.querySelector('[data-action="raw"]').click() },
        { id: "settings", label: "Open settings — theme, font, indent, accent", hint: "Settings", icon: ICONS.gear, run: () => { setPaletteOpen(false); setSettingsOpen(true); } },
        { id: "focus-search", label: "Focus search bar", hint: "⌘⇧K", icon: ICONS.search, run: () => { setPaletteOpen(false); searchInput.focus(); searchInput.select(); } },
        { id: "focus-filter", label: "Focus jq-style path filter", hint: "/", icon: ICONS.filter, run: () => { setPaletteOpen(false); filterInput.focus(); filterInput.select(); } },
        ...(isTabularArray(parsed) ? [
          { id: "export-csv", label: "Download root array as CSV", hint: "Export", icon: ICONS.csv, run: () => {
            const src = generateCSV(parsed);
            if (!src) { flash(root, "Not tabular"); return; }
            const blob = new Blob([src], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            const base = (location.pathname.split("/").pop() || "document").replace(/\.json$/i, "") || "document";
            a.href = url; a.download = `${base}.csv`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            flash(root, "Saved CSV");
          } },
          { id: "export-csv-copy", label: "Copy root array as CSV", hint: "Export", icon: ICONS.csv, run: async () => {
            const src = generateCSV(parsed);
            if (!src) { flash(root, "Not tabular"); return; }
            try { await navigator.clipboard.writeText(src); flash(root, "Copied CSV"); }
            catch { flash(root, "Copy failed"); }
          } },
        ] : []),
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
    // ⌘K / Ctrl+K is the primary command-palette shortcut; ⌘⇧P kept as an alias for parity with editor conventions.
    document.addEventListener("keydown", (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      const isK = !ev.shiftKey && !ev.altKey && (ev.key === "k" || ev.key === "K");
      const isShiftP = ev.shiftKey && (ev.key === "p" || ev.key === "P");
      if (mod && (isK || isShiftP)) {
        // Don't hijack when the user is typing inside a JSON Lens input/textarea — let them keep editing.
        const t = ev.target;
        const insideEditable = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t.isContentEditable === true));
        const insideLens = !!(t && t.closest && t.closest(".jl-root"));
        if (insideEditable && insideLens && !palette.hidden) return; // already inside palette input
        ev.preventDefault();
        setPaletteOpen(palette.hidden);
      } else if (!palette.hidden && ev.key === "Escape") {
        ev.preventDefault();
        setPaletteOpen(false);
      }
    });

    // ---------- pinned nodes sidebar ----------
    // Pins live in-memory for this session and are persisted per URL via
    // chrome.storage.local for stable cross-reference across reloads. Each pin
    // is `{ path, ts }`; the value preview is resolved live from `parsed` so
    // edits flow through automatically.
    const PINS_KEY = "json-lens:pins";
    const PINS_MAX = 64;
    const pinsPanel = root.querySelector(".jl-pins-panel");
    const pinsBtn = root.querySelector('[data-action="pins"]');
    const pinsBody = root.querySelector(".jl-pins-body");
    const pinsEmpty = root.querySelector(".jl-pins-empty");
    const pinsSummary = root.querySelector(".jl-pins-summary");
    const pinsClose = root.querySelector(".jl-pins-close");
    const pinsClear = root.querySelector(".jl-pins-clear");
    const pinsCopy = root.querySelector(".jl-pins-copy");
    const pinsDropzone = root.querySelector(".jl-pins-dropzone");
    const pinsCount = root.querySelector(".jl-pin-count");
    /** @type {{ path: string, ts: number }[]} */
    let pinsList = [];

    function pinsStorage() {
      try { return chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
      catch { return null; }
    }
    function loadPinsAll() {
      return new Promise((resolve) => {
        const s = pinsStorage();
        if (!s) { resolve({}); return; }
        try {
          s.get(PINS_KEY, (obj) => {
            if (chrome.runtime && chrome.runtime.lastError) { resolve({}); return; }
            const v = obj && obj[PINS_KEY];
            resolve(v && typeof v === "object" ? v : {});
          });
        } catch { resolve({}); }
      });
    }
    function savePinsAll(map) {
      return new Promise((resolve) => {
        const s = pinsStorage();
        if (!s) { resolve(false); return; }
        try { s.set({ [PINS_KEY]: map }, () => resolve(!(chrome.runtime && chrome.runtime.lastError))); }
        catch { resolve(false); }
      });
    }
    async function loadPinsForCurrent() {
      const map = await loadPinsAll();
      const list = Array.isArray(map[location.href]) ? map[location.href] : [];
      pinsList = list
        .filter((p) => p && typeof p.path === "string")
        .map((p) => ({ path: p.path, ts: Number(p.ts) || Date.now() }))
        .slice(0, PINS_MAX);
      refreshPinUI();
    }
    async function persistPins() {
      const map = await loadPinsAll();
      if (pinsList.length) map[location.href] = pinsList; else delete map[location.href];
      // Cap stored URLs to avoid unbounded growth.
      const keys = Object.keys(map);
      if (keys.length > 200) {
        // drop oldest by latest pin ts
        keys.map((k) => ({ k, t: Math.max(...(map[k].map((p) => p.ts || 0))) || 0 }))
          .sort((a, b) => a.t - b.t)
          .slice(0, keys.length - 200)
          .forEach(({ k }) => { delete map[k]; });
      }
      await savePinsAll(map);
    }

    function isPinned(pathStr) { return pinsList.some((p) => p.path === pathStr); }

    function refreshPinIcon(pathStr) {
      const node = tree.querySelector(`.jl-node[data-path="${cssEscape(pathStr)}"]`);
      if (!node) return;
      const btn = node.querySelector(':scope > .jl-row > .jl-row-actions > .jl-row-action-pin');
      if (!btn) return;
      const on = isPinned(pathStr);
      btn.innerHTML = `${on ? ICONS.pinFilled : ICONS.pin}<span class="jl-row-action-label">${on ? "Pinned" : "Pin"}</span>`;
      btn.classList.toggle("jl-row-action-pin-on", on);
      btn.setAttribute("title", on ? "Unpin node" : "Pin node");
      btn.setAttribute("aria-pressed", String(on));
      node.classList.toggle("jl-node-pinned", on);
    }
    function refreshAllPinIcons() {
      tree.querySelectorAll(".jl-node-pinned").forEach((n) => n.classList.remove("jl-node-pinned"));
      tree.querySelectorAll(".jl-row-action-pin").forEach((btn) => {
        const node = btn.closest(".jl-node");
        if (!node) return;
        const p = node.getAttribute("data-path") || "";
        const on = isPinned(p);
        if (on) node.classList.add("jl-node-pinned");
        btn.innerHTML = `${on ? ICONS.pinFilled : ICONS.pin}<span class="jl-row-action-label">${on ? "Pinned" : "Pin"}</span>`;
        btn.classList.toggle("jl-row-action-pin-on", on);
        btn.setAttribute("title", on ? "Unpin node" : "Pin node");
        btn.setAttribute("aria-pressed", String(on));
      });
    }

    function refreshPinUI() {
      if (pinsCount) {
        if (pinsList.length) { pinsCount.hidden = false; pinsCount.textContent = String(pinsList.length); }
        else { pinsCount.hidden = true; pinsCount.textContent = ""; }
      }
      refreshAllPinIcons();
      if (!pinsPanel.hidden) renderPins();
    }

    function shortPreview(value, max) {
      max = max || 64;
      const t = typeOf(value);
      if (t === "array") { const n = value.length; return `[${n} ${n === 1 ? "item" : "items"}]`; }
      if (t === "object") { const n = Object.keys(value).length; return `{${n} ${n === 1 ? "key" : "keys"}}`; }
      if (t === "string") {
        const s = JSON.stringify(value);
        return s.length > max ? s.slice(0, max - 1) + "\u2026\"" : s;
      }
      if (t === "null") return "null";
      const s = String(value);
      return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
    }

    function renderPins() {
      if (!pinsList.length) {
        pinsEmpty.hidden = false;
        pinsBody.innerHTML = "";
        pinsSummary.textContent = "";
        pinsClear.disabled = true;
        pinsCopy.disabled = true;
        return;
      }
      pinsEmpty.hidden = true;
      pinsClear.disabled = false;
      pinsCopy.disabled = false;
      pinsSummary.textContent = `${pinsList.length} pinned`;
      const frag = document.createDocumentFragment();
      pinsList.forEach((p, i) => {
        const resolved = resolvePath(parsed, p.path);
        const ok = resolved.ok;
        const t = ok ? typeOf(resolved.value) : "missing";
        const card = document.createElement("div");
        card.className = "jl-pins-card";
        card.setAttribute("role", "listitem");
        card.setAttribute("draggable", "true");
        card.dataset.path = p.path;
        card.dataset.index = String(i);
        card.innerHTML = `
          <span class="jl-pins-card-grip" aria-hidden="true" title="Drag to reorder">${ICONS.grip}</span>
          <button type="button" class="jl-pins-card-main" data-act="jump" title="Jump to ${escapeHTML(p.path)}">
            <div class="jl-pins-card-head">
              <span class="jl-pins-card-type" data-type="${escapeHTML(t)}">${escapeHTML(t)}</span>
              <code class="jl-pins-card-path">${escapeHTML(p.path)}</code>
            </div>
            <div class="jl-pins-card-preview">${ok ? escapeHTML(shortPreview(resolved.value)) : '<span class="jl-pins-card-missing">no longer in document</span>'}</div>
          </button>
          <div class="jl-pins-card-actions">
            <button type="button" class="jl-icon-btn" data-act="copy" title="Copy value as JSON" aria-label="Copy value as JSON" ${ok ? "" : "disabled aria-disabled=\"true\""}>${ICONS.copy}</button>
            <button type="button" class="jl-icon-btn" data-act="unpin" title="Unpin" aria-label="Unpin">${ICONS.close}</button>
          </div>`;
        frag.appendChild(card);
      });
      pinsBody.innerHTML = "";
      pinsBody.appendChild(frag);
    }

    function setPinsOpen(open) {
      pinsPanel.hidden = !open;
      root.classList.toggle("jl-pins-open", open);
      pinsBtn.setAttribute("aria-pressed", String(open));
      if (open) renderPins();
    }

    function togglePin(pathStr) {
      if (!pathStr) return;
      const idx = pinsList.findIndex((p) => p.path === pathStr);
      if (idx >= 0) {
        pinsList.splice(idx, 1);
        flash(root, "Unpinned " + pathStr);
      } else {
        if (pinsList.length >= PINS_MAX) { flash(root, `Pin limit reached (${PINS_MAX})`); return; }
        pinsList.unshift({ path: pathStr, ts: Date.now() });
        flash(root, "Pinned " + pathStr);
      }
      refreshPinUI();
      persistPins();
    }

    function jumpToPath(pathStr) {
      const node = tree.querySelector(`.jl-node[data-path="${cssEscape(pathStr)}"]`);
      if (!node) { flash(root, "Path not in tree"); return; }
      expandAncestorsOf(node, tree);
      if (node.classList.contains("jl-collapsed")) setCollapsed(node, false);
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      const row = node.querySelector(":scope > .jl-row");
      if (row) { row.classList.add("jl-row-ping"); setTimeout(() => row.classList.remove("jl-row-ping"), 700); }
    }

    pinsBtn.addEventListener("click", () => setPinsOpen(pinsPanel.hidden));
    pinsClose.addEventListener("click", () => setPinsOpen(false));
    pinsClear.addEventListener("click", () => {
      if (!pinsList.length) return;
      pinsList = [];
      refreshPinUI();
      persistPins();
      flash(root, "All pins cleared");
    });
    pinsCopy.addEventListener("click", async () => {
      if (!pinsList.length) { flash(root, "No pins"); return; }
      const payload = pinsList.map((p) => {
        const r = resolvePath(parsed, p.path);
        return { path: p.path, value: r.ok ? r.value : null, missing: !r.ok };
      });
      try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); flash(root, "Pins copied"); }
      catch { flash(root, "Copy failed"); }
    });
    pinsBody.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest("button[data-act]") : null;
      if (!btn) return;
      const card = btn.closest(".jl-pins-card");
      if (!card) return;
      const path = card.dataset.path;
      const act = btn.dataset.act;
      if (act === "jump") {
        jumpToPath(path);
      } else if (act === "unpin") {
        togglePin(path);
      } else if (act === "copy") {
        const r = resolvePath(parsed, path);
        if (!r.ok) { flash(root, "Value missing"); return; }
        try { navigator.clipboard.writeText(JSON.stringify(r.value, null, 2)); flash(root, "Value copied"); }
        catch { flash(root, "Copy failed"); }
      }
    });

    // Drag & drop. Tree rows + their pin buttons start a drag carrying the
    // node's path; the panel + its dropzone accept it. Inside the panel we
    // also allow reordering by dragging cards.
    const DRAG_MIME = "application/x-json-lens-path";
    function dragSetPath(ev, path) {
      try {
        ev.dataTransfer.setData(DRAG_MIME, path);
        ev.dataTransfer.setData("text/plain", path);
        ev.dataTransfer.effectAllowed = "copyMove";
      } catch {}
    }
    function dragGetPath(ev) {
      try {
        const v = ev.dataTransfer.getData(DRAG_MIME) || ev.dataTransfer.getData("text/plain");
        return (typeof v === "string" && v.startsWith("$")) ? v : "";
      } catch { return ""; }
    }
    tree.addEventListener("dragstart", (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (!t) return;
      // Either a row itself or its pin button starts the drag.
      let path = "";
      const node = t.closest(".jl-node");
      if (node) path = node.getAttribute("data-path") || "";
      if (!path || path === "$" || path === "") {
        // Allow root pin via the pin button explicitly.
        if (t.closest(".jl-row-action-pin")) path = node ? node.getAttribute("data-path") || "" : "";
      }
      if (!path) return;
      dragSetPath(ev, path);
      root.classList.add("jl-dragging-pin");
    });
    tree.addEventListener("dragend", () => { root.classList.remove("jl-dragging-pin"); });

    function panelDragOver(ev) {
      if (!ev.dataTransfer) return;
      const types = ev.dataTransfer.types;
      const hasPath = types && (Array.prototype.indexOf.call(types, DRAG_MIME) >= 0 || Array.prototype.indexOf.call(types, "text/plain") >= 0);
      if (!hasPath) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      pinsDropzone.classList.add("jl-pins-dropzone-hot");
      pinsPanel.classList.add("jl-pins-panel-hot");
    }
    function panelDragLeave() {
      pinsDropzone.classList.remove("jl-pins-dropzone-hot");
      pinsPanel.classList.remove("jl-pins-panel-hot");
    }
    function panelDrop(ev) {
      const path = dragGetPath(ev);
      panelDragLeave();
      if (!path) return;
      ev.preventDefault();
      if (!isPinned(path)) {
        if (pinsList.length >= PINS_MAX) { flash(root, `Pin limit reached (${PINS_MAX})`); return; }
        pinsList.unshift({ path, ts: Date.now() });
        refreshPinUI();
        persistPins();
        flash(root, "Pinned " + path);
      } else {
        flash(root, "Already pinned");
      }
    }
    pinsPanel.addEventListener("dragover", panelDragOver);
    pinsPanel.addEventListener("dragleave", panelDragLeave);
    pinsPanel.addEventListener("drop", panelDrop);
    pinsDropzone.addEventListener("dragover", panelDragOver);
    pinsDropzone.addEventListener("drop", panelDrop);

    // Reorder pins by dragging cards within the body.
    let dragReorderFrom = -1;
    pinsBody.addEventListener("dragstart", (ev) => {
      const card = ev.target instanceof Element ? ev.target.closest(".jl-pins-card") : null;
      if (!card) return;
      dragReorderFrom = Number(card.dataset.index);
      try {
        ev.dataTransfer.setData(DRAG_MIME, card.dataset.path || "");
        ev.dataTransfer.setData("text/plain", card.dataset.path || "");
        ev.dataTransfer.effectAllowed = "move";
      } catch {}
      card.classList.add("jl-pins-card-dragging");
    });
    pinsBody.addEventListener("dragend", (ev) => {
      const card = ev.target instanceof Element ? ev.target.closest(".jl-pins-card") : null;
      if (card) card.classList.remove("jl-pins-card-dragging");
      dragReorderFrom = -1;
    });
    pinsBody.addEventListener("dragover", (ev) => {
      if (dragReorderFrom < 0) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
    });
    pinsBody.addEventListener("drop", (ev) => {
      if (dragReorderFrom < 0) return;
      const card = ev.target instanceof Element ? ev.target.closest(".jl-pins-card") : null;
      const toIdx = card ? Number(card.dataset.index) : pinsList.length - 1;
      if (Number.isNaN(toIdx) || toIdx === dragReorderFrom) { dragReorderFrom = -1; return; }
      const [moved] = pinsList.splice(dragReorderFrom, 1);
      pinsList.splice(Math.max(0, Math.min(pinsList.length, toIdx)), 0, moved);
      dragReorderFrom = -1;
      refreshPinUI();
      persistPins();
    });

    // Keyboard: 'p' toggles pin on focused tree node when not typing; 'P'
    // toggles the panel (cap to avoid clobbering 'p' on focused row).
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "p" && ev.key !== "P") return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t = ev.target;
      const tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
      ev.preventDefault();
      if (ev.key === "P") { setPinsOpen(pinsPanel.hidden); return; }
      const focused = tree.querySelector(".jl-focused");
      if (focused) {
        const p = focused.getAttribute("data-path") || "";
        if (p) togglePin(p);
      } else {
        setPinsOpen(pinsPanel.hidden);
      }
    });

    // Sync pins across tabs that share the same URL.
    try {
      if (chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes[PINS_KEY]) return;
          loadPinsForCurrent();
        });
      }
    } catch {}

    loadPinsForCurrent();

    // ---------- annotations (per-path notes, persisted per URL) ----------
    // Stored in chrome.storage.local under ANNOTATIONS_KEY. Shape:
    //   { [url]: { [pathStr]: { text, updatedAt } } }
    // Notes ride alongside pins/history — they survive reloads and never leave
    // the user's machine. A small badge on each annotated row reveals the note
    // inline; a popover editor handles edits/deletes.
    const ANNOTATIONS_KEY = "json-lens:annotations";
    const ANNOTATION_MAX_LEN = 2000;
    const ANNOTATIONS_MAX_URLS = 200;
    /** @type {Map<string, { text: string, updatedAt: number }>} */
    const annotations = new Map();

    function annotationsStorage() {
      try { return chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null; }
      catch { return null; }
    }
    function loadAnnotationsAll() {
      return new Promise((resolve) => {
        const s = annotationsStorage();
        if (!s) { resolve({}); return; }
        try {
          s.get(ANNOTATIONS_KEY, (obj) => {
            if (chrome.runtime && chrome.runtime.lastError) { resolve({}); return; }
            const v = obj && obj[ANNOTATIONS_KEY];
            resolve(v && typeof v === "object" ? v : {});
          });
        } catch { resolve({}); }
      });
    }
    function saveAnnotationsAll(map) {
      return new Promise((resolve) => {
        const s = annotationsStorage();
        if (!s) { resolve(false); return; }
        try { s.set({ [ANNOTATIONS_KEY]: map }, () => resolve(!(chrome.runtime && chrome.runtime.lastError))); }
        catch { resolve(false); }
      });
    }
    async function loadAnnotationsForCurrent() {
      const map = await loadAnnotationsAll();
      const bucket = map[location.href];
      annotations.clear();
      if (bucket && typeof bucket === "object") {
        for (const [p, v] of Object.entries(bucket)) {
          if (!v || typeof v !== "object") continue;
          const text = typeof v.text === "string" ? v.text : "";
          if (!text) continue;
          annotations.set(p, { text: text.slice(0, ANNOTATION_MAX_LEN), updatedAt: Number(v.updatedAt) || 0 });
        }
      }
      refreshAllNoteIcons();
    }
    async function persistAnnotations() {
      const map = await loadAnnotationsAll();
      if (annotations.size) {
        const bucket = {};
        for (const [p, v] of annotations) bucket[p] = { text: v.text, updatedAt: v.updatedAt };
        map[location.href] = bucket;
      } else {
        delete map[location.href];
      }
      const keys = Object.keys(map);
      if (keys.length > ANNOTATIONS_MAX_URLS) {
        keys.map((k) => {
          const e = Object.values(map[k] || {});
          const t = e.length ? Math.max(...e.map((x) => Number(x.updatedAt) || 0)) : 0;
          return { k, t };
        }).sort((a, b) => a.t - b.t)
          .slice(0, keys.length - ANNOTATIONS_MAX_URLS)
          .forEach(({ k }) => { delete map[k]; });
      }
      await saveAnnotationsAll(map);
    }

    function refreshNoteIcon(pathStr) {
      const node = tree.querySelector(`.jl-node[data-path="${cssEscape(pathStr)}"]`);
      if (!node) return;
      const btn = node.querySelector(':scope > .jl-row > .jl-row-actions > .jl-row-action-note');
      if (!btn) return;
      const has = annotations.has(pathStr);
      btn.innerHTML = `${has ? ICONS.noteFilled : ICONS.note}<span class="jl-row-action-label">${has ? "Note" : "Note"}</span>`;
      btn.classList.toggle("jl-row-action-note-on", has);
      btn.setAttribute("title", has ? "Edit note" : "Add a note");
      btn.setAttribute("aria-pressed", String(has));
      node.classList.toggle("jl-node-annotated", has);
      ensureNoteBadge(node, pathStr);
    }
    function refreshAllNoteIcons() {
      tree.querySelectorAll(".jl-node-annotated").forEach((n) => n.classList.remove("jl-node-annotated"));
      tree.querySelectorAll(".jl-note-badge").forEach((b) => b.remove());
      tree.querySelectorAll(".jl-row-action-note").forEach((btn) => {
        const node = btn.closest(".jl-node");
        if (!node) return;
        const p = node.getAttribute("data-path") || "";
        const has = annotations.has(p);
        if (has) node.classList.add("jl-node-annotated");
        btn.innerHTML = `${has ? ICONS.noteFilled : ICONS.note}<span class="jl-row-action-label">Note</span>`;
        btn.classList.toggle("jl-row-action-note-on", has);
        btn.setAttribute("title", has ? "Edit note" : "Add a note");
        btn.setAttribute("aria-pressed", String(has));
        if (has) ensureNoteBadge(node, p);
      });
    }

    function ensureNoteBadge(node, pathStr) {
      const ann = annotations.get(pathStr);
      const row = node.querySelector(":scope > .jl-row");
      if (!row) return;
      let badge = row.querySelector(":scope > .jl-note-badge");
      if (!ann) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement("button");
        badge.type = "button";
        badge.className = "jl-note-badge";
        badge.setAttribute("aria-label", "Show or edit note");
        // Append at end so it sits after actions/trailing punctuation.
        row.appendChild(badge);
      }
      const summary = ann.text.split(/\r?\n/)[0].slice(0, 120);
      badge.innerHTML = `${ICONS.note}<span class="jl-note-badge-text">${escapeHTML(summary)}</span>`;
      badge.setAttribute("title", ann.text.length > summary.length ? ann.text : summary);
    }

    // Single shared popover editor lives at the root.
    const noteEditor = document.createElement("div");
    noteEditor.className = "jl-note-editor";
    noteEditor.hidden = true;
    noteEditor.setAttribute("role", "dialog");
    noteEditor.setAttribute("aria-modal", "false");
    noteEditor.setAttribute("aria-label", "Edit note");
    noteEditor.innerHTML = `
      <div class="jl-note-editor-head">
        <span class="jl-note-editor-icon" aria-hidden="true">${ICONS.note}</span>
        <code class="jl-note-editor-path"></code>
        <button type="button" class="jl-icon-btn jl-note-editor-close" title="Close (Esc)" aria-label="Close note editor">${ICONS.close}</button>
      </div>
      <textarea class="jl-note-editor-text" rows="4" maxlength="${ANNOTATION_MAX_LEN}" placeholder="Add a note — visible only to you, saved with this URL." aria-label="Note text"></textarea>
      <div class="jl-note-editor-foot">
        <span class="jl-note-editor-meta" aria-live="polite"></span>
        <span class="jl-note-editor-actions">
          <button type="button" class="jl-btn jl-btn-ghost jl-note-editor-delete" title="Delete note" aria-label="Delete note">${ICONS.trash}<span>Delete</span></button>
          <button type="button" class="jl-btn jl-note-editor-save" title="Save note (⌘⏎)" aria-label="Save note">${ICONS.save}<span>Save</span></button>
        </span>
      </div>`;
    root.appendChild(noteEditor);
    const noteEditorPath = noteEditor.querySelector(".jl-note-editor-path");
    const noteEditorText = noteEditor.querySelector(".jl-note-editor-text");
    const noteEditorMeta = noteEditor.querySelector(".jl-note-editor-meta");
    const noteEditorDelete = noteEditor.querySelector(".jl-note-editor-delete");
    const noteEditorSave = noteEditor.querySelector(".jl-note-editor-save");
    const noteEditorClose = noteEditor.querySelector(".jl-note-editor-close");
    let noteEditorActivePath = "";

    function positionNoteEditor(anchor) {
      noteEditor.hidden = false;
      const r = anchor.getBoundingClientRect();
      const w = noteEditor.offsetWidth || 360;
      const h = noteEditor.offsetHeight || 200;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = Math.min(Math.max(8, r.left), vw - w - 8);
      let top = r.bottom + 8;
      if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
      noteEditor.style.left = `${left}px`;
      noteEditor.style.top = `${top}px`;
    }

    function openNoteEditor(node, pathStr) {
      if (!pathStr) return;
      noteEditorActivePath = pathStr;
      const existing = annotations.get(pathStr);
      noteEditorPath.textContent = pathStr;
      noteEditorPath.title = pathStr;
      noteEditorText.value = existing ? existing.text : "";
      noteEditorDelete.disabled = !existing;
      noteEditorMeta.textContent = existing
        ? `Updated ${relativeTime(existing.updatedAt)} · ${noteEditorText.value.length}/${ANNOTATION_MAX_LEN}`
        : `${noteEditorText.value.length}/${ANNOTATION_MAX_LEN}`;
      // Anchor to the row's note action button when available.
      const anchor = node.querySelector(":scope > .jl-row .jl-row-action-note") || node.querySelector(":scope > .jl-row") || node;
      positionNoteEditor(anchor);
      requestAnimationFrame(() => {
        try { noteEditorText.focus(); noteEditorText.setSelectionRange(noteEditorText.value.length, noteEditorText.value.length); } catch {}
      });
    }
    function closeNoteEditor() {
      noteEditor.hidden = true;
      noteEditorActivePath = "";
    }
    async function saveNoteFromEditor() {
      const path = noteEditorActivePath;
      if (!path) return;
      const text = noteEditorText.value.trim().slice(0, ANNOTATION_MAX_LEN);
      if (!text) { await deleteNoteFromEditor(); return; }
      annotations.set(path, { text, updatedAt: Date.now() });
      refreshNoteIcon(path);
      flash(root, "Note saved");
      closeNoteEditor();
      persistAnnotations();
    }
    async function deleteNoteFromEditor() {
      const path = noteEditorActivePath;
      if (!path) return;
      if (annotations.has(path)) {
        annotations.delete(path);
        refreshNoteIcon(path);
        flash(root, "Note removed");
        persistAnnotations();
      }
      closeNoteEditor();
    }

    noteEditorText.addEventListener("input", () => {
      const n = noteEditorText.value.length;
      const existing = annotations.get(noteEditorActivePath);
      noteEditorMeta.textContent = existing
        ? `Updated ${relativeTime(existing.updatedAt)} · ${n}/${ANNOTATION_MAX_LEN}`
        : `${n}/${ANNOTATION_MAX_LEN}`;
    });
    noteEditorText.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); closeNoteEditor(); return; }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); saveNoteFromEditor(); }
    });
    noteEditorSave.addEventListener("click", () => saveNoteFromEditor());
    noteEditorDelete.addEventListener("click", () => deleteNoteFromEditor());
    noteEditorClose.addEventListener("click", () => closeNoteEditor());
    document.addEventListener("mousedown", (ev) => {
      if (noteEditor.hidden) return;
      const t = ev.target;
      if (!(t instanceof Node)) return;
      if (noteEditor.contains(t)) return;
      // Clicking another note button reopens the editor for that path; let the
      // tree click handler run after we close this one.
      closeNoteEditor();
    }, true);

    // Clicking the badge on a row opens the editor for that path.
    tree.addEventListener("click", (ev) => {
      const badge = ev.target instanceof Element ? ev.target.closest(".jl-note-badge") : null;
      if (!badge) return;
      ev.stopPropagation();
      const node = badge.closest(".jl-node");
      if (!node) return;
      const p = node.getAttribute("data-path") || "";
      if (p) openNoteEditor(node, p);
    });

    try {
      if (chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes[ANNOTATIONS_KEY]) return;
          loadAnnotationsForCurrent();
        });
      }
    } catch {}
    loadAnnotationsForCurrent();

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
    const settings = readSettings();
    applySettings(settings);
    const shell = buildShell(parsed.value, rawText);

    pre.style.display = "none";
    pre.setAttribute("data-jl-original", "true");

    document.body.appendChild(shell);
    document.documentElement.setAttribute("data-json-lens", "active");
    applySettings(settings);
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
