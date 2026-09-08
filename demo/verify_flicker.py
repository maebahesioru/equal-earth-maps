# -*- coding: utf-8 -*-
"""ズーム連続フレーム差分 = チラつき計測 (GSI東京)"""
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
    pg.evaluate("""(() => {
      const s=window.__slip;
      const p0=window.EEMath.project(139.76, 35.70);
      s._setView(p0.x, p0.y, 4e5, true);
    })()""")
    time.sleep(2.0)
    # 連続ズームイン6ノッチ
    for _ in range(6):
        pg.mouse.wheel(0,-120); time.sleep(0.05)
    # ズーム後 ~2.5s をフレーム収集(約8fps)
    rect = pg.evaluate("() => { const r=window.__ov.canvas.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
    frames = []
    t_end = time.time() + 2.6
    while time.time() < t_end:
        shot = pg.screenshot(clip={"x":rect["x"],"y":rect["y"],"width":rect["w"],"height":rect["h"]})
        a = np.asarray(Image.open(io.BytesIO(shot)).convert("RGB"), dtype=float)
        frames.append(a)
        time.sleep(0.12)
    b.close()

# 平均フレーム間差分
diffs = [np.abs(frames[i+1]-frames[i]).mean() for i in range(len(frames)-1)]
print("frames=%d  mean interframe diff=%.3f  max=%.3f" % (len(frames), float(np.mean(diffs)), float(np.max(diffs))))
# 画面が青(モザイク空)に戻る回数
blue_rat = []
for a in frames:
    bl = ((np.abs(a[:,:,0]-170)<35)&(np.abs(a[:,:,1]-211)<25)&(np.abs(a[:,:,2]-223)<25)).mean()
    blue_rat.append(float(bl))
print("blue ratio per frame:", [round(x,2) for x in blue_rat])
ok = float(np.mean(diffs)) < 6.0
print("FLICKER_CHECK", "OK(calm)" if ok else "NG(high flicker)")
