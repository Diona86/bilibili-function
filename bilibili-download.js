import { resolveBiliPart } from "./bilibili-audio.js";
import { mediaResource } from "./media/resource.js";

// Runs in the page world so the player's manifest and its recent requests are both available.
function findVideoFiles(cid) {
  function mediaUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, location.href);
      const host = /(^|\.)bilivideo\.(com|cn|net)$/i.test(url.hostname) ||
        /^upos-[\w-]+\.akamaized\.net$/i.test(url.hostname);
      const parts = url.pathname.split("/");
      if (url.protocol === "https:" && host && !url.username && !url.password &&
          (parts.includes(cid) || parts.at(-1).startsWith(cid + "-") || parts.at(-1).startsWith(cid + "_"))) {
        return url.href;
      }
    } catch { /* Ignore resource names that are not media URLs. */ }
    return null;
  }

  const data = globalThis.__playinfo__?.data;
  const urls = (track) => [track.url ?? track.baseUrl ?? track.base_url,
    ...(track.backupUrl ?? track.backup_url ?? [])].map(mediaUrl).filter(Boolean);
  const direct = new Set();
  if (data?.durl?.length === 1) {
    for (const url of urls(data.durl[0])) {
      if (/\.mp4$/i.test(new URL(url).pathname)) direct.add(url);
    }
  }
  const player = /** @type {HTMLVideoElement | null} */ (document.querySelector(".bpx-player-video-wrap video, #bilibili-player video"));
  const src = mediaUrl(player?.currentSrc);
  if (src && !data?.durl?.length && /\.mp4$/i.test(new URL(src).pathname)) direct.add(src);

  const video = new Set();
  const audio = new Set();
  for (const entry of performance.getEntriesByType("resource").reverse()) {
    const url = mediaUrl(entry.name);
    if (!url) continue;
    const code = new URL(url).pathname.match(/-(\d+)\.m4s$/i)?.[1];
    if (code) (/^30(2|3)/.test(code) ? audio : video).add(url);
  }
  const dash = data?.dash;
  for (const track of dash?.video ?? []) urls(track).forEach((url) => video.add(url));
  for (const track of dash?.audio ?? []) urls(track).forEach((url) => audio.add(url));
  const silent = dash?.video?.some((track) => urls(track).length) &&
    !dash.audio?.length && !dash.dolby?.audio?.length && !dash.flac?.audio;
  return { direct: [...direct], video: [...video], audio: [...audio], silent: Boolean(silent) };
}

export async function getBiliResource(video) {
  const { cid, target } = await resolveBiliPart(video);
  const [reply] = await chrome.scripting.executeScript({ target, world: "MAIN", func: findVideoFiles, args: [cid] });
  const files = reply?.result;
  if (!files || (!files.direct.length && !(files.video.length && (files.audio.length || files.silent)))) {
    throw new Error("请先播放当前分 P 几秒，再下载视频。");
  }
  return mediaResource(video, { documentId: reply.documentId, href: video.url }, {
    id: video.key, protocol: "bilibili", sourceType: "bilibili", detectionConfidence: "player",
    title: video.title + " - P" + video.part, mediaUrl: null, files, credentials: "omit", supportStatus: "ready"
  });
}
