import { parseHls } from "./hls.js";
import { readText } from "./io.js";

export function subtitleFormat(text) {
  if (/^WEBVTT(?:[ \t][^\r\n]*)?(?:\r?\n|$)/.test(text) && /(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}/.test(text)) return "vtt";
  if (/^\s*\d+\s*\r?\n\d{2,}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2,}:\d{2}:\d{2},\d{3}/.test(text)) return "srt";
  return null;
}
export async function subtitleFile(track, ctx) {
  if (track.unsupportedReason || !track.url) throw new Error(track.unsupportedReason || "字幕没有外部文件地址。");
  const root = await readText(track.url, ctx);
  if (!root.text.trimStart().startsWith("#EXTM3U")) {
    const extension = subtitleFormat(root.text);
    if (!extension) throw new Error("未识别到有效的 WebVTT 或 SRT 时间轴。");
    return { blob: root.blob, extension };
  }
  const list = parseHls(root.text, root.url);
  if (list.init || list.videos.length || list.segments.some(s => s.range)) throw new Error("该字幕使用封装或字节范围，无法原样保存时间轴。");
  const blocks = new Set();
  let header = null, first = null, previousStart = -1;
  for (const s of list.segments) {
    const part = await readText(s.url, ctx);
    if (!/^WEBVTT(?:\s|$)/.test(part.text)) throw new Error("HLS 字幕分片不是 WebVTT。");
    const [intro, ...cues] = part.text.trimEnd().split(/\r?\n[ \t]*\r?\n/);
    if (header !== null && header !== intro) throw new Error("字幕分片的时间映射不同，无法无损拼接。");
    header = intro; first ??= part.blob;
    for (const cue of cues) {
      if (blocks.has(cue)) continue;
      const time = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->/m.exec(cue);
      if (time) {
        const start = Number(time[1] || 0) * 3600 + Number(time[2]) * 60 + Number(time[3]) + Number(time[4]) / 1000;
        if (start < previousStart) throw new Error("字幕分片时间轴发生回退，无法无损拼接。");
        previousStart = start;
      }
      blocks.add(cue);
    }
  }
  const text = [header, ...blocks].join("\n\n") + "\n";
  if (subtitleFormat(text) !== "vtt") throw new Error("字幕没有有效的时间轴。");
  return { blob: list.segments.length === 1 ? first : new Blob([text], { type: "text/vtt" }), extension: "vtt" };
}
