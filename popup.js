function updateUI(isRunning) {
    startButton.disabled = isRunning;
    stopButton.disabled = !isRunning;
  }
  
  document.addEventListener("DOMContentLoaded", function () {
    const intervalInput = document.getElementById("interval");
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
  });
  window.addEventListener("DOMContentLoaded", () => {
    // Clear the notification dot
    chrome.action.setBadgeText({ text: "" });
  
    // ...
  });
  
  
// document.addEventListener("DOMContentLoaded", function () {
//     const intervalInput = document.getElementById("interval");
//     const startButton = document.getElementById("start");
//     const stopButton = document.getElementById("stop");
  
//     function updateUI(isRunning) {
//       startButton.disabled = isRunning;
//       stopButton.disabled = !isRunning;
//     }
  
//     chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
//       if (response.isRunning) {
//         intervalInput.value = response.interval / 1000;
//         updateUI(true);
//       } else {
//         updateUI(false);
//       }
//     });
  
//     startButton.addEventListener("click", function () {
//       const interval = parseInt(intervalInput.value) * 1000;
//       chrome.runtime.sendMessage({ action: "start", interval });
//       updateUI(true);
//     });
  
//     stopButton.addEventListener("click", function () {
//       chrome.runtime.sendMessage({ action: "stop" });
//       updateUI(false);
//     });
//   });
  