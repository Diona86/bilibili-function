// Runs in the same isolated world as the player commands in video.js.
(() => {
  function registerAudioProcessor() {
    class BiliAudioProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.buffer = new Int16Array(sampleRate * 45);
        this.used = 0;
        this.finished = false;
        this.port.onmessage = () => this.send(true);
      }

      send(done) {
        const samples = this.buffer.slice(0, this.used);
        this.port.postMessage({ samples, done }, [samples.buffer]);
        this.used = 0;
        this.finished = done;
      }

      process(inputs) {
        const channel = inputs[0]?.[0];
        if (!this.finished && channel) {
          for (const sample of channel) {
            this.buffer[this.used++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
            if (this.used === this.buffer.length) this.send(false);
          }
        }
        return true;
      }
    }
    registerProcessor("bili-summary-audio", BiliAudioProcessor);
  }

  function pcmBase64(samples) {
    const buffer = new ArrayBuffer(samples.byteLength);
    const bytes = new Uint8Array(buffer);
    const pcm = new DataView(buffer);
    for (let index = 0; index < samples.length; index += 1) {
      pcm.setInt16(index * 2, samples[index], true);
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    }
    return btoa(binary);
  }

  globalThis.biliSummaryRecordAudio = async (player, id, stillCurrent, controller) => {
    const { signal } = controller;
    const duration = player.duration;
    const port = chrome.runtime.connect({ name: `bili-summary-audio:${id}` });
    const disconnect = () => controller.abort();
    port.onDisconnect.addListener(disconnect);
    let stream;
    let context;
    let node;
    const listeners = new AbortController();
    const options = { signal: listeners.signal };

    try {
      stream = player.captureStream();
      const tracks = stream.getAudioTracks();
      if (!tracks.length) throw new Error("播放器没有可采集的音轨，请先播放视频再试。");
      context = new AudioContext({ sampleRate: 16000 });
      const script = new Blob([`(${registerAudioProcessor.toString()})();`], { type: "text/javascript" });
      const url = URL.createObjectURL(script);
      const startup = AbortSignal.any([signal, AbortSignal.timeout(7000)]);
      try {
        await Promise.race([
          Promise.all([context.audioWorklet.addModule(url), context.resume()]),
          new Promise((_, reject) => {
            startup.addEventListener("abort", () => reject(new Error("无法启动音频采集，请先在视频页点击播放。")), options);
          }),
        ]);
      } finally {
        URL.revokeObjectURL(url);
      }
      signal.throwIfAborted();

      node = new AudioWorkletNode(context, "bili-summary-audio", { channelCount: 1, channelCountMode: "explicit" });
      context.createMediaStreamSource(new MediaStream(tracks)).connect(node).connect(context.destination);

      await new Promise((resolve, reject) => {
        let start = 0;
        let lastProgress = -1;
        let ending = false;
        let flushTimer;
        const stop = (error) => {
          clearTimeout(flushTimer);
          listeners.abort();
          if (error) reject(error);
          else resolve();
        };
        const verify = () => {
          if (!stillCurrent()) throw new Error("视频或音轨已切换，请重新生成摘要。");
        };
        const progress = () => {
          if (ending) return;
          try {
            verify();
            const seconds = Math.floor(player.currentTime);
            if (seconds === lastProgress) return;
            lastProgress = seconds;
            port.postMessage({ type: "progress", seconds, duration });
          } catch (error) {
            stop(error);
          }
        };

        node.port.onmessage = ({ data: { samples, done } }) => {
          try {
            signal.throwIfAborted();
            if (!ending) verify();
            const end = ending ? duration : player.currentTime;
            if (samples.length && end > start) {
              port.postMessage({ type: "chunk", start, end, pcm: pcmBase64(samples) });
              start = end;
            }
            if (done) {
              port.postMessage({ type: "done" });
              stop();
            }
          } catch (error) {
            stop(error);
          }
        };
        player.addEventListener("timeupdate", progress, options);
        player.addEventListener("ended", (event) => {
          // Keep this part selected until the extension restores the original playback state.
          event.stopImmediatePropagation();
          ending = true;
          flushTimer = setTimeout(() => {
            node.port.postMessage("flush");
            flushTimer = setTimeout(() => stop(new Error("未能完成片尾音频采集，请重试。")), 3000);
          }, 160);
        }, { ...options, capture: true, once: true });
        player.addEventListener("seeking", () => {
          if (!ending) stop(new Error("播放进度已改变，请重新开始完整音频采集。"));
        }, options);
        player.addEventListener("ratechange", () => {
          if (player.playbackRate !== 1) stop(new Error("播放速度已改变，请重新开始完整音频采集。"));
        }, options);
        player.addEventListener("error", () => stop(new Error("播放器无法继续播放音轨。")), options);
        node.addEventListener("processorerror", () => stop(new Error("音频编码失败，请重试。")), options);
        signal.addEventListener("abort", () => stop(signal.reason), options);
        progress();
        if (!listeners.signal.aborted) player.play().catch(() => stop(new Error("请先在视频页点击播放，再开始音频采集。")));
      });
    } finally {
      listeners.abort();
      node?.port.close();
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close();
      port.onDisconnect.removeListener(disconnect);
    }
  };
})();
