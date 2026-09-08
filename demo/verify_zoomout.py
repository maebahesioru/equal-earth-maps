# -*- coding: utf-8 -*-
"""ズームアウト復帰時間計測(GSI)"""
import time, io
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:8099/demo/test-ee-gsi.html"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width":1400,"height":900})
    pg.goto(URL, wait_until="load")
    for _ in range(80):
        time.sleep(0.25)
        if pg.evaluate("() => { const s=window.__slip; return s && s._cov && !s._busy; }"): break
    # 東京へ deep zoom
    pg.evaluate("() => { const s=window.__slip; const p0=window.EEMath.project(139.76,35.70); s._setView(p0.x,p0.y,3e5,true); }")
    time.sleep(1.5)
    for _ in range(10):
        pg.mouse.wheel(0,-120); time.sleep(0.05)
    # settle deep
    for _ in range(60):
        time.sleep(0.25)
        st = pg.evaluate("() => { const s=window.__slip; return s._busy; }")
        if not st: break
    deep = pg.evaluate("() => { const s=window.__slip; return s._cov ? s._cov.z : null; }")
    print("deep cov z:", deep)
    rect = pg.evaluate("() => { const r=window.__ov.canvas.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
    # 一気にズームアウト12ノッチ
    t0 = time.time()
    for _ in range(12):
        pg.mouse.wheel(0, 120); time.sleep(0.04)
    # 100msごとに「暗い(未復帰)」比率を記録
    dark_hist = []
    while time.time() - t0 < 8:
        shot = pg.screenshot(clip={"x":rect["x"],"y":rect["y"],"width":rect["w"],"height":rect["h"]})
        a = np.asarray(Image.open(io.BytesIO(shot)).convert("RGB"), dtype=int)
        dark = ((a[:,:,0]<45)&(a[:,:,1]<45)&(a[:,:,2]<45)).mean()
        dark_hist.append((round(time.time()-t0,2), round(float(dark)*100,1)))
        if dark < 0.05: break
        time.sleep(0.1)
    print("recover timeline (sec, dark%):", dark_hist[:14])
    b.close()
