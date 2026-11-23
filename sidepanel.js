import { audioLink, requireSpeechAccess, transcribeVideo } from "./audio.js";
import { downloadBiliAudio } from "./bilibili-audio.js";
import { downloadBiliVideo } from "./bilibili-download.js";
import { modelEndpoint, modelHost } from "./summary.js";
import { captureVideoFrames, formatTime, runOnVideo, videoFromTab } from "./video.js";

const ui = Object.fromEntries([
  "settingsButton", "settingsDialog", "settingsForm", "apiAddress", "modelName", "apiKey",
  "settingsError", "closeSettings", "saveSettings", "videoMeta", "videoLabel", "videoTitle", "videoPart",
  "emptyVideo", "workspace", "audioSource", "audioFile", "audioUrl", "sourceHelp", "generateButton",
  "status", "retryButton", "resultPanel", "resultVideo", "overview", "highlights", "copyButton", "transcript", "transcriptText",
  "sourceSection", "sourceNotice", "downloadButton", "downloadStatus",
].map((id) => [id, document.getElementById(id)]));

const sourceHelp = {
  auto: "播放几秒后生成。扩展会从当前分 P 的播放请求定位并下载音轨。",
  file: "选择与当前分 P 对应的完整文件，浏览器会直接解码。",
  url: "填可直接下载完整媒体文件的授权链接，适合已有音轨地址的情况。",
  player: "从头静音播放到片尾，约需视频时长。采集时保留原视频页和侧栏，可以切换标签页。",
};

const { modelSettings } = await chrome.storage.local.get("modelSettings");
let model = modelSettings ?? null;
let video = null;
let result = null;
let preparing = null;
let job = null;
let videoRevision = 0;
let downloadingKey = null;

function showStatus(message = "", error = false) {
  ui.status.textContent = message;
  ui.status.dataset.tone = error ? "error" : "normal";
}

function renderControls() {
  const jobVideo = preparing?.video ?? (job?.phase === "running" ? job.video : null);
  const displayed = jobVideo ?? video;
  const busy = Boolean(jobVideo);
  const kind = ui.audioSource.value;
  const hasMedia = (kind !== "file" || ui.audioFile.files.length > 0) &&
    (kind !== "url" || ui.audioUrl.value.trim() !== "");
  ui.videoTitle.textContent = displayed?.title ?? "打开 B 站视频";
  ui.videoPart.textContent = displayed ? `P${displayed.part}` : "";
  ui.videoLabel.textContent = preparing ? "正在准备视频资料" : busy ? "后台生成 · 可关闭侧栏" : "当前 B 站视频";
  ui.videoMeta.hidden = !displayed;
  ui.emptyVideo.hidden = Boolean(displayed);
  ui.downloadButton.hidden = !video || displayed?.key !== video.key;
  ui.downloadButton.disabled = Boolean(downloadingKey);
  ui.downloadButton.textContent = video && downloadingKey === video.key ? "正在准备 MP4…" : "下载当前分 P";
  ui.downloadStatus.hidden = ui.downloadButton.hidden;
  ui.workspace.hidden = !displayed;
  ui.sourceSection.hidden = busy;
  ui.sourceNotice.hidden = busy;
  ui.resultVideo.hidden = !result || displayed?.url === result.video.url;
  ui.audioFile.hidden = kind !== "file";
  ui.audioUrl.hidden = kind !== "url";
  ui.sourceHelp.textContent = sourceHelp[kind];
  ui.audioSource.disabled = busy;
  ui.audioFile.disabled = busy;
  ui.audioUrl.disabled = busy;
  ui.settingsButton.disabled = busy;
  ui.copyButton.disabled = busy;
  ui.highlights.inert = busy;
  ui.generateButton.disabled = !busy && (!video || !hasMedia);
  ui.generateButton.textContent = busy ? "取消生成" : "生成学习笔记";
  ui.retryButton.hidden = busy || !job?.retryable;
  ui.retryButton.title = job?.retryable ? `${job.video.title} · P${job.video.part}` : "";
}

