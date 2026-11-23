import { captureVideoAudio, formatTime } from "./video.js";

const ASR_URL = "https://api.deepseek.com/v1/tools/asr";
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = SAMPLE_RATE * 45;

export function audioLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("请输入完整的音轨直链。"); }
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("请输入可直接取得媒体文件的 HTTPS 地址，本机可用 HTTP。");
  }
  return url.href;
}

function wavFile(pcm) {
  const bytes = new Uint8Array(44);
  const header = new DataView(bytes.buffer);
  const encoding = new TextEncoder();
  bytes.set(encoding.encode("RIFF"), 0);
  bytes.set(encoding.encode("WAVEfmt "), 8);
  bytes.set(encoding.encode("data"), 36);
  header.setUint32(4, 36 + pcm.byteLength, true);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(40, pcm.byteLength, true);
  return new Blob([bytes, pcm], { type: "audio/wav" });
}

async function transcribe(pcm, start, end, apiKey, signal) {
  signal.throwIfAborted();
  const form = new FormData();
  form.append("file", wavFile(pcm), "audio.wav");
  const timeout = AbortSignal.timeout(120_000);
  let response;
  let data;
  try {
    response = await fetch(ASR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.any([signal, timeout]),
    });
    if (response.ok) data = await response.json();
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new Error("语音识别请求超时。");
    if (error instanceof SyntaxError) throw new Error("语音识别接口返回了无效的内容。");
    throw new Error("无法连接 DeepSeek 语音识别接口。");
  }

  if (response.status === 401 || response.status === 403) throw new Error("请检查 DeepSeek API Key 及权限。");
  if (response.status === 402) throw new Error("DeepSeek 余额不足。");
  if (response.status === 429) throw new Error("DeepSeek 语音识别限流，请稍后重试。");
  if (!response.ok) throw new Error(`语音识别接口返回 HTTP ${response.status}。`);
  if (typeof data?.text !== "string") throw new Error("语音识别接口未返回转写文字。");
  return { start, end, text: data.text.trim() };
}

export function requireSpeechAccess(model) {
  if (new URL(model.endpoint).origin !== new URL(ASR_URL).origin || !model.apiKey) {
    throw new Error("请在模型设置里填写 DeepSeek 官方 API 地址及对应的 API Key。");
  }
}

async function readAudioBytes(media, signal, onProgress) {
  if (typeof media !== "string") return media.arrayBuffer();
  onProgress("正在下载指定的音轨文件…");
  const timeout = AbortSignal.timeout(180_000);
  let response;
  try {
    response = await fetch(media, { credentials: "omit", signal: AbortSignal.any([signal, timeout]) });
    if (response.status === 200 && !response.headers.get("Content-Type")?.includes("text/html")) {
      return await response.arrayBuffer();
    }
  } catch {
    signal.throwIfAborted();
    if (timeout.aborted) throw new Error("下载音轨超时，可以使用本地音视频文件。");
    throw new Error("浏览器无法从该地址读取音轨，请检查链接权限。");
  }
  throw new Error("该地址没有返回完整媒体文件，请检查音轨直链或使用本地音视频文件。");
}

export async function transcribeMedia(media, duration, model, signal, onProgress) {
  const bytes = await readAudioBytes(media, signal, onProgress);
  signal.throwIfAborted();
  onProgress("正在解码完整音轨…");
  let audio;
  try {
    audio = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes);
  } catch {
    signal.throwIfAborted();
    throw new Error("Chrome 无法解码这个文件的音轨，请使用常见的 MP3、M4A、WAV 或 MP4 文件。");
  }
  signal.throwIfAborted();
  const tolerance = Math.min(2, Math.max(0.35, duration * 0.005));
  if (Math.abs(audio.duration - duration) > tolerance) {
    throw new Error(`音源时长 ${formatTime(audio.duration)} 和当前视频 ${formatTime(duration)} 不一致，请选择同一分 P 的完整文件。`);
  }

  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  const transcript = [];
  const count = Math.ceil(audio.length / CHUNK_SAMPLES);
  for (let offset = 0; offset < audio.length; offset += CHUNK_SAMPLES) {
    signal.throwIfAborted();
    onProgress(`正在转写第 ${offset / CHUNK_SAMPLES + 1} / ${count} 段音频…`);
    const end = Math.min(offset + CHUNK_SAMPLES, audio.length);
    const pcm = new DataView(new ArrayBuffer((end - offset) * 2));
    for (let index = offset; index < end; index += 1) {
      let sum = 0;
      for (const channel of channels) sum += channel[index];
      const sample = Math.max(-1, Math.min(1, sum / channels.length));
      pcm.setInt16((index - offset) * 2, Math.round(sample * 32767), true);
    }
    const cue = await transcribe(pcm.buffer, offset / SAMPLE_RATE, end / SAMPLE_RATE, model.apiKey, signal);
    if (cue.text) transcript.push(cue);
  }
  return transcript;
}

export async function transcribeVideo(video, model, signal, onProgress) {
  const controller = new AbortController();
  const jobSignal = AbortSignal.any([signal, controller.signal]);
  const tasks = [];
  let completed = 0;
  let failure;

  try {
    await captureVideoAudio(video, jobSignal, (message) => {
      if (message.type === "progress") {
        onProgress(`正在采集音频 ${formatTime(message.seconds)} / ${formatTime(message.duration)}，已转写 ${completed} 段。`);
      } else if (message.type === "chunk") {
        const index = tasks.length + 1;
        const binary = atob(message.pcm);
        const pcm = new Uint8Array(binary.length);
        for (let byte = 0; byte < pcm.length; byte += 1) pcm[byte] = binary.charCodeAt(byte);
        tasks.push(transcribe(pcm, message.start, message.end, model.apiKey, jobSignal).then((cue) => {
          completed += 1;
          return cue;
        }).catch((error) => {
          if (!jobSignal.aborted) {
            failure = new Error(`第 ${index} 段转写失败。${error.message}`);
            controller.abort();
          }
          return null;
        }));
      }
    });
    onProgress("音频采集完成，正在汇总转写结果…");
    const transcript = (await Promise.all(tasks)).filter((cue) => cue?.text);
    if (failure) throw failure;
    signal.throwIfAborted();
    return transcript;
  } catch (error) {
    controller.abort();
    await Promise.all(tasks);
    throw failure ?? error;
  }
}
