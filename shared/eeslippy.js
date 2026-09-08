/* ============================================================
 * EESlippy — 自己駆動のイコールアース・スリッピー地図
 * OSM / 国土地理院 等、タイルURLが {z}/{x}/{y} 形式のサイト向け。
 *
 * 従来の「下のメルカトル地図を追いかける」方式と違い、パン/ズームは
 * EE平面上の2D変換だけで完結(カクつき・メルカトル露出なし)。
 * 見えている範囲に必要なメルカトルタイルをオンデマンドで取得し、
 * モザイクとしてWebGLテクスチャに持つ。不足タイルは裏で到着次第
 * 鮮明化する(通常のスリッピー地図と同じ挙動)。
 * ============================================================ */
(function (root) {
  'use strict';
  const EE = root.EEMath;

  // EE世界の生座標範囲 (中心子午線0固定)
  const X_HALF = EE.project(180, 0).x;        // ≈ 2.7066
  const Y_HALF = EE.project(0, 90).y;         // ≈ 1.3174
  const F0 = X_HALF / (Math.PI);              // x(180°,0)/π = x のθ=0でのλ係数
  const D2R = EE.D2R;
  const MAX_Z = 19;
  const TEX_CAP = 6144;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerpLon(a, b) { return a + (b - a); } // lonは常に連続範囲で扱う(この地図ではwrap無し)

  // ズーム範囲: 世界全体の28%表示(最小) 〜 z19タイル密度相当(最大)
  // 最大k: 必要px/度 = k*F0*π/180 の1.35倍が 256*2^19/360 を超えない値
  const MAX_K = 1.85e7;
  const MIN_K_RATIO = 0.28;

  class EESlippy {
    /**
     * @param pane 地図パネル要素(.leaflet-container等)
     * @param overlay EEOverlay
     * @param templateFn () => string|null  タイルURLテンプレート
     *   e.g. https://tile.openstreetmap.org/{z}/{x}/{y}.png
     */
    constructor(pane, overlay, templateFn, opts) {
      this.pane = pane;
      this.ov = overlay;
      this.templateFn = templateFn || (() => null);
      opts = opts || {};
      // サーバーごとの上限z (GSI標準地図はz18まで。OSMはz19)
      this._maxZ = opts.maxZoom || 19;
      this._dead = false;
      this._view = { xc: 0, yc: 0, k: 100 };
      this._cov = null;        // 現在テクスチャのカバー {z,lonL,lonR,rowT,rowB}
      this._mosaic = null;
      this._seq = 0;
      this._busy = false;
      this._ensureT = null;
      this._lastEnsure = 0;
      this._cache = new Map(); // "z/x/y" -> Promise<bitmap>
      this._down = null;
      this._capK = Infinity;   // タイル取得不能時の表示ズーム上限(シャープ保証用)
      this._tplIx = 0; this._tplRot = 0; this._tplListCached = null;
    }

    /* ---------- 公開操作 ---------- */
    attach() {
      if (this._started) return;
      this._started = true;
      // データ未取得領域は黒くせず海色で表示(ズームアウト等で真っ黒に見えないように)
      this.ov._bg = [170, 211, 223];
      this._resize();
      this._fitWorld();
      this.ov.setEnabled(true);
      this.ov.setVisible(true);

      // ポインタ/ホイール
      const opts = { passive: true };
      this._pd = (e) => {
        if (!this.ov.enabled || e.button !== 0) return;
        this._down = { x: e.clientX, y: e.clientY, xc: this._view.xc, yc: this._view.yc, k: this._view.k };
      };
      this._pm = (e) => {
        if (!this._down) return;
        const k = this._view.k;
        const kk = this._css2canvas();
        const dx = (e.clientX - this._down.x) * kk;
        const dy = (e.clientY - this._down.y) * kk;
        this._setView(this._down.xc - dx / k, this._down.yc + dy / k, this._down.k, false);
      };
      const end = (e) => { if (this._down) { this._down = null; this._scheduleEnsure(80); } };
      this._pu = end; this._pc = end;

      this._wh = (e) => {
        if (!this.ov.enabled) return;
        const kk = this._css2canvas();
        const ax = e.clientX * kk, ay = e.clientY * kk;
        const W = this.ov.canvas.width, H = this.ov.canvas.height;
        const xa = this._view.xc + (ax - W / 2) / this._view.k;
        const ya = this._view.yc - (ay - H / 2) / this._view.k;
        const f = Math.pow(2, -e.deltaY / 140);   // 1ノッチ≈1.6-1.8倍(滑らか)
        const k2 = clamp(this._view.k * f, this._minK() * MIN_K_RATIO, this._cap());
        const kf = k2 / this._view.k;
        let k = this._view.k * kf;
        // アンカー(画面座標)を保ってズーム
        const xc = xa - (ax - W / 2) / k;
        const yc = ya + (ay - H / 2) / k;
        this._setView(xc, yc, k, false);
        this._scheduleEnsure(220);   // 操作停止後にまとめて1回だけ鮮明化(チラつき防止)
      };

      this.pane.addEventListener('pointerdown', this._pd, opts);
      window.addEventListener('pointermove', this._pm, opts);
      window.addEventListener('pointerup', this._pu, opts);
      window.addEventListener('pointercancel', this._pc, opts);
      // サイト側がstopPropagationしても拾えるよう capture phase で受ける
      window.addEventListener('wheel', this._wh, { passive: true, capture: true });

      this._ro = new ResizeObserver(() => { this._resize(); this._fitWorld(); });
      this._ro.observe(this.pane);

      // サイトのズームコントロールはEE地図と独立なので隠す(ピルに+/-がある)
      const zc = this.pane.querySelector('.leaflet-control-zoom');
      if (zc) { this._zoomCtl = zc; this._zoomCtlPrev = zc.style.visibility; zc.style.visibility = 'hidden'; }
    }

    /** 世界全体表示に戻す */
    resetWorld() {
      this._fitWorld();
      this._scheduleEnsure(60);
    }

    /** ズーム (factor>1で拡大) */
    zoomBy(factor) {
      const k = clamp(this._view.k * factor, this._minK() * MIN_K_RATIO, this._cap());
      // 画面中央アンカー
      const xa = this._view.xc;
      const ya = this._view.yc;
      const xc = xa;
      const yc = ya;
      this._setView(xc, yc, k, false);
      this._scheduleEnsure(60);
    }

    detach() {
      this._dead = true;
      this._started = false;
      const opts = { passive: true };
      if (this._zoomCtl) { this._zoomCtl.style.visibility = this._zoomCtlPrev || ''; this._zoomCtl = null; }
      this.pane.removeEventListener('pointerdown', this._pd, opts);
      window.removeEventListener('pointermove', this._pm, opts);
      window.removeEventListener('pointerup', this._pu, opts);
      window.removeEventListener('pointercancel', this._pc, opts);
      window.removeEventListener('wheel', this._wh, { capture: true });
      if (this._ro) this._ro.disconnect();
      clearTimeout(this._ensureT);
    }

    /* ---------- 内部 ---------- */
    _css2canvas() {
      const r = this.pane.getBoundingClientRect();
      return r.width > 0 ? this.ov.canvas.width / r.width : 1;
    }

    _minK() {
      const W = this.ov.canvas.width, H = this.ov.canvas.height;
      // 世界全体が収まる最小
      return Math.min(W / (2 * X_HALF), H / (2 * Y_HALF));
    }

    /** ズームzのタイルをオーバーサンプル1.9倍で表示できる最大k */
    _kMaxForZ(z) {
      const ppd = (256 * Math.pow(2, z)) / 360;
      return ppd / (1.9 * F0 * D2R);
    }

    /** このサーバーで許されるズーム上限 */
    _effMaxZ() { return Math.min(MAX_Z, this._maxZ); }

    /** このサーバーのタイル上限から決まる表示kの上限 */
    _maxKCeil() {
      return Math.min(MAX_K, this._kMaxForZ(this._effMaxZ()));
    }

    /** 現在有効な表示ズーム上限 */
    _cap() {
      const c = this._capK == null ? Infinity : this._capK;
      return Math.max(this._minK() * MIN_K_RATIO, Math.min(this._maxKCeil(), c));
    }

    _resize() {
      this.ov.layout();
    }

    _fitWorld() {
      const k = this._minK();
      this._setView(0, 0, k, true);
      this._scheduleEnsure(50);
    }

    _clampView(v) {
      const W = this.ov.canvas.width, H = this.ov.canvas.height;
      const halfX = W / (2 * v.k), halfY = H / (2 * v.k);
      let xc = v.xc, yc = v.yc;
      if (halfX >= X_HALF) xc = 0; else xc = clamp(xc, -(X_HALF - halfX), X_HALF - halfX);
      if (halfY >= Y_HALF) yc = 0; else yc = clamp(yc, -(Y_HALF - halfY), Y_HALF - halfY);
      return { xc, yc, k: v.k };
    }

    _setView(xc, yc, k, force) {
      if (this._dead) return;
      // タイル取得不能時は取得済み解像度で表示できる上限までで止める(シャープ保証)
      const kk = clamp(k, this._minK() * MIN_K_RATIO, this._cap());
      const v = this._clampView({ xc, yc, k: kk });
      const cur = this._view;
      const moved = Math.abs(v.xc - cur.xc) > 1e-9 || Math.abs(v.yc - cur.yc) > 1e-9 || Math.abs(v.k - cur.k) > 1e-9;
      if (!moved && !force) return;
      this._view = v;
      this.ov.setRawView(v.xc, v.yc, v.k);
    }

    /** 指定スケールkで必要となる地理窓(余白付き)を返す */
    _needGeoAt(kk) {
      const W = this.ov.canvas.width, H = this.ov.canvas.height;
      const v = this._view, m = 1.15;
      const xLr = v.xc - (W * m) / (2 * kk), xRr = v.xc + (W * m) / (2 * kk);
      const yTr = v.yc + (H * m) / (2 * kk), yBr = v.yc - (H * m) / (2 * kk);
      const corners = [
        [xLr, yTr], [xRr, yTr], [xLr, yBr], [xRr, yBr]
      ].map(([x, y]) => EE.unproject(clamp(x, -X_HALF, X_HALF), clamp(y, -Y_HALF, Y_HALF)));
      let lonL = Infinity, lonR = -Infinity, latT = -Infinity, latB = Infinity;
      for (const c of corners) {
        lonL = Math.min(lonL, c.lonDeg); lonR = Math.max(lonR, c.lonDeg);
        latT = Math.max(latT, c.latDeg); latB = Math.min(latB, c.latDeg);
      }
      lonL = clamp(lonL, -180, 180); lonR = clamp(lonR, -180, 180);
      latT = clamp(latT, -EE.MAX_LAT, EE.MAX_LAT);
      latB = clamp(latB, -EE.MAX_LAT, EE.MAX_LAT);
      const rowT = EE.rowFrac(latT), rowB = EE.rowFrac(latB);
      return { lonL, lonR, rowT, rowB };
    }

    _needGeo() { return this._needGeoAt(this._view.k); }

    /** 指定スケールkに対するソースz。1.9倍オーバーサンプル */
    _needZForK(kk) {
      const eqPxPerDeg = kk * F0 * D2R;
      const ppd = eqPxPerDeg * 1.9;
      let z = Math.ceil(Math.log2(Math.max(0.5, ppd * 360 / 256)));
      return clamp(z, 0, this._effMaxZ());
    }

    /** 必要なソースズーム(z)。1.9倍オーバーサンプルで拡大時もシャープに */
    _needZ() {
      return this._needZForK(this._view.k);
    }

    /** 次のズーム段階のタイルを先読みしてキャッシュを温める(表示は変えない) */
    _prefetchNext() {
      if (this._dead || !this.ov.enabled || this._prefetchT) return;
      this._prefetchT = setTimeout(async () => {
        this._prefetchT = null;
        if (this._dead || !this.ov.enabled) return;
        const cov = this._cov;
        // ズームイン方向の先読み
        const kNext = this._view.k * 1.8;
        if (cov && kNext <= this._cap()) {
          const zNext = this._needZForK(kNext);
          if (zNext > cov.z) {
            const need = this._needGeoAt(kNext);
            const n = Math.pow(2, zNext);
            const x0 = Math.max(0, Math.floor(((need.lonL + 180) / 360) * n));
            const x1 = Math.min(n - 1, Math.ceil(((need.lonR + 180) / 360) * n) - 1);
            const y0 = Math.max(0, Math.floor(need.rowT * n));
            const y1 = Math.min(n - 1, Math.ceil(need.rowB * n) - 1);
            const count = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
            if (count > 0 && count <= 260) {
              const list = [];
              for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) list.push([tx, ty]);
              for (let i = 0; i < list.length; i += 8) {
                if (this._dead) return;
                await Promise.allSettled(list.slice(i, i + 8).map(([tx, ty]) => this._getTile(zNext, tx, ty)));
              }
            }
          }
        }
        // ズームアウト方向も先読み: 1段ズームアウト時に要る(広い)範囲のタイルを温める
        try {
          const kOut = this._view.k / 1.8;
          if (cov && kOut >= this._minK() * MIN_K_RATIO) {
            const zOut = cov.z - 1;
            if (zOut >= 0) {
              const needOut = this._needGeoAt(kOut);
              const n2 = Math.pow(2, zOut);
              const ox0 = Math.max(0, Math.floor(((needOut.lonL + 180) / 360) * n2));
              const ox1 = Math.min(n2 - 1, Math.ceil(((needOut.lonR + 180) / 360) * n2) - 1);
              const oy0 = Math.max(0, Math.floor(needOut.rowT * n2));
              const oy1 = Math.min(n2 - 1, Math.ceil(needOut.rowB * n2) - 1);
              const oc = Math.max(0, ox1 - ox0 + 1) * Math.max(0, oy1 - oy0 + 1);
              if (oc > 0 && oc <= 90) {
                const ol = [];
                for (let ty = oy0; ty <= oy1; ty++) for (let tx = ox0; tx <= ox1; tx++) ol.push([tx, ty]);
                for (let i = 0; i < ol.length; i += 8) {
                  if (this._dead) return;
                  await Promise.allSettled(ol.slice(i, i + 8).map(([tx, ty]) => this._getTile(zOut, tx, ty)));
                }
              }
            }
          }
        } catch (e) { /* 先読み失敗は無視 */ }
      }, 180);
    }

    _scheduleEnsure(delay) {
      if (this._dead) return;
      clearTimeout(this._ensureT);
      const now = Date.now();
      const wait = Math.max(0, delay - (now - this._lastEnsure));
      this._ensureT = setTimeout(() => { if (!this._dead && this.ov.enabled) this.ensureSource(); }, wait);
    }

    /** ズーム中も高頻度でタイル更新を走らせる(ぼやけ時間を短縮) */
    _ensureSoon() {
      if (this._dead) return;
      const now = Date.now();
      if (now - this._lastEnsure > 350) this.ensureSource();
      else this._scheduleEnsure(60);
    }

    /** contentからの互換呼び出し */
    schedule(delay) { this._scheduleEnsure(delay || 80); }

    ensureSource() {
      if (this._dead || !this.ov.enabled) return;
      if (this._busy) { this._scheduleEnsure(150); return; } // 取得中は後で再評価
      this._lastEnsure = Date.now();
      const need = this._needGeo();
      const z = this._needZ();

      const cov = this._cov;
      const covEnough = cov && cov.z === z &&
        cov.lonL <= need.lonL && cov.lonR >= need.lonR &&
        cov.rowT <= need.rowT && cov.rowB >= need.rowB;
      // 一部タイル失敗時は再試行期限後にもう一度取得する
      const retryDue = this._retryUntil && Date.now() > this._retryUntil;
      if (covEnough && !retryDue) { this._prefetchNext(); return; }
      if (retryDue) this._retryUntil = 0;

      // ズームアウトで広い範囲が必要なときは、まず枚数が少ない粗いタイルで
      // 全画面を即復帰させ、直後のensureで精細化する(表示が戻るまでの待ちを解消)
      if (cov && z < cov.z && (cov.z - z) >= 2) {
        const zQuick = this._pickQuickZ(need, z);
        if (zQuick >= 0 && zQuick !== z) {
          this._fetchRegion(zQuick, need, true);   // early=true: 最初の数枚から即表示
          return;
        }
      }

      this._fetchRegion(z, need);
    }

    /** need窓をzで覆うのに必要なタイル枚数 */
    _countTiles(need, zz) {
      const n = Math.pow(2, zz);
      const x0 = Math.max(0, Math.floor(((need.lonL + 180) / 360) * n));
      const x1 = Math.min(n - 1, Math.ceil(((need.lonR + 180) / 360) * n) - 1);
      const y0 = Math.max(0, Math.floor(need.rowT * n));
      const y1 = Math.min(n - 1, Math.ceil(need.rowB * n) - 1);
      return Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
    }

    /** 粗い即復帰用ズーム: 枚数≦48でできるだけ細かいz */
    _pickQuickZ(need, targetZ) {
      for (let zq = targetZ; zq >= 0; zq--) {
        const c = this._countTiles(need, zq);
        if (c > 0 && c <= 48) return zq;
      }
      return -1;
    }

    _tileUrl(z, x, y) {
      const t = this._tplCandidates();
      const tpl = t && t[this._tplIx];
      if (!tpl) return null;
      return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }

    /** タイル候補一覧(string|配列|null)。取得失敗時に自動で次へ切替 */
    _tplCandidates() {
      if (this._tplListCached) return this._tplListCached;
      let v = typeof this.templateFn === 'function' ? this.templateFn() : this.templateFn;
      let list;
      if (v == null) list = [];
      else if (Array.isArray(v)) list = v.filter(Boolean);
      else list = [v];
      this._tplListCached = list;
      this._tplIx = Math.min(this._tplIx || 0, Math.max(0, list.length - 1));
      return list;
    }

    /** 失敗時にタイル候補を次へ。一周したらfalse */
    _rotateTpl() {
      const list = this._tplCandidates();
      if (list.length <= 1) return false;
      this._tplRot = (this._tplRot || 0) + 1;
      if (this._tplRot >= list.length) { this._tplRot = 0; return false; }
      this._tplIx = (this._tplIx + 1) % list.length;
      return true;
    }

    _getTile(z, x, y) {
      const tplIx = this._tplIx || 0;
      const key = tplIx + '/' + z + '/' + x + '/' + y;
      let p = this._cache.get(key);
      if (p) return p;
      const url = this._tileUrl(z, x, y);
      if (!url) return Promise.resolve(null);
      p = root.EESources.fetchTileBitmap(url).catch((err) => { this._lastErr = String(err && err.message || err); return null; });
      this._cache.set(key, p);
      if (this._cache.size > 900) {
        // 低ズーム(世界〜大陸)タイルは保護: ズームアウトで再取得しないよう消さない
        let removed = 0;
        for (const k of this._cache.keys()) {
          if (removed >= 60) break;
          const zz = parseInt(k.split('/')[1], 10);
          if (!isNaN(zz) && zz <= 6) continue;
          this._cache.delete(k);
          removed++;
        }
      }
      return p;
    }

    async _fetchRegion(z, need, earlyPublish) {
      const seq = ++this._seq;
      this._busy = true;
      // 万一タイル取得がハングしてもbusyで固まらないようウォッチドッグ
      const wd = setTimeout(() => {
        if (this._busy) { this._busy = false; this._scheduleEnsure(200); }
      }, 25000);
      this._dbg = { z: z, list: 0, seqMiss: 0, nullBmp: 0, drawErr: 0, success: 0 };
      try {
        // タイルURLテンプレートがまだ推定できない(タイル未ロード)場合はリトライ
        if (!this._tileUrl(z, 0, 0)) {
          if (this._cov === null) {
            this._tplListCached = null;   // 再評価できるようにキャッシュ破棄
            this._scheduleEnsure(700);
          }
          return;
        }
        // テクスチャ上限へ縮小
        let ppd = (256 * Math.pow(2, z)) / 360;
        const rowSpanPx = (need.rowB - need.rowT) * 256 * Math.pow(2, z);
        const lonSpanPx = (need.lonR - need.lonL) * ppd;
        while ((lonSpanPx > TEX_CAP || rowSpanPx > TEX_CAP) && z > 0) {
          z--; ppd /= 2;
          const rowSpanPx2 = (need.rowB - need.rowT) * 256 * Math.pow(2, z);
          const lonSpanPx2 = (need.lonR - need.lonL) * ppd;
          if (lonSpanPx2 > TEX_CAP || rowSpanPx2 > TEX_CAP) continue;
          break;
        }
        ppd = (256 * Math.pow(2, z)) / 360;

        const Wm = Math.max(16, Math.ceil((need.lonR - need.lonL) * ppd));
        const Hm = Math.max(16, Math.ceil((need.rowB - need.rowT) * 256 * Math.pow(2, z)));
        const n = Math.pow(2, z);
        const x0 = Math.max(0, Math.floor(((need.lonL + 180) / 360) * n));
        const x1 = Math.min(n - 1, Math.ceil(((need.lonR + 180) / 360) * n) - 1);
        const y0 = Math.max(0, Math.floor(need.rowT * n));
        const y1 = Math.min(n - 1, Math.ceil(need.rowB * n) - 1);

        if (!this._mosaic) this._mosaic = document.createElement('canvas');
        this._mosaic.width = Wm; this._mosaic.height = Hm;
        const ctx = this._mosaic.getContext('2d');
        // 海色で敷き詰め(データ欠落領域を黒にしない)
        ctx.fillStyle = '#aad3df';
        ctx.fillRect(0, 0, Wm, Hm);
        // 前フレーム(より低ズーム)の内容を引き継いでシード: 空白フラッシュ=チラつきを防ぐ
        if (this._prev && this._prev.canvas && this._prev.z < z) {
          const p = this._prev;
          const ilo = Math.max(need.lonL, p.lonL), ihi = Math.min(need.lonR, p.lonR);
          const it = Math.max(need.rowT, p.rowT), ib = Math.min(need.rowB, p.rowB);
          if (ihi > ilo && ib > it) {
            const ox = (ilo - p.lonL) / (p.lonR - p.lonL) * p.w;
            const ow = (ihi - ilo) / (p.lonR - p.lonL) * p.w;
            const oy = (it - p.rowT) / (p.rowB - p.rowT) * p.h;
            const oh = (ib - it) / (p.rowB - p.rowT) * p.h;
            const dx = (ilo - need.lonL) / (need.lonR - need.lonL) * Wm;
            const dw = (ihi - ilo) / (need.lonR - need.lonL) * Wm;
            const dy = (it - need.rowT) / (need.rowB - need.rowT) * Hm;
            const dh = (ib - it) / (need.rowB - need.rowT) * Hm;
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(p.canvas, ox, oy, ow, oh, dx, dy, dw, dh);
          }
        }
        // 高解像タイルで上書きされるので、次フレームのシード用に複製保持は最後に行う
        if (this._dbg) {
          this._dbg.zFinal = z; this._dbg.lonL = need.lonL; this._dbg.lonR = need.lonR;
          this._dbg.rowT = need.rowT; this._dbg.rowB = need.rowB;
          this._dbg.k = this._view.k; this._dbg.xc = this._view.xc;
        }

        // タイル取得・描画(並行8本)。取得できた分から順次アップロード=プログレッシブ表示
        const list = [];
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) list.push([tx, ty]);
        }
        const publish = () => {
          if (this._seq !== seq || this._dead) return;
          this._cov = { z, lonL: need.lonL, lonR: need.lonR, rowT: need.rowT, rowB: need.rowB };
          this.ov.setSourceCanvas(this._mosaic, { x: 0, y: 0, w: Wm, h: Hm });
          this.ov.setSourceBox({ lonL: need.lonL, lonR: need.lonR, rowTop: need.rowT, rowBot: need.rowB });
          this.ov.setRawView(this._view.xc, this._view.yc, this._view.k);
        };
        const drawOne = async ([tx, ty]) => {
          if (this._dbg) this._dbg.list++;
          if (this._seq !== seq || this._dead) { if (this._dbg) this._dbg.seqMiss++; return false; }
          try {
            const bmp = await this._getTile(z, tx, ty);
            if (bmp) {
              const lon0 = -180 + (tx / n) * 360;
              const row0 = ty / n;
              const dx = Math.round((lon0 - need.lonL) * ppd);
              const dy = Math.round((row0 - need.rowT) * 256 * n);
              ctx.drawImage(bmp, dx, dy);
              if (this._dbg) this._dbg.success++;
              return true;
            }
            // そのズームに無い(404等)場合は親ズームのタイルを切り出して埋める
            for (let dz = 1; dz <= Math.min(7, z); dz++) {
              const pz = z - dz, ptx = tx >> dz, pty = ty >> dz;
              const pb = await this._getTile(pz, ptx, pty);
              if (!pb) continue;
              const steps = 1 << dz;
              const fx = (tx - ptx * steps) / steps;
              const fy = (ty - pty * steps) / steps;
              const lon0 = -180 + (tx / n) * 360;
              const row0 = ty / n;
              const dx = Math.round((lon0 - need.lonL) * ppd);
              const dy = Math.round((row0 - need.rowT) * 256 * n);
              const ss = Math.max(1, Math.round(256 / steps));
              ctx.drawImage(pb,
                Math.round(fx * 256), Math.round(fy * 256), ss, ss,
                dx, dy, 256, 256);
              if (this._dbg) this._dbg.success++;
              return true;
            }
            if (this._dbg) this._dbg.nullBmp++;
            return false;
          } catch (e) { if (this._dbg) this._dbg.drawErr++; return false; }
        };
        let batchWait = 0;
        let success = 0;
        let lastPub = 0;
        for (let i = 0; i < list.length; i += 8) {
          if (this._seq !== seq || this._dead) return;
          if (batchWait) await new Promise(r => setTimeout(r, batchWait));
          const batch = await Promise.all(list.slice(i, i + 8).map(drawOne));
          success += batch.filter(Boolean).length;
          batchWait = 3;
          // ズームアウト復帰(空画面状態)だけは最初の数枚から途中表示する
          if (earlyPublish && success >= 3) {
            const now = performance.now();
            if (now - lastPub > 120) { publish(); lastPub = now; }
          }
        }
        if (this._seq !== seq || this._dead) return;
        publish();   // 1回のズーム=1回の切り替え(チラつき防止)

        // 全部失敗: 別のタイル候補(レイヤー)を試す。全部試したら
        // 現状の(鮮明な)フレームを維持し、拡大を取得済み解像度までに制限
        if (list.length && success === 0 && this._cov) {
          if (this._rotateTpl()) {
            this._retryUntil = 0;
            this._scheduleEnsure(300);
            return;
          }
          this._capK = this._kMaxForZ(this._cov.z);
          this._setView(this._view.xc, this._view.yc, this._view.k, false);
          this._retryUntil = Date.now() + 1500;
          this._scheduleEnsure(1500);
          return;
        }
        if (list.length && success < list.length) {
          // 一部失敗: 得られた分は表示しつつ後で再試行
          this._retryUntil = Date.now() + 900;
        } else {
          this._retryUntil = 0;
          this._capK = Infinity;   // 必要な解像度が揃ったので上限解除
          this._tplRot = 0;
          this._lastErr = '';
        }
        // 次のズーム段階のシード用に、完成モザイクを複製保持(巨大過ぎる場合は省略)
        try {
          if (Wm * Hm <= 40e6) {
            const c = document.createElement('canvas');
            c.width = Wm; c.height = Hm;
            c.getContext('2d').drawImage(this._mosaic, 0, 0);
            this._prev = { canvas: c, z: z, lonL: need.lonL, lonR: need.lonR, rowT: need.rowT, rowB: need.rowB, w: Wm, h: Hm };
          } else { this._prev = null; }
        } catch (e) { this._prev = null; }
      } finally {
        clearTimeout(wd);
        this._busy = false;
        // 取得中にさらにズーム/パンが進んだ場合のため再評価
        if (!this._dead && this.ov.enabled) this._scheduleEnsure(90);
      }
    }
  }

  /** ページ内のLeafletタイルURLから {z}/{x}/{y} テンプレートを推定 */
  function inferTemplate(pane) {
    const el = pane.querySelector('img.leaflet-tile');
    if (!el || !el.currentSrc) return null;
    const src = el.currentSrc.split('?')[0];
    const m = src.match(/\/(\d+)\/(\d+)\/(\d+)(?:@\d+x)?(\.[a-z0-9]+)?$/i);
    if (!m) return null;
    // {z}/{x}/{y} 形式のみ(クエリ付き動的タイルは対象外)
    return src.replace(/\/\d+\/\d+\/\d+(?:@\d+x)?(\.[a-z0-9]+)?$/i, '/{z}/{x}/{y}$1');
  }

  root.EESlippy = EESlippy;
  root.EESlippyInfer = inferTemplate;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EESlippy, inferTemplate };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
