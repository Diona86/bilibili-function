const files = { mp4: "mp4", m4v: "m4v", mov: "mov", webm: "webm", mkv: "mkv", ogv: "ogv" };
const mimeFiles = { "video/mp4": "mp4", "video/x-m4v": "m4v", "video/quicktime": "mov", "video/webm": "webm", "video/ogg": "ogv", "video/x-matroska": "mkv" };
export function mediaUrl(value, base, allowBlob = false) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (url.username || url.password || (!/^https?:$/.test(url.protocol) && !(allowBlob && url.protocol === "blob:"))) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}
export function classify(url, type = "", player = false) {
  const mime = type.split(";")[0].trim().toLowerCase();
  const ext = new URL(url).pathname.toLowerCase().split(".").pop();
  if (/^(image\/|font\/|text\/(?:html|css|javascript)|.*(?:json|javascript|ecmascript))/.test(mime)) return null;
  if (/mpegurl/.test(mime) || ext === "m3u8") return { protocol: "hls", fileExtension: "m3u8" };
  if (mime === "application/dash+xml" || ext === "mpd") return { protocol: "dash", fileExtension: "mpd" };
  if (["m4s", "cmfv", "cmfa", "cmft", "ts", "m4f"].includes(ext) || /^(video\/mp2t|(?:audio|video)\/iso\.segment|application\/mp4)$/.test(mime) ||
    /\/(?:init(?:ialization)?|segment|chunk)[-_.]?\d*\.mp4$/i.test(new URL(url).pathname)) return { protocol: "segment", fileExtension: ext };
  if (ext === "vtt" || ext === "srt" || /^(text\/vtt|application\/x-subrip)$/.test(mime)) return { protocol: "subtitle", fileExtension: mime === "text/vtt" || ext === "vtt" ? "vtt" : "srt" };
  if (/^audio\//.test(mime) || /^(aac|m4a|mp3)$/.test(ext)) return null;
  if (Object.hasOwn(files, ext) || Object.hasOwn(mimeFiles, mime) || player) return {
    protocol: "direct",
    fileExtension: Object.hasOwn(mimeFiles, mime) ? mimeFiles[mime] : Object.hasOwn(files, ext) ? files[ext] : null
  };
  return null;
}
export function totalLength(headers) {
  const range = headers.get("content-range");
  if (range) return Number(range.match(/^bytes \d+-\d+\/(\d+)$/i)?.[1]) || null;
  if (headers.get("content-encoding") && headers.get("content-encoding") !== "identity") return null;
  return Number(headers.get("content-length")) || null;
}
export function fileName(title, extension) {
  let name = String(title || "视频").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.(mp4|webm|m4v|mov|ogv|mkv|mpd|m3u8|srt|vtt)$/i, "");
  name = [...name].slice(0, 60).join("").replace(/^[.\s]+|[.\s]+$/g, "").replace(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i, "_$&");
  return (name || "视频") + "." + extension;
}
// The document identifier scopes signed URLs and player identities to a single navigation.
/** @returns {import("../types/media.js").MediaResource} */
export function mediaResource(page, frame, entry) {
  const url = entry.mediaUrl;
  const kind = entry.protocol;
  const now = Date.now();
  return {
    id: frame.documentId + ":" + (entry.playerId || url), tabId: page.tabId, documentId: frame.documentId,
    pageUrl: page.url, pageTitle: page.title, frameUrl: frame.href, mediaUrl: url, title: entry.title || page.title,
    mediaType: "video", sourceType: entry.sourceType, protocol: kind, mimeType: null, fileExtension: null,
    contentLength: null, duration: null, width: null, height: null, resolution: entry.width && entry.height ? entry.width + "×" + entry.height : null, bitrate: null, frameRate: null,
    codecs: null, audioTracks: [], videoTracks: [], subtitleTracks: [], detectedAt: now, lastSeenAt: now,
    detectionConfidence: "candidate", downloadStatus: null, supportStatus: "detected", unsupportedReason: null,
    ...entry,
  };
}
