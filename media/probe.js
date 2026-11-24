import { context, invalidBody, plainMime } from "./io.js";
import { streamPlan } from "./manifests.js";
import { classify, totalLength } from "./resource.js";

const cache = new Map();
export async function inspect(source, choice = {}, refresh = false) {
  const key = JSON.stringify([location.href, source.mediaUrl, source.protocol, choice.videoId, choice.audioId, source.credentials]);
  const hit = cache.get(key);
  if (!refresh && hit && hit.until > Date.now()) return hit.value;
  const value = inspectNow(source, choice).catch(error => ({
    supportStatus: "unsupported", unsupportedReason: /[\u3400-\u9fff]/.test(error.message) ? error.message : "媒体结构损坏或暂不支持。",
  }));
  if (cache.size >= 40) cache.delete(cache.keys().next().value);
  cache.set(key, { value, until: Date.now() + 45000 });
  return value;
}
async function inspectNow(source, choice) {
  if (source.unsupportedReason && source.sourceType === "player" && source.protocol === "player") return source;
  const ctx = context(undefined, source.credentials);
  if (["hls", "dash"].includes(source.protocol)) {
    const p = await streamPlan(source.mediaUrl, source.protocol, choice, ctx, true);
    const track = p.videoTracks.find(t => t.id === choice.videoId) || p.videoTracks[0];
    return {
      videoTracks: p.videoTracks, audioTracks: p.audioTracks, subtitleTracks: p.subtitleTracks, relatedUrls: p.relatedUrls,
      contentLength: null, duration: p.duration, width: track?.width, height: track?.height, resolution: track?.width && track?.height ? track.width + "×" + track.height : null,
      codecs: track?.codecs, bitrate: track?.bitrate, frameRate: track?.frameRate,
      segmentCount: p.video?.segments?.length, supportStatus: p.issue ? "unsupported" : "ready", unsupportedReason: p.issue || null
    };
  }
  const blob = source.mediaUrl?.startsWith("blob:");
  let res;
  try {
    res = await fetch(source.mediaUrl, { method: blob ? "GET" : "HEAD", credentials: source.credentials || "same-origin", signal: AbortSignal.timeout(8000) });
    if (!blob && [403, 405, 501].includes(res.status)) {
      await res.body?.cancel();
      res = await fetch(source.mediaUrl, { headers: { Range: "bytes=0-0" }, credentials: source.credentials || "same-origin", signal: AbortSignal.timeout(8000) });
    }
    if (!res.ok || invalidBody(plainMime(res))) throw new Error("媒体地址返回了错误页或访问受限（HTTP " + res.status + "）。");
    let kind = classify(res.url || source.mediaUrl, plainMime(res));
    if (!blob && !kind && !source.fileExtension) {
      const sample = await fetch(source.mediaUrl, { headers: { Range: "bytes=0-2047" }, credentials: ctx.credentials, signal: AbortSignal.timeout(8000) });
      try {
        if (sample.ok && sample.body) {
          const reader = sample.body.getReader();
          try {
            const { value } = await reader.read();
            const start = new TextDecoder().decode(value?.subarray(0, 2048)).trimStart();
            if (start.startsWith("#EXTM3U")) kind = { protocol: "hls", fileExtension: "m3u8" };
            if (/^(?:<\?xml[^>]*>\s*)?<MPD\b/i.test(start)) kind = { protocol: "dash", fileExtension: "mpd" };
          } finally { await reader.cancel().catch(() => {}); }
        }
      } finally { await sample.body?.cancel().catch(() => {}); }
    }
    if (kind && ["dash", "hls"].includes(kind.protocol)) {
      const detail = await inspectNow({ ...source, ...kind }, choice);
      return { ...detail, ...kind, mimeType: plainMime(res) };
    }
    return { contentLength: totalLength(res.headers) || source.contentLength, mimeType: plainMime(res) || source.mimeType, supportStatus: "ready" };
  } catch (error) {
    if (blob) return { protocol: "player", supportStatus: "unsupported", unsupportedReason: "这是临时流播放器，尚未关联到可读取的媒体文件或清单。" };
    if (error instanceof TypeError && new URL(source.mediaUrl).origin !== location.origin) {
      return { needsOrigin: true, supportStatus: "permission", unsupportedReason: "网页无法验证跨域直链，可授权读取该文件域名。" };
    }
    throw error;
  } finally { await res?.body?.cancel().catch(() => {}); }
}
