import { getBiliResource } from "./bilibili-download.js";
import { findPageVideos, detailsOf } from "./web-download.js";
import { modelHost } from "./summary.js";

const select = id => /** @type {HTMLSelectElement} */(document.getElementById(id));
const button = id => /** @type {HTMLButtonElement} */(document.getElementById(id));
const el = id => document.getElementById(id);
const states = {
  Pending: "等待下载", Detecting: "正在解析", Downloading: "下载中", Merging: "合并中",
  Verifying: "正在校验和保存", Completed: "已完成", Failed: "失败", Cancelled: "已取消"
};
const protocols = { frame: "嵌入播放器", direct: "直链", hls: "HLS", dash: "DASH", player: "播放器", bilibili: "B 站" };
function size(n) {
  if (!(n >= 0) || n == null) return "";
  const unit = n < 1024 ? 0 : n < 1024 ** 2 ? 1 : n < 1024 ** 3 ? 2 : 3;
  return Number((n / 1024 ** unit).toFixed(1)) + " " + ["B", "KiB", "MiB", "GiB"][unit];
}
function time(n) {
  if (!(n > 0)) return "";
  n = Math.round(n);
  return Math.floor(n / 60) + "分" + n % 60 + "秒";
}
function trackName(t, index) {
  return [t.width && t.height ? t.width + "×" + t.height : "", t.label, t.language !== t.label && t.language,
  t.bitrate && Math.round(t.bitrate / 1000) + " kb/s", t.codecs].filter(Boolean).join(" · ") || "轨道 " + (index + 1);
}
function options(field, items, preferred, label, visible = items.length > 0) {
  field.parentElement.hidden = !visible;
  field.replaceChildren(...items.map((item, i) => new Option(label(item, i), item.id)));
  const value = items.find(t => t.id === preferred) || items.find(t => t.default) || items[0];
  if (value) field.value = value.id;
}
async function manager(action, body) {
  const response = await chrome.runtime.sendMessage({ target: "media-manager", action, ...body });
  if (!response || response.error) throw new Error(response?.error || "无法连接下载队列。");
  return response;
}
function taskList(tasks) {
  const queue = el("taskQueue"), history = el("taskHistory");
  queue.replaceChildren(); history.replaceChildren();
  for (const t of tasks.slice().reverse()) {
    const done = ["Completed", "Failed", "Cancelled"].includes(t.state);
    const row = document.createElement("li"), name = document.createElement("strong"), info = document.createElement("p");
    name.textContent = (t.subtitle ? "字幕 · " : "") + (t.filename || t.title);
    info.textContent = [t.site, t.paused ? "已暂停" : states[t.state],
    t.verifiedSize ? size(t.verifiedSize) : t.bytes ? size(t.bytes) + (t.total ? " / " + size(t.total) : "") : "",
    t.segmentTotal && t.segments + " / " + t.segmentTotal + " 段",
    t.speed > 0 && size(t.speed) + "/秒", t.eta > 0 && "约剩 " + time(t.eta), t.reason].filter(Boolean).join(" · ");
    row.append(name, info);
    if (!done && (t.total || t.segmentTotal)) {
      const meter = document.createElement("progress");
      meter.max = t.total || t.segmentTotal; meter.value = t.total ? t.bytes : t.segments; meter.setAttribute("aria-label", "下载进度");
      row.append(meter);
    }
    function action(label, kind) {
      const b = document.createElement("button"); b.className = "secondary"; b.textContent = label;
      b.onclick = async () => {
        b.disabled = true; el("taskNotice").textContent = "";
        try { await manager(kind, { id: t.id }); } catch (e) { el("taskNotice").textContent = e.message; b.disabled = false; }
      };
      row.append(b);
    }
    if (!done) {
      if (t.state === "Pending" || t.downloadId != null || t.state === "Downloading" && ["dash", "hls"].includes(t.protocol) && !t.subtitle)
        action(t.paused ? "继续" : "暂停", t.paused ? "resume" : "pause");
      action("取消", "cancel");
    } else if (t.state !== "Completed") action("重试", "retry");
    (done ? history : queue).append(row);
  }
  el("queueGroup").hidden = !queue.childElementCount; el("historyGroup").hidden = !history.childElementCount;
  el("historyCount").textContent = String(history.childElementCount);
  el("tasksPanel").hidden = !tasks.length;
}
export function initMediaPanel() {
  const list = select("mediaSelect"), source = select("sourceVariant"), quality = select("qualitySelect"), audio = select("audioTrackSelect"),
    sub = select("subtitleSelect"), container = select("containerSelect"), scanButton = button("scanButton"), save = button("downloadButton"),
    subSave = button("subtitleButton"), link =/** @type {HTMLAnchorElement} */(el("openPlayer")), preview =/** @type {HTMLImageElement} */(el("mediaPreview"));
  let page = null, groups = [], media = null, busy = false, probing = false, armed = false, generation = 0, revision = 0, timer, dirty = false, recentTasks = [];
  function status(message = "", error = false) { el("downloadStatus").textContent = message; el("downloadStatus").dataset.tone = error ? "error" : "normal"; }
  function draw() {
    const generic = page && !page.part, group = groups.find(g => g.id === list.value);
    const embed = generic && group?.protocol === "frame", visible = generic && media && !embed;
    scanButton.hidden = !generic; scanButton.disabled = busy; scanButton.textContent = busy ? "正在查找…" : armed ? "重新查找" : "查找网页视频";
    el("mediaLabel").hidden = !generic || !groups.length; el("mediaDetails").hidden = !visible;
    el("mediaDetails").setAttribute("aria-busy", String(busy || probing));
    list.disabled = busy;
    for (const field of [source, quality, audio, sub]) field.disabled = busy || probing;
    save.hidden = !page || generic && !group; save.disabled = busy || probing || visible && Boolean(media.unsupportedReason && !media.needsOrigin);
    save.textContent = page?.part ? "下载当前分 P" : embed ? "允许读取播放器" : media?.needsOrigin ? "授权读取并下载" : "下载所选视频";
    link.hidden = !embed; if (embed) link.href = group.mediaUrl; else link.removeAttribute("href");
    subSave.hidden = !visible || !media.subtitleTracks?.length;
    const subtitle = media?.subtitleTracks?.find(t => t.id === sub.value);
    subSave.disabled = busy || probing || !subtitle || Boolean(subtitle.unsupportedReason) || Boolean(media?.unsupportedReason);
    subSave.title = subtitle?.unsupportedReason || "";
    if (!visible) return;
    const stream = ["hls", "dash"].includes(media.protocol);
    container.parentElement.hidden = !stream;
    const task = recentTasks.findLast(t => t.documentId === media.documentId && t.title === media.title && t.resourceKey === media.resourceKey && !t.subtitle);
    media.downloadStatus = task?.state || null;
    const support = probing ? "正在解析" : media.unsupportedReason || (task && !["Failed", "Cancelled"].includes(task.state) ? states[task.state] : media.supportStatus === "ready" ? "可下载" : "已识别");
    el("mediaFacts").textContent = [protocols[media.protocol], media.fileExtension?.toUpperCase(), media.mediaUrl && new URL(media.mediaUrl).host,
    media.resolution || (media.width && media.height && media.width + "×" + media.height), time(media.duration), size(media.contentLength),
    media.bitrate && Math.round(media.bitrate / 1000) + " kb/s", media.frameRate && Number(media.frameRate.toFixed(2)) + " fps", media.codecs,
    media.segmentCount && media.segmentCount + " 个视频分片", typeof media.playing === "boolean" && (media.playing ? "播放中" : "已暂停"),
    media.detectionConfidence === "same-frame" && "来自同一播放器页面的请求", support, subtitle?.unsupportedReason].filter(Boolean).join(" · ");
    const image = media.preview;
    preview.hidden = !image; if (image && preview.getAttribute("src") !== image) preview.src = image; else if (!image) preview.removeAttribute("src");
  }
  function clear() {
    generation++; revision++; clearTimeout(timer); dirty = false; armed = false; busy = false; probing = false; groups = []; media = null;
    list.replaceChildren(); source.replaceChildren(); quality.replaceChildren(); audio.replaceChildren(); sub.replaceChildren(); container.value = "auto"; status(); draw();
  }
  function display(next) { if (page?.key !== next?.key) { page = next; clear(); } else { page = next; draw(); } }
  function tracks(entry, v, a, s) {
    options(quality, entry.videoTracks || [], v, trackName); options(audio, entry.audioTracks || [], a, trackName); options(sub, entry.subtitleTracks || [], s, trackName);
  }
  async function inspect(keep, force = false) {
    const stamp = ++revision, group = groups.find(g => g.id === list.value);
    if (!group || group.protocol === "frame") { media = null; probing = false; draw(); return; }
    const alt = group.alternatives?.find(t => t.mediaUrl === source.value);
    const entry = { ...group, ...alt, subtitleTracks: group.subtitleTracks || [] };
    const videoId = keep ? quality.value : "", audioId = keep ? audio.value : "", subId = keep ? sub.value : "";
    media = entry; probing = true; draw();
    try {
      let info = {};
      if (!entry.unsupportedReason || entry.videoTracks?.length)
        info = await detailsOf(entry, { videoId, audioId }, force);
      if (stamp !== revision) return;
      media = { ...entry, ...info };
      const domTracks = entry.subtitleTracks.filter(t => !t.group && !t.playlist);
      media.subtitleTracks = [...new Map([...domTracks, ...(info.subtitleTracks || [])].map(t => [t.id, t])).values()];
      tracks(media, videoId, audioId, subId);
    } catch (e) { if (stamp === revision) media = { ...entry, unsupportedReason: e.message }; }
    finally { if (stamp === revision) { probing = false; draw(); } }
  }
  function groupChanged(keep = false, force = false) {
    const g = groups.find(g => g.id === list.value), old = source.value, choices = g?.alternatives || [];
    const sources = choices.map(t => ({ ...t, id: t.mediaUrl }));
    options(source, sources, keep ? old : null, (t, i) => t.label || [protocols[t.protocol], t.width && t.height && t.width + "×" + t.height,
    t.mediaUrl?.startsWith("blob:") ? "临时文件" : new URL(t.mediaUrl).pathname.split("/").pop() || "来源 " + (i + 1)].filter(Boolean).join(" · "), sources.length > 1);
    if (!keep) container.value = "auto";
    return inspect(keep, force);
  }
  async function scan(force = false) {
    if (busy) { dirty = true; return; }
    if (!page || page.part) return;
    const stamp = generation;
    busy = true; armed = true; draw();
    try {
      const found = await findPageVideos(page, force);
      if (stamp !== generation) return;
      const selected = list.value;
      groups = found;
      options(list, groups, selected, g => [g.title, protocols[g.protocol], g.frameUrl && new URL(g.frameUrl).host].filter(Boolean).join(" · "));
      status(found.length ? "" : "未发现视频来源。可播放几秒后重新查找。");
      await groupChanged(Boolean(selected && selected === list.value), force);
    } catch (e) { if (stamp === generation) status(e.message, true); }
    finally {
      if (stamp === generation) {
        busy = false; draw(); if (dirty) { dirty = false; schedule(); }
      }
    }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => { if (armed) void scan(); }, 500); }
  async function download(subtitle = false) {
    const stamp = generation, current = page, selected = groups.find(g => g.id === list.value);
    if (!current) return;
    try {
      if (selected?.protocol === "frame") {
        if (!await chrome.permissions.request({ origins: [modelHost(selected.mediaUrl)] })) throw new Error("读取该嵌入页需要播放器域名授权。");
        if (stamp === generation) await scan(true); return;
      }
      let item = media;
      const choice = subtitle ? { subtitleId: sub.value } : current.part ? {} : {
        videoId: quality.value || null, audioId: audio.value || null,
        container: ["hls", "dash"].includes(item.protocol) ? container.value : null
      };
      if (current.part) item = await getBiliResource(current);
      else if (item?.needsOrigin) {
        if (!await chrome.permissions.request({ origins: [modelHost(item.mediaUrl)] })) throw new Error("读取直链需要该文件域名授权。");
        item = { ...item, publicFetch: true, supportStatus: "ready", unsupportedReason: null };
      }
      if (stamp !== generation) return;
      const result = await manager("enqueue", { source: item, choice });
      if (stamp === generation) status(result.duplicate ? "相同下载任务已在队列中。" : item.publicFetch ? "已加入下载队列。" : "已加入下载队列。可以关闭侧栏，请保留原视频页。");
    } catch (e) { if (stamp === generation) status(e.message, true); }
  }
  scanButton.onclick = () => scan(true); list.onchange = () => groupChanged();
  source.onchange = () => inspect(false); quality.onchange = () => { audio.replaceChildren(); void inspect(true); }; audio.onchange = () => inspect(true);
  sub.onchange = draw; save.onclick = () => download(); subSave.onclick = () => download(true);
  chrome.runtime.onMessage.addListener((m, sender) => {
    const tabId = sender.tab?.id ?? (sender.url === chrome.runtime.getURL("background.js") ? m.tabId : null);
    if (m?.target === "media-change" && armed && tabId === page?.tabId) schedule();
  });
  function updateTasks(value) { recentTasks = Array.isArray(value) ? value : []; taskList(recentTasks); draw(); }
  void chrome.storage.local.get("downloadTasks").then(r => updateTasks(r.downloadTasks));
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.downloadTasks) updateTasks(changes.downloadTasks.newValue); });
  return { clear, display };
}
