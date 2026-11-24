import { Input, MP4, QTFF, WEBM, MATROSKA, BlobSource, EncodedPacketSink } from "../vendor/mediabunny.min.mjs";

export const fileInput = blob => new Input({ formats: [MP4, QTFF, WEBM, MATROSKA], source: new BlobSource(blob) });

// Inspect box boundaries and protection declarations without decoding or copying an mdat.
export async function checkIsoBoxes(blob, signal) {
  let start = -1, buffer = new Uint8Array();
  async function read(at, length) {
    if (at < start || at + length > start + buffer.length) {
      start = at;
      buffer = new Uint8Array(await blob.slice(at, at + 64 * 1024).arrayBuffer());
    }
    return buffer.subarray(at - start, at - start + length);
  }
  const first = await read(0, 8);
  if (!["ftyp", "styp", "moov", "moof", "mdat", "wide", "free", "skip", "sidx"].includes(String.fromCharCode(...first.slice(4, 8)))) return;
  const containers = ["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "stsd"];
  async function walk(position, end, depth) {
    if (depth > 10) throw new Error("MP4 嵌套结构异常。");
    while (position < end) {
      signal.throwIfAborted();
      if (end - position < 8) throw new Error("MP4 的结尾不完整。");
      const header = await read(position, 16);
      const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const type = String.fromCharCode(...header.slice(4, 8)), size32 = dv.getUint32(0);
      const headerLength = size32 === 1 ? 16 : 8;
      const size = size32 === 1 && header.length === 16 ? Number(dv.getBigUint64(8)) : size32 || end - position;
      if (!Number.isSafeInteger(size) || size < headerLength || position + size > end) throw new Error("MP4 数据长度不完整。");
      if (["pssh", "encv", "enca", "senc"].includes(type)) throw new Error("媒体文件包含加密轨道或内容保护。");
      if (containers.includes(type)) await walk(position + headerLength + (type === "stsd" ? 8 : 0), position + size, depth + 1);
      position += size;
    }
  }
  await walk(0, blob.size, 0);
}

// Chromium installations vary in Ogg/Theora playback support. Preserve the file unchanged.
async function verifyOgg(blob) {
  let offset = 0, videoSerial = null, finished = false;
  while (offset < blob.size) {
    const head = new Uint8Array(await blob.slice(offset, offset + 282).arrayBuffer());
    if (head.length < 27 || String.fromCharCode(...head.subarray(0, 4)) !== "OggS" || head[4] !== 0) throw new Error("Ogg 页头损坏。");
    const count = head[26], body = offset + 27 + count;
    if (head.length < 27 + count) throw new Error("Ogg 页不完整。");
    const size = head.slice(27, 27 + count).reduce((n, v) => n + v, 0);
    const serial = new DataView(head.buffer).getUint32(14, true);
    // The first Theora header has a non-UTF-8 marker.
    if (head[5] & 2) {
      const id = new Uint8Array(await blob.slice(body, body + 7).arrayBuffer());
      if (id[0] === 128 && String.fromCharCode(...id.slice(1)) === "theora") videoSerial = serial;
    }
    if ((head[5] & 4) && serial === videoSerial) finished = true;
    offset = body + size;
  }
  if (offset !== blob.size || videoSerial === null || !finished) throw new Error("没有找到完整的 Ogg/Theora 视频轨道。");
  return { extension: "ogv", size: blob.size, duration: null, width: null, height: null, hasAudio: null };
}
export async function verifyFile(blob, expected = {}, signal = new AbortController().signal) {
  signal.throwIfAborted();
  if (blob.size < 16) throw new Error("媒体文件过小或为空。");
  const header = new Uint8Array(await blob.slice(0, 128).arrayBuffer());
  const text = String.fromCharCode(...header);
  if (text.startsWith("OggS")) return verifyOgg(blob);
  await checkIsoBoxes(blob, signal);
  const input = fileInput(blob);
  try {
    const format = await input.getFormat();
    const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
    if (!video || (expected.audio && !audio)) throw new Error("文件缺少所需的视频或音频轨道。");
    const tracks = [video, audio].filter(Boolean);
    for (const track of tracks) {
      signal.throwIfAborted();
      const sink = new EncodedPacketSink(track);
      const first = await sink.getFirstPacket(), last = await sink.getPacket(Infinity);
      if (!first?.data.byteLength || !last?.data.byteLength) throw new Error("媒体轨道为空或结尾损坏。");
    }
    const duration = (await input.computeDuration(tracks)) - (await input.getFirstTimestamp(tracks));
    if (!Number.isFinite(duration) || duration <= 0 || (expected.duration && Math.abs(duration - expected.duration) > Math.max(0.25, Math.min(2, expected.duration * 0.025)))) {
      throw new Error("实际音画时长与媒体声明不符。");
    }
    const extension = format === QTFF || text.slice(8, 12) === "qt  " ? "mov" : format === WEBM ? "webm" : format === MATROSKA ? "mkv" :
      expected.extension === "m4v" ? "m4v" : "mp4";
    return { extension, size: blob.size, duration, width: await video.getDisplayWidth(), height: await video.getDisplayHeight(), hasAudio: Boolean(audio) };
  } catch (e) {
    if (/[\u3400-\u9fff]/.test(e.message)) throw e;
    throw new Error("文件不是可验证的完整视频，或使用了不支持的编码或内容保护。");
  } finally { input.dispose(); }
}
