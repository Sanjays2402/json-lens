# JSON Lens

Interactive JSON viewer with live jq-style filter, schema inference, diff, and copy-as-typescript-interface.

> Status: **v0.1.0 — scaffold**. Features ship every 15 minutes via an autonomous agent. See `ROADMAP.md` for what's next.

## Node actions

Every collapsible node in the tree view carries quick actions, including:

- **Copy as YAML** — copy the focused node as YAML (plain scalars stay bare; quoted
  automatically when a value needs escaping, e.g. `"true"`, `"a: b"`, newlines).
- Copy as TypeScript interface / JSON Schema / CSV / JSON.

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

## Terms & Disclaimer

By using this project you agree to the following.

- **No warranty.** This software is provided "as is", without warranty of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.
- **No liability.** To the maximum extent permitted by law, the author and contributors are not liable for any claim, loss, or damage (direct, indirect, incidental, or consequential, including lost data or profits) arising from its use.
- **Your responsibility.** You use it at your own risk and are responsible for complying with the laws that apply to you.
- **Third-party sites.** This tool runs on websites you visit; use it in line with their terms.
- **Third parties.** Names, logos, APIs, and services of others belong to their owners and are used for identification only; no affiliation or endorsement is implied.
- **Your statutory rights.** Nothing here limits rights that cannot be waived by agreement, including under consumer-protection laws in the USA, Canada (including Quebec), and India (Consumer Protection Act, 2019).
- **License.** Use, copying, and distribution are governed by the [LICENSE](LICENSE) file; if anything here conflicts with it, the license controls.
