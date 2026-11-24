chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).then(() => {
    // Clicking the toolbar can grant activeTab while the side panel is already open.
    return chrome.runtime.sendMessage({ target: "bili-panel", kind: "refresh-page" }).catch(() => {});
  }).catch((error) => {
    console.error("打开视频总结侧栏失败", error.message);
  });
});

const jobPage = "jobs.html";
const jobUrl = chrome.runtime.getURL(jobPage);
const panelUrl = chrome.runtime.getURL("sidepanel.html");
let opening;

async function hasJobPage() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [jobUrl],
  });
  return contexts.length > 0;
}

function openJobPage() {
  if (!opening) {
    opening = (async () => {
      if (await hasJobPage()) return;
      await chrome.offscreen.createDocument({
        url: jobPage,
        reasons: ["BLOBS"],
        justification: "Read and decode the selected audio blob for a long-running transcription in the background.",
      });
    })().finally(() => { opening = null; });
  }
  return opening;
}

async function forwardJob(message) {
  if (message.kind === "start") await openJobPage();
  else if (!(await hasJobPage())) return { job: null };
  return chrome.runtime.sendMessage({ ...message, target: "bili-jobs" });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== panelUrl || message?.target !== "bili-background" ||
      !["start", "state", "cancel", "retry"].includes(message.kind)) return;
  forwardJob(message).then(respond, (error) => respond({ error: error.message }));
  return true;
});
