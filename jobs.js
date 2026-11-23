import { transcribeMedia } from "./audio.js";
import { summarizeNotes } from "./summary.js";

let job = null;
let active = null;
let draft = null;
let revision = 0;

function publish(changes) {
  job = { ...job, ...changes, revision: ++revision };
  void chrome.runtime.sendMessage({ target: "bili-panel", job }).catch(() => {});
}

function finishError(error, signal) {
  if (signal.aborted) draft = null;
  publish(signal.aborted ? { phase: "cancelled", retryable: false, message: "已取消生成。" }
    : { phase: "error", retryable: Boolean(draft), message: error.message || "后台生成失败，请重试。" });
}

async function generate(input, media, signal) {
  const report = (message) => publish({ message });
  try {
    const transcript = input.transcript ?? await transcribeMedia(media, input.duration, input.model, signal, report);
    signal.throwIfAborted();
    draft = { transcript, frames: input.frames, video: input.video };
    const evidence = [...transcript, ...input.frames].sort((a, b) => a.start - b.start);
    const notes = await summarizeNotes(evidence, input.model, signal, report);
    signal.throwIfAborted();
    publish({
      phase: "done",
      retryable: false,
      message: transcript.length ? "笔记已整理。点击时间可回看原片。" : "笔记已整理。音轨未识别到口播，内容依据原片画面。",
      result: { ...notes, evidence, transcript, frames: input.frames, video: input.video },
    });
    draft = null;
  } catch (error) {
    finishError(error, signal);
  } finally {
    active = null;
  }
}

async function start(input) {
  if (active) throw new Error("已有一份笔记正在生成。");
  active = new AbortController();
  const { signal } = active;
  draft = null;
  job = null;
  publish({ id: input.id, video: input.video, phase: "running", message: "正在把音轨交给后台…" });
  try {
    let media = input.mediaUrl;
    if (input.blobUrl) {
      const response = await fetch(input.blobUrl, { signal });
      if (!response.ok) throw new Error("无法把音轨交给后台，请重新生成。");
      media = await response.blob();
    }
    signal.throwIfAborted();
    void generate(input, media, signal);
  } catch (error) {
    finishError(error, signal);
    active = null;
  }
  return { job };
}

async function retry(id, model) {
  if (active) throw new Error("已有一份笔记正在生成。");
  if (job?.id !== id || job.phase !== "error" || !draft) throw new Error("找不到可重用的转写，请重新生成笔记。");
  active = new AbortController();
  publish({ phase: "running", retryable: false, message: "正在用已完成的转写和画面重新整理…" });
  void generate({ ...draft, model }, null, active.signal);
  return { job };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL("background.js") || message?.target !== "bili-jobs") return;
  if (message.kind === "start" || message.kind === "retry") {
    const task = message.kind === "start" ? start(message.input) : retry(message.id, message.model);
    task.then(respond, (error) => respond({ error: error.message }));
    return true;
  }
  if (message.kind === "cancel" && job?.id === message.id) active?.abort();
  respond({ job });
});
