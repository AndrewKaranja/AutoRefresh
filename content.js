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
