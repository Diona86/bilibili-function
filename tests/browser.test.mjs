import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { fileInput, verifyFile } from "../media/verify.js";
import { EncodedPacketSink } from "../vendor/mediabunny.min.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url)), fixtures = join(sourceRoot, "tests", "fixtures");
const types = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".m3u8": "application/vnd.apple.mpegurl", ".mpd": "application/dash+xml",
  ".m4s": "video/iso.segment", ".ts": "video/mp2t", ".vtt": "text/vtt", ".srt": "application/x-subrip", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".ogv": "video/ogg"
};
const delay = ms => new Promise(ok => setTimeout(ok, ms));
async function hasSelectedAudio(bytes) {
  const inputs = [fileInput(new Blob([bytes])), fileInput(new Blob([await readFile(join(fixtures, "second.m4a"))]))];
  try {
    const packets = await Promise.all(inputs.map(async input => {
      const sink = new EncodedPacketSink(await input.getPrimaryAudioTrack()), data = [];
      for await (const packet of sink.packets()) data.push(Buffer.from(packet.data));
      return data;
    }));
    assert.ok(packets[0].some(p => p.equals(packets[1][Math.floor(packets[1].length / 2)])), "输出须包含第二音轨的实际编码包");
  } finally { inputs.forEach(input => input.dispose()); }
}

