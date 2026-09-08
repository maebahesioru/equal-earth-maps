/* ============================================================
 * EEOverlay — WebGLによるイコールアース投影オーバーレイ
 * 地図パネル要素(container)に絶対配置キャンバスを重ねる。
 * ソース画像(メルカトル描画結果)をテクスチャに持ち、
 * 表示窓(lonL..lonR / latBot..latTop)をイコールアースで描く。
 * container 直下に置くため container は position:relative 前提。
 * ============================================================ */
(function (root) {
  'use strict';
  const EE = root.EEMath;
  const SH = (typeof module !== 'undefined' && module.exports)
    ? require('./glsl.js')
    : root.EEShaders;

  const BG = [10, 14, 20, 255]; // レターボックス背景 (暗色)

  class EEOverlay {
    /**
     * @param {HTMLElement} container 地図パネル要素
     * @param {object} opts
     *   maxDim: キャンバス長辺の上限(デバイスpx) default 4096
     *   scale: 解像度スケール default devicePixelRatio (cap maxDim)
     */
    constructor(container, opts) {
      opts = opts || {};
      this.container = container;
      this.maxDim = opts.maxDim || 6144;
      this.enabled = false;
      this._tex = null;
      this._params = null;   // 直前の描画パラメータ
      this._hasSource = false;
      this._init();
    }

    _init() {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      const st = canvas.style;
      if (this._isDocEl()) {
        st.position = 'fixed';
        st.left = '0'; st.top = '0';
        st.width = '100vw'; st.height = '100vh';
      } else {
        const cs = getComputedStyle(this.container);
        if (cs.position === 'static') {
          this._hadStatic = true;
          this.container.style.position = 'relative';
        }
        st.position = 'absolute';
        st.left = '0'; st.top = '0';
        st.width = '100%'; st.height = '100%';
      }
      st.zIndex = '900';
      st.pointerEvents = 'none';
      st.display = 'none';
      this.canvas = canvas;
      this.container.appendChild(canvas);

      const gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false, alpha: true, premultipliedAlpha: false });
      if (!gl) { this._err('WebGLを利用できません'); return; }
      this.gl = gl;
      this._bg = BG.slice();   // 背景色(スリッピーは海色に差し替え可能)
      // 注意: FLIP_Yは使わない。ソース(上原点画像)はそのままアップロードされ、
      // uv.y = (regionY + sy)/texH (v=0=画像上端) でサンプルする。

      const prog = gl.createProgram();
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, SH.EE_VERT); gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) { this._err('VS: ' + gl.getShaderInfoLog(vs)); return; }
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, SH.EE_FRAG); gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) { this._err('FS: ' + gl.getShaderInfoLog(fs)); return; }
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this._err('LINK: ' + gl.getProgramInfoLog(prog)); return; }
      gl.useProgram(prog);
      this.prog = prog;

      // フルスクリーンクアッド
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this.u = {};
      for (const n of ['uTex', 'uTexRegion', 'uTexSize', 'uCanvasSize', 'uDrawRect', 'uPan', 'uZoomAnchor', 'uZoomScale', 'uEEBox', 'uWinLon', 'uRowRange', 'uSrcBox', 'uMaxLat']) {
        this.u[n] = gl.getUniformLocation(prog, n);
      }
      this._ok = true;
    }

    _err(msg) { console.warn('[EEOverlay]', msg); }

    get ready() { return !!this._ok; }

    /** containerのクライアントサイズ → キャンバス実サイズ反映 */
    _isDocEl() {
      return this.container === document.body || this.container === document.documentElement;
    }

    layout() {
      if (!this.ready) return;
      const rect = this.container.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let w = Math.max(2, Math.round(rect.width * dpr));
      let h = Math.max(2, Math.round(rect.height * dpr));
      const m = Math.max(w, h);
      if (m > this.maxDim) { const s = this.maxDim / m; w = Math.round(w * s); h = Math.round(h * s); }
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this._scale = this.canvas.width / rect.width; // css px → canvas px
    }

    setEnabled(on) {
      this.enabled = !!on;
      this._applyVisible();
      if (on && this._ok) this.render();
    }

    /** 表示/非表示(操作中は元のメルカトル地図を見せるため) */
    setVisible(v) {
      this._visible = !!v;
      this._applyVisible();
      if (this._visible && this._ok) this.render();
    }

    _applyVisible() {
      if (!this.canvas) return;
      this.canvas.style.display = (this._ok && this.enabled && this._visible !== false) ? 'block' : 'none';
    }

    /** ジェスチャ追従 (canvasデバイスpx)。render時に反映され再構築後に resetGesture する */
    setGesture(pan, zoomScale, zoomAnchor) {
      if (!this._ok) return;
      this._pan = pan || { x: 0, y: 0 };
      this._zoomScale = (zoomScale && zoomScale > 1) ? zoomScale : 1;
      this._zoomAnchor = zoomAnchor || { x: this.canvas.width / 2, y: this.canvas.height / 2 };
      if (this.enabled) this.render();
    }

    resetGesture() {
      this._pan = { x: 0, y: 0 };
      this._zoomScale = 1;
    }

    /** ソースをCanvas(モザイク等)から設定。canvasはパネルと同領域・同スケール。 */
    setSourceCanvas(srcCanvas, regionPx) {
      if (!this.ready) return false;
      const gl = this.gl;
      if (this._tex) gl.deleteTexture(this._tex);
      this._tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._texW = srcCanvas.width; this._texH = srcCanvas.height;
      // region: パネル領域 (canvas px)。nullなら全体。
      this._region = regionPx || { x: 0, y: 0, w: srcCanvas.width, h: srcCanvas.height };
      this._hasSource = true;
      return true;
    }

    /** ソースをHTMLImageから設定 (キャプチャ画像)。regionPxは画像px内のパネル矩形 */
    setSourceImage(img, regionPx) {
      if (!this.ready) return false;
      const gl = this.gl;
      if (this._tex) gl.deleteTexture(this._tex);
      this._tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._texW = img.naturalWidth || img.width;
      this._texH = img.naturalHeight || img.height;
      this._region = regionPx || { x: 0, y: 0, w: this._texW, h: this._texH };
      this._hasSource = true;
      return true;
    }

    /**
     * 表示窓とソースの対応を更新
     * @param {object} win
     *   lonL, lonR 度 (unwrapped連続。窓が±180を跨ぐ場合はそのまま)
     *   latTop, latBot 度 (mercator表示上限±85.05112878へ自動クランプ)
     */
    setWindow(win) {
      if (!this._ok) return;
      const lt = Math.min(win.latTop, EE.MAX_LAT);
      const lb = Math.max(win.latBot, -EE.MAX_LAT);
      this._win = { lonL: win.lonL, lonR: win.lonR, latTop: lt, latBot: lb };
      this._viewRaw = null;
      this._srcBox = null;   // ソース=窓(従来挙動)
    }

    /**
     * スリッピー(自己駆動)ビュー: EE生座標の中心(xc,yc)と px/生単位 k で画面を張る。
     * このモードでは画面全体がEE平面(レターボックス無し・欠けた部分は背景)になる。
     */
    setRawView(xc, yc, k) {
      if (!this._ok) return;
      this._viewRaw = { xc, yc, k: Math.max(1e-6, k) };
      if (this.enabled) this.render();
    }

    /** スリッピー: ソース(タイルモザイク)が覆う範囲を指定 (lonL,rowTop,lonR,rowBot) */
    setSourceBox(box) {
      if (!this._ok) return;
      this._srcBox = { lonL: box.lonL, lonR: box.lonR, rowTop: box.rowTop, rowBot: box.rowBot };
      if (this.enabled) this.render();
    }

    /** 描画 (パラメータ更新込み)。enabled時のみ */
    render() {
      if (!this._ok || !this.enabled || !this._hasSource) return;
      if (!this._win && !this._viewRaw) return;
      const gl = this.gl;
      const W = this.canvas.width, H = this.canvas.height;
      gl.viewport(0, 0, W, H);
      const bg = this._bg || BG;
      gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, bg[3] / 255);
      gl.clear(gl.COLOR_BUFFER_BIT);

      let vLonL, vLonR, vRowTop, vRowBot;
      let dx, dy, dw, dh, x0, x1, y0, y1;

      if (this._viewRaw) {
        // --- スリッピー: 画面全体=EE平面 ---
        const v = this._viewRaw;
        const k = v.k;
        x0 = v.xc - W / (2 * k); x1 = v.xc + W / (2 * k);
        y0 = v.yc - H / (2 * k); y1 = v.yc + H / (2 * k);
        dx = 0; dy = 0; dw = W; dh = H;
        vLonL = -180; vLonR = 180; vRowTop = -0.02; vRowBot = 1.02;
      } else {
        // --- 従来: 地理窓をEEでフィット描画 ---
        const win = this._win;
        vLonL = win.lonL; vLonR = win.lonR;
        vRowTop = EE.rowFrac(win.latTop);
        vRowBot = EE.rowFrac(win.latBot);
        const pL = EE.project(win.lonL, 0), pR = EE.project(win.lonR, 0);
        const pT = EE.project(0, win.latTop), pB = EE.project(0, win.latBot);
        x0 = pL.x; x1 = pR.x; y1 = pT.y; y0 = pB.y;
        const eew = x1 - x0, eeh = y1 - y0;
        const scale = Math.min(W / eew, H / eeh);
        dw = eew * scale; dh = eeh * scale;
        dx = (W - dw) / 2; dy = (H - dh) / 2;
      }

      // ソース範囲: setSourceBoxがあればそれ、無ければ従来どおり窓と同一
      let sL, sR, sT, sB;
      if (this._srcBox) {
        sL = this._srcBox.lonL; sR = this._srcBox.lonR;
        sT = this._srcBox.rowTop; sB = this._srcBox.rowBot;
      } else {
        sL = vLonL; sR = vLonR;
        sT = this._viewRaw ? -0.02 : vRowTop; sB = this._viewRaw ? 1.02 : vRowBot;
      }

      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.uniform1i(this.u.uTex, 0);
      gl.uniform4f(this.u.uTexRegion, this._region.x, this._region.y, this._region.w, this._region.h);
      gl.uniform2f(this.u.uTexSize, this._texW, this._texH);
      gl.uniform2f(this.u.uCanvasSize, W, H);
      gl.uniform2f(this.u.uPan, this._pan ? this._pan.x : 0, this._pan ? this._pan.y : 0);
      gl.uniform2f(this.u.uZoomAnchor, this._zoomAnchor ? this._zoomAnchor.x : W / 2, this._zoomAnchor ? this._zoomAnchor.y : H / 2);
      gl.uniform1f(this.u.uZoomScale, this._zoomScale || 1);
      gl.uniform4f(this.u.uDrawRect, dx, dy, dw, dh);
      gl.uniform4f(this.u.uEEBox, x0, y0, x1, y1);
      gl.uniform2f(this.u.uWinLon, vLonL, vLonR);
      gl.uniform2f(this.u.uRowRange, vRowTop, vRowBot);
      gl.uniform4f(this.u.uSrcBox, sL, sT, sR, sB);
      gl.uniform1f(this.u.uMaxLat, EE.MAX_LAT);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    destroy() {
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      if (this._ok && this._tex) { this.gl.deleteTexture(this._tex); this._tex = null; }
      if (this._hadStatic && this.container) this.container.style.position = '';
    }
  }

  root.EEOverlay = EEOverlay;
  if (typeof module !== 'undefined' && module.exports) module.exports = { EEOverlay: EEOverlay };
})(typeof globalThis !== 'undefined' ? globalThis : this);