function timeButton(seconds) {
  const time = document.createElement("button");
  time.className = "time";
  time.type = "button";
  time.textContent = formatTime(seconds);
  time.setAttribute("aria-label", `跳转到 ${time.textContent}`);
  time.addEventListener("click", () => jumpTo(seconds));
  return time;
}

function renderResult() {
  ui.resultPanel.hidden = !result;
  ui.resultVideo.textContent = result ? `${result.video.title} · P${result.video.part}` : "";
  ui.overview.textContent = result?.overview ?? "";
  ui.highlights.replaceChildren();
  ui.transcript.hidden = !result?.transcript.length;
  ui.transcript.open = false;
  ui.transcriptText.textContent = result?.transcript.map(({ start, text }) => `[${formatTime(start)}] ${text}`).join("\n\n") ?? "";
  if (!result) return;

  for (const { cue, title, points } of result.sections) {
    const focus = result.evidence[cue - 1];
    const speech = focus.text ? focus : result.transcript.find(({ start, end }) => start <= focus.start && focus.start < end);
    const frame = focus.image ? focus : result.frames.find(({ start }) => focus.start <= start && start < focus.end);
    const heading = document.createElement("h4");
    heading.className = "note-title";
    heading.textContent = title;
    const list = document.createElement("ul");
    list.className = "note-points";
    for (const point of points) {
      const item = document.createElement("li");
      item.textContent = point;
      list.append(item);
    }
    const details = document.createElement("details");
    const label = document.createElement("summary");
    label.textContent = speech && frame ? "查看原文和画面" : speech ? "查看转写原文" : "查看原片画面";
    details.append(label);
    if (speech) {
      const quote = document.createElement("p");
      quote.textContent = speech.text;
      details.append(quote);
    }
    if (frame) {
      const figure = document.createElement("figure");
      figure.className = "evidence-frame";
      const image = document.createElement("img");
      image.src = frame.image;
      image.alt = `${formatTime(frame.start)} 的视频画面`;
      image.loading = "lazy";
      figure.append(timeButton(frame.start), image);
      details.append(figure);
    }

    const content = document.createElement("div");
    content.append(heading, list, details);
    const item = document.createElement("li");
    item.append(timeButton(focus.start), content);
    ui.highlights.append(item);
  }
}

async function activeVideo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return videoFromTab(tab);
}

async function refreshVideo() {
  const revision = ++videoRevision;
  try {
    const next = await activeVideo();
    if (revision !== videoRevision) return;

    const changed = next?.key !== video?.key;
    video = next;
    if (changed) {
      ui.downloadStatus.textContent = "";
      ui.audioFile.value = "";
      ui.audioUrl.value = "";
    }
    renderControls();
  } catch {
    if (revision === videoRevision) showStatus("无法读取当前标签页，请重新打开侧栏。", true);
  }
}

async function jumpTo(seconds) {
  const source = result?.video;
  if (!source || preparing || job?.phase === "running") return;
  try {
    const original = await chrome.tabs.get(source.tabId).catch(() => null);
    const existing = videoFromTab(original);
    if (existing?.url === source.url && !original.discarded) {
      await chrome.tabs.update(source.tabId, { active: true });
      await chrome.windows.update(original.windowId, { focused: true });
      await runOnVideo(existing, seconds);
      if (result?.video === source) showStatus(`已跳到 ${formatTime(seconds)}。`);
      return;
    }
    const url = new URL(source.url);
    url.searchParams.set("t", String(Math.floor(seconds)));
    await chrome.tabs.create({ url: url.href, active: true });
  } catch (error) {
    if (result?.video === source) showStatus(error.message, true);
  }
}

