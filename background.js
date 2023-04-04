let refreshIntervals = {};
let isRunning = {};

function startRefreshing(tabId, interval) {
  clearTimeout(refreshIntervals[tabId]);
  refreshIntervals[tabId] = setTimeout(() => {
    chrome.tabs.reload(tabId);
    if (isRunning[tabId]) {
      startRefreshing(tabId, interval);
    }
  }, interval);
}

function showNotificationDotOnTab(tabId) {
  const code = `
    if (!document.originalTitle) {
      document.originalTitle = document.title;
    }
    document.title = "• " + document.originalTitle;
  `;

  chrome.tabs.executeScript(tabId, { code });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = request.tabId;
  if (request.action === "start") {
    isRunning[tabId] = true;
    const currentInterval = request.interval;
    startRefreshing(tabId, currentInterval);
  } else if (request.action === "stop") {
    isRunning[tabId] = false;
    clearTimeout(refreshIntervals[tabId]);
  } else if (request.action === "getStatus") {
    sendResponse({ isRunning: isRunning[tabId], interval: currentInterval });
  }
  if (request.action === "domChanged") {
    playNotificationSound();
    showNotificationDotOnTab(sender.tab.id);
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});

function playNotificationSound() {
  const audio = new Audio(chrome.runtime.getURL("notification.mp3"));
  audio.play();
}

function showNotificationDot() {
  chrome.action.setBadgeText({ text: "•" });
  chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
}




// let refreshInterval;
// let isRunning = false;
// let currentInterval;

// function startRefreshing(tabId, interval) {
//   clearTimeout(refreshInterval);
//   refreshInterval = setTimeout(() => {
//     chrome.tabs.reload(tabId);
//     if (isRunning) {
//       startRefreshing(tabId, interval);
//     }
//   }, interval);
// }


// chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
//     if (request.action === "start") {
//       isRunning = true;
//       currentInterval = request.interval;
//       chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
//         startRefreshing(tabs[0].id, currentInterval);
//       });
//     } else if (request.action === "stop") {
//         isRunning = false;
//     clearTimeout(refreshInterval);
//     } else if (request.action === "getStatus") {
//         sendResponse({ isRunning, interval: currentInterval });
//     }
//   });

// chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
//   if (request.action === "start") {
//     isRunning = true;
//     currentInterval = request.interval;
//     chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
//       startRefreshing(tabs[0].id, currentInterval);
//     });
//   } else if (request.action === "stop") {
//     isRunning = false;
//     clearTimeout(refreshInterval);
//   } else if (request.action === "getStatus") {
//     sendResponse({ isRunning, interval: currentInterval });
//   }
// });
