import { prepareResource } from "../web-stream.js";
import { fileName } from "./resource.js";

const runs = new Map();
function current(source) {
  if (source.publicFetch) return true;
  if (source.protocol !== "bilibili") return location.href === source.frameUrl;
  const u = new URL(source.pageUrl), here = new URL(location.href);
  return here.origin === u.origin && here.pathname.replace(/\/$/, "") === u.pathname.replace(/\/$/, "") &&
    (Number(here.searchParams.get("p")) || 1) === Number(u.searchParams.get("p"));
}
export function control(run, action) {
  const job = runs.get(run);
  if (!job) return false;
  if (action === "cancel") job.controller.abort(new Error("已取消下载。"));
  if (action === "pause") {
    if (job.state !== "Downloading") return false;
    job.paused = true;
  }
  if (action === "resume" || action === "cancel") { job.paused = false; job.wake?.(); }
  if (action === "release" || action === "cancel") {
    if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
    runs.delete(run);
  }
  return true;
}
export function start(jobId, run, source, choice) {
  if (runs.has(run)) return true;
  const controller = new AbortController();
  const job = { controller, state: "Detecting", paused: false, wake: null, blobUrl: null };
  runs.set(run, job);
  const send = (action, data = {}) => chrome.runtime.sendMessage({ target: "media-executor", action, jobId, run, ...data });
  let bytes = 0, total = null, segments = 0, segmentTotal = null, last = 0;
  const progress = (force = false) => {
    if (!force && Date.now() - last < 650) return;
    last = Date.now();
    void send("progress", { state: job.state, bytes, total, segments, segmentTotal }).catch(() => {});
  };
  const ctx = {
    signal: controller.signal, credentials: source.publicFetch || source.protocol === "bilibili" ? "omit" : source.credentials || "same-origin",
    publicFetch: Boolean(source.publicFetch),
    async checkpoint() {
      if (job.paused) await new Promise(resolve => { job.wake = resolve; });
      controller.signal.throwIfAborted();
      if (!current(source)) throw new Error("原视频页面已切换，请重新识别。");
    },
    phase(next, info = {}) {
      job.state = next;
      if (info.segmentTotal) segmentTotal = info.segmentTotal;
      progress(true);
    },
    bytes(n, declared) { bytes = Math.max(0, bytes + n); if (source.protocol === "direct" && declared) total = declared; progress(); },
    segment() { segments++; progress(); },
  };
  void (async () => {
    try {
      await ctx.checkpoint();
      if (!source.publicFetch && [...document.querySelectorAll("video")].some(v =>
        (v.currentSrc === source.mediaUrl || source.protocol === "bilibili") && (v.mediaKeys || v.controlsList?.contains("nodownload")))) {
        throw new Error("播放器已声明内容保护或禁止下载。");
      }
      const result = await prepareResource(source, choice, ctx);
      await ctx.checkpoint();
      job.blobUrl = URL.createObjectURL(result.blob);
      const title = source.title + (choice.subtitleId ? " - " + (source.subtitleTracks.find(t => t.id === choice.subtitleId)?.label || "字幕") : "");
      const reply = await send("ready", { url: job.blobUrl, filename: fileName(title, result.extension), size: result.blob.size });
      if (reply?.error) throw new Error(reply.error);
    } catch (error) {
      const reason = /[\u3400-\u9fff]/.test(error.message) ? error.message : "媒体读取或封装失败，请检查文件、网络和编码兼容性。";
      await send("failed", { reason }).catch(() => {});
      control(run, "release");
    }
  })();
  return true;
}
