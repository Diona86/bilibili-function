import { Input, BlobSource, MP4, WEBM, MPEG_TS, ADTS } from "./vendor/mediabunny.min.mjs";
import { remux } from "./media-mp4.js";
import { readBody } from "./media/io.js";
import { selectTrack, streamPlan } from "./media/manifests.js";
import { subtitleFile } from "./media/subtitles.js";
import { checkIsoBoxes, fileInput, verifyFile } from "./media/verify.js";

async function assembled(track, ctx) {
  const blobs = [];
  for (const part of [track.init, ...track.segments].filter(Boolean)) {
    const { blob } = await readBody(part.url, ctx, { range: part.range, count: true });
    blobs.push(blob);
    ctx.segment();
  }
  const blob = new Blob(blobs);
  await checkIsoBoxes(blob, ctx.signal);
  return new Input({ formats: [MP4, WEBM, MPEG_TS, ADTS], source: new BlobSource(blob) });
}
async function biliFile(resource, ctx) {
  async function fetchOne(urls) {
    let error;
    for (const url of urls.slice(0, 4)) {
      try { return (await readBody(url, ctx, { count: true, attempts: 1 })).blob; }
      catch (e) { ctx.signal.throwIfAborted(); error = e; }
    }
    throw error || new Error("当前分 P 没有可读取的媒体。");
  }
  const files = resource.files;
  ctx.phase("Downloading");
  if (files.direct.length) {
    try {
      const blob = await fetchOne(files.direct);
      await verifyFile(blob, {}, ctx.signal);
      return { blob, extension: "mp4" };
    } catch (e) { ctx.signal.throwIfAborted(); if (!files.video.length) throw e; }
  }
  async function track(urls) {
    const blob = await fetchOne(urls);
    await checkIsoBoxes(blob, ctx.signal);
    return fileInput(blob);
  }
  const input = await track(files.video);
  let audio;
  try {
    if (files.audio.length) audio = await track(files.audio);
    else if (!files.silent) throw new Error("当前分 P 缺少已加载的独立音轨。");
    ctx.phase("Merging");
    return await remux(input, audio, { ctx, container: "mp4" });
  } finally { input.dispose(); audio?.dispose(); }
}
export async function prepareResource(resource, choice, ctx) {
  if (resource.unsupportedReason) throw new Error(resource.unsupportedReason);
  let result, expectedDuration;
  if (choice.subtitleId) {
    const track = selectTrack(resource.subtitleTracks, choice.subtitleId, "字幕");
    ctx.phase("Downloading");
    const subtitle = await subtitleFile(track, ctx);
    ctx.phase("Verifying");
    return subtitle;
  }
  if (resource.protocol === "bilibili") result = await biliFile(resource, ctx);
  else if (["hls", "dash"].includes(resource.protocol)) {
    const plan = await streamPlan(resource.mediaUrl, resource.protocol, choice, ctx);
    expectedDuration = plan.duration;
    const tracks = [plan.video, plan.sound].filter(Boolean);
    ctx.phase("Downloading", { segmentTotal: tracks.reduce((n, t) => n + t.segments.length + Number(Boolean(t.init)), 0) });
    const inputs = [];
    try {
      for (const track of tracks) inputs.push(await assembled(track, ctx));
      await ctx.checkpoint();
      ctx.phase("Merging");
      let videoOffset = plan.video.presentationOffset, audioOffset = plan.sound?.presentationOffset;
      if (resource.protocol === "hls" && plan.sound?.programTime != null && plan.video.programTime != null) {
        const delta = plan.sound.programTime - plan.video.programTime;
        videoOffset = await inputs[0].getFirstTimestamp();
        audioOffset = await inputs[1].getFirstTimestamp() - delta;
      }
      result = await remux(inputs[0], inputs[1], { ctx, container: choice.container, videoOffset, audioOffset });
      if (plan.requiresAudio && !result.hasAudio) throw new Error("未找到清单声明的音频轨道。");
    } finally { inputs.forEach(input => input.dispose()); }
  } else {
    ctx.phase("Downloading");
    const file = await readBody(resource.mediaUrl, ctx, { count: true });
    if (resource.contentLength && file.blob.size !== resource.contentLength) throw new Error("文件大小与识别时的响应不符，请重新查找。");
    expectedDuration = resource.duration;
    result = { blob: file.blob, extension: resource.fileExtension };
  }
  ctx.phase("Verifying");
  const info = await verifyFile(result.blob, { audio: result.hasAudio, duration: expectedDuration, extension: result.extension }, ctx.signal);
  return { blob: result.blob, extension: info.extension };
}
