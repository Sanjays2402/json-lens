# JSON Lens

Interactive JSON viewer with live jq-style filter, schema inference, diff, and copy-as-typescript-interface.

> Status: **v0.1.0 — scaffold**. Features ship every 15 minutes via an autonomous agent. See `ROADMAP.md` for what's next.

## Install (dev)

```
git clone https://github.com/Sanjays2402/json-lens.git
cd json-lens
```

Then in Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → select this folder.

## Permissions

- `storage`
- `activeTab`
- `scripting`

**Host permissions:**
- `<all_urls>`

## Roadmap

- [ ] MV3 manifest + content script scaffolding
- [ ] Auto-detect JSON content-type and replace raw view
- [ ] Collapsible tree view with type badges
- [ ] Live filter bar (jq-style path filtering)
- [ ] Search keys and values with highlight
- [ ] Inferred schema panel (types + counts)
- [ ] Copy node as TypeScript interface
- [ ] Copy node as JSON Schema
- [ ] Diff two JSON URLs side-by-side
- [ ] Pretty-print + minify toggle
- [ ] Path breadcrumb on hover
- [ ] Export filtered subtree
- [ ] Performance mode for >10MB JSON (virtualized tree)
- [ ] Liquid-glass overlay UI
- [ ] Dark/light theme + monospace tweaks

## License

MIT — see [LICENSE](LICENSE).
