/* ============================================================
 * content.js — ページ内コントローラ
 * 対応サイト検出 → EEOverlay → 有効化時にソース構築
 *  Leaflet系: EESlippy(自己駆動EE地図)を優先、失敗時は追従方式
 *  その他:    キャプチャ方式(世界表示前提)
 * 地図パネル右上に小さなピルUI(ON/OFF・全体へ・+/-)を出す
 * ============================================================ */
(function () {
  'use strict';
  if (window.__EEInjected) return;
  window.__EEInjected = true;

  const isExt = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  const bg = isExt ? chrome : null;

  let cfg = null;
  let pane = null;
  let overlay = null;
  let source = null;
  let enabled = false;
  let stateListeners = [];
  let retryTimer = null;
  let guidanceShown = false;
  let pill = null;

  function storageGet(key, def) {
    return new Promise((res) => {
      if (!isExt) return res(def);
      bg.storage.sync.get({ [key]: def }, (o) => res(o[key]));
    });
  }
  function storageSet(key, val) {
    return new Promise((res) => {
      if (!isExt) return res();
      bg.storage.sync.set({ [key]: val }, () => res());
    });
  }

  /* ---------- ピルUI (地図パネル右上・クリック可) ---------- */
  function ensurePill() {
    if (!pane) return null;
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'ee-earth-pill';
      // innerHTMLは自前固定文字列のみ(サイト由来データは含まない)
      pill.innerHTML =
        '<button type="button" class="ee-toggle" title="イコールアース表示をOFFにする">Equal Earth: ON</button>' +
        '<button type="button" class="ee-zout" title="ズームアウト">－</button>' +
        '<button type="button" class="ee-zin" title="ズームイン">＋</button>' +
        '<button type="button" class="ee-world" title="最小ズーム(世界全体表示)にする">全体へ</button>';
      const st = pill.style;
      st.position = 'absolute';
      st.top = '10px'; st.right = '10px';
      st.zIndex = '2000';
      st.display = 'flex';
      st.gap = '4px';
      st.font = '12px/1 system-ui, "Segoe UI", sans-serif';
      const mk = (btn) => {
        btn.style.cssText = 'pointer-events:auto;cursor:pointer;border:0;border-radius:8px;padding:6px 9px;' +
          'background:rgba(13,17,23,.84);color:#e6edf3;box-shadow:0 1px 5px rgba(0,0,0,.45);' +
          'font:inherit;font-weight:600;backdrop-filter:blur(3px);';
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(31,111,235,.9)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(13,17,23,.84)'; });
      };
      const b1 = pill.querySelector('.ee-toggle');
      const bz = pill.querySelector('.ee-zout');
      const bzi = pill.querySelector('.ee-zin');
      const bw = pill.querySelector('.ee-world');
      mk(b1); mk(bz); mk(bzi); mk(bw);
      b1.addEventListener('click', () => storageSet('eeEnabled', false));
      bzi.addEventListener('click', () => { if (source && source.zoomBy) source.zoomBy(1.7); else zoomSite(1); });
      bz.addEventListener('click', () => { if (source && source.zoomBy) source.zoomBy(1 / 1.7); else zoomSite(-1); });
      bw.addEventListener('click', () => {
        if (source && source.resetWorld) source.resetWorld();
        else zoomSite(0);
      });
      pane.appendChild(pill);
    }
    // ズームボタンはスリッピー時のみ意味を持つ
    const zin = pill.querySelector('.ee-zin'), zout = pill.querySelector('.ee-zout');
    const hasSlippy = source && source.resetWorld;
    zin.style.display = hasSlippy ? '' : 'none';
    zout.style.display = hasSlippy ? '' : 'none';
    pill.style.display = enabled ? 'flex' : 'none';
    return pill;
  }

  async function zoomSite(step) {
    if (window.EESources && pane) await window.EESources.zoomToWorld(pane);
    if (source && source.schedule) source.schedule(120);
  }

  function toast(msg, ms) {
    if (!pane) return;
    let t = pane.querySelector('.ee-earth-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'ee-earth-toast';
      const st = t.style;
      st.position = 'absolute';
      st.top = '46px'; st.left = '50%';
      st.transform = 'translateX(-50%)';
      st.zIndex = '2000';
      st.background = 'rgba(10,14,20,0.92)';
      st.color = '#e8eef5';
      st.font = '12px/1.5 system-ui, "Segoe UI", sans-serif';
      st.padding = '7px 13px';
      st.borderRadius = '10px';
      st.boxShadow = '0 2px 8px rgba(0,0,0,0.5)';
      st.pointerEvents = 'none';
      st.maxWidth = '76%';
      pane.appendChild(t);
    }
    t.textContent = msg;
    clearTimeout(t._h);
    t._h = setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, ms || 5000);
  }

  function ensureDbg() {
    if (!pane) return;
    let d = pane.querySelector('.ee-earth-dbg');
    if (!d) {
      d = document.createElement('div');
      d.className = 'ee-earth-dbg';
      const st = d.style;
      st.position = 'absolute';
      st.left = '10px'; st.bottom = '8px';
      st.zIndex = '2000';
      st.background = 'rgba(10,14,20,0.62)';
      st.color = '#9fb0c0';
      st.font = '10px/1.3 ui-monospace, Consolas, monospace';
      st.padding = '2px 6px';
      st.borderRadius = '6px';
      st.pointerEvents = 'none';
      st.maxWidth = '70%';
      st.overflow = 'hidden';
      st.textOverflow = 'ellipsis';
      pane.appendChild(d);
    }
    return d;
  }

  function updateDbg() {
    const d = ensureDbg();
    if (!d) return;
    if (!enabled || !source) { d.textContent = ''; return; }
    try {
      if (source.captureMode) {
        const w = overlay && overlay._win;
        const s = overlay.canvas ? overlay.canvas.width + 'x' + overlay.canvas.height : '-';
        const hasTex = overlay._hasSource ? 'src' : 'no-src';
        const rng = w ? ' lon' + w.lonL.toFixed(0) + '..' + w.lonR.toFixed(0) : '';
        const err = source._lastErr ? ' err=' + String(source._lastErr).slice(0, 90) : '';
        d.textContent = 'EE[capture] ' + s + ' ' + hasTex + rng + err;
        return;
      }
      const cov = source._cov, view = source._view || { k: 0 };
      const ov = overlay;
      const bufW = ov.canvas ? ov.canvas.width : 0;
      const dpr = (window.devicePixelRatio || 1);
      // 実際のオーバーサンプル比 = ソースppd / (画面px/度)
      const srcPpd = (256 * Math.pow(2, cov.z)) / 360;
      const screenPpd = view.k * 0.861545 * (Math.PI / 180); // k*F0*D2R (赤道)
      const ovs = screenPpd > 0 ? (srcPpd / screenPpd).toFixed(2) : '-';
      const zNeed = source._needZ ? source._needZ() : cov.z;
      const loading = zNeed > cov.z ? ' (loading z' + zNeed + ')' : '';
      const tpl = (source._tplIx !== undefined) ? ' tpl=' + source._tplIx : '';
      const err = source._lastErr ? ' err=' + String(source._lastErr).slice(0, 46) : '';
      const mode = (source.resetWorld ? 'slippy' : (source.captureMode ? 'capture' : ''));
      d.textContent = 'EE[' + mode + '] z=' + cov.z + ' k=' + Math.round(view.k) + ' ovs=' + ovs +
        ' dpr=' + dpr + ' buf=' + bufW + loading + tpl + err;
    } catch (e) { d.textContent = 'EE'; }
  }

  /* ---------- 起動 ---------- */
  function detectAndInit(force) {
    if (!force && pane && overlay) return;
    cfg = (window.EESites && window.EESites.detect()) || null;
    if (!cfg) return;
    pane = window.EESites.findPane(cfg);
    if (!pane) return;
    if (pane === document.body || pane === document.documentElement) {
      if (!guidanceShown) { toast('地図パネルを特定できませんでした。'); guidanceShown = true; }
      pane = null; return;
    }
    try {
      overlay = new window.EEOverlay(pane, { maxDim: 6144 });
    } catch (e) { console.warn('EE init failed', e); return; }
    if (!overlay.ready) { toast('WebGLが使えないためイコールアース表示を開始できません。'); overlay = null; return; }
    notifyState();
  }

  /* ---------- キャプチャ用: 撮影中だけ地図以外のUIを隠す ---------- */
  function captureUiHider(pane) {
    let targets = [];
    function refresh() {
      targets = [];
      // 地図を描いている大きなcanvasを探し、その祖先パスを「残す要素」にする
      let canvas = null;
      for (const cv of pane.querySelectorAll('canvas')) {
        const r = cv.getBoundingClientRect();
        if (r.width > 300 && r.height > 300) { canvas = cv; break; }
      }
      if (!canvas) { targets = []; return; }
      const keep = new Set();
      let el = canvas;
      while (el && el !== pane && el !== document.body) { keep.add(el); el = el.parentElement; }
      keep.add(pane);
      const walk = (node) => {
        for (const child of Array.from(node.children)) {
          if (keep.has(child)) { walk(child); continue; }
          targets.push(child);
        }
      };
      walk(pane);
    }
    return {
      hide() {
        refresh();
        // visibility:hidden はWebGLの描画を止めることがある → opacityで隠す
        for (const t of targets) { t.style.opacity = '0'; }
      },
      restore() {
        for (const t of targets) { t.style.opacity = ''; }
        targets = [];
      }
    };
  }

  async function buildSource() {
    if (!overlay || !pane) return false;
    if (cfg.mode === 'leaflet') {
      // OSM/国土地理院(または即時推定できるタイル)は自己駆動EE(スリッピー)を優先。
      // タイルURL推定は遅延OK — eeslippy内でタイルがDOMに現れるまでリトライする
      const canInfer = (cfg.id === 'osm' || cfg.id === 'gsi') ||
        !!(window.EESlippyInfer && window.EESlippyInfer(pane));
      if (canInfer && window.EESlippy) {
        // サーバー上限z: 国土地理院の標準地図はz18まで(19は404=欠けの原因になる)
        const maxZoom = (cfg.id === 'gsi') ? 18 : 19;
        let templateFn;
        if (cfg.id === 'gsi') {
          // 地理院はページの推定レイヤー(陰影等の部分レイヤー)を拾うと欠けやすい。
          // 標準地図(全世界)を優先し、失敗時は淡色に自動切替(自己修復)
          templateFn = () => [
            'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
            'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'
          ];
        } else {
          templateFn = () => (window.EESlippyInfer ? window.EESlippyInfer(pane) : null) || null;
        }
        source = new window.EESlippy(pane, overlay, templateFn, { maxZoom: maxZoom });
        return true;
      }
      source = new window.EESources.LeafletSource(pane, overlay);
      return true;
    }
    source = new window.EESources.CaptureSource(pane, overlay, async () => {
      try {
        const r = await bg.runtime.sendMessage({ type: 'EE_CAPTURE' });
        if (r && r.dataUrl) { source._lastErr = ''; return r.dataUrl; }
        source._lastErr = (r && r.error) ? String(r.error) : 'capture: empty response';
        return null;
      } catch (e) {
        source._lastErr = 'capture: ' + String((e && e.message) || e);
        return null;
      }
    }, null /* captureUiHider(pane) — 実験中: UI隠しで暗くなるため一旦無効 */);
    return true;
  }

  async function applyEnabled(on) {
    enabled = !!on;
    if (enabled && !overlay) {
      detectAndInit(true);
      if (!overlay) scheduleRetry();
    }
    if (overlay) {
      if (!on) {
        if (source && source.detach) { try { source.detach(); } catch (e) {} }
        source = null;
      }
      if (on && !source) {
        const ok = await buildSource();
        if (!ok) return;
      }
      overlay.setEnabled(on);
      ensurePill();
      if (on && source && !source._started) {
        source.attach();
      }
      if (on && source && source.schedule) source.schedule(60);
      if (on && cfg && cfg.mode === 'capture' && !guidanceShown) {
        toast('世界全体表示(最小ズーム)で正確になります。必要なら「全体へ」ボタンで自動縮小。');
        guidanceShown = true;
      }
    }
    notifyState();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(async () => {
      const on = await storageGet('eeEnabled', false);
      if (on) { detectAndInit(true); if (overlay) applyEnabled(true); else scheduleRetry(); }
    }, 2500);
  }

  function notifyState() {
    const s = { enabled, mode: cfg ? cfg.mode : null, site: cfg ? cfg.name : null };
    for (const fn of stateListeners) {
      try { fn(s); } catch (e) {}
    }
  }

  /* ---------- 外部イベント ---------- */
  async function init() {
    const on = await storageGet('eeEnabled', false);
    detectAndInit(false);
    if (on) {
      let tries = 0;
      const waitMap = setInterval(async () => {
        tries++;
        if (pane && overlay && overlay.ready) {
          clearInterval(waitMap);
          applyEnabled(true);
          return;
        }
        detectAndInit(true);
        if (pane && overlay && overlay.ready) {
          clearInterval(waitMap);
          applyEnabled(true);
          return;
        }
        if (tries > 40) {
          clearInterval(waitMap);
          toast('地図の読み込みを待っています。ページを再読込するか、もう一度トグルしてください。');
        }
      }, 500);
    }

    if (isExt) {
      bg.storage.onChanged.addListener((ch, area) => {
        if (area === 'sync' && ch.eeEnabled) applyEnabled(!!ch.eeEnabled.newValue);
      });
      bg.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg.type === 'EE_TOGGLE') storageGet('eeEnabled', false).then(v => storageSet('eeEnabled', !v));
        if (msg && msg.type === 'EE_ON') storageSet('eeEnabled', true);
        if (msg && msg.type === 'EE_OFF') storageSet('eeEnabled', false);
        if (msg && msg.type === 'EE_STATE') {
          sendResponse({ enabled, site: cfg ? cfg.name : null, mode: cfg ? cfg.mode : null });
        }
      });

      const bodyWatch = new MutationObserver(() => {
        if (pane && !document.contains(pane)) {
          if (source && source.detach) { try { source.detach(); } catch (e) {} }
          if (overlay) { try { overlay.destroy(); } catch (e) {} }
          source = null; overlay = null; pane = null; cfg = null; pill = null;
          storageGet('eeEnabled', false).then(on2 => { if (on2) { detectAndInit(true); scheduleRetry(); } });
        }
      });
      bodyWatch.observe(document.documentElement, { childList: true, subtree: true });
      window.__EEBodyWatch = bodyWatch;
    }

    window.__EEApi = {
      isEnabled: () => enabled,
      getState: () => ({ enabled, site: cfg ? cfg.name : null, mode: cfg ? cfg.mode : null })
    };
    // 診断情報(EE表示中のズーム段階・オーバーサンプル比等)を画面下に出す
    setInterval(updateDbg, 600);
    notifyState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
