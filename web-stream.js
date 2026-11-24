import { Input, UrlSource, HLS_FORMATS, MP4, WEBM, BlobSource } from "./vendor/mediabunny.min.mjs";
import { remuxMp4 } from "./media-mp4.js";

// All requests run in the player frame and inherit its normal network permissions.
function mediaFetch(resource, options = {}) {
  const url = new URL(resource instanceof Request ? resource.url : resource);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("媒体地址无效。");
  const timeout = AbortSignal.timeout(120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return fetch(resource, { ...options, signal });
}

async function readDashFile(playlist, credentials, signal) {
  async function readPart({ resolvedUri, byterange }) {
    const start = byterange?.offset;
    const end = byterange && start + byterange.length - 1;
    const headers = byterange ? { Range: "bytes=" + start + "-" + end } : {};
    const response = await mediaFetch(resolvedUri, { headers, credentials, signal });
    if (!response.ok || (!byterange && response.status === 206)) throw new Error("DASH 分段下载失败。");
    const returnedRange = response.headers.get("Content-Range");
    if (byterange && returnedRange && !returnedRange.startsWith("bytes " + start + "-" + end + "/")) {
      throw new Error("DASH 分段范围与清单不一致。");
    }
    let part = await response.blob();
    if (byterange && response.status === 200) part = part.slice(start, end + 1);
    if (!part.size || (byterange && part.size !== byterange.length)) throw new Error("DASH 分段不完整。");
    return part;
  }
  if (!playlist.segments?.length) {
    return readPart({ resolvedUri: playlist.sidx?.resolvedUri || playlist.resolvedUri });
  }
  const parts = [];
  const init = playlist.segments[0].map;
  if (init) parts.push(await readPart(init));
  for (const segment of playlist.segments) parts.push(await readPart(segment));
  return new Blob(parts);
}

async function dashInputs(response, credentials, signal) {
  await import("./vendor/mpd-parser.min.js");
  const xml = await response.text();
  const root = globalThis.mpdParser.stringToMpdXml(xml);
  if (root.getAttribute("type") === "dynamic") throw new Error("直播仍在进行，请在回放发布后下载。");
  if (root.getElementsByTagNameNS("*", "ContentProtection").length) throw new Error("该 DASH 视频使用了内容保护。");
  if (root.getElementsByTagNameNS("*", "Period").length !== 1) throw new Error("目前支持单时段的 DASH 点播视频。");
  const manifest = globalThis.mpdParser.parse(xml, { manifestUri: response.url });
  const highestBandwidth = (tracks) => [...tracks].sort((a, b) => b.attributes.BANDWIDTH - a.attributes.BANDWIDTH)[0];
  const video = highestBandwidth(manifest.playlists);
  if (!video) throw new Error("清单中没有视频轨道。");
  const groups = Object.values(manifest.mediaGroups.AUDIO[video.attributes.AUDIO] ?? {});
  const group = groups.find((item) => item.default) ?? groups[0];
  const audio = group && highestBandwidth(group.playlists);
  const files = await Promise.all((audio ? [video, audio] : [video]).map((track) => readDashFile(track, credentials, signal)));
  return files.map((file) => new Input({ formats: [MP4, WEBM], source: new BlobSource(file) }));
}

export async function downloadStream(response, kind, credentials) {
  const controller = new AbortController();
  let inputs = [];
  try {
    if (kind === "dash") {
      inputs = await dashInputs(response, credentials, controller.signal);
    } else {
      await response.body?.cancel();
      const source = new UrlSource(response.url, {
        requestInit: { credentials }, fetchFn: mediaFetch,
        getRetryDelay: (attempts) => attempts < 1 ? 0.5 : null,
      });
      inputs = [new Input({ formats: HLS_FORMATS, source })];
    }
    return await remuxMp4(...inputs);
  } finally {
    controller.abort();
    inputs.forEach((input) => input.dispose());
  }
}
