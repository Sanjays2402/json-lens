// Smoke test: validates manifest.json shape and required files exist.
import fs from "node:fs";
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const must = ["manifest_version","name","version","description"];
for (const k of must) if (!m[k]) { console.error("missing manifest key:", k); process.exit(1); }
if (m.manifest_version !== 3) { console.error("manifest_version must be 3"); process.exit(1); }
for (const p of ["src/popup.html","src/popup.js","src/popup.css","src/background.js","src/content.js","src/viewer.css"])
  if (!fs.existsSync(p)) { console.error("missing file:", p); process.exit(1); }
for (const sz of [16,32,48,128]) if (!fs.existsSync(`icons/icon-${sz}.png`)) { console.error("missing icon:", sz); process.exit(1); }
if (!Array.isArray(m.content_scripts) || !m.content_scripts.length) { console.error("manifest missing content_scripts"); process.exit(1); }
const cs = m.content_scripts[0];
if (!Array.isArray(cs.js) || !cs.js.includes("src/content.js")) { console.error("content_scripts must include src/content.js"); process.exit(1); }
if (!Array.isArray(cs.matches) || !cs.matches.length) { console.error("content_scripts.matches required"); process.exit(1); }
console.log("\u2713 smoke ok");
