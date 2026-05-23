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
- [ ] Inline value editing with revert + copy-as-curl PATCH
- [ ] History timeline of JSON snapshots per URL (last 20)
- [ ] Smart number formatting (thousands separators, byte units, timestamps)
- [ ] Detect and render embedded base64/JWT/UUID with decoded preview
- [ ] Keyboard navigation (j/k/h/l vim-style) with focus ring
- [ ] Export tree as CSV for tabular arrays
- [ ] Pinned nodes sidebar (drag any node to pin for cross-reference)
- [ ] Command palette (Cmd+K) for all extension actions