function openSettings() {
  ui.apiAddress.value = model?.endpoint ?? "";
  ui.modelName.value = model?.name ?? "";
  ui.apiKey.value = model?.apiKey ?? "";
  ui.settingsError.textContent = "";
  ui.settingsDialog.showModal();
}

async function saveModel(event) {
  event.preventDefault();
  ui.saveSettings.disabled = true;
  ui.settingsError.textContent = "";
  try {
    const endpoint = modelEndpoint(ui.apiAddress.value);
    const name = ui.modelName.value.trim();
    if (!name) throw new Error("请输入模型名称。");
    const next = { endpoint, name, apiKey: ui.apiKey.value.trim() };
    const granted = await chrome.permissions.request({ origins: [modelHost(endpoint)] });
    if (!granted) throw new Error("请授予访问该模型接口的权限后保存。");
    await chrome.storage.local.set({ modelSettings: next });
    model = next;
    ui.settingsDialog.close();
    showStatus("模型设置已保存。");
  } catch (error) {
    ui.settingsError.textContent = error.message;
  } finally {
    ui.saveSettings.disabled = false;
  }
}

async function backgroundJob(kind, payload = {}) {
  const reply = await chrome.runtime.sendMessage({ target: "bili-background", kind, ...payload });
  if (!reply || reply.error) throw new Error(reply?.error ?? "无法连接学习笔记后台。");
  return reply.job;
}

function acceptJob(next) {
  if (!next || (job && next.revision <= job.revision)) return;
  job = next;
  const nextResult = next.result ?? null;
  if (result !== nextResult) {
    result = nextResult;
    renderResult();
  }
  if (!preparing || preparing.id === next.id) showStatus(next.message, next.phase === "error");
  renderControls();
}

async function generate() {
  if (preparing || job?.phase === "running") {
    const id = preparing?.id ?? job.id;
    preparing?.controller.abort();
    if (job?.phase === "running" && job.id === id) {
      try { acceptJob(await backgroundJob("cancel", { id })); }
      catch (error) { showStatus(error.message, true); }
    }
    return;
  }
  if (!video) return;
  if (!model) {
    openSettings();
    return;
  }

  const current = video;
  const config = model;
  const kind = ui.audioSource.value;
  let media = ui.audioFile.files[0];
  const controller = new AbortController();
  const { signal } = controller;
  const pending = { id: crypto.randomUUID(), controller, video: current };
  preparing = pending;
  const report = (message) => { if (preparing === pending) showStatus(message); };
  let blobUrl;
  renderControls();
  report("正在检查视频和音频来源…");

  try {
    requireSpeechAccess(config);
    if (kind === "url") {
      media = audioLink(ui.audioUrl.value);
      const granted = await chrome.permissions.request({ origins: [modelHost(media)] });
      if (!granted) throw new Error("请允许扩展访问所填音轨的地址。");
    }
    signal.throwIfAborted();
    const sourceTab = await chrome.tabs.get(current.tabId).catch(() => null);
    if (videoFromTab(sourceTab)?.key !== current.key) {
      throw new Error("原视频页已更换或关闭，请重新打开视频再生成。");
    }
    if (!(await chrome.permissions.contains({ origins: [modelHost(config.endpoint)] }))) {
      throw new Error("请在模型设置里重新保存接口授权。");
    }

    const { duration } = await runOnVideo(current);
    signal.throwIfAborted();
    if (kind === "auto") {
      report("正在定位并下载当前分 P 的 B 站音轨…");
      media = await downloadBiliAudio(current, signal);
    }
    if (kind === "file" && !media) throw new Error("请选择当前分 P 的完整音视频文件。");
    report("正在从原视频取样画面…");
    const frames = await captureVideoFrames(current, signal);
    let transcript;
    if (kind === "player") {
      report("正在从视频开头准备采集音频…");
      transcript = await transcribeVideo(current, config, signal, report);
    } else if (typeof media !== "string") {
      blobUrl = URL.createObjectURL(media);
    }
    signal.throwIfAborted();
    report("正在把资料交给后台…");
    acceptJob(await backgroundJob("start", { input: {
      id: pending.id, video: current, model: config, frames, duration, transcript, blobUrl,
      mediaUrl: typeof media === "string" ? media : undefined,
    } }));
    if (signal.aborted) acceptJob(await backgroundJob("cancel", { id: pending.id }));
  } catch (error) {
    if (preparing === pending) showStatus(signal.aborted ? "已取消生成。" : error.message, !signal.aborted);
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (preparing === pending) {
      preparing = null;
      renderControls();
    }
  }
}

