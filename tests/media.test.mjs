import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classify, mediaUrl, totalLength, fileName } from "../media/resource.js";
import { parseHls } from "../media/hls.js";
import { subtitleFormat } from "../media/subtitles.js";
import { groupFrame } from "../web-download.js";
import { fileInput, verifyFile } from "../media/verify.js";
import { remux } from "../media-mp4.js";

const fixture = name => readFile(new URL("./fixtures/" + name, import.meta.url));
const base = "https://example.test/video/master.m3u8";
test("MIME、签名、临时 URL 与分片分类", () => {
  assert.equal(classify("https://cdn.test/watch?k=1", "video/mp4").protocol, "direct");
  assert.equal(classify("https://cdn.test/watch?k=1", "application/vnd.apple.mpegurl").protocol, "hls");
  assert.equal(classify("https://cdn.test/watch", "application/dash+xml").protocol, "dash");
  for (const mime of ["text/html", "text/css", "text/javascript", "image/png", "application/json"])
    assert.equal(classify("https://example.test/fake.mp4", mime, true), null);
  for (const name of ["chunk.m4s", "fragment.cmfv", "part.ts", "init.mp4"])
    assert.equal(classify(new URL(name, base).href).protocol, "segment");
  assert.equal(mediaUrl("javascript:alert(1)", base), null);
  assert.equal(mediaUrl("https://user:pwd@example.test/a", base), null);
  assert.equal(totalLength(new Headers({ "Content-Range": "bytes 2-5/47" })), 47);
  assert.equal(fileName("CON.mp4", "mp4"), "_CON.mp4");
});
test("HLS 多画质、外部音轨、字幕和字节范围", async () => {
  const master = parseHls((await fixture("master.m3u8")).toString(), base);
  assert.deepEqual(master.videos.map(v => v.width), [96, 72]);
  assert.equal(master.videos[0].codecs, "avc1.64000a,mp4a.40.2");
  assert.equal(master.audio[0].language, "en"); assert.equal(master.subtitles[0].language, "zh");
  const range = parseHls((await fixture("range.m3u8")).toString().replace("12220@13160", "12220"), base);
  assert.equal(range.duration, 2); assert.equal(range.segments[1].range.offset, range.segments[0].range.length);
  const fmp4 = parseHls((await fixture("high.m3u8")).toString(), base);
  assert.ok(fmp4.init.url.endsWith("/high-init.mp4"));
});
test("区分直播、加密、缺片、时间线切换及错误范围", async () => {
  const media = (await fixture("ts.m3u8")).toString();
  for (const [tag, rx] of [['#EXT-X-KEY:METHOD=AES-128,URI="key"', /加密/], ['#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES', /加密/],
  ['#EXT-X-GAP', /缺失/], ['#EXT-X-DISCONTINUITY', /时间线/], ['#EXT-X-BYTERANGE:256', /范围/]])
    assert.throws(() => parseHls(media.replace("#EXTM3U", "#EXTM3U\n" + tag), base), rx);
  assert.throws(() => parseHls(media.replace("#EXT-X-ENDLIST", ""), base), /直播/);
  assert.throws(() => parseHls("<html></html>", base), /清单/);
});
test("同一播放器聚合多个来源，独立播放器和字幕分开", () => {
  const page = { tabId: 1, url: base, title: "示例" }, src = "https://example.test/a.mp4";
  const frame = {
    href: base, documentId: "doc", segments: [], looseSubtitles: [], entries: [
      { playerId: "A", protocol: "direct", mediaUrl: src }, { playerId: "A", protocol: "direct", mediaUrl: src + "?alternative" },
      { protocol: "direct", mediaUrl: src, sourceType: "headers", contentLength: 123 },
      { protocol: "hls", mediaUrl: base, playerId: "B", relatedUrls: [src + "?child"] }, { protocol: "direct", mediaUrl: src + "?child" }]
  };
  const result = groupFrame(page, frame);
  assert.equal(result.length, 2); assert.equal(result[0].alternatives.length, 2); assert.equal(result[0].contentLength, 123);
  assert.equal(result[0].bitrate, null);
});
for (const ext of ["mp4", "webm", "mov", "mkv", "ogv", "m4v"]) {
  test("直接验证真实 " + ext.toUpperCase() + " 容器", async () => {
    const data = await fixture("clip." + (ext === "m4v" ? "mp4" : ext));
    const info = await verifyFile(new Blob([data]), { extension: ext });
    assert.equal(info.extension, ext); assert.equal(info.size, data.length);
    if (ext !== "ogv") { assert.ok(info.hasAudio); assert.equal(info.width, 96); assert.ok(Math.abs(info.duration - 2) < 0.15); }
  });
}
test("拒绝假媒体、截断文件和仅有初始化的 MP4", async () => {
  for (const bytes of [Buffer.from("<html><body>Forbidden</body></html>"), (await fixture("clip.mp4")).subarray(0, 5000), await fixture("audio-init.mp4")])
    await assert.rejects(verifyFile(new Blob([bytes])));
  const protectedSample = new Blob([await fixture("clip.mp4"), Uint8Array.from([0, 0, 0, 8, 112, 115, 115, 104])]);
  await assert.rejects(verifyFile(protectedSample), /保护/);
});
test("按实际编码无损封装 WebM 并拒绝不兼容的目标容器", async () => {
  const vp9 = fileInput(new Blob([await fixture("clip.webm")])), avc = fileInput(new Blob([await fixture("clip.mp4")]));
  try {
    const output = await remux(vp9, null, { container: "webm" });
    const info = await verifyFile(output.blob, { duration: 2, audio: true }); assert.equal(info.extension, "webm");
    await assert.rejects(remux(avc, null, { container: "webm" }), /封装|兼容/);
  } finally { vp9.dispose(); avc.dispose(); }
});
test("识别真实 VTT 和 SRT 时间轴", async () => {
  assert.equal(subtitleFormat((await fixture("one.vtt")).toString()), "vtt");
  assert.equal(subtitleFormat((await fixture("caption.srt")).toString()), "srt");
  assert.equal(subtitleFormat("WEBVTT\n\n<html>"), null);
});
