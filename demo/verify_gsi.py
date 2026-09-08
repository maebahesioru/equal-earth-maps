# -*- coding: utf-8 -*-
"""GSI slippy再現(東京): 世界ロード完了→東京z18ズーム→黒い欠け/404計測"""
import time, json
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8099/demo/test-ee-gsi.html"
fails = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    pg.on("response", lambda r: fails.append(r.status) if (r.status >= 400 and "gsi.go.jp" in r.url) else None)
    pg.on("pageerror", lambda e: print("PAGEERR", e))
    pg.goto(URL, wait_until="load")
    def st():
        return pg.evaluate("""(() => {
          const s=window.__slip, ov=window.__ov;
          if(!s||!ov) return null;
          return {k:+s._view.k.toFixed(1), xc:+s._view.xc.toFixed(4), yc:+s._view.yc.toFixed(4),
                  cov:s._cov?{z:s._cov.z,L:+s._cov.lonL.toFixed(1),R:+s._cov.lonR.toFixed(1)}:null,
                  cache:s._cache.size, busy:s._busy};
        })()""")
    # 世界ロード完了待ち
    t = None
    for _ in range(60):
        time.sleep(0.5)
        t = st()
        if t and t["cov"] and not t["busy"]: break
    print("T0(世界ロード完了)", json.dumps(t))
    # 東京中心・中間ズームへ
    pg.evaluate("""(() => {
      const s=window.__slip;
      const p=window.EEMath.project(139.69, 35.68);  // 東京の生座標(正しい中心)
      s._setView(p.x, p.y, 3.0e5, true);
    })()""")
    time.sleep(3.0); t1 = st(); print("T1(東京中間)", json.dumps(t1))
    # さらにズームイン (z18到達)
    for _ in range(6):
        pg.mouse.wheel(0, -120); time.sleep(0.05)
    time.sleep(3.5); t2 = st(); print("T2(東京z18近傍)", json.dumps(t2))
    # パン
    pg.mouse.move(700,450); pg.mouse.down()
    for i in range(6):
        pg.mouse.move(700 - i*90, 450, steps=2); time.sleep(0.05)
    pg.mouse.up(); time.sleep(2.5); t3 = st(); print("T3(パン後)", json.dumps(t3))
    rect = pg.evaluate("(() => { const r=window.__ov.canvas.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()")
    pg.screenshot(path="gsi_tokyo.png", clip={"x":rect["x"],"y":rect["y"],"width":rect["w"],"height":rect["h"]})
    b.close()

from PIL import Image
import numpy as np
im = Image.open("gsi_tokyo.png").convert("RGB")
a = np.asarray(im, dtype=int)
bg = (np.abs(a[:,:,0]-10)<40)&(np.abs(a[:,:,1]-14)<40)&(np.abs(a[:,:,2]-20)<40)
from collections import Counter
print("black-ish px ratio: %.2f%%" % (bg.mean()*100))
print("http>=400:", len(fails), dict(Counter(fails)))
ok = (t1 and t1["cov"] and t2 and t2["cov"]) and bg.mean() < 0.03
print("GSI_TOKYO", "OK(no black)" if ok else "NG(black present)")