async function retryNotes() {
  if (preparing || job?.phase !== "error" || !job.retryable) return;
  if (!model) {
    openSettings();
    return;
  }
  const id = job.id;
  const config = model;
  ui.retryButton.disabled = true;
  try {
    requireSpeechAccess(config);
    if (!(await chrome.permissions.contains({ origins: [modelHost(config.endpoint)] }))) {
      throw new Error("请在模型设置里重新保存接口授权。");
    }
    const next = await backgroundJob("retry", { id, model: config });
    if (!next) throw new Error("找不到可重用的转写，请重新生成笔记。");
    acceptJob(next);
  } catch (error) {
    if (job?.id === id && job.phase === "error") showStatus(error.message, true);
  } finally {
    ui.retryButton.disabled = false;
  }
}

ui.downloadButton.addEventListener("click", async () => {
  if (!video || downloadingKey) return;
  const current = video;
  downloadingKey = current.key;
  ui.downloadStatus.textContent = "正在准备 MP4，请保留原视频页…";
  ui.downloadStatus.dataset.tone = "normal";
  renderControls();
  try {
    await downloadBiliVideo(current);
    if (video?.key === current.key) ui.downloadStatus.textContent = "已请求保存 MP4，可在 Chrome 下载记录中查看。";
  } catch (error) {
    if (video?.key === current.key) {
      ui.downloadStatus.textContent = error.message;
      ui.downloadStatus.dataset.tone = "error";
    }
  } finally {
    downloadingKey = null;
    renderControls();
  }
});

ui.audioSource.addEventListener("change", renderControls);
ui.audioFile.addEventListener("change", renderControls);
ui.audioUrl.addEventListener("input", renderControls);
ui.settingsButton.addEventListener("click", openSettings);
ui.settingsForm.addEventListener("submit", saveModel);
ui.closeSettings.addEventListener("click", () => ui.settingsDialog.close());
ui.settingsDialog.addEventListener("close", () => { ui.apiKey.value = ""; });
ui.generateButton.addEventListener("click", generate);
ui.retryButton.addEventListener("click", retryNotes);
ui.copyButton.addEventListener("click", async () => {
  const selected = result;
  if (!selected) return;
  const current = selected.video;
  const notes = selected.sections.flatMap(({ cue, title, points }) => [
    `## ${formatTime(selected.evidence[cue - 1].start)} ${title}`,
    "",
    ...points.map((point) => `- ${point}`),
    "",
  ]);
  try {
    await navigator.clipboard.writeText([`# ${current.title}（P${current.part}）`, current.url, "", selected.overview, "", ...notes].join("\n"));
    if (result === selected) showStatus("已复制笔记。");
  } catch {
    if (result === selected) showStatus("复制失败，请选中笔记后手动复制。", true);
  }
});

chrome.tabs.onActivated.addListener(refreshVideo);
chrome.tabs.onUpdated.addListener((_, change, tab) => {
  if (tab.active && (change.url || change.title || change.status === "complete")) void refreshVideo();
});
const jobsUrl = chrome.runtime.getURL("jobs.html");
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.url === jobsUrl && message?.target === "bili-panel") acceptJob(message.job);
});
window.addEventListener("pagehide", () => preparing?.controller.abort());
void backgroundJob("state").then(acceptJob).catch(() => {});
void refreshVideo();
