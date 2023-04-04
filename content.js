let refreshTimeout;

const observer = new MutationObserver(onDOMChange);
observer.observe(document, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.action === "start") {
    clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(function () {
      location.reload();
    }, request.interval);
  } else if (request.action === "stop") {
    clearTimeout(refreshTimeout);
  }
  if (request.action === "stopMonitoring") {
    observer.disconnect();
  }
});

function onDOMChange(mutations) {
  chrome.storage.sync.get("monitorChangesEnabled", (data) => {
    if (chrome.runtime.lastError) {
      console.log("Some Error: Extension context invalidated.");
    } else {
      if (data.monitorChangesEnabled) {
        chrome.runtime.sendMessage({ action: "domChanged" });
      }
    }
  });
}


