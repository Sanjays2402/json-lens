// JSON Lens — service worker
console.log("[json-lens] service worker booted");
chrome.runtime.onInstalled.addListener(() => console.log("[json-lens] installed"));

// Cross-origin JSON fetch on behalf of the content script. Uses host_permissions
// so the page itself doesn't need CORS to read another endpoint for diffing.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type !== "json-lens:fetch") return;
  const url = String(msg.url || "");
  if (!/^https?:\/\//i.test(url)) {
    sendResponse({ ok: false, error: "Only http(s) URLs are supported" });
    return false;
  }
  (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, {
        method: "GET",
        credentials: "omit",
        redirect: "follow",
        signal: ctrl.signal,
        headers: { Accept: "application/json, */*;q=0.1" },
      });
      clearTimeout(timer);
      const text = await res.text();
      sendResponse({
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type") || "",
        text,
      });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true; // async
});
