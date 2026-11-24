import { start, control } from "./runner.js";
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.target !== "media-offscreen" || sender.id !== chrome.runtime.id || sender.tab) return;
  try {
    if (m.action === "start" && m.source?.publicFetch && m.source.protocol === "direct" && /^https?:\/\//.test(m.source.mediaUrl)) {
      reply(start(m.id, m.run, m.source, m.choice));
    } else reply(control(m.run, m.action));
  } catch (error) { reply({ error: error.message }); }
});
