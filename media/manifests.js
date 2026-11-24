import { parseHls } from "./hls.js";
import { readText } from "./io.js";
import { mediaUrl } from "./resource.js";

export function selectTrack(list, id, description) {
  const item = id ? list.find(t => t.id === id) : list.find(t => t.default) || list[0];
  if (id && !item) throw new Error(description + "已经变化，请重新识别。");
  return item || null;
}
function dashPart(s) {
  const r = s.byterange;
  if (r && (!Number.isSafeInteger(r.length) || r.length < 1 || !Number.isSafeInteger(r.offset) || r.offset < 0)) throw new Error("DASH 字节范围无效。");
  return { url: s.resolvedUri, range: r || null };
}
export async function parseDash(xml, url) {
  await import("../vendor/mpd-parser.min.js");
  const root = window.mpdParser.stringToMpdXml(xml);
  if (root.getAttribute("type") === "dynamic") throw new Error("动态 DASH 或直播不支持完整下载。");
  if (root.getElementsByTagNameNS("*", "ContentProtection").length) throw new Error("DASH 清单使用了内容保护。");
  if (root.getElementsByTagNameNS("*", "Period").length !== 1) throw new Error("目前支持单时段 DASH，多时段不能可靠拼接。");
  const reps = [...root.getElementsByTagNameNS("*", "Representation")];
  const m = window.mpdParser.parse(xml, { manifestUri: url });
  function describe(p, type, group = null) {
    const a = p.attributes, rep = reps.find(r => r.getAttribute("id") === a.NAME);
    const set = rep?.parentElement;
    const attr = n => rep?.getAttribute(n) || set?.getAttribute(n);
    const frame = (attr("frameRate") || "").split("/").map(Number);
    const segments = (p.segments || []).map(dashPart);
    const map = p.segments?.[0]?.map || p.sidx?.map;
    let init = map ? dashPart(map) : null;
    if (!segments.length) {
      const file = p.sidx?.resolvedUri || p.resolvedUri;
      if (!file || file === url || new URL(file).pathname.endsWith("/")) throw new Error("DASH 轨道缺少独立文件或分段索引。");
      segments.push({ url: file, range: null });
      if (init?.url === file) init = null;
    }
    const template = rep?.querySelector("SegmentTemplate,SegmentList,SegmentBase");
    const parent = set?.querySelector(":scope > SegmentTemplate,:scope > SegmentList,:scope > SegmentBase");
    const val = name => template?.getAttribute(name) ?? parent?.getAttribute(name);
    const scale = Number(val("timescale")) || 1;
    return {
      id: String(a.NAME ?? p.resolvedUri), type, url: p.resolvedUri, label: group?.label || attr("lang") || a.NAME,
      language: group?.language || attr("lang") || null, default: group?.default ?? false, audioGroup: a.AUDIO,
      width: a.RESOLUTION?.width || null, height: a.RESOLUTION?.height || null, bitrate: a.BANDWIDTH || null,
      codecs: a.CODECS || null, frameRate: frame[0] / (frame[1] || 1) || null, init, segments,
      presentationOffset: Number(val("presentationTimeOffset")) / scale || 0
    };
  }
  const videos = m.playlists.filter(p => p.attributes.RESOLUTION || reps.some(r => r.getAttribute("id") === p.attributes.NAME &&
    /video/.test([r.getAttribute("mimeType"), r.parentElement.getAttribute("contentType"), r.parentElement.getAttribute("mimeType")].join(" ")))).map(p => describe(p, "video"));
  if (!videos.length) throw new Error("DASH 清单没有可识别的视频轨道。");
  const audio = [];
  for (const [group, languages] of Object.entries(m.mediaGroups.AUDIO)) {
    for (const [label, rendition] of Object.entries(languages)) {
      for (const p of rendition.playlists || []) audio.push({ ...describe(p, "audio", { ...rendition, label }), group });
    }
  }
  const subtitles = [];
  for (const r of reps) {
    const set = r.parentElement;
    if (!/text|subtitle|ttml|vtt|stpp|wvtt/.test([r.getAttribute("mimeType"), set.getAttribute("mimeType"), set.getAttribute("contentType"), r.getAttribute("codecs")].join(" "))) continue;
    let base = url;
    for (const elem of [root, set.parentElement, set, r]) {
      const part = elem?.querySelector(":scope > BaseURL")?.textContent.trim();
      if (part) base = mediaUrl(part, base);
    }
    const supported = base && base !== url && /\.(vtt|srt)([?#]|$)/i.test(base) && !set.querySelector("SegmentTemplate,SegmentList");
    subtitles.push({
      id: r.id || base, url: base, label: set.getAttribute("lang") || r.id || "字幕", language: set.getAttribute("lang"),
      unsupportedReason: supported ? null : "暂不支持封装字幕或此字幕的分片结构。"
    });
  }
  return { videos, audio, subtitles, duration: Number(m.duration) || null };
}
function summary(track) {
  const { segments, init, ...info } = track;
  return { ...info, segmentCount: segments?.length ?? null };
}
export async function streamPlan(url, protocol, choice, ctx, preview = false) {
  const root = await readText(url, ctx);
  if (protocol === "dash") {
    const manifest = await parseDash(root.text, root.url);
    const video = selectTrack(manifest.videos, choice.videoId, "画质");
    const audios = manifest.audio.filter(a => !video.audioGroup || a.group === video.audioGroup);
    const sound = selectTrack(audios, choice.audioId, "音轨");
    return {
      video, sound, duration: manifest.duration,
      videoTracks: manifest.videos.map(summary), audioTracks: audios.map(summary), subtitleTracks: manifest.subtitles,
      relatedUrls: [...manifest.videos, ...audios].flatMap(t => [t.url, t.init?.url, ...t.segments.map(s => s.url)]).filter(Boolean).slice(0, 400)
    };
  }
  const hls = parseHls(root.text, root.url);
  const video = hls.videos.length ? selectTrack(hls.videos, choice.videoId, "画质") : null;
  if (!video && choice.videoId && choice.videoId !== url) throw new Error("清单已变化，请重新识别。");
  const audios = hls.audio.filter(t => t.group === video?.audioGroup);
  const sound = selectTrack(audios, choice.audioId, "音轨");
  const subtitles = hls.subtitles.filter(t => t.group === video?.subtitleGroup);
  let picture = hls, audio = null, issue = null;
  try {
    if (sound && !sound.url && audios.filter(t => !t.url).length > 1) throw new Error("该清单含多条内封音轨，无法可靠选择指定语言。");
    if (video) {
      const child = await readText(video.url, ctx);
      picture = parseHls(child.text, child.url);
      if (picture.videos.length) throw new Error("暂不支持嵌套的 HLS 主清单。");
    }
    if (sound?.url) {
      const child = await readText(sound.url, ctx);
      audio = parseHls(child.text, child.url);
      if (audio.videos.length) throw new Error("HLS 音轨地址没有直接指向媒体清单。");
    }
  } catch (error) {
    if (!preview) throw error;
    issue = error.message;
  }
  return {
    video: picture, sound: audio, duration: picture.duration, issue, requiresAudio: Boolean(sound || /mp4a|opus|vorbis|ac-3|ec-3/i.test(video?.codecs || "")),
    videoTracks: (hls.videos.length ? hls.videos : [{ id: url, url }]).map(t => ({ ...t, segmentCount: !video || t.id === video.id ? picture.segments.length : null })),
    audioTracks: audios, subtitleTracks: subtitles.map(t => ({ ...t, playlist: true })),
    relatedUrls: [...hls.videos, ...hls.audio, ...hls.subtitles, picture.init, audio?.init, ...picture.segments, ...(audio?.segments || [])].map(t => t?.url).filter(Boolean).slice(0, 400)
  };
}
