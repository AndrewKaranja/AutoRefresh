let refreshTimeout;

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.action === "start") {
    clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(function () {
      location.reload();
    }, request.interval);
  } else if (request.action === "stop") {
    clearTimeout(refreshTimeout);
  }
});

function onDOMChange(mutations) {
  chrome.runtime.sendMessage({ action: "domChanged" });
}

const observer = new MutationObserver(onDOMChange);
observer.observe(document, { childList: true, subtree: true });
