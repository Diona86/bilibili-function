import { mediaResource } from "./media/resource.js";

async function scanInFrame(records, refresh) {
  const { scanFrame } = await import(chrome.runtime.getURL("media/detector.js"));
  const { inspect } = await import(chrome.runtime.getURL("media/probe.js"));
  const frame = await scanFrame(records);
  const manifests = new Map();
  for (const entry of frame.entries) {
    if (entry.unsupportedReason || (!["hls", "dash"].includes(entry.protocol) && !entry.mediaUrl?.startsWith("blob:") &&
      !(entry.playerId && entry.mediaUrl && !entry.fileExtension))) continue;
    if (!manifests.has(entry.mediaUrl) && manifests.size < 12) manifests.set(entry.mediaUrl, entry);
  }
  // Limit simultaneous manifest reads on pages with many players.
  const entries = [...manifests.values()];
  const details = new Map();
  for (let i = 0; i < entries.length; i += 3) {
    await Promise.all(entries.slice(i, i + 3).map(async e => details.set(e.mediaUrl, await inspect(e, {}, refresh))));
  }
  for (const e of frame.entries) {
    const info = details.get(e.mediaUrl);
    if (info && !e.unsupportedReason) {
      const subs = [...(e.subtitleTracks || []), ...(info.subtitleTracks || [])];
      Object.assign(e, info, { subtitleTracks: subs });
    }
  }
  return frame;
}
export function groupFrame(page, frame) {
  const children = new Set(frame.entries.flatMap(e => (e.relatedUrls || []).filter(url => url && url !== e.mediaUrl)));
  const byUrl = new Map(), groups = new Map();
  for (const e of frame.entries) {
    if (children.has(e.mediaUrl) && !e.playerId) continue;
    const key = e.mediaUrl || e.playerId;
    const old = byUrl.get(key);
    if (!old || (!old.playerId && e.playerId)) byUrl.set(key, { ...old, ...e });
    else {
      old.contentLength ??= e.contentLength;
      old.mimeType ||= e.mimeType;
      if (old.protocol === "direct" && ["hls", "dash"].includes(e.protocol) && !old.unsupportedReason) {
        Object.assign(old, {
          protocol: e.protocol, fileExtension: e.fileExtension, videoTracks: e.videoTracks, audioTracks: e.audioTracks,
          subtitleTracks: [...(old.subtitleTracks || []), ...(e.subtitleTracks || [])], duration: e.duration || old.duration,
          supportStatus: e.supportStatus, unsupportedReason: e.unsupportedReason
        });
      }
      if (e.sourceType === "headers") { old.detectedAt = e.detectedAt; old.lastSeenAt = e.lastSeenAt; }
    }
  }
  const entries = [...byUrl.values()];
  const players = new Set(entries.map(e => e.playerId).filter(Boolean));
  const unresolved = entries.find(e => e.playerId && e.protocol === "player" && !e.mediaUrl?.startsWith("http") && !/保护|禁止/.test(e.unsupportedReason || ""));
  const observed = entries.filter(e => !e.playerId && ["direct", "hls", "dash"].includes(e.protocol) && !e.unsupportedReason && e.sourceType !== "link");
  if (players.size === 1 && unresolved && observed.length === 1) {
    Object.assign(observed[0], {
      playerId: unresolved.playerId, title: unresolved.title, playing: unresolved.playing,
      subtitleTracks: [...(observed[0].subtitleTracks || []), ...(unresolved.subtitleTracks || [])], detectionConfidence: "same-frame"
    });
  }
  for (const e of entries) {
    const key = e.playerId || e.mediaUrl;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return [...groups.values()].map(variants => {
    variants.sort((a, b) => Number(Boolean(a.unsupportedReason)) - Number(Boolean(b.unsupportedReason)) ||
      Number(Boolean(b.selected)) - Number(Boolean(a.selected)));
    const entry = variants[0];
    const resource = mediaResource(page, frame, entry);
    resource.title ||= entry.mediaUrl ? new URL(entry.mediaUrl).pathname.split("/").pop() || page.title : page.title;
    resource.alternatives = variants.filter(v => !v.unsupportedReason).map(v => ({ ...v, relatedUrls: undefined }));
    resource.subtitleTracks = [...new Map([...(resource.subtitleTracks || []), ...(groups.size === 1 ? frame.looseSubtitles : [])].map(t => [t.id, t])).values()];
    resource.segmentsSeen = frame.segments;
    return resource;
  });
}
export async function findPageVideos(page, refresh = false) {
  const response = await chrome.runtime.sendMessage({ target: "media-manager", action: "watch", tabId: page.tabId, url: page.url });
  const records = response?.records || [];
  // Bind observations to the precise document, even when several embeds share an origin.
  const ids = await chrome.scripting.executeScript({ target: { tabId: page.tabId, allFrames: true }, func: () => location.href });
  if (ids.find(f => f.frameId === 0)?.result !== page.url) throw new Error("网页已切换或没有读取权限，请在目标页点扩展图标。");
  const options = [], embeds = new Map(), scanned = new Set();
  const frames = await Promise.all(ids.map(async f => {
    const result = await chrome.scripting.executeScript({
      target: { tabId: page.tabId, documentIds: [f.documentId] }, func: scanInFrame,
      args: [records.filter(e => e.documentId === f.documentId), refresh]
    }).catch(() => []);
    return result[0]?.result && { ...result[0].result, documentId: f.documentId };
  }));
  for (const frame of frames.filter(Boolean)) {
    scanned.add(new URL(frame.href).origin);
    options.push(...groupFrame(page, frame));
    for (const embed of frame.embeds) embeds.set(embed.url, embed);
  }
  for (const embed of embeds.values()) if (!scanned.has(new URL(embed.url).origin)) {
    options.push(mediaResource(page, { documentId: null, href: embed.url }, {
      id: embed.url, protocol: "frame", mediaUrl: embed.url,
      title: embed.title, mediaType: "player", sourceType: "iframe", detectionConfidence: "frame", supportStatus: "permission"
    }));
  }
  for (const resource of options) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(resource.id));
    resource.resourceKey = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
  }
  return options;
}
export async function detailsOf(resource, choice, refresh = false) {
  const [reply] = await chrome.scripting.executeScript({
    target: { tabId: resource.tabId, documentIds: [resource.documentId] },
    func: async (entry, selection, force) => {
      if (location.href !== entry.frameUrl) return { supportStatus: "unsupported", unsupportedReason: "播放器已切换，请重新查找。" };
      const { inspect } = await import(chrome.runtime.getURL("media/probe.js"));
      return inspect(entry, selection, force);
    }, args: [resource, choice, refresh]
  });
  if (!reply?.result) throw new Error("无法连接到原播放器。");
  return reply.result;
}
