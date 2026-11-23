import { resolveBiliPart } from "./bilibili-audio.js";

// Runs in the page world so the player's manifest and its recent requests are both available.
function findVideoFiles(cid) {
  function mediaUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, location.href);
      const host = /(^|\.)bilivideo\.(com|cn|net)$/i.test(url.hostname) ||
        /^upos-[\w-]+\.akamaized\.net$/i.test(url.hostname);
      const parts = url.pathname.split("/");
      if (url.protocol === "https:" && host && !url.username && !url.password &&
          (parts.includes(cid) || parts.at(-1).startsWith(cid + "-") || parts.at(-1).startsWith(cid + "_"))) {
        return url.href;
      }
    } catch { /* Ignore resource names that are not media URLs. */ }
    return null;
  }

  const data = globalThis.__playinfo__?.data;
  const urls = (track) => [track.url ?? track.baseUrl ?? track.base_url,
    ...(track.backupUrl ?? track.backup_url ?? [])].map(mediaUrl).filter(Boolean);
  const direct = new Set();
  if (data?.durl?.length === 1) {
    for (const url of urls(data.durl[0])) {
      if (/\.mp4$/i.test(new URL(url).pathname)) direct.add(url);
    }
  }
  const player = document.querySelector(".bpx-player-video-wrap video, #bilibili-player video");
  const src = mediaUrl(player?.currentSrc);
  if (src && !data?.durl?.length && /\.mp4$/i.test(new URL(src).pathname)) direct.add(src);

  const video = new Set();
  const audio = new Set();
  for (const entry of performance.getEntriesByType("resource").reverse()) {
    const url = mediaUrl(entry.name);
    if (!url) continue;
    const code = new URL(url).pathname.match(/-(\d+)\.m4s$/i)?.[1];
    if (code) (/^30(2|3)/.test(code) ? audio : video).add(url);
  }
  const dash = data?.dash;
  for (const track of dash?.video ?? []) urls(track).forEach((url) => video.add(url));
  for (const track of dash?.audio ?? []) urls(track).forEach((url) => audio.add(url));
  const silent = dash?.video?.some((track) => urls(track).length) &&
    !dash.audio?.length && !dash.dolby?.audio?.length && !dash.flac?.audio;
  return { direct: [...direct], video: [...video], audio: [...audio], silent: Boolean(silent) };
}

// Fetch in the video's isolated world so the CDN receives the normal page referrer.
async function saveVideoFiles(files, expectedUrl, filename) {
  const expected = new URL(expectedUrl);
  function verifyPart() {
    const here = new URL(location.href);
    if (here.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "") ||
        (Number(here.searchParams.get("p")) || 1) !== Number(expected.searchParams.get("p"))) {
      throw new Error("视频分 P 已切换，请重新下载。");
    }
  }

  const controller = new AbortController();
  async function fetchFile(urls) {
    for (const url of urls.slice(0, 4)) {
      verifyPart();
      try {
        const response = await fetch(url, {
          credentials: "omit", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]),
        });
        if (response.status !== 200 || response.headers.has("Content-Range")) {
          await response.body?.cancel();
          continue;
        }
        const file = await response.blob();
        // Both standalone MP4 and Bilibili DASH files start with an ISO BMFF file type box.
        if (await file.slice(4, 8).text() === "ftyp") return file;
      } catch {
        controller.signal.throwIfAborted();
      }
    }
    throw new Error("未能下载完整媒体文件，请刷新视频页并播放几秒后重试。");
  }

  async function mergeTracks(video, audio) {
    const { Input, MP4, BlobSource, Output, Mp4OutputFormat, AppendOnlyStreamTarget,
      EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource } =
      await import(chrome.runtime.getURL("vendor/mediabunny.min.mjs"));
    const inputs = [video, audio].map((file) => new Input({ formats: [MP4], source: new BlobSource(file) }));
    const chunks = [];
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "fragmented" }),
      target: new AppendOnlyStreamTarget(new WritableStream({ write(bytes) { chunks.push(new Blob([bytes])); } })),
    });
    async function copyPackets(track, source) {
      let meta = { decoderConfig: await track.getDecoderConfig() };
      for await (const packet of new EncodedPacketSink(track).packets()) {
        await source.add(packet, meta);
        meta = undefined;
      }
      if (meta) throw new Error("媒体轨道为空。");
      source.close();
    }
    try {
      const picture = await inputs[0].getPrimaryVideoTrack();
      const sound = await inputs[1].getPrimaryAudioTrack();
      if (!picture || !sound) throw new Error("缺少视频或音频轨道。");
      const videoSource = new EncodedVideoPacketSource(await picture.getCodec());
      const audioSource = new EncodedAudioPacketSource(await sound.getCodec());
      output.addVideoTrack(videoSource, { rotation: await picture.getRotation() });
      output.addAudioTrack(audioSource);
      await output.start();
      await Promise.all([copyPackets(picture, videoSource), copyPackets(sound, audioSource)]);
      await output.finalize();
      return new Blob(chunks, { type: "video/mp4" });
    } catch {
      await output.cancel().catch(() => {});
      throw new Error("无法合并这个视频的音画轨道，请在播放器中切换清晰度后重试。");
    } finally {
      inputs.forEach((input) => input.dispose());
    }
  }

  if (globalThis.biliSummarySavingVideo) return { error: "这个视频页已有下载正在准备。" };
  globalThis.biliSummarySavingVideo = true;
  try {
    verifyPart();
    const hasDash = files.video.length && (files.audio.length || files.silent);
    let file;
    if (files.direct.length) {
      try { file = await fetchFile(files.direct); }
      catch (error) { if (!hasDash) throw error; }
    }
    if (!file) {
      if (!hasDash) throw new Error("未找到当前分 P 的完整媒体，请播放几秒后重试。");
      const [picture, sound] = await Promise.all([
        fetchFile(files.video), files.audio.length ? fetchFile(files.audio) : null,
      ]);
      verifyPart();
      file = sound ? await mergeTracks(picture, sound) : picture;
    }
    verifyPart();
    const href = URL.createObjectURL(file);
    try {
      const link = document.createElement("a");
      link.href = href;
      link.download = filename;
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(href), 60000);
    }
    return {};
  } catch (error) {
    return { error: error.message };
  } finally {
    controller.abort();
    delete globalThis.biliSummarySavingVideo;
  }
}

export async function downloadBiliVideo(video) {
  const { cid, target } = await resolveBiliPart(video);
  const [lookup] = await chrome.scripting.executeScript({ target, world: "MAIN", func: findVideoFiles, args: [cid] });
  if (!lookup?.result) throw new Error("无法读取播放信息，请刷新视频页后重试。");
  const title = video.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 90) || "视频";
  const filename = title + " - P" + video.part + ".mp4";
  const [reply] = await chrome.scripting.executeScript({
    target, func: saveVideoFiles, args: [lookup.result, video.url, filename],
  });
  if (!reply?.result || reply.result.error) throw new Error(reply?.result?.error ?? "视频页已关闭或刷新，请重试。");
}
