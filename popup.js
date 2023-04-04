function updateUI(isRunning) {
    startButton.disabled = isRunning;
    stopButton.disabled = !isRunning;
  }

  function showWarningMessageIfNeeded() {
    const refreshInterval = document.getElementById("refreshInterval");
    const warningMessage = document.getElementById("warningMessage");
  
    if (parseInt(refreshInterval.value) < 30) {
      warningMessage.hidden = false;
    } else {
      warningMessage.hidden = true;
    }
  }
  
  // document.addEventListener("DOMContentLoaded", function () {
  
  // });
  window.addEventListener("DOMContentLoaded", () => {
    const intervalInput = document.getElementById("refreshInterval");
    const startButton = document.getElementById("start");
    const stopButton = document.getElementById("stop");

    chrome.action.setBadgeText({ text: "" });
  
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0].id;
      chrome.runtime.sendMessage({ action: "getStatus", tabId }, (response) => {
        if (response.isRunning) {
          intervalInput.value = response.interval / 1000;
          updateUI(true);
        } else {
          updateUI(false);
        }
      });
  
      startButton.addEventListener("click", function () {
        const interval = parseInt(intervalInput.value) * 1000;
        chrome.runtime.sendMessage({ action: "start", interval, tabId });
        updateUI(true);
      });
  
      stopButton.addEventListener("click", function () {
        chrome.runtime.sendMessage({ action: "stop", tabId });
        updateUI(false);
      });
    });


    // Clear the notification dot
    chrome.action.setBadgeText({ text: "" });
     // Refresh interval input
  const refreshInterval = document.getElementById("refreshInterval");
  refreshInterval.addEventListener("input", showWarningMessageIfNeeded);
  restoreRefreshInterval();
  
  });
  