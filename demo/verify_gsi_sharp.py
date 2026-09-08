# -*- coding: utf-8 -*-
"""GSI深ズームの精細度: 実描画 vs モザイク直接描画(参照)"""
import time, json
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:8099/demo/test-ee-gsi.html"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width":1400,"height":900})
    pg.goto(URL, wait_until="load")
    for _ in range(80):
        time.sleep(0.25)
        if pg.evaluate("() => { const s=window.__slip; return s && s._cov && !s._busy; }"): break
    pg.evaluate("""(() => {
      const s=window.__slip;
      const p0=window.EEMath.project(139.76, 35.70);   // 東京23区内
      s._setView(p0.x, p0.y, 1.5e5, true);
    })()""")
    time.sleep(3)
    # さらに深く(最大近く)へ
    for _ in range(6):
        pg.mouse.wheel(0,-120); time.sleep(0.06)
    # settle
    for _ in range(40):
        time.sleep(0.25)
        if pg.evaluate("() => { const s=window.__slip; return !s._busy; }"): break
    time.sleep(1.5)
    info = pg.evaluate("""(() => {
      const s=window.__slip, ov=window.__ov;
      const cov=s._cov; if(!cov) return null;
      const m=s._mosaic;
      // モザイク中の「今見えている窓」を計算
      const W=ov.canvas.width, H=ov.canvas.height, k=s._view.k;
      const xL= s._view.xc - W/(2*k), xR= s._view.xc + W/(2*k);
      const yT= s._view.yc + H/(2*k), yB= s._view.yc - H/(2*k);
      const UL=window.EEMath.unproject(xL,yT), UR=window.EEMath.unproject(xR,yT),
            LL=window.EEMath.unproject(xL,yB), LR=window.EEMath.unproject(xR,yB);
      const lonL=Math.min(UL.lonDeg,LL.lonDeg), lonR=Math.max(UR.lonDeg,LR.lonDeg);
      const latT=Math.max(UL.latDeg,UR.latDeg), latB=Math.min(LL.latDeg,LR.latDeg);
      const rT=window.EEMath.rowFrac(latT), rB=window.EEMath.rowFrac(latB);
      const mx=(lonL-cov.lonL)/(cov.lonR-cov.lonL)*m.width;
      const mw=(lonR-lonL)/(cov.lonR-cov.lonL)*m.width;
      const my=(rT-cov.rowT)/(cov.rowB-cov.rowT)*m.height;
      const mh=(rB-rT)/(cov.rowB-cov.rowT)*m.height;
      // 参照canvas: モザイクの同窓を画面サイズへ直接拡大描画
      const ref=document.createElement('canvas'); ref.width=W; ref.height=H;
      ref.getContext('2d').drawImage(m, mx,my,mw,mh, 0,0,W,H);
      window.__refCanvas=ref;
      return {k:+k.toFixed(0), covZ:cov.z, mx:+mx.toFixed(0), my:+my.toFixed(0), mw:+mw.toFixed(0), mh:+mh.toFixed(0),
              W:H||0, mW:m.width, mH:m.height, dpr: window.devicePixelRatio||1};
    })()""")
    print("info", json.dumps(info, ensure_ascii=False))
    rect = pg.evaluate("() => { const r=window.__ov.canvas.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
    # 参照を画面左上に配置してlive非表示→参照撮影→live表示→実撮影
    pg.evaluate("""(() => {
      const ref=window.__refCanvas;
      ref.style.position='absolute'; ref.style.left='0px'; ref.style.top='0px'; ref.style.zIndex='5000';
      document.body.appendChild(ref);
      window.__ov.canvas.style.display='none';
    })()""")
    time.sleep(0.4)
    pg.screenshot(path="gsi_blur_ref.png", clip={"x":rect["x"],"y":rect["y"],"width":rect["w"],"height":rect["h"]})
    pg.evaluate("window.__ov.canvas.style.display='block'; window.__refCanvas.style.zIndex='-1';")
    time.sleep(0.5)
    pg.screenshot(path="gsi_blur_live.png", clip={"x":rect["x"],"y":rect["y"],"width":rect["w"],"height":rect["h"]})
    b.close()

import numpy as np
from PIL import Image
def lap(path):
    a = np.asarray(Image.open(path).convert("L"), dtype=float)
    gx = np.abs(np.diff(a, axis=1)); gy = np.abs(np.diff(a, axis=0))
    return float((gx.mean()+gy.mean()))
lv, rf = lap("gsi_blur_live.png"), lap("gsi_blur_ref.png")
print("live lap=%.2f ref lap=%.2f ratio=%.2f" % (lv, rf, lv/max(rf,1e-9)))
print("BLUR_CHECK", "OK(crisp)" if lv/max(rf,1e-9) > 0.55 else "NG(blurry vs reference)")
