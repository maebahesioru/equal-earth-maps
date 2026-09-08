# -*- coding: utf-8 -*-
"""EESlippy smoke: 初期世界表示・ホイールズーム・ドラッグ・オンデマンドタイル"""
import json, time
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8099/demo/test-ee-slippy.html"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until="load")
    time.sleep(3.5)  # leaflet + slippy attach

    def st():
        return pg.evaluate("""(() => {
          const s = window.__slip, ov = window.__ov;
          if (!s || !ov) return null;
          return { ready: !!window.__eeReady,
                   k: +s._view.k.toFixed(2), xc: +s._view.xc.toFixed(4), yc: +s._view.yc.toFixed(4),
                   disp: ov.canvas.style.display, hasSrc: !!ov._hasSource,
                   cov: s._cov ? {z: s._cov.z, L:+s._cov.lonL.toFixed(1), R:+s._cov.lonR.toFixed(1)} : null,
                   mosaic: s._mosaic ? s._mosaic.width + 'x' + s._mosaic.height : null,
                   cache: s._cache.size, busy: s._busy };
        })()""")

    t0 = st()
    print("T0:", json.dumps(t0))
    assert t0 and t0["ready"]
    time.sleep(2.5)   # 初期タイル取得待ち
    t1 = st()
    print("T1(初期世界):", json.dumps(t1))
    assert t1["hasSrc"] and t1["cov"] is not None, "no initial texture"

    # ズームイン (wheel)
    pg.mouse.move(700, 450)
    for _ in range(3):
        pg.mouse.wheel(0, -120)
        time.sleep(0.15)
    time.sleep(2.0)
    t2 = st()
    print("T2(ズームイン後):", json.dumps(t2))
    assert t2["k"] > t1["k"] * 2.2, "zoom did not increase k"

    # ドラッグ(左へ=東を見る)→ xc増加
    pg.mouse.move(1000, 450); pg.mouse.down()
    for i in range(6):
        pg.mouse.move(1000 - i * 60, 450, steps=2); time.sleep(0.06)
    pg.mouse.up()
    time.sleep(1.5)
    t3 = st()
    print("T3(ドラッグ後):", json.dumps(t3))
    assert t3["xc"] > t2["xc"], "drag did not move view east"

    # 中心画素が海色(緯度0経度0付近は海)か簡易チェック(ズームアウト→全体中心)
    # リセットして世界表示: 中心=0,0 はギニア湾の海
    pg.evaluate("window.__slip.resetWorld()")
    time.sleep(2.5)
    t4 = st()

    # --- ズームアウトの下限(世界の28%表示まで) ---
    for _ in range(2):
        pg.mouse.wheel(0, 120)
        time.sleep(0.12)
    time.sleep(1.0)
    t5 = st()
    print("T5(ズームアウト後):", json.dumps(t5))

    # --- ズームインの上限(z19相当まで) ---
    for _ in range(16):
        pg.mouse.wheel(0, -120)
        time.sleep(0.06)
    time.sleep(4.0)
    t6 = st()
    print("T6(超ズームイン後):", json.dumps(t6))

    rect = pg.evaluate("(() => { const r = window.__ov.canvas.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()")
    shot = pg.screenshot(clip={"x": rect["x"] + rect["w"]/2 - 3, "y": rect["y"] + rect["h"]/2 - 3, "width": 6, "height": 6})
    open("slippy_center.png", "wb").write(shot)
    from PIL import Image
    im = Image.open("slippy_center.png").convert("RGB")
    px = im.resize((1,1)).getpixel((0,0))
    print("world center px:", px, "(ocean 期待: B>R)")
    k0 = t1["k"]
    ok = t1["hasSrc"] and t2["k"] > k0*2 and t3["xc"] > t2["xc"] and t4["hasSrc"] and \
         t5["k"] < k0*0.6 and t6["k"] > 5e5 and t6["hasSrc"] and t6["cov"] and t6["cov"]["z"] >= 15 \
         and px[2] >= px[0]
    print("SLIPPY_SMOKE", "OK" if ok else "NG")
    if errs: print("pageerrors:", errs[:6])
    b.close()
