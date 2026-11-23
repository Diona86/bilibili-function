export function videoFromTab(tab) {
  if (!tab?.url || tab.id === undefined) return null;

  const url = new URL(tab.url);
  if (url.origin !== "https://www.bilibili.com") return null;
  const id = url.pathname.match(/^\/video\/((?:BV[\da-z]+|av\d+))\/?$/i)?.[1];
  if (!id) return null;

  const page = Number(url.searchParams.get("p"));
  const part = Number.isSafeInteger(page) && page > 0 ? page : 1;
  return {
    tabId: tab.id,
    key: `${tab.id}:${id}:${part}`,
    title: tab.title?.replace(/\s*_哔哩哔哩_bilibili\s*$/i, "").trim() || id,
    url: `${url.origin}/video/${id}/?p=${part}`,
    part,
  };
}

export function formatTime(seconds) {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const time = [minutes, whole % 60].map((value) => String(value).padStart(2, "0")).join(":");
  return hours ? `${hours}:${time}` : time;
}

// Chrome injects this function into the current tab's isolated world.
async function usePlayer(videoUrl, seconds, capture) {
  if (capture?.stop) {
    const running = globalThis.biliSummaryCapture;
    if (running?.id === capture.id) running.controller.abort();
    return {};
  }

  const expected = new URL(videoUrl);
  const onExpectedPage = () => {
    const page = Number(new URL(location.href).searchParams.get("p"));
    const part = Number.isSafeInteger(page) && page > 0 ? page : 1;
    return location.origin === expected.origin &&
      location.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "") &&
      part === Number(expected.searchParams.get("p"));
  };
  const changedVideo = "视频已切换，请在当前视频重新生成摘要。";
  if (!onExpectedPage()) return { error: changedVideo };

  const player = document.querySelector(".bpx-player-video-wrap video, #bilibili-player video")
    ?? Array.from(document.querySelectorAll("video"))
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];

  if (capture) {
    if (globalThis.biliSummaryCapture) return { error: "当前播放器正在采集，请稍后重试。" };
    if (!player || player.readyState < 2 || (!capture.audio && !player.videoWidth) ||
        !Number.isFinite(player.duration) || player.duration <= 0) {
      return { error: "请先播放视频，等画面加载后再生成摘要。" };
    }

    const originalTime = player.currentTime;
    const originalSource = player.currentSrc;
    const wasPlaying = !player.paused && !player.ended;
    const originalRate = player.playbackRate;
    const originalMute = player.muted;
    const originalLoop = player.loop;
    const duration = player.duration;
    const stillCurrent = () => onExpectedPage() && player.isConnected && player.currentSrc === originalSource;
    const controller = new AbortController();
    const { signal } = controller;
    globalThis.biliSummaryCapture = { id: capture.id, controller };

    const seek = (time) => new Promise((resolve, reject) => {
      if (!player.seeking && player.readyState >= 2 && Math.abs(player.currentTime - time) < 0.05) {
        resolve();
        return;
      }
      const listeners = new AbortController();
      const finish = (error) => {
        clearTimeout(timeout);
        listeners.abort();
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error("播放器跳转超时，请等视频缓冲后重试。")), 6500);
      const options = { signal: listeners.signal, once: true };
      player.addEventListener("seeked", () => finish(), options);
      player.addEventListener("error", () => finish(new Error("播放器未能加载这个片段。")), options);
      signal.addEventListener("abort", () => finish(signal.reason), options);
      player.currentTime = time;
    });

    try {
      player.pause();
      if (capture.audio) {
        if (typeof globalThis.biliSummaryRecordAudio !== "function") {
          throw new Error("音频采集未初始化，请重新打开侧栏后重试。");
        }
        player.playbackRate = 1;
        player.muted = true;
        player.loop = false;
        await seek(0);
        signal.throwIfAborted();
        if (!stillCurrent()) throw new Error(changedVideo);
        await globalThis.biliSummaryRecordAudio(player, capture.id, stillCurrent, controller);
        return {};
      }

      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1280 / Math.max(player.videoWidth, player.videoHeight));
      canvas.width = Math.max(1, Math.round(player.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(player.videoHeight * scale));
      const context = canvas.getContext("2d");
      const count = Math.min(12, Math.max(3, Math.ceil(duration / 15)));
      const frames = [];
      for (let index = 0; index < count; index += 1) {
        signal.throwIfAborted();
        if (!stillCurrent()) throw new Error(changedVideo);
        await seek(duration * ((index + 0.5) / count));
        signal.throwIfAborted();
        if (!stillCurrent()) throw new Error(changedVideo);
        context.drawImage(player, 0, 0, canvas.width, canvas.height);
        const image = canvas.toDataURL("image/jpeg", 0.8);
        if (frames.at(-1)?.image !== image) frames.push({ start: player.currentTime, image });
      }
      return { frames };
    } catch (error) {
      return { error: error.name === "SecurityError" ? "浏览器限制读取这个视频的媒体内容。" : error.message };
    } finally {
      delete globalThis.biliSummaryCapture;
      if (stillCurrent()) {
        if (capture.audio) {
          player.pause();
          player.playbackRate = originalRate;
          player.muted = originalMute;
          player.loop = originalLoop;
        }
        player.currentTime = originalTime;
        if (wasPlaying) void player.play().catch(() => {});
      }
    }
  }

  if (seconds !== null) {
    if (globalThis.biliSummaryCapture) return { error: "正在采集视频内容，请稍后跳转。" };
    if (!player || player.readyState === 0 || !Number.isFinite(player.duration)) {
      return { error: "播放器还在加载，请打开视频后重试。" };
    }
    if (seconds > player.duration) {
      return { error: "这个时间超出了当前视频时长，请确认当前分 P。" };
    }
    player.currentTime = seconds;
    return {};
  }

  if (!player || !Number.isFinite(player.duration) || player.duration <= 0) {
    return { error: "请先播放视频，等播放器加载后再生成笔记。" };
  }
  return { duration: player.duration };
}

