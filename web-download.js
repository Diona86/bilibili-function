// Injected into each accessible frame, including the frames that host embedded players.
function findMedia() {
  const sources = new Map();
  const embeds = new Map();
  let protectedPlayer = false;
  function add(value, { type = "", title, player = false, priority = 3, credentials = "same-origin" } = {}) {
    if (!value) return;
    let url;
    try { url = new URL(value, document.baseURI); } catch { return; }
    if (url.username || url.password || !(/^https?:$/.test(url.protocol) || (player && url.protocol === "blob:"))) return;
    const path = url.pathname.toLowerCase();
    const mime = type.toLowerCase().split(";")[0];
    let kind = "file";
    if (path.endsWith(".m3u8") || mime.includes("mpegurl")) kind = "hls";
    else if (path.endsWith(".mpd") || mime === "application/dash+xml") kind = "dash";
    else if (/\.(m4s|cmf[av]|ts|m4a|mp3|aac)$/.test(path) || mime.startsWith("audio/") ||
        (!player && !mime.startsWith("video/") && !/\.(mp4|webm|m4v|mov|ogv|mkv)$/.test(path))) return;
    if (url.protocol === "blob:") priority = 5;
    url.hash = "";
    if (sources.has(url.href) && sources.get(url.href).priority <= priority) return;
    let name = url.protocol === "blob:" ? "播放器视频" : url.pathname.split("/").pop();
    try { name = decodeURIComponent(name); } catch { /* Keep the original filename. */ }
    sources.set(url.href, { url: url.href, kind, priority, credentials,
      title: (title?.trim() || name || document.title || "视频").slice(0, 120) });
  }

  function inspect(root) {
    for (const video of root.querySelectorAll("video")) {
      if (video.mediaKeys) { protectedPlayer = true; continue; }
      const options = { player: true, priority: video.paused ? 1 : 0, title: video.title || video.getAttribute("aria-label"),
        credentials: video.crossOrigin === "use-credentials" ? "include" : "same-origin" };
      const current = video.currentSrc || video.src;
      for (const source of video.querySelectorAll("source[src]")) {
        add(source.src, { ...options, type: source.type, title: source.getAttribute("label") || options.title,
          priority: current && source.src !== current ? options.priority + 1 : options.priority });
      }
      add(current, options);
    }
    for (const frame of root.querySelectorAll("iframe[src]")) {
      const { width, height } = frame.getBoundingClientRect();
      if (width < 64 || height < 36) continue;
      let url;
      try { url = new URL(frame.src, document.baseURI); } catch { continue; }
      if (!/^https?:$/.test(url.protocol) || url.origin === location.origin || url.username || url.password) continue;
      embeds.set(url.href, { kind: "frame", url: url.href, title: frame.title || url.host });
    }
    for (const link of root.querySelectorAll("a[href]")) {
      add(link.getAttribute("href"), { type: link.getAttribute("type") || "", title: link.getAttribute("download") || link.textContent });
    }
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) inspect(el.shadowRoot);
  }
  inspect(document);
  for (const tag of document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[itemprop="contentUrl"]')) add(tag.content);
  if (!protectedPlayer) {
    for (const entry of performance.getEntriesByType("resource")) {
      const kind = entry.contentType || "";
      if (entry.initiatorType === "video" || /\.(m3u8|mpd)(?:[?#]|$)/i.test(entry.name) || /mpegurl|dash\+xml/i.test(kind)) {
        add(entry.name, { type: kind, priority: 2 });
      }
    }
  }
  return { href: location.href, origin: location.origin, sources: [...sources.values()], embeds: [...embeds.values()], protectedPlayer };
}

export async function findPageVideos(page) {
  const frames = await chrome.scripting.executeScript({ target: { tabId: page.tabId, allFrames: true }, func: findMedia })
    .catch(() => { throw new Error("请在目标网页点一次工具栏中的扩展图标，再查找视频。"); });
  if (frames.find((frame) => frame.frameId === 0)?.result?.href !== page.url) throw new Error("网页已切换，请重新查找。");
  const scanned = new Set(frames.map(({ result }) => result?.origin));
  const sources = [];
  const embeds = new Map();
  for (const { documentId, result } of frames) {
    if (!result) continue;
    for (const source of result.sources) sources.push({ ...source, documentId, frameUrl: result.href });
    for (const embed of result.embeds) if (!scanned.has(new URL(embed.url).origin)) embeds.set(embed.url, embed);
  }
  sources.sort((a, b) => a.priority - b.priority);
  // Preserve the highest-ranked player context for each URL.
  const unique = new Map();
  for (const source of sources) if (!unique.has(source.url)) unique.set(source.url, source);
  const options = [...unique.values(), ...embeds.values()];
  if (!options.length && frames.some((frame) => frame.result?.protectedPlayer)) throw new Error("这个播放器使用了内容保护。");
  return options;
}

// Fetch where the player runs, preserving its referrer and same-site session.
async function prepareFile(source) {
  if (location.href !== source.frameUrl) return { error: "播放器页面已切换，请重新查找视频。" };
  try {
    let response;
    try {
      response = await fetch(source.url, { credentials: source.credentials, signal: AbortSignal.timeout(600_000) });
    } catch (error) {
      // Direct media on a different origin can play without CORS. Chrome can download its URL directly.
      const url = new URL(source.url);
      if (error.name === "TypeError" && source.kind === "file" && /^https?:$/.test(url.protocol) && url.origin !== location.origin) {
        return { native: true };
      }
      throw new Error(url.protocol === "blob:" ? "播放器仅提供临时流。请播放几秒后重新查找播放清单。" : "无法读取视频源，请确认视频可以播放后重试。");
    }
    const range = response.headers.get("Content-Range")?.match(/^bytes 0-(\d+)\/(\d+)$/i);
    if (!response.ok || (response.status === 206 && (!range || Number(range[1]) + 1 !== Number(range[2])))) {
      await response.body?.cancel();
      throw new Error("服务器未提供完整文件（HTTP " + response.status + "）。");
    }
    const mime = (response.headers.get("Content-Type") ?? "").toLowerCase();
    let file;
    let ext;
    const kind = mime.includes("mpegurl") ? "hls" : mime.includes("dash+xml") ? "dash" : source.kind;
    if (kind === "hls" || kind === "dash") {
      const { downloadStream } = await import(chrome.runtime.getURL("web-stream.js"));
      file = await downloadStream(response, kind, source.credentials);
      ext = "mp4";
    } else {
      file = await response.blob();
      if (range && file.size !== Number(range[2])) throw new Error("视频文件不完整，请重试。");
      const head = new Uint8Array(await file.slice(0, 128).arrayBuffer());
      const text = String.fromCharCode(...head);
      if (text.slice(4, 8) === "ftyp") ext = text.slice(8, 12) === "qt  " ? "mov" : "mp4";
      else if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) ext = text.includes("matroska") ? "mkv" : "webm";
      else if (text.startsWith("OggS")) ext = "ogv";
      else if (mime.includes("quicktime") && /^(moov|wide|mdat|free)$/.test(text.slice(4, 8))) ext = "mov";
      else throw new Error("这个地址没有返回可识别的完整视频文件。");
    }
    if (location.href !== source.frameUrl) throw new Error("播放器页面已切换，请重新查找视频。");
    const url = URL.createObjectURL(file);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return { url, ext };
  } catch (error) {
    return { error: /[\u3400-\u9fff]/.test(error.message) ? error.message : "无法读取视频或播放清单，请确认它是可访问的点播视频。" };
  }
}

export async function downloadPageVideo(page, source) {
  const current = await chrome.tabs.get(page.tabId);
  if (current.url !== page.url) throw new Error("网页已切换，请重新查找视频。");
  const [reply] = await chrome.scripting.executeScript({
    target: { tabId: page.tabId, documentIds: [source.documentId] }, func: prepareFile, args: [source],
  }).catch(() => { throw new Error("原播放器已关闭或刷新，请重新查找视频。"); });
  const result = reply?.result;
  if (!result || result.error) throw new Error(result?.error ?? "原播放器已关闭或刷新，请重新查找视频。");
  const url = result.native ? source.url : result.url;
  const ext = result.ext ?? new URL(url).pathname.match(/\.(mp4|webm|m4v|mov|ogv|mkv)$/i)?.[1];
  if ((await chrome.tabs.get(page.tabId)).url !== page.url) throw new Error("网页已切换，请重新查找视频。");
  const title = (source.title || page.title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\.(mp4|webm|m4v|mov|ogv|mkv|mpd|m3u8)$/i, "");
  const name = [...title].slice(0, 60).join("").replace(/^[.\s]+|[.\s]+$/g, "")
    .replace(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i, "_$&") || "视频";
  await chrome.downloads.download({ url, filename: ext ? name + "." + ext : undefined, conflictAction: "uniquify" });
}
