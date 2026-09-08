/* popup.js */
'use strict';
const master = document.getElementById('master');
const statusEl = document.getElementById('status');

function sendToTab(tabId, msg) {
  return new Promise((res) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (r) => {
        if (chrome.runtime.lastError) return res(null);
        res(r || null);
      });
    } catch (e) { res(null); }
  });
}

function setStatus(text, off) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (off ? ' off' : '');
}

async function refresh() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id) { setStatus('タブがありません'); return; }
  const st = await sendToTab(tab.id, { type: 'EE_STATE' });
  if (!st) { setStatus('このページには地図拡張が動作していません(対応サイト以外)'); master.disabled = false; return; }
  const base = st.site ? `${st.site} で表示中` : '対応地図ページ';
  setStatus(`${base} — 現在: ${st.enabled ? 'ON' : 'OFF'}`);
  master.checked = !!st.enabled;
}

chrome.storage.sync.get({ eeEnabled: false }, (o) => { master.checked = !!o.eeEnabled; });
refresh();

master.addEventListener('change', async () => {
  const v = master.checked;
  chrome.storage.sync.set({ eeEnabled: v }, () => {
    setStatus(v ? 'ON にしました。地図ページを確認してください' : 'OFF にしました', !v);
  });
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0] && tabs[0].id) {
    await sendToTab(tabs[0].id, { type: v ? 'EE_ON' : 'EE_OFF' });
  }
});
