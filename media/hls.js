import { mediaUrl } from "./resource.js";

function attributes(line) {
  const result = Object.create(null);
  for (const m of line.matchAll(/(?:^|,)([\w-]+)=("[^"]*"|[^,]*)/g)) result[m[1]] = m[2].replace(/^"|"$/g, "");
  return result;
}
function address(value, base) {
  const url = mediaUrl(value, base);
  if (!url || value.includes("{$")) throw new Error("HLS 地址或变量结构暂不支持。");
  return url;
}
function byteRange(value, previous, url) {
  if (!value) return null;
  const m = /^(\d+)(?:@(\d+))?$/.exec(value);
  const length = Number(m?.[1]);
  const offset = m?.[2] !== undefined ? Number(m[2]) : previous?.url === url && previous.range ? previous.range.offset + previous.range.length : NaN;
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("HLS 字节范围不完整。");
  return { offset, length };
}
export function parseHls(text, base) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("地址没有返回 HLS 播放清单。");
  const videos = [], audio = [], subtitles = [], segments = [];
  let variant, duration, range, init = null, previous = null, total = 0;
  let closed = false, programTime = null;
  for (const line of lines) {
    const colon = line.indexOf(":");
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = line.slice(colon + 1);
    switch (tag) {
      case "#EXT-X-KEY": case "#EXT-X-SESSION-KEY":
        if (attributes(value).METHOD !== "NONE") throw new Error("HLS 清单使用加密或内容保护。");
        break;
      case "#EXT-X-DISCONTINUITY": throw new Error("不支持含时间线切换的 HLS 清单。");
      case "#EXT-X-GAP": throw new Error("HLS 清单声明了缺失的分片。");
      case "#EXT-X-STREAM-INF": variant = attributes(value); break;
      case "#EXT-X-MEDIA": {
        const a = attributes(value);
        if (!["AUDIO", "SUBTITLES"].includes(a.TYPE)) break;
        const url = a.URI ? address(a.URI, base) : null;
        const track = {
          id: JSON.stringify([a["GROUP-ID"], a.NAME]), group: a["GROUP-ID"], url,
          label: a.NAME || a.LANGUAGE, language: a.LANGUAGE || null, default: a.DEFAULT === "YES"
        };
        (a.TYPE === "AUDIO" ? audio : subtitles).push(track);
        break;
      }
      case "#EXT-X-MAP": {
        const a = attributes(value), url = address(a.URI, base);
        const next = { url, range: byteRange(a.BYTERANGE, init, url) };
        if (init && JSON.stringify(next) !== JSON.stringify(init)) throw new Error("HLS 初始化分片在播放中发生变化。");
        init = next;
        break;
      }
      case "#EXTINF": duration = Number(value.split(",")[0]); break;
      case "#EXT-X-BYTERANGE": range = value; break;
      case "#EXT-X-ENDLIST": closed = true; break;
      case "#EXT-X-PROGRAM-DATE-TIME":
        if (!segments.length && Number.isFinite(Date.parse(value))) programTime = Date.parse(value) / 1000;
        break;
      default:
        if (line.startsWith("#")) break;
        const url = address(line, base);
        if (variant) {
          const dims = /^(\d+)x(\d+)$/i.exec(variant.RESOLUTION || "");
          videos.push({
            id: url, url, width: Number(dims?.[1]) || null, height: Number(dims?.[2]) || null,
            bitrate: Number(variant.BANDWIDTH) || null, frameRate: Number(variant["FRAME-RATE"]) || null,
            codecs: variant.CODECS || null, audioGroup: variant.AUDIO, subtitleGroup: variant.SUBTITLES
          });
          variant = null;
        } else {
          if (!Number.isFinite(duration) || duration <= 0) throw new Error("HLS 分片缺少有效时长。");
          previous = { url, range: byteRange(range, previous, url), duration };
          segments.push(previous);
          total += duration;
          range = null; duration = null;
        }
    }
  }
  if (variant || range || duration != null) throw new Error("HLS 清单未完整结束。");
  if (!videos.length && !closed) throw new Error("直播或尚未结束的 HLS 不支持完整下载。");
  if (!videos.length && !segments.length) throw new Error("HLS 清单中没有媒体分片。");
  return { videos, audio, subtitles, segments, init, duration: total || null, programTime };
}
