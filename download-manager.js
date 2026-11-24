import { headersFor } from "./media/network.js";

const LIMIT = 2, HISTORY = 40;
const terminal = new Set(["Completed", "Failed", "Cancelled"]);
const panel = chrome.runtime.getURL("sidepanel.html"), offscreen = chrome.runtime.getURL("jobs.html");
const sessionKey = id => "downloadInput:" + id;
let tasks = [], serial = Promise.resolve(), openDocument;
const load = chrome.storage.local.get("downloadTasks").then(r => { tasks = Array.isArray(r.downloadTasks) ? r.downloadTasks : []; });
/** @typedef {{source: {mediaUrl: string}, choice: object, saveUrl?: string}} StoredInput */
const inputFor = async id => /** @type {StoredInput} */((await chrome.storage.session.get(sessionKey(id)))[sessionKey(id)]);
function locked(fn) {
  const op = serial.then(async () => { await load; return fn(); });
  serial = op.catch(() => {});
  return op;
}
async function persist() {
  const done = tasks.filter(t => terminal.has(t.state));
  if (done.length > HISTORY) {
    const ids = new Set(done.slice(0, -HISTORY).map(t => t.id));
    tasks = tasks.filter(t => !ids.has(t.id));
    await chrome.storage.session.remove([...ids].map(sessionKey));
  }
  await chrome.storage.local.set({ downloadTasks: tasks });
}
async function inExecutor(t, payload, action) {
  if (t.publicFetch) {
    if (action === "start") await openDocument();
    return chrome.runtime.sendMessage({ target: "media-offscreen", action, id: t.id, run: t.run, ...(action === "start" ? payload : {}) });
  }
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: t.tabId, documentIds: [t.documentId] },
    func: async (id, run, action, payload) => {
      const worker = await import(chrome.runtime.getURL("media/runner.js"));
      return action === "start" ? worker.start(id, run, payload.source, payload.choice) : worker.control(run, action);
    }, args: [t.id, t.run, action, action === "start" ? payload : null]
  });
  return r?.result;
}
function stopExecutor(t, action) {
  void inExecutor({ ...t }, null, action).catch(() => {});
}
function finish(t, state, reason = null) {
  t.state = state; t.reason = reason; t.updated = Date.now(); t.paused = false; t.eta = null; t.speed = null;
  stopExecutor(t, state === "Cancelled" ? "cancel" : "release");
}
async function nativeState(t) {
  const [item] = await chrome.downloads.search({ id: t.downloadId });
  if (!item) return finish(t, "Failed", "Chrome 下载记录已移除。");
  t.paused = item.paused; t.canResume = item.canResume;
  if (item.state === "complete") {
    if ((item.fileSize > 0 && item.fileSize !== t.verifiedSize) || !t.verifiedSize || !item.exists) {
      finish(t, "Failed", "保存后的文件大小或状态异常。");
    } else finish(t, "Completed");
  } else if (item.state === "interrupted") finish(t, item.error === "USER_CANCELED" ? "Cancelled" : "Failed", "Chrome 下载中断（" + item.error + "）。");
}
async function launch(t) {
  try {
    const p = await inputFor(t.id);
    if (!p) throw new Error("浏览器会话已结束，请在原网页重新识别。");
    if (t.publicFetch) {
      const u = new URL(p.source.mediaUrl);
      if (!(await chrome.permissions.contains({ origins: [u.protocol + "//" + u.hostname + "/*"] }))) throw new Error("文件域名访问权限已撤销。");
    }
    if (!await inExecutor(t, p, "start")) throw new Error("无法连接原播放器。");
    await locked(async () => {
      const actual = tasks.find(x => x.id === t.id);
      if (!actual || actual.run !== t.run || terminal.has(actual.state)) stopExecutor(t, "cancel");
    });
  } catch (error) {
    await locked(async () => {
      const actual = tasks.find(x => x.id === t.id);
      if (actual?.run !== t.run || terminal.has(actual.state)) return;
      finish(actual, "Failed", /[\u3400-\u9fff]/.test(error.message) ? error.message : "原页面已关闭、刷新或无读取权限，请重新识别。");
      await persist(); await pump();
    });
  }
}
// Called inside the serialized state transition. Persist ownership before starting any transfer.
async function pump() {
  const active = tasks.filter(t => !terminal.has(t.state) && t.state !== "Pending");
  const next = tasks.filter(t => t.state === "Pending" && !t.paused).slice(0, Math.max(0, LIMIT - active.length));
  for (const t of next) { t.state = "Detecting"; t.run = crypto.randomUUID(); t.updated = Date.now(); }
  if (next.length) {
    await persist();
    for (const t of next) void launch({ ...t });
  }
  if (tasks.some(t => !terminal.has(t.state))) {
    if (!await chrome.alarms.get("media-recovery")) await chrome.alarms.create("media-recovery", { periodInMinutes: 1 });
  } else await chrome.alarms.clear("media-recovery");
}
async function enqueue(source, choice) {
  if (!source.documentId || source.unsupportedReason || !["bilibili", "hls", "dash", "direct"].includes(source.protocol)) throw new Error("该资源当前不可下载。");
  if (tasks.filter(t => !terminal.has(t.state)).length >= 24) throw new Error("队列已满，请等已有任务结束。");
  const key = JSON.stringify([source.documentId, source.mediaUrl || source.id, choice.videoId, choice.audioId, choice.container, choice.subtitleId]);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))), n => n.toString(16).padStart(2, "0")).join("");
  const duplicate = tasks.find(t => t.key === digest && !terminal.has(t.state));
  if (duplicate) return { id: duplicate.id, duplicate: true };
  const id = crypto.randomUUID(), now = Date.now();
  // Signed media URLs and per-document identifiers needed for replay live only in session storage.
  const { alternatives, relatedUrls, preview, videoTracks, audioTracks, ...saved } = source;
  saved.subtitleTracks = choice.subtitleId ? source.subtitleTracks.filter(t => t.id === choice.subtitleId) : [];
  await chrome.storage.session.set({ [sessionKey(id)]: { source: saved, choice } });
  tasks.push({
    id, key: digest, title: source.title, site: new URL(source.pageUrl).host, tabId: source.tabId, documentId: source.documentId,
    protocol: source.protocol, resourceKey: source.resourceKey, publicFetch: Boolean(source.publicFetch), subtitle: Boolean(choice.subtitleId), state: "Pending", created: now, updated: now,
    run: null, downloadId: null, paused: false, bytes: 0, total: null, segments: 0, segmentTotal: null, verifiedSize: null, reason: null
  });
  await persist(); await pump();
  return { id };
}
async function command(id, action) {
  const t = tasks.find(x => x.id === id);
  if (!t) throw new Error("任务已移出历史记录。");
  if (action === "retry") {
    if (!["Failed", "Cancelled"].includes(t.state)) return;
    if (tasks.some(x => x.id !== id && x.key === t.key && !terminal.has(x.state))) throw new Error("已有相同任务在队列中。");
    if (t.downloadId != null && t.canResume) {
      await chrome.downloads.resume(t.downloadId); t.state = "Verifying"; t.reason = null;
    } else {
      const input = await inputFor(id);
      if (!input) throw new Error("原浏览器会话已结束。请重新识别视频并加入队列。");
      delete input.saveUrl;
      await chrome.storage.session.set({ [sessionKey(id)]: input });
      Object.assign(t, { state: "Pending", reason: null, bytes: 0, total: null, segments: 0, segmentTotal: null, downloadId: null, verifiedSize: null, paused: false, run: null });
    }
  } else if (action === "cancel" && !terminal.has(t.state)) {
    if (t.downloadId != null) await chrome.downloads.cancel(t.downloadId).catch(() => {});
    finish(t, "Cancelled");
  } else if (action === "pause" || action === "resume") {
    if (terminal.has(t.state)) return;
    if (t.downloadId != null) {
      if (action === "pause") await chrome.downloads.pause(t.downloadId); else await chrome.downloads.resume(t.downloadId);
    } else if (t.state !== "Pending") {
      if (action === "pause" && (t.state !== "Downloading" || t.subtitle || !["hls", "dash"].includes(t.protocol))) throw new Error("此阶段不支持暂停。");
      if (!await inExecutor(t, null, action)) throw new Error("下载阶段已变化或原播放器已断开。");
    }
    t.paused = action === "pause"; t.speed = null; t.eta = null;
  }
  t.updated = Date.now(); await persist(); await pump();
}
async function executor(m, sender) {
  const t = tasks.find(x => x.id === m.jobId);
  if (!t || t.run !== m.run || terminal.has(t.state) ||
    (t.publicFetch ? sender.url !== offscreen : sender.tab?.id !== t.tabId || sender.documentId !== t.documentId)) throw new Error("下载会话已结束。");
  if (m.action === "progress") {
    if (t.downloadId != null || !["Detecting", "Downloading", "Merging", "Verifying"].includes(m.state)) return;
    const now = Date.now(), elapsed = (now - t.updated) / 1000;
    if (m.state === "Downloading" && elapsed > 0.2 && m.bytes >= t.bytes && !t.paused) {
      t.speed = (m.bytes - t.bytes) / elapsed;
      t.eta = m.total && t.speed > 0 ? Math.max(0, (m.total - m.bytes) / t.speed) :
        m.segmentTotal && m.segments > 0 ? Math.max(0, (now - (t.started || now)) / 1000 / m.segments * (m.segmentTotal - m.segments)) : null;
    } else if (m.state !== "Downloading") { t.speed = null; t.eta = null; }
    if (t.state !== "Downloading" && m.state === "Downloading") t.started = now;
    Object.assign(t, { state: m.state, bytes: m.bytes, total: m.total, segments: m.segments, segmentTotal: m.segmentTotal, updated: now });
  } else if (m.action === "ready") {
    if (t.downloadId != null) return;
    if (!m.url?.startsWith("blob:") || !Number.isSafeInteger(m.size) || m.size <= 0 || !m.filename || /[/\\]/.test(m.filename)) throw new Error("保存请求无效。");
    const p = await inputFor(t.id);
    if (!p) throw new Error("原下载会话已结束。");
    t.state = "Verifying"; t.verifiedSize = m.size; t.filename = m.filename;
    await chrome.storage.session.set({ [sessionKey(t.id)]: { ...p, saveUrl: m.url } });
    await persist();
    t.downloadId = await chrome.downloads.download({ url: m.url, filename: m.filename, conflictAction: "uniquify" });
    await nativeState(t);
  } else if (m.action === "failed") finish(t, "Failed", m.reason);
  await persist();
  if (terminal.has(t.state)) await pump();
}
async function reconcile() {
  for (const t of tasks.filter(t => !terminal.has(t.state))) {
    const p = await inputFor(t.id);
    if (t.downloadId == null && p?.saveUrl) {
      const [found] = await chrome.downloads.search({ url: p.saveUrl, limit: 1, orderBy: ["-startTime"] });
      if (found) t.downloadId = found.id;
      else if (t.verifiedSize && t.filename && await inExecutor(t, null, "ping").catch(() => false)) {
        try { t.downloadId = await chrome.downloads.download({ url: p.saveUrl, filename: t.filename, conflictAction: "uniquify" }); }
        catch { finish(t, "Failed", "未能恢复已校验文件的保存，请重试。"); }
      }
    }
    if (t.downloadId != null) await nativeState(t);
    else if (!p) finish(t, "Failed", "浏览器已重启，原网页会话已失效。请重新识别视频。");
    else if (t.state !== "Pending" && !await inExecutor(t, null, "ping").catch(() => false)) {
      finish(t, "Failed", "准备任务已中断。原页面仍在时可以重试，否则请重新识别。");
    }
  }
  await persist(); await pump();
}
export function installDownloadManager(ensureOffscreen) {
  openDocument = ensureOffscreen;
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (m?.target === "media-manager" && sender.url === panel) {
      const promise = m.action === "watch" ? headersFor(m.tabId, m.url).then(records => ({ records })) :
        locked(() => m.action === "enqueue" ? enqueue(m.source, m.choice) : command(m.id, m.action));
      promise.then(value => reply(value || {}), e => reply({ error: e.message })); return true;
    }
    if (m?.target === "media-executor" && sender.id === chrome.runtime.id) {
      locked(() => executor(m, sender)).then(() => reply({}), e => reply({ error: e.message })); return true;
    }
  });
  chrome.downloads.onChanged.addListener(delta => {
    void locked(async () => {
      const t = tasks.find(x => x.downloadId === delta.id && !terminal.has(x.state));
      if (t) { await nativeState(t); await persist(); await pump(); }
    });
  });
  chrome.alarms.onAlarm.addListener(a => { if (a.name === "media-recovery") void locked(reconcile); });
  void locked(reconcile);
}
