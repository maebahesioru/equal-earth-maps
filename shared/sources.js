/* ============================================================
 * ソースモジュール: 表示窓の計算とソース画像の組み立て
 *  - LeafletSource : OSM/国土地理院などLeafletタイルページ
 *      DOMのタイル<img>から正確な表示窓を復元し、
 *      同タイルを再取得してモザイク画像を作る
 *  - CaptureSource : Google/Bing/Yahoo!/百度
 *      画面キャプチャ(chrome.tabs.captureVisibleTab)を
 *      「世界全体=経度±180°をパネル幅いっぱい」という前提でEE化
 *
 *  UX方針: 操作中でもオーバーレイを外さない。
 *  ドラッグ/ホイールは GestureTracker がフレームへ即時反映し
 *  (手に追従)、裏では連続再構築して鮮明なフレームへ置き換える。
 * ============================================================ */
(function (root) {
  'use strict';
  const EE = root.EEMath;

  /* ---------- ユーティリティ ---------- */

  /** タイルURLから z/x/y を抽出 (…/z/x/y[@2x].png等) */
  function parseTileSrc(src) {
    if (!src) return null;
    const m = String(src).match(/\/(\d+)\/(\d+)\/(\d+)(?:@\d+x)?(?:\.[a-z0-9]+)?(?:\?.*)?$/i);
    if (!m) return null;
    return { z: +m[1], x: +m[2], y: +m[3] };
  }

  const CACHE_LIMIT = 800;
  const tileCache = new Map(); // src -> Promise<HTMLImageElement|ImageBitmap>

  /** CORS同意付きimgでタイルをロード(ページと同じReferer/UA/Originで飛ぶ=OSMポリシーOK) */
  function loadTileElement(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      const timer = setTimeout(() => { im.src = ''; reject(new Error('img-timeout ' + src)); }, 12000);
      im.crossOrigin = 'anonymous';
      im.onload = () => { clearTimeout(timer); resolve(im); };
      im.onerror = () => { clearTimeout(timer); reject(new Error('cors-img ' + src)); };
      im.src = src;
    });
  }

  /** CORS非対応サーバー用フォールバック: blob取得(拡張権限fetch) */
  async function fetchTileBlob(src) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 12000) : null;
    try {
      const res = await fetch(src, { mode: 'cors', credentials: 'omit', signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error('tile ' + res.status + ' ' + src);
      return await res.blob();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function fetchTileBitmap(src) {
    let p = tileCache.get(src);
    if (p) return p;
    p = (async () => {
      try {
        return await loadTileElement(src);
      } catch (e) {
        // CORS不可サーバー(地理院等)は従来どおりblob取得→bitmap
        const blob = await fetchTileBlob(src);
        if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
        const url = URL.createObjectURL(blob);
        try {
          return await new Promise((ok, ng) => {
            const im = new Image();
            im.onload = () => ok(im);
            im.onerror = ng;
            im.src = url;
          });
        } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
      }
    })();
    p.catch(() => { tileCache.delete(src); });
    tileCache.set(src, p);
    if (tileCache.size > CACHE_LIMIT) {
      let removed = 0;
      for (const u of tileCache.keys()) {
        if (removed >= 80) break;
        const zm = u.match(/\/(\d+)\/\d+\/\d+(?:@\d+x)?(?:\.[a-z0-9]+)?$/i);
        if (zm && parseInt(zm[1], 10) <= 6) continue;   // 低ズーム保護(ズームアウト用)
        tileCache.delete(u);
        removed++;
      }
    }
    return p;
  }

  /** 世界表示(経度±180°を幅いっぱい)前提の表示窓 */
  function worldWindow(wCss, hCss) {
    const a = hCss / Math.max(1, wCss);
    const vis = Math.min(1, a);          // パネルに見える世界の縦割合
    const rowTop = 0.5 - vis / 2;
    const rowBot = 0.5 + vis / 2;
    return {
      lonL: -180, lonR: 180,
      latTop: EE.latFromRowFrac(rowTop),
      latBot: EE.latFromRowFrac(rowBot)
    };
  }

  /* ============================================================
   * GestureTracker — ドラッグ/ホイールをオーバーレイへ即時反映
   * 実際の地図操作は下の(メルカトル)地図が受ける。ここでは見た目だけ
   * 「手に追従」させる(ちらつき・メルカトル露出をさせない)
   * ============================================================ */
  class GestureTracker {
    /**
     * @param pane 地図パネル
     * @param overlay EEOverlay
     * @param hooks { onGesture():void ドラッグ中に定期再構築を促す,
     *               onSettle():void ジェスチャ終了(再構築を促す) }
     */
    constructor(pane, overlay, hooks) {
      this.pane = pane;
      this.ov = overlay;
      this.hooks = hooks || {};
      this._down = null;
      this._active = false;
      this._panCss = { x: 0, y: 0 };
      this._zoom = 1;
      this._anchorCss = null;
      this._settleT = null;
      this._moveT = null;
      this._attached = false;
    }

    _k() { // css px → canvas px
      const r = this.pane.getBoundingClientRect();
      return (r.width > 0 && this.ov.canvas) ? this.ov.canvas.width / r.width : 1;
    }

    _apply() {
      if (!this.ov.enabled) return;
      const k = this._k();
      const pan = { x: this._panCss.x * k, y: this._panCss.y * k };
      const anchor = this._anchorCss ? { x: this._anchorCss.x * k, y: this._anchorCss.y * k } : null;
      this.ov.setGesture(pan, this._zoom, anchor);
    }

    attach() {
      if (this._attached) return;
      this._attached = true;
      const opts = { passive: true };

      this._pd = (e) => {
        if (!this.ov.enabled || !e.isPrimary || e.button !== 0) return;
        this._down = { x: e.clientX, y: e.clientY };
        this._panCss = { x: 0, y: 0 };
        this._zoom = 1;
        this._anchorCss = null;
        this._active = true;
        this._apply();
      };
      this._pm = (e) => {
        if (!this._active || !this._down) return;
        this._panCss = { x: e.clientX - this._down.x, y: e.clientY - this._down.y };
        this._apply();
        if (this.hooks.onGesture) this.hooks.onGesture(); // 頻度は呼び出し側で制御
      };
      const settle = (e) => {
        if (!this._active) return;
        this._active = false;
        this._down = null;
        clearTimeout(this._settleT);
        this._settleT = setTimeout(() => {
          if (this.hooks.onSettle) this.hooks.onSettle();
        }, 140);
      };
      this._pu = settle;
      this._pc = settle;

      this._wh = (e) => {
        if (!this.ov.enabled) return;
        const k = this._k();
        this._anchorCss = { x: e.clientX, y: e.clientY };
        const factor = Math.pow(2, -e.deltaY / 100);   // Leafletと同程度の感度
        this._zoom = Math.max(1, Math.min(10, this._zoom * factor));
        this._apply();
        clearTimeout(this._settleT);
        this._settleT = setTimeout(() => {
          if (this.hooks.onSettle) this.hooks.onSettle();
        }, 240);
      };

      this.pane.addEventListener('pointerdown', this._pd, opts);
      window.addEventListener('pointermove', this._pm, opts);
      window.addEventListener('pointerup', this._pu, opts);
      window.addEventListener('pointercancel', this._pc, opts);
      // サイト側がstopPropagationしても拾えるよう capture phase で受ける
      window.addEventListener('wheel', this._wh, { passive: true, capture: true });
    }

    /** ジェスチャの見た目追従をリセット(新しいフレームを出した後) */
    reset() {
      this._zoom = 1;
      this._panCss = { x: 0, y: 0 };
      this.ov.resetGesture();
    }

    detach() {
      const opts = { passive: true };
      this.pane.removeEventListener('pointerdown', this._pd, opts);
      window.removeEventListener('pointermove', this._pm, opts);
      window.removeEventListener('pointerup', this._pu, opts);
      window.removeEventListener('pointercancel', this._pc, opts);
      window.removeEventListener('wheel', this._wh, { capture: true });
      this._attached = false;
    }
  }

  /* ============================================================
   * LeafletSource
   * ============================================================ */
  class LeafletSource {
    constructor(pane, overlay) {
      this.pane = pane;
      this.ov = overlay;
      this._timer = null;
      this._busy = false;
      this._seq = 0;
      this._dead = false;
      this._mosaic = null;
      this._lastBuild = 0;
    }

    attach() {
      const rootEl = this.pane.querySelector('.leaflet-map-pane') || this.pane;
      this._tilePane = this.pane.querySelector('.leaflet-tile-pane') || rootEl;
      this._mo = new MutationObserver(() => this.schedule(220));
      this._mo.observe(this._tilePane, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
      this._ro = new ResizeObserver(() => this.schedule(150));
      this._ro.observe(this.pane);

      // ジェスチャ追従: 操作中はフレームを動かし、裏で継続再構築
      this._gesture = new GestureTracker(this.pane, this.ov, {
        onGesture: () => { if (this.ov.enabled) this._throttleBuild(100); },
        onSettle: () => { if (this.ov.enabled) this.schedule(120); }
      });
      this._gesture.attach();

      // 初期構築
      this.schedule(300);
    }

    schedule(delay) {
      if (this._dead) return;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { if (!this._dead) this.build(); }, delay);
    }

    _throttleBuild(minGap) {
      if (this._dead) return;
      const now = Date.now();
      if (now - this._lastBuild >= minGap) {
        this._lastBuild = now;
        this.build();
      } else {
        this.schedule(minGap - (now - this._lastBuild));
      }
    }

    async build() {
      if (this._dead || !this.ov.enabled) return;
      if (this._busy) { this.schedule(120); return; }
      this._busy = true;
      const seq = ++this._seq;
      try {
        await this._doBuild(seq);
      } catch (e) {
        console.warn('[EE leaflet build]', e);
      } finally {
        this._busy = false;
      }
    }

    async _doBuild(seq) {
      const paneRect = this.pane.getBoundingClientRect();
      if (paneRect.width < 50 || paneRect.height < 50) { this.schedule(400); return; }

      // キャンバスサイズ更新
      this.ov.layout();
      const scale = this.ov.canvas.width / paneRect.width;

      // --- 可視タイル収集 ---
      const imgs = [];
      const seen = new Set();
      const tq = this._tilePane || this.pane;
      for (const el of tq.querySelectorAll('img')) {
        if (el.complete && el.naturalWidth > 0 && el.currentSrc && !el.classList.contains('leaflet-marker-icon')) {
          const parsed = parseTileSrc(el.currentSrc);
          if (!parsed) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          if (r.right <= paneRect.left || r.left >= paneRect.right || r.bottom <= paneRect.top || r.top >= paneRect.bottom) continue;
          const key = parsed.z + '/' + parsed.x + '/' + parsed.y;
          if (seen.has(key)) continue;
          seen.add(key);
          imgs.push({ parsed, rect: r, el });
        }
      }
      if (imgs.length === 0) { this.schedule(400); return; }

      // --- アンカー(パネル中心に最も近いタイル)で座標復元 ---
      const ccx = paneRect.left + paneRect.width / 2, ccy = paneRect.top + paneRect.height / 2;
      let anchor = imgs[0], bestD = Infinity;
      for (const t of imgs) {
        const r = t.rect;
        const d = Math.hypot((r.left + r.width / 2) - ccx, (r.top + r.height / 2) - ccy);
        if (d < bestD) { bestD = d; anchor = t; }
      }
      const z = anchor.parsed.z;
      const perCssLon = 360 / (Math.pow(2, z) * anchor.rect.width); // 度/csspx
      const anchorCenterLon = -180 + (anchor.parsed.x + 0.5) / Math.pow(2, z) * 360;
      const anchorCenterCss = anchor.rect.left + anchor.rect.width / 2;
      const paneCenterCss = paneRect.left + paneRect.width / 2;
      let lonC = anchorCenterLon + (paneCenterCss - anchorCenterCss) * perCssLon;
      // unwrapped整合: lonC を概ね(-180,180]へ
      while (lonC > 180) lonC -= 360;
      while (lonC <= -180) lonC += 360;
      let lonL = lonC - (paneRect.width / 2) * perCssLon;
      let lonR = lonC + (paneRect.width / 2) * perCssLon;
      if (lonR - lonL > 360) { lonL = lonC - 180; lonR = lonC + 180; }

      // 縦(rowFrac) — タイル行から
      const rowAtCssY = (cssY) => {
        const dy = (cssY - anchor.rect.top) / anchor.rect.height;
        return (anchor.parsed.y + dy) / Math.pow(2, z);
      };
      let rowTop = rowAtCssY(paneRect.top);
      let rowBot = rowAtCssY(paneRect.bottom);
      if (rowTop < 0) rowTop = 0; if (rowBot > 1) rowBot = 1;
      if (rowBot <= rowTop) { rowBot = rowTop + 0.01; }
      const latTop = EE.latFromRowFrac(rowTop);
      const latBot = EE.latFromRowFrac(rowBot);

      // --- モザイク描画 ---
      const W = this.ov.canvas.width, H = this.ov.canvas.height;
      if (!this._mosaic) {
        this._mosaic = document.createElement('canvas');
      }
      if (this._mosaic.width !== W) this._mosaic.width = W;
      if (this._mosaic.height !== H) this._mosaic.height = H;
      const ctx = this._mosaic.getContext('2d');
      ctx.clearRect(0, 0, W, H);

      // タイル画像を並行取得し、到着次第モザイクへ
      const draws = imgs.map(async (t) => {
        try {
          const bmp = await fetchTileBitmap(t.el.currentSrc);
          if (!bmp || this._seq !== seq || this._dead) return;
          const r = t.rect;
          const dx = (r.left - paneRect.left) * scale;
          const dy = (r.top - paneRect.top) * scale;
          const dw = r.width * scale, dh = r.height * scale;
          ctx.drawImage(bmp, dx, dy, dw, dh);
        } catch (e) { /* 個別タイル失敗はスキップ */ }
      });
      try {
        await Promise.race([
          Promise.allSettled(draws),
          new Promise(res => setTimeout(res, 2000))
        ]);
      } catch (e) { /* */ }
      if (this._seq !== seq || this._dead) return;

      this.ov.setWindow({ lonL, lonR, latTop, latBot });
      this.ov.setSourceCanvas(this._mosaic, { x: 0, y: 0, w: W, h: H });
      if (this._gesture) this._gesture.reset();   // 新しいフレームに置換 → 追従リセット
      this.ov.setVisible(true);
    }

    detach() {
      this._dead = true;
      clearTimeout(this._timer);
      if (this._mo) this._mo.disconnect();
      if (this._ro) this._ro.disconnect();
      if (this._gesture) this._gesture.detach();
    }
  }

  /* ============================================================
   * CaptureSource
   * ============================================================ */
  class CaptureSource {
    /**
     * @param pane 地図パネル要素
     * @param overlay
     * @param captureFn async () => dataURL | null (background経由)
     */
    constructor(pane, overlay, captureFn, hideUi) {
      this.pane = pane;
      this.ov = overlay;
      this.captureFn = captureFn;
      this.hideUi = hideUi || null;   // {hide(), restore()}: 撮影中にUIを隠す
      this.captureMode = true;
      this._timer = null;
      this._busy = false;
      this._seq = 0;
      this._dead = false;
      this._gesture = null;
    }

    attach() {
      this._gesture = new GestureTracker(this.pane, this.ov, {
        onSettle: () => { if (this.ov.enabled) this.schedule(200); }
      });
      this._gesture.attach();
      this.schedule(150);
    }

    schedule(delay) {
      if (this._dead) return;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { if (!this._dead) this.refresh(); }, delay);
    }

    async refresh() {
      if (this._dead || this._busy || !this.ov.enabled) return;
      this._busy = true;
      const seq = ++this._seq;
      try {
        const paneRect = this.pane.getBoundingClientRect();
        if (paneRect.width < 50 || paneRect.height < 50) return;
        this.ov.layout();
        this.ov.setWindow(worldWindow(paneRect.width, paneRect.height));
        // キャプチャ時のみオーバーレイとUIを隠す(写り込み防止・数十ms)
        this.ov.setVisible(false);
        if (this.hideUi) this.hideUi.hide();
        await new Promise(r => setTimeout(r, 70));
        const dataUrl = await this.captureFn();
        if (this.hideUi) this.hideUi.restore();
        if (this._seq !== seq || this._dead) return;
        if (!dataUrl) { this.ov.setVisible(true); this.schedule(700); return; }
        const img = await new Promise((ok, ng) => {
          const im = new Image();
          im.onload = () => ok(im);
          im.onerror = () => ng(new Error('decode'));
          im.src = dataUrl;
        });
        if (this._seq !== seq || this._dead) return;
        // キャプチャ全体とパネル領域
        const capW = img.naturalWidth || img.width;
        const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
        const s = capW / Math.max(1, vw);
        const region = {
          x: Math.round(paneRect.left * s),
          y: Math.round(paneRect.top * s),
          w: Math.round(paneRect.width * s),
          h: Math.round(paneRect.height * s)
        };
        if (region.w < 20 || region.h < 20) return;
        this.ov.setSourceImage(img, region);
        if (this._gesture) this._gesture.reset();
        this.ov.setVisible(true);
      } catch (e) {
        if (this.hideUi) { try { this.hideUi.restore(); } catch (e2) {} }
        try { this.ov.setVisible(true); } catch (e2) {}
      } finally {
        this._busy = false;
      }
    }

    detach() {
      this._dead = true;
      clearTimeout(this._timer);
      if (this._gesture) this._gesture.detach();
    }
  }

  /* ============================================================
   * zoomToWorld — 対応サイトを最小ズーム(世界全体)まで縮小
   *  Leaflet系はズームアウトボタンを押下。capture系は汎用セレクタで
   * ベストエフォート(見つからなければ何もしない)
   * ============================================================ */
  const ZOOM_OUT_TEXT = ['zoom out', 'ズームアウト', '縮小', '－', '−', '-'];

  function findZoomOutBtn(rootEl) {
    const btns = rootEl.querySelectorAll('button, [role="button"], a');
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.width < 12 || r.width > 90 || r.height < 12 || r.height > 90) continue;
      const aria = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + (b.textContent || '');
      const t = aria.trim();
      if (!t) continue;
      const lower = t.toLowerCase();
      if (/zoom\s*out/.test(lower) || lower.includes('ズームアウト') || lower.includes('縮小') ||
          lower === '-' || lower === '−' || lower === '－' || lower === '−') {
        return b;
      }
    }
    return null;
  }

  async function zoomToWorld(pane) {
    // Leaflet: 確実なコントロールがある
    const leafBtn = pane.querySelector('.leaflet-control-zoom-out');
    if (leafBtn) {
      for (let i = 0; i < 24; i++) {
        const btn = pane.querySelector('.leaflet-control-zoom-out');
        if (!btn || btn.classList.contains('leaflet-disabled') || btn.disabled) return true;
        btn.click();
        await new Promise(r => setTimeout(r, 150));
      }
      return true;
    }
    // 汎用: aria-label等から
    for (let i = 0; i < 18; i++) {
      const btn = findZoomOutBtn(pane);
      if (!btn) return false;
      if (btn.getAttribute('aria-disabled') === 'true' || btn.disabled || btn.classList.contains('leaflet-disabled') ||
          btn.classList.contains('disabled')) {
        return true;
      }
      btn.click();
      await new Promise(r => setTimeout(r, 160));
    }
    return true;
  }

  root.EESources = { LeafletSource, CaptureSource, GestureTracker, parseTileSrc, worldWindow, fetchTileBitmap, zoomToWorld };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LeafletSource, CaptureSource, GestureTracker, parseTileSrc, worldWindow, fetchTileBitmap, zoomToWorld };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
