import { classify, mediaUrl } from "./resource.js";

const ids = new WeakMap();
const observedRoots = new WeakSet();
const encrypted = new WeakSet();
let nextId = 0;
let notifyTimer;
let timingObserver;
const announced = new Set();
const firstSeen = new Map();
let pageHref = location.href;
let since = 0;
function notify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    void chrome.runtime.sendMessage({ target: "media-change" }).catch(() => {});
  }, 350);
}
function observe(root) {
  if (observedRoots.has(root)) return;
  observedRoots.add(root);
  const selector = "video,source,track,iframe";
  new MutationObserver((changes) => {
    if (changes.some(c => c.type === "attributes" ? c.target instanceof Element && c.target.matches(selector) :
      [...c.addedNodes, ...c.removedNodes].some(n => n instanceof Element && (n.matches(selector) || n.querySelector(selector) || n.shadowRoot)))) notify();
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "type", "label", "controlslist"] });
  for (const event of ["loadedmetadata", "play", "pause", "emptied", "encrypted"]) {
    root.addEventListener(event, e => {
      if (e.target instanceof HTMLVideoElement) {
        if (e.type === "encrypted") encrypted.add(e.target);
        notify();
      }
    }, true);
  }
}
export async function scanFrame(network = []) {
  if (pageHref !== location.href) { pageHref = location.href; since = performance.now(); announced.clear(); firstSeen.clear(); }
  const entries = [], embeds = [], segments = new Set(), looseSubtitles = [];
  const blocked = new Set();
  let protectedPlayer = false;
  function candidate(value, type, extra) {
    const url = mediaUrl(value, document.baseURI, Boolean(extra.playerId));
    if (!url) return;
    const kind = classify(url, type || "", Boolean(extra.playerId));
    if (!kind) return;
    if (kind.protocol === "segment") { segments.add(kind.fileExtension || "分片"); return; }
    if (kind.protocol === "subtitle") { looseSubtitles.push({ id: url, url, label: extra.title || kind.fileExtension, format: kind.fileExtension }); return; }
    if (!firstSeen.has(url)) {
      if (firstSeen.size >= 400) firstSeen.delete(firstSeen.keys().next().value);
      firstSeen.set(url, Date.now());
    }
    entries.push({ mediaUrl: url, ...kind, mimeType: type || null, detectedAt: firstSeen.get(url), lastSeenAt: Date.now(), ...extra });
  }
  function visit(root) {
    observe(root);
    for (const video of root.querySelectorAll("video")) {
      if (!ids.has(video)) ids.set(video, "player-" + ++nextId);
      const playerId = ids.get(video);
      const current = video.currentSrc || video.src;
      const reason = video.mediaKeys || encrypted.has(video) ? "播放器使用了内容保护。" :
        video.controlsList?.contains("nodownload") ? "播放器已声明禁止下载。" : null;
      const tracks = [...video.querySelectorAll("track[src]")].filter(t => ["subtitles", "captions"].includes(t.kind))
        .map(t => ({ id: t.src, url: mediaUrl(t.src, document.baseURI), label: t.label || t.srclang || "字幕", language: t.srclang })).filter(t => t.url);
      let preview = null;
      if (!reason && video.readyState >= 2 && video.videoWidth) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 144; canvas.height = Math.max(1, Math.min(200, Math.round(144 * video.videoHeight / video.videoWidth)));
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          preview = canvas.toDataURL("image/jpeg", 0.6);
        } catch { /* Cross-origin frames can still be detected without a thumbnail. */ }
      }
      const info = {
        playerId, preview, title: video.title || video.getAttribute("aria-label") || document.title, sourceType: "player",
        playing: !video.paused && !video.ended, duration: Number.isFinite(video.duration) ? video.duration : null,
        poster: mediaUrl(video.poster, document.baseURI), credentials: video.crossOrigin === "use-credentials" ? "include" : "same-origin",
        subtitleTracks: tracks, unsupportedReason: reason, supportStatus: reason ? "unsupported" : "detected", detectionConfidence: "player"
      };
      const sources = [...video.querySelectorAll("source[src]")].map(s => ({ url: s.src, type: s.type, label: s.getAttribute("label") }));
      if (current && !sources.some(s => s.url === current)) sources.unshift({ url: current, type: "", label: "" });
      if (!sources.length) {
        entries.push({ ...info, mediaUrl: null, protocol: "player", unsupportedReason: reason || "播放器尚未提供可读取的媒体地址。", supportStatus: "unsupported" });
      }
      for (const s of sources) {
        const selected = s.url === current;
        if (reason) { blocked.add(s.url); protectedPlayer = true; }
        candidate(s.url, s.type, {
          ...info, label: s.label, selected,
          width: selected ? video.videoWidth || null : null, height: selected ? video.videoHeight || null : null
        });
      }
      if (reason) protectedPlayer = true;
    }
    for (const el of root.querySelectorAll("iframe[src]")) {
      const url = mediaUrl(el.src, document.baseURI);
      if (url && el.getBoundingClientRect().width >= 64 && new URL(url).origin !== location.origin) embeds.push({ url, title: el.title || new URL(url).host });
    }
    for (const a of root.querySelectorAll("a[href]")) candidate(a.getAttribute("href"), a.getAttribute("type"), { title: a.textContent.trim(), sourceType: "link" });
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
  }
  visit(document);
  for (const t of document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[itemprop="contentUrl"]')) {
    candidate(t.getAttribute("content"), document.querySelector('meta[property="og:video:type"]')?.getAttribute("content"), { sourceType: "metadata" });
  }
  if (!protectedPlayer) {
    for (const e of performance.getEntriesByType("resource")) {
      if (e.startTime < since) continue;
      const entry = /** @type {PerformanceResourceTiming} */ (e);
      candidate(entry.name, entry.contentType, { sourceType: "timing", lastSeenAt: performance.timeOrigin + entry.startTime });
    }
    for (const e of network) candidate(e.mediaUrl, e.mimeType, e);
  }
  if (!timingObserver) {
    timingObserver = new PerformanceObserver(list => {
      if (list.getEntries().some(e => {
        const u = mediaUrl(e.name, location.href);
        const k = u && classify(u, /** @type {PerformanceResourceTiming} */(e).contentType);
        if (!k || !["hls", "dash", "direct"].includes(k.protocol) || announced.has(u)) return false;
        if (announced.size >= 120) announced.delete(announced.values().next().value);
        announced.add(u);
        return true;
      })) notify();
    });
    timingObserver.observe({ type: "resource" });
  }
  return { href: location.href, entries: entries.filter(e => e.playerId || !blocked.has(e.mediaUrl)), embeds, segments: [...segments], looseSubtitles };
}
