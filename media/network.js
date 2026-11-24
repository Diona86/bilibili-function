import { classify, totalLength } from "./resource.js";

const watched = new Map();
const ready = chrome.storage.session.get("mediaWatch").then(({ mediaWatch = {} }) => {
  for (const [id, tab] of Object.entries(mediaWatch)) watched.set(Number(id), tab);
});
let pending;
function persist() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    void chrome.storage.session.set({ mediaWatch: Object.fromEntries(watched) }).catch(() => {});
  }, 250);
}
export async function watch(tabId, url) {
  await ready;
  if (!/^https?:\/\//.test(url || "")) return;
  if (watched.get(tabId)?.url !== url) watched.set(tabId, { url, entries: [] });
  if (watched.size > 12) watched.delete(watched.keys().next().value);
  persist();
}
export async function headersFor(tabId, url) {
  await watch(tabId, url);
  return watched.get(tabId)?.entries || [];
}
chrome.tabs.onRemoved.addListener(id => { void ready.then(() => { if (watched.delete(id)) persist(); }); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (!change.url && change.status !== "loading") return;
  void ready.then(() => {
    const tab = watched.get(id);
    if (!tab) return;
    if (change.url && new URL(change.url).origin !== new URL(tab.url).origin) watched.delete(id);
    else { tab.url = change.url || tab.url; tab.entries = []; }
    persist();
  });
});
function recordResponse(e) {
  const tab = watched.get(e.tabId);
  if (!tab || !e.documentId || ![200, 206].includes(e.statusCode)) return;
  const headers = new Headers();
  for (const h of e.responseHeaders || []) {
    if (h.value && /^(content-type|content-length|content-encoding|content-range)$/i.test(h.name)) headers.set(h.name, h.value);
  }
  const mimeType = headers.get("content-type")?.split(";")[0] || "";
  const kind = classify(e.url, mimeType);
  if (!kind) return;
  const entries = tab.entries;
  // A sample per segment format/document suffices for MSE detection.
  const old = entries.find(x => x.documentId === e.documentId && (x.mediaUrl === e.url ||
    kind.protocol === "segment" && x.protocol === "segment" && x.fileExtension === kind.fileExtension));
  if (old && kind.protocol === "segment") return;
  const record = {
    ...kind, documentId: e.documentId, mediaUrl: e.url, mimeType,
    sourceType: "headers", detectionConfidence: mimeType ? "headers" : "candidate", contentLength: kind.protocol === "direct" ? totalLength(headers) : null,
    detectedAt: old?.detectedAt ?? e.timeStamp, lastSeenAt: e.timeStamp
  };
  if (old) Object.assign(old, record);
  else {
    entries.push(record);
    if (entries.length > 80) entries.shift();
    if (kind.protocol !== "segment") void chrome.runtime.sendMessage({ target: "media-change", tabId: e.tabId }).catch(() => {});
  }
  persist();
}
chrome.webRequest.onHeadersReceived.addListener(e => {
  void ready.then(() => recordResponse(e));
  return undefined;
}, { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other"] }, ["responseHeaders"]);
