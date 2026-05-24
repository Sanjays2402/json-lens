# Roadmap

This file is the agent's task queue. Unchecked items get implemented in order. When all items are checked, the agent appends a new batch of 10.

- [x] MV3 manifest + content script scaffolding
- [x] Auto-detect JSON content-type and replace raw view
- [x] Collapsible tree view with type badges
- [x] Live filter bar (jq-style path filtering)
- [x] Search keys and values with highlight
- [x] Inferred schema panel (types + counts)
- [x] Copy node as TypeScript interface
- [x] Copy node as JSON Schema
- [x] Diff two JSON URLs side-by-side
- [x] Pretty-print + minify toggle
- [x] Path breadcrumb on hover
- [x] Export filtered subtree
- [x] Performance mode for >10MB JSON (virtualized tree)
- [x] Liquid-glass overlay UI
- [x] Dark/light theme + monospace tweaks
- [x] Bookmark frequently-visited JSON endpoints with named tags
- [x] JSONPath expression evaluator panel (alternative to jq syntax)
- [x] Inline value editing with revert + copy-as-curl PATCH
- [x] History timeline of JSON snapshots per URL (last 20)
- [x] Smart number formatting (thousands separators, byte units, timestamps)
- [x] Detect and render embedded base64/JWT/UUID with decoded preview
- [x] Keyboard navigation (j/k/h/l vim-style) with focus ring
- [x] Export tree as CSV for tabular arrays
- [x] Pinned nodes sidebar (drag any node to pin for cross-reference)
- [x] Command palette (Cmd+K) for all extension actions
- [x] GraphQL response detection with operation/variables panel
- [x] Inline syntax-highlighted regex search across keys and values
- [x] Node annotations — attach personal notes to any JSON path (persisted per-URL)
- [x] Auto-link detection: render URLs, emails, and IP addresses as clickable chips
- [x] Schema comparison: diff inferred schemas between two endpoints
- [x] Export current view as standalone shareable HTML snapshot
- [ ] Heatmap mode — colorize numeric leaves by relative magnitude within their array
- [ ] Time-series detection: chart numeric arrays of {timestamp, value} inline
- [ ] Saved query workspace — store named jq/JSONPath expressions per domain
- [ ] Settings panel with theme, font, indent width, and accent color picker
