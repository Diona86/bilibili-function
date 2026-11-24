import {
  Output, Mp4OutputFormat, MkvOutputFormat, WebMOutputFormat, AppendOnlyStreamTarget, EncodedPacketSink,
  EncodedVideoPacketSource, EncodedAudioPacketSource
} from "./vendor/mediabunny.min.mjs";

const formats = { mp4: Mp4OutputFormat, webm: WebMOutputFormat, mkv: MkvOutputFormat };
async function copyPackets(track, source, offset, ctx) {
  let meta = { decoderConfig: await track.getDecoderConfig() };
  for await (const packet of new EncodedPacketSink(track).packets()) {
    ctx?.signal.throwIfAborted();
    await source.add(offset ? packet.clone({ timestamp: packet.timestamp - offset }) : packet, meta);
    meta = undefined;
  }
  if (meta) throw new Error("媒体轨道为空。");
  source.close();
}
export async function remux(videoInput, audioInput, options = {}) {
  const picture = await videoInput.getPrimaryVideoTrack();
  const sound = await (audioInput || videoInput).getPrimaryAudioTrack();
  if (!picture || (!sound && audioInput)) throw new Error("缺少所选的视频或音频轨道。");
  if (await picture.isLive() || await sound?.isLive()) throw new Error("暂不支持直播。");
  const vCodec = await picture.getCodec(), aCodec = await sound?.getCodec();
  const compatible = Object.keys(formats).filter(key => {
    const fmt = new formats[key]();
    return fmt.getSupportedVideoCodecs().includes(vCodec) && (!sound || fmt.getSupportedAudioCodecs().includes(aCodec));
  });
  const extension = options.container && options.container !== "auto" ? options.container : compatible[0];
  if (!compatible.includes(extension)) throw new Error(compatible.length ? "此编码无法封装到所选容器。可选择 " + compatible.join("、") + "。" : "没有兼容的无损封装格式。");
  const vOffset = options.videoOffset || 0, aOffset = options.audioOffset || 0;
  const first = Math.min(await picture.getFirstTimestamp() - vOffset, sound ? await sound.getFirstTimestamp() - aOffset : Infinity);
  const chunks = [];
  const output = new Output({
    format: extension === "mp4" ? new Mp4OutputFormat({ fastStart: "fragmented" }) : new formats[extension]({ appendOnly: true }),
    target: new AppendOnlyStreamTarget(new WritableStream({ write(bytes) { chunks.push(new Blob([new Uint8Array(bytes)])); } }))
  });
  try {
    const v = new EncodedVideoPacketSource(vCodec);
    output.addVideoTrack(v, { rotation: await picture.getRotation() });
    const a = sound && new EncodedAudioPacketSource(aCodec);
    if (a) output.addAudioTrack(a);
    await output.start();
    await Promise.all([copyPackets(picture, v, first + vOffset, options.ctx), sound && copyPackets(sound, a, first + aOffset, options.ctx)]);
    await output.finalize();
    return {
      blob: new Blob(chunks, { type: { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska" }[extension] }),
      extension, hasAudio: Boolean(sound)
    };
  } catch (error) {
    await output.cancel().catch(() => {});
    options.ctx?.signal.throwIfAborted();
    throw error;
  }
}