test("Chromium 扩展、侧栏、下载队列与落盘文件", { timeout: 180000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), "bili-media-")), downloads = join(folder, "downloads");
  await mkdir(downloads);
  const retries = new Map();
  let hold, gate, hitGate, hits = 0;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname, name = basename(path);
      res.setHeader("Cache-Control", "no-store");
      if (path === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end('<meta charset=utf-8><title>本地测试片</title><video title="直链视频" controls preload="metadata" src="/file?token=sample"><track kind="subtitles" label="SRT" src="/caption.srt"></video>' +
          '<a href="/clip.webm">WebM 直链</a><a href="/redirect.mp4">重定向文件</a><a href="/master.m3u8">多画质 HLS</a><a href="/ts.m3u8">TS 点播</a><a href="/range.m3u8">范围 HLS</a>' +
          '<a href="/movie.mpd">DASH 点播</a><a href="/bad.mp4">错误网页</a><a href="/flaky.m3u8">重试点播</a><a href="/gate.m3u8">可暂停点播</a><a href="/gate2.m3u8">第二路点播</a>' +
          '<video title="无后缀清单" preload="none" src="/opaque?key=example"></video>' +
          '<iframe title="同源播放器" src="/embed"></iframe><iframe title="跨域播放器" src="http://localhost:' + server.address().port + '/embed"></iframe>'); return;
      }
      if (path === "/embed") { res.setHeader("Content-Type", "text/html"); res.end('<video title="嵌入视频" src="/clip.mp4?embed=1" preload="metadata"></video>'); return; }
      if (path === "/bad.mp4") { res.setHeader("Content-Type", "text/html"); res.end("<html>Access denied</html>"); return; }
      if (path === "/redirect.mp4") { res.writeHead(302, { Location: "/clip.mp4?redirect=1" }); res.end(); return; }
      if (path === "/opaque") { res.setHeader("content-type", "application/octet-stream"); res.end(await readFile(join(fixtures, "ts.m3u8"))); return; }
      if (path === "/gate.m3u8" || path === "/gate2.m3u8" || path === "/flaky.m3u8") {
        res.setHeader("Content-Type", types[".m3u8"]);
        res.end((await readFile(join(fixtures, "ts.m3u8"), "utf8")).replace("ts0.ts", path === "/flaky.m3u8" ? "retry.ts" : "gate.ts")); return;
      }
      if (path === "/retry.ts" && !retries.has(path)) { retries.set(path, 1); res.writeHead(503); res.end(); return; }
      if (path === "/gate.ts" && gate) { hits++; hitGate?.(); await gate; }
      const file = name === "file" || name === "observed" ? "clip.mp4" : name === "gate.ts" || name === "retry.ts" ? "ts0.ts" : name;
      const data = await readFile(join(fixtures, file)); res.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      if (range) {
        const start = Number(range[1]), end = range[2] ? Number(range[2]) : data.length - 1;
        if (end >= data.length || start > end) { res.writeHead(416); res.end(); return; }
        res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + data.length); res.writeHead(206, { "Content-Length": end - start + 1 }); res.end(data.subarray(start, end + 1)); return;
      }
      res.writeHead(200, { "Content-Length": data.length }); res.end(data);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  let ctx;
  try {
    let root = sourceRoot;
    if (process.env.TEST_EXTENSION_ZIP) {
      root = join(folder, "extension");
      execFileSync("python", ["-m", "zipfile", "-e", resolve(process.env.TEST_EXTENSION_ZIP), root]);
    }
    await new Promise((ok, no) => server.once("error", no).listen(0, "127.0.0.1", ok));
    const origin = "http://127.0.0.1:" + server.address().port;
    // CHROMIUM_PATH can select an already installed build with extension debugging support.
    const launch = () => chromium.launchPersistentContext(join(folder, "profile"), {
      executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, acceptDownloads: true,
      args: ["--disable-extensions-except=" + root, "--load-extension=" + root, "--enable-unsafe-extension-debugging", "--disable-background-networking",
        "--host-resolver-rules=MAP *.bilivideo.com ~NOTFOUND, MAP www.bilibili.com ~NOTFOUND"]
    });
    ctx = await launch();
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host, browser = await ctx.browser().newBrowserCDPSession();
    await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
    const site = ctx.pages()[0]; await site.goto(origin);
    await site.waitForLoadState("domcontentloaded");
    const panel = await ctx.newPage();
    const errors = []; panel.on("pageerror", err => errors.push(err.message));
    await panel.goto("chrome-extension://" + id + "/sidepanel.html");
    async function grant(url) {
      await site.bringToFront();
      const { targetInfos } = await browser.send("Target.getTargets", { filter: [{ type: "tab" }] });
      const target = targetInfos.find(x => x.url === url);
      assert.ok(target, "找不到活动测试页 " + url);
      await browser.send("Extensions.triggerAction", { id, targetId: target.targetId });
    }
    await grant(site.url());
    const click = id => panel.locator("#" + id + ":not(:disabled)").evaluate(b => b.click());
    const waitFor = async fn => panel.waitForFunction(fn, undefined, { timeout: 15000 });
    await waitFor(() => !document.querySelector("#scanButton").hidden);
    await click("scanButton");
    await waitFor(() => !document.querySelector("#scanButton").disabled && document.querySelector("#mediaSelect").length > 0);
    const choices = () => panel.locator("#mediaSelect option").allTextContents();
    async function choose(label) {
      const value = await panel.locator("#mediaSelect option").evaluateAll((items, label) => items.find(item => item.textContent.includes(label))?.value, label);
      assert.ok(value, "来源缺失 " + label + " " + (await choices()).join(" / "));
      await panel.locator("#mediaSelect").selectOption(value);
      await panel.waitForFunction(id => document.querySelector("#mediaSelect").value === id &&
        document.querySelector("#mediaDetails").getAttribute("aria-busy") === "false", value, {timeout:15000});
    }
    const tasks = () => panel.evaluate(async () => (await chrome.storage.local.get("downloadTasks")).downloadTasks || []);
    async function finished(id) {
      for (let i = 0; i < 160; i++) {
        const t = (await tasks()).find(t => t.id === id);
        if (t && ["Completed", "Failed", "Cancelled"].includes(t.state)) return t;
        await delay(100);
      }
      throw Error("任务超时 " + JSON.stringify(await tasks()));
    }
    async function add(button = "downloadButton") {
      const previous = new Set((await tasks()).map(t => t.id)); await click(button);
      for (let i = 0; i < 70; i++) { const next = (await tasks()).find(t => !previous.has(t.id)); if (next) return next.id; await delay(75); }
      throw Error("未创建任务 " + await panel.locator("#downloadStatus").textContent() + " / " + await panel.locator("#mediaFacts").textContent());
    }
    async function fileFor(id) {
      const task = await finished(id); assert.equal(task.state, "Completed", task.reason || task.title);
      const path = await panel.evaluate(async id => (await chrome.downloads.search({ id }))[0].filename, task.downloadId);
      const bytes = await readFile(path); assert.equal(bytes.length, task.verifiedSize); return bytes;
    }
    async function checkDownload(name, extension, width = 96) {
      await choose(name); const bytes = await fileFor(await add());
      const info = await verifyFile(new Blob([bytes]));
      assert.equal(info.extension, extension); assert.equal(info.width, width); assert.ok(info.hasAudio); assert.ok(Math.abs(info.duration - 2) < 0.17); return bytes;
    }
    await t.test("普通、多视频、动态、iframe、Blob 与 MediaSource", async () => {
      assert.ok((await choices()).some(s => s.includes("嵌入视频")));
      await choose("跨域播放器"); assert.equal(await panel.locator("#downloadButton").textContent(), "允许读取播放器");
      await site.evaluate(async () => {
        const file = await (await fetch("/clip.webm")).blob();
        for (const [title, url] of [["动态播放器", "/clip.mov"], ["文件 Blob", URL.createObjectURL(file)]]) {
          const v = document.createElement("video"); v.title = title; v.src = url; document.body.append(v);
        }
        const v = document.createElement("video"); v.title = "MediaSource 流"; v.src = URL.createObjectURL(new MediaSource()); document.body.append(v);
      });
      await waitFor(() => document.querySelector("#mediaSelect").textContent.includes("动态播放器") && document.querySelector("#mediaSelect").textContent.includes("MediaSource 流"));
      await choose("MediaSource 流"); assert.match(await panel.locator("#mediaFacts").textContent(), /临时流|无法/);
      await choose("错误网页"); assert.equal(await panel.locator("#downloadButton").isDisabled(), true);
      assert.deepEqual(await checkDownload("文件 Blob", "webm"), await readFile(join(fixtures, "clip.webm")));
    });
    await t.test("从响应头发现无后缀、未出现在 DOM 中的请求", async () => {
      await site.evaluate(async () => { await (await fetch("/observed?signature=example")).arrayBuffer(); });
      await panel.waitForFunction(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const result = await chrome.runtime.sendMessage({ target: "media-manager", action: "watch", tabId: tab.id, url: tab.url });
        return result.records.some(r => r.mediaUrl.includes("/observed?") && r.protocol === "direct" && r.contentLength > 0);
      }, undefined, { timeout: 10000 });
    });
    await t.test("MP4 无扩展名和查询参数、WebM、SRT 原字节落盘", async () => {
      const original = await readFile(join(fixtures, "clip.mp4")); assert.deepEqual(await checkDownload("直链视频", "mp4"), original);
      await choose("直链视频"); assert.deepEqual(await fileFor(await add("subtitleButton")), await readFile(join(fixtures, "caption.srt")));
      assert.deepEqual(await checkDownload("WebM 直链", "webm"), await readFile(join(fixtures, "clip.webm")));
      assert.deepEqual(await checkDownload("重定向文件", "mp4"), original);
    });
    await t.test("已授权域名的公开跨域文件由后台无凭据读取", async () => {
      const url = "https://www.bilibili.com/public-fixture.mp4", data = await readFile(join(fixtures, "clip.mp4"));
      const cookies = [];
      await ctx.addCookies([{ name: "fixture_only", value: "test", url: "https://www.bilibili.com" }]);
      await ctx.route(url, route => {
        return route.fulfill({ contentType: "video/mp4", headers: { "Access-Control-Allow-Origin": "https://www.bilibili.com" }, body: data });
      });
      // Offscreen documents are separate Chrome targets, outside Playwright's page routing.
      await sw.evaluate(() => chrome.offscreen.createDocument({ url: "jobs.html", reasons: ["BLOBS"], justification: "Local download regression" }));
      const targets = await browser.send("Target.getTargets", { filter: [{}] });
      const target = targets.targetInfos.find(w => w.url === "chrome-extension://" + id + "/jobs.html");
      assert.ok(target);
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
      let sequence = 0;
      const send = (method, params) => browser.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: ++sequence, method, params }) });
      const intercept = event => {
        if (event.sessionId !== sessionId) return;
        const msg = JSON.parse(event.message);
        if (msg.method !== "Fetch.requestPaused") return;
        const { request, requestId } = msg.params;
        cookies.push(request.headers.Cookie || request.headers.cookie);
        void send("Fetch.fulfillRequest", {
          requestId, responseCode: 200, body: data.toString("base64"), responseHeaders: [
            { name: "Content-Type", value: "video/mp4" }, { name: "Content-Length", value: String(data.length) }]
        });
      };
      browser.on("Target.receivedMessageFromTarget", intercept);
      await send("Fetch.enable", { patterns: [{ urlPattern: url }] });
      await site.evaluate(url => {
        const v = document.createElement("video"); v.preload = "none"; v.title = "公开跨域文件"; v.src = url; document.body.append(v);
      }, url);
      await waitFor(() => document.querySelector("#mediaSelect").textContent.includes("公开跨域文件"));
      await choose("公开跨域文件");
      await waitFor(() => !document.querySelector("#downloadButton").disabled && document.querySelector("#downloadButton").textContent === "授权读取并下载");
      assert.deepEqual(await fileFor(await add()), data);
      assert.ok(cookies.length > 0); assert.ok(cookies.every(c => !c));
      browser.off("Target.receivedMessageFromTarget", intercept);
      await browser.send("Target.detachFromTarget", { sessionId });
    });
    await t.test("HLS TS、字节范围及 503 分片重试", async () => {
      for (const name of ["TS 点播", "范围 HLS", "重试点播", "无后缀清单"]) await checkDownload(name, "mp4");
      assert.equal(retries.size, 1);
    });
    await t.test("HLS fMP4 主清单、选低画质、独立音轨和分段 WebVTT", async () => {
      await choose("多画质 HLS");
      assert.equal(await panel.locator("#qualitySelect option").count(), 2); assert.equal(await panel.locator("#audioTrackSelect option").count(), 2);
      await panel.locator("#qualitySelect").selectOption({ index: 1 });
      await waitFor(() => !document.querySelector("#downloadButton").disabled && document.querySelector("#mediaFacts").textContent.includes("72×48"));
      await panel.locator("#containerSelect").selectOption("mkv");
      await panel.locator("#audioTrackSelect").selectOption({ index: 1 }); await waitFor(() => !document.querySelector("#downloadButton").disabled);
      const bytes = await fileFor(await add()); await hasSelectedAudio(bytes);
      const info = await verifyFile(new Blob([bytes])); assert.equal(info.extension, "mkv"); assert.equal(info.width, 72); assert.ok(info.hasAudio);
      const captions = (await fileFor(await add("subtitleButton"))).toString();
      for (const s of ["00:00.000 --> 00:00.900", "00:01.000 --> 00:01.900", "第一段", "第二段"]) assert.ok(captions.includes(s));
    });
    await t.test("DASH SegmentTimeline 与模板、选择视频和独立音频", async () => {
      await choose("DASH 点播");
      assert.equal(await panel.locator("#qualitySelect option").count(), 2); assert.equal(await panel.locator("#audioTrackSelect option").count(), 2);
      await panel.locator("#qualitySelect").selectOption({ index: 1 });
      await waitFor(() => !document.querySelector("#downloadButton").disabled && document.querySelector("#mediaFacts").textContent.includes("72×48"));
      await panel.locator("#audioTrackSelect").selectOption({ index: 1 }); await waitFor(() => !document.querySelector("#downloadButton").disabled);
      const bytes = await fileFor(await add()); await hasSelectedAudio(bytes);
      const info = await verifyFile(new Blob([bytes])); assert.equal(info.width, 72); assert.ok(info.hasAudio); assert.ok(Math.abs(info.duration - 2) < 0.12);
    });
    await t.test("DASH 拒绝动态、多时段和 ContentProtection", async () => {
      const xml = await readFile(join(fixtures, "movie.mpd"), "utf8");
      const reasons = await panel.evaluate(async ({ xml, origin }) => {
        const { parseDash } = await import("./media/manifests.js");
        return Promise.all([xml.replace('type="static"', 'type="dynamic"'), xml.replace("</MPD>", "<Period/></MPD>"),
        xml.replace("<Representation", "<ContentProtection/><Representation")].map(async input => {
          try { await parseDash(input, origin + "/movie.mpd"); return ""; } catch (e) { return e.message; }
        }));
      }, { xml, origin });
      assert.match(reasons[0], /直播/); assert.match(reasons[1], /多时段/); assert.match(reasons[2], /保护/);
    });
    await t.test("取消、去重、暂停、继续、重试和任务历史", async () => {
      await choose("可暂停点播"); gate = new Promise(ok => { hold = ok; });
      const waiting = new Promise(ok => { hitGate = ok; }), id = await add(); await waiting;
      async function command(action) {
        const result = await panel.evaluate(async ({ id, action }) => chrome.runtime.sendMessage({ target: "media-manager", action, id }), { id, action });
        assert.ok(!result.error, result.error);
      }
      const count = (await tasks()).length; await click("downloadButton"); await delay(160); assert.equal((await tasks()).length, count);
      await command("pause"); assert.ok((await tasks()).find(t => t.id === id).paused);
      await command("resume"); await command("cancel"); assert.equal((await finished(id)).state, "Cancelled");
      gate = null; hold(); await command("retry"); await fileFor(id); assert.ok(hits);
      assert.ok(await panel.locator("#historyCount").textContent());
    });
    await t.test("两路并发、关闭侧栏及后台工作线程重启后继续", async () => {
      gate = new Promise(ok => { hold = ok; }); hits = 0;
      await choose("可暂停点播"); const first = await add();
      await choose("第二路点播"); const second = await add();
      await choose("直链视频"); const third = await add();
      const list = await tasks(); assert.equal(list.find(t => t.id === third).state, "Pending");
      assert.equal(list.filter(t => ["Detecting", "Downloading"].includes(t.state)).length, 2);
      const currentWorker = ctx.serviceWorkers().find(w => w.url().endsWith("/background.js"));
      await currentWorker.evaluate(() => { globalThis.lifecycleTestMarker = true; });
      const targets = await browser.send("Target.getTargets", { filter: [{ type: "service_worker" }] });
      const workerTarget = targets.targetInfos.find(w => w.url === currentWorker.url());
      await panel.evaluate(async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.close?.({ windowId: w.id }).catch(() => {}); });
      await panel.goto("about:blank");
      try {
        assert.ok((await browser.send("Target.closeTarget", { targetId: workerTarget.targetId })).success);
      } finally {
        gate = null; hold(); await panel.goto("chrome-extension://" + id + "/sidepanel.html"); await site.bringToFront();
      }
      for (const key of [first, second, third]) assert.ok((await fileFor(key)).length > 0);
      const restarted = ctx.serviceWorkers().find(w => w.url().endsWith("/background.js"));
      assert.equal(await restarted.evaluate(() => globalThis.lifecycleTestMarker), undefined);
    });
    await t.test("B 站分 P 的 CID、直链和独立音画回归", async () => {
      const bv = "BV1Ab1234xyz", target = "https://www.bilibili.com/video/" + bv + "/?p=2", cdn = "https://fixture.bilivideo.com/202/";
      const mp4 = await readFile(join(fixtures, "clip.mp4"));
      async function concat(names) { return Buffer.concat(await Promise.all(names.map(n => readFile(join(fixtures, n))))); }
      const videoOnly = await concat(["high-init.mp4", "high0.m4s", "high1.m4s"]);
      const audioOnly = await concat(["audio-init.mp4", "audio0.m4s", "audio1.m4s", "audio2.m4s"]);
      await ctx.route("https://fixture.bilivideo.com/**", route => {
        const u = route.request().url(), body = u.endsWith("30280.m4s") ? audioOnly : u.endsWith(".m4s") ? videoOnly : mp4;
        return route.fulfill({ status: 200, contentType: "video/mp4", headers: { "Access-Control-Allow-Origin": "*" }, body });
      });
      await ctx.route("https://www.bilibili.com/video/**", route => route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<meta charset=utf-8><title>分 P 回归</title><div id="bilibili-player"><video></video></div>'
      }));
      await site.goto(target);
      await site.evaluate(({ bv, cdn }) => {
        window.__INITIAL_STATE__ = { videoData: { bvid: bv, pages: [{ page: 1, cid: 101 }, { page: 2, cid: 202 }] } };
        window.__playinfo__ = { data: { durl: [{ url: cdn + "202.mp4" }] } };
      }, { bv, cdn });
      await grant(site.url()); await waitFor(() => !document.querySelector("#workspace").hidden && document.querySelector("#videoPart").textContent === "P2");
      assert.deepEqual(await fileFor(await add()), mp4);
      await site.evaluate(cdn => { window.__playinfo__ = { data: { dash: { video: [{ baseUrl: cdn + "202-30016.m4s" }], audio: [{ baseUrl: cdn + "202-30280.m4s" }] } } }; }, cdn);
      const info = await verifyFile(new Blob([await fileFor(await add())])); assert.equal(info.width, 96); assert.ok(info.hasAudio);
    });
    await t.test("浏览器重启后保留历史并标记中断原因", async () => {
      await site.goto(origin); await grant(site.url()); await waitFor(() => !document.querySelector("#scanButton").hidden);
      await click("scanButton"); await waitFor(() => !document.querySelector("#scanButton").disabled && document.querySelector("#mediaSelect").length > 0);
      gate = new Promise(ok => { hold = ok; }); const waiting = new Promise(ok => { hitGate = ok; });
      await choose("可暂停点播"); const interrupted = await add(); await waiting;
      await ctx.close(); gate = null; hold(); ctx = await launch();
      const view = await ctx.newPage(); await view.goto("chrome-extension://" + id + "/sidepanel.html");
      await view.waitForFunction(async taskId => {
        const list = (await chrome.storage.local.get("downloadTasks")).downloadTasks;
        return list.some(t => t.state === "Completed") && list.some(t => t.id === taskId && t.state === "Failed" && /重启|中断/.test(t.reason));
      }, interrupted, { timeout: 12000 });
    });
    assert.deepEqual(errors, []);
  } finally {
    hold?.(); await ctx?.close(); server.closeAllConnections(); server.close();
    if (dirname(resolve(folder)) === resolve(tmpdir()) && basename(folder).startsWith("bili-media-"))
      await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
});
