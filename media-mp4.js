import { Output, Mp4OutputFormat, AppendOnlyStreamTarget, EncodedPacketSink,
  EncodedVideoPacketSource, EncodedAudioPacketSource } from "./vendor/mediabunny.min.mjs";

async function copyPackets(track, source, start) {
  let meta = { decoderConfig: await track.getDecoderConfig() };
  for await (const packet of new EncodedPacketSink(track).packets()) {
    await source.add(start ? packet.clone({ timestamp: packet.timestamp - start }) : packet, meta);
    meta = undefined;
  }
  if (meta) throw new Error("媒体轨道为空。");
  source.close();
}

export async function remuxMp4(videoInput, audioInput = videoInput) {
  const picture = await videoInput.getPrimaryVideoTrack();
  const sound = await audioInput.getPrimaryAudioTrack();
  if (!picture || (!sound && audioInput !== videoInput)) throw new Error("缺少完整的视频或音频轨道。");
  if (await picture.isLive() || await sound?.isLive()) throw new Error("直播仍在进行，请在回放发布后下载。");
  const start = Math.min(await picture.getFirstTimestamp(), sound ? await sound.getFirstTimestamp() : Infinity);

  const chunks = [];
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented" }),
    target: new AppendOnlyStreamTarget(new WritableStream({ write(bytes) { chunks.push(new Blob([bytes])); } })),
  });
  try {
    const videoSource = new EncodedVideoPacketSource(await picture.getCodec());
    output.addVideoTrack(videoSource, { rotation: await picture.getRotation() });
    const audioSource = sound && new EncodedAudioPacketSource(await sound.getCodec());
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    await Promise.all([copyPackets(picture, videoSource, start), sound && copyPackets(sound, audioSource, start)]);
    await output.finalize();
    return new Blob(chunks, { type: "video/mp4" });
  } catch {
    await output.cancel().catch(() => {});
    throw new Error("无法合并这个视频的音画轨道，请切换清晰度或视频源后重试。");
  }
}
