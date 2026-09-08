/* ============================================================
 * background.js (Chrome MV3 service worker / Firefox event page)
 *  - 画面キャプチャ (captureVisibleTab) の提供
 *  - キーボードショートカットによる切替
 * ============================================================ */
'use strict';

const CAPTURE_OPTS = { format: 'jpeg', quality: 85 };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'EE_CAPTURE') return;
  // captureVisibleTab の第一引数は タブID ではなく ウィンドウID
  const winId = sender && sender.tab ? sender.tab.windowId : null;
  try {
    chrome.tabs.captureVisibleTab(winId, CAPTURE_OPTS, (dataUrl) => {
      const err = chrome.runtime.lastError;
      if (err) { sendResponse({ error: err.message }); return; }
      sendResponse({ dataUrl });
    });
  } catch (e) {
    sendResponse({ error: String(e && e.message || e) });
  }
  return true; // async response
});

async function toggleAllTabs() {
  const cur = await new Promise((res) => {
    chrome.storage.sync.get({ eeEnabled: false }, (o) => res(!!o.eeEnabled));
  });
  await new Promise((res) => {
    chrome.storage.sync.set({ eeEnabled: !cur }, () => res());
  });
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-equal-earth') toggleAllTabs();
});

// Firefoxはクロームストレージイベントが content に届くので切替は storage経由で十分
