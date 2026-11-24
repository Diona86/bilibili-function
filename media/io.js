import { mediaUrl, totalLength } from "./resource.js";

export const plainMime = response => (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
export const invalidBody = mime => /^(text\/(?:html|css|javascript)|image\/|.*(?:json|javascript))/.test(mime);
/** @param {AbortSignal} [signal] @param {RequestCredentials} [credentials] */
export function context(signal = new AbortController().signal, credentials = "same-origin") {
  return { signal, credentials, checkpoint: async () => signal.throwIfAborted(), bytes: (count, total) => {}, segment: () => {} };
}
export async function readBody(url, ctx, { range = null, limit = Infinity, text = false, count = false, attempts = 3 } = {}) {
  if (!mediaUrl(url, undefined, true)) throw new Error("媒体地址无效。");
  for (let attempt = 0; ; attempt++) {
    await ctx.checkpoint();
    let retry = true;
    let response;
    let received = 0;
    const timeout = new AbortController();
    let timer;
    const arm = () => { timer = setTimeout(() => timeout.abort(new Error("读取媒体超时。")), 120000); };
    try {
      const signal = AbortSignal.any([ctx.signal, timeout.signal]);
      arm();
      response = await fetch(url, {
        credentials: ctx.credentials, redirect: ctx.publicFetch ? "error" : "follow", signal,
        headers: range ? { Range: "bytes=" + range.offset + "-" + (range.offset + range.length - 1) } : {}
      });
      clearTimeout(timer);
      retry = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!response.ok) throw new Error("媒体请求失败（HTTP " + response.status + "）。");
      retry = false;
      const mime = plainMime(response);
      if (invalidBody(mime)) throw new Error("服务器返回了网页、图片或错误信息。");
      const total = totalLength(response.headers);
      const contentRange = response.headers.get("content-range");
      const expected = range || { offset: 0, length: total };
      if (response.status === 206 && (!expected.length || (contentRange ?
        !contentRange.startsWith("bytes " + expected.offset + "-" + (expected.offset + expected.length - 1) + "/") : !range))) {
        throw new Error("服务器返回了不完整或错误的字节范围。");
      }
      if (total && total > limit) throw new Error("清单或字幕文件过大。");
      if (!response.body) throw new Error("服务器返回了空文件。");
      const reader = response.body.getReader();
      const chunks = [];
      retry = true;
      try {
        while (true) {
          await ctx.checkpoint();
          arm();
          const { done, value } = await reader.read();
          clearTimeout(timer);
          if (done) break;
          received += value.length;
          if (received > limit) { retry = false; throw new Error("清单或字幕文件过大。"); }
          chunks.push(new Blob([value]));
          if (count) ctx.bytes(value.length, range ? null : total);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let blob = new Blob(chunks, { type: mime });
      const declared = response.status === 206 ? expected.length : total;
      if (!blob.size || (declared && blob.size !== declared)) throw new Error("文件长度与服务器声明不符。");
      if (range && response.status === 200) blob = blob.slice(range.offset, range.offset + range.length);
      if (range && blob.size !== range.length) throw new Error("分段长度与清单不一致。");
      return { blob, text: text ? await blob.text() : null, url: response.url || url, mime };
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      ctx.signal.throwIfAborted();
      if (received && count) ctx.bytes(-received, null);
      if (!retry || attempt + 1 >= attempts) {
        if (error instanceof TypeError) throw new Error("无法读取媒体，请检查网络、登录状态或文件域名的访问权限。");
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    } finally { clearTimeout(timer); }
  }
}
export function readText(url, ctx) { return readBody(url, ctx, { limit: 4 * 1024 * 1024, text: true }); }
