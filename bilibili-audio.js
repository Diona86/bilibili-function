import { receiveVideoAudio } from "./video.js";

// The page supplies the archive and part IDs. Keep media URLs in the video tab.
function readPartId(expectedUrl, part) {
  const expected = new URL(expectedUrl);
  const id = location.pathname.match(/^\/video\/((?:BV[\da-z]+|av\d+))\/?$/i)?.[1];
  const page = Number(new URL(location.href).searchParams.get("p"));
  const actualPart = Number.isSafeInteger(page) && page > 0 ? page : 1;
  if (!id || location.origin !== expected.origin || actualPart !== part ||
      location.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "")) return null;
  const archive = globalThis.__INITIAL_STATE__?.videoData;
  const matchesArchive = id.toLowerCase().startsWith("av")
    ? archive && Number(id.slice(2)) === Number(archive.aid)
    : id === archive?.bvid;
  if (!matchesArchive) return null;

  const clip = archive.pages?.find((entry) => Number(entry.page) === part);
  const cid = String(clip?.cid ?? (part === 1 ? archive.cid ?? "" : ""));
  return /^[1-9]\d*$/.test(cid) ? cid : null;
}

// Download using the video page's regular cross-origin permissions.
async function downloadInVideoTab(cid, expectedUrl, name) {
  const expected = new URL(expectedUrl);
  const onExpectedPart = () => {
    const page = Number(new URL(location.href).searchParams.get("p"));
    const part = Number.isSafeInteger(page) && page > 0 ? page : 1;
    return location.origin === expected.origin &&
      location.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "") &&
      part === Number(expected.searchParams.get("p"));
  };
  if (!onExpectedPart()) return { error: "视频分 P 已切换，请在当前分 P 重新生成。" };

  const tracks = new Set();
  for (const entry of performance.getEntriesByType("resource").reverse()) {
    const url = new URL(entry.name);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !/(^|\.)bilivideo\.(com|cn|net)$/i.test(url.hostname)) continue;
    const match = url.pathname.match(/\/(\d+)-\d+-302\d+\.m4s$/i);
    if (match?.[1] === cid) tracks.add(url.href);
  }
  if (!tracks.size) return { error: "当前分 P 没有可读取的独立音轨。请播放几秒后重试，或切换音频来源。" };

  const port = chrome.runtime.connect({ name });
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(180_000);
  const signal = AbortSignal.any([controller.signal, timeout]);
  const disconnect = () => controller.abort();
  port.onDisconnect.addListener(disconnect);

  try {
    let file;
    // A video can have multiple normal CDN requests for the same part.
    for (const url of [...tracks].slice(0, 4)) {
      signal.throwIfAborted();
      if (!onExpectedPart()) return { error: "视频分 P 已切换，请在当前分 P 重新生成。" };
      try {
        const response = await fetch(url, { credentials: "omit", redirect: "error", signal });
        if (response.status !== 200 || response.headers.has("Content-Range") ||
            response.headers.get("Content-Type")?.includes("text/html")) {
          await response.body?.cancel();
          continue;
        }
        file = await response.blob();
        if (file.size) break;
      } catch {
        signal.throwIfAborted();
      }
    }
    if (!file?.size) return { error: "B 站音轨暂时无法完整下载。请刷新视频页再试，或切换音频来源。" };

    const blockSize = 512 * 1024;
    for (let offset = 0; offset < file.size; offset += blockSize) {
      signal.throwIfAborted();
      if (!onExpectedPart()) return { error: "视频分 P 已切换，请在当前分 P 重新生成。" };
      const block = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file.slice(offset, offset + blockSize));
      });
      signal.throwIfAborted();
      port.postMessage({ type: "chunk", block });
    }
    port.postMessage({ type: "done" });
    return {};
  } catch {
    return { error: timeout.aborted ? "下载 B 站音轨超时，请稍后重试。" : "未能从当前视频页取得完整音轨。" };
  } finally {
    port.onDisconnect.removeListener(disconnect);
  }
}

export async function resolveBiliPart(video) {
  const [lookup] = await chrome.scripting.executeScript({
    target: { tabId: video.tabId }, world: "MAIN", func: readPartId, args: [video.url, video.part],
  });
  if (!lookup?.result || !lookup.documentId) {
    throw new Error("无法确认当前分 P 的编号，请刷新视频页再试。");
  }
  return { cid: lookup.result, target: { tabId: video.tabId, documentIds: [lookup.documentId] } };
}

export async function downloadBiliAudio(video, signal) {
  signal.throwIfAborted();
  const { cid, target } = await resolveBiliPart(video);
  signal.throwIfAborted();

  const name = `bili-summary-download:${crypto.randomUUID()}`;
  const blocks = [];
  await receiveVideoAudio(video, name, signal, async () => {
    const [reply] = await chrome.scripting.executeScript({
      target, func: downloadInVideoTab, args: [cid, video.url, name],
    });
    signal.throwIfAborted();
    if (!reply?.result || reply.result.error) throw new Error(reply?.result?.error ?? "无法读取当前分 P 的音轨。");
  }, ({ block }) => {
    const binary = atob(block);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = binary.charCodeAt(index);
    blocks.push(bytes);
  });
  signal.throwIfAborted();
  return new Blob(blocks, { type: "audio/mp4" });
}