export async function runOnVideo(video, seconds = null, capture = null) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: video.tabId },
    func: usePlayer,
    args: [video.url, seconds, capture],
  }).catch(() => {
    throw new Error("无法访问当前视频，请检查扩展的 B 站访问权限后重试。");
  });
  if (!result || result.error) throw new Error(result?.error ?? "未能连接到播放器。");
  return result;
}

async function runCapture(video, signal, capture) {
  signal.throwIfAborted();
  const stop = () => { void runOnVideo(video, null, { id: capture.id, stop: true }).catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const result = await runOnVideo(video, null, capture);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export async function captureVideoFrames(video, signal) {
  return (await runCapture(video, signal, { id: crypto.randomUUID() })).frames;
}

export async function receiveVideoAudio(video, name, signal, run, onMessage) {
  signal.throwIfAborted();
  let port;
  let connect;
  const done = new Promise((resolve, reject) => {
    connect = (candidate) => {
      if (candidate.name !== name || candidate.sender?.tab?.id !== video.tabId) return;
      if (signal.aborted) {
        candidate.disconnect();
        return;
      }
      port = candidate;
      port.onDisconnect.addListener(() => reject(new Error("与视频页的音频连接已断开。")));
      port.onMessage.addListener((message) => {
        if (message.type === "done") resolve();
        else if (!signal.aborted) {
          try { onMessage(message); } catch (error) { reject(error); }
        }
      });
    };
  });
  const disconnect = () => {
    port?.disconnect();
    port = undefined;
  };
  signal.addEventListener("abort", disconnect, { once: true });
  chrome.runtime.onConnect.addListener(connect);
  try {
    await Promise.all([run(), done]);
  } finally {
    signal.removeEventListener("abort", disconnect);
    chrome.runtime.onConnect.removeListener(connect);
    disconnect();
  }
}

export async function captureVideoAudio(video, signal, onMessage) {
  signal.throwIfAborted();
  await chrome.scripting.executeScript({ target: { tabId: video.tabId }, files: ["audio-capture.js"] });
  const id = crypto.randomUUID();
  await receiveVideoAudio(video, `bili-summary-audio:${id}`, signal,
    () => runCapture(video, signal, { id, audio: true }), onMessage);
}
