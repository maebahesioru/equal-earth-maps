# -*- coding: utf-8 -*-
"""EEパイプライン数値検証:
ソースに「色=lon/lat」のインデックステクスチャを置き、EE出力ピクセルを復号。
各ピクセルの復号(lon,lat)と CPU EEMath による EE逆投影値の一致を測る。"""
import json, sys, time
from playwright.sync_api import sync_playwright
from PIL import Image

URL = "http://127.0.0.1:8099/demo/test-ee-grid.html"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1300, "height": 800}, device_scale_factor=1)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until="load")
    time.sleep(2.5)
    # 検証に必要なパラメータをページから取得
    params = pg.evaluate("""(() => {
      const t = window.__t; if (!t) return null;
      const ov = t.ov, gl = ov.gl, prog = ov.prog;
      function glr(name){ return gl.getUniformLocation(prog, name); }
      const g = (n)=>{ const loc=glr(n); const v=gl.getUniform(prog, loc); return v; };
      // uniformを読み直すため一度render()(値を設定している)
      ov.render();
      const uni = {};
      for (const n of ['uCanvasSize','uDrawRect','uEEBox','uWinLon','uRowRange','uMaxLat']) uni[n]=Array.from(g(n));
      const rect = ov.canvas.getBoundingClientRect();
      return { canvasW: ov.canvas.width, canvasH: ov.canvas.height,
               css: {x:rect.x,y:rect.y,w:rect.width,h:rect.height},
               uni, win: t.win };
    })()""")
    if params is None:
        print("NO STATE"); b.close(); sys.exit(1)
    print("params:", json.dumps(params))
    bbox = params["css"]
    # クリップでスクリーンショット (canvas領域)
    shot = pg.screenshot(clip={"x": bbox["x"], "y": bbox["y"], "width": bbox["w"], "height": bbox["h"]})
    open("grid_shot.png", "wb").write(shot)
    b.close()

# --- 解析 ---
im = Image.open("grid_shot.png").convert("RGB")
print("shot size", im.size, "expect", params["canvasW"], params["canvasH"])
W, H = im.size
if (W, H) != (params["canvasW"], params["canvasH"]):
    # dpr等でずれたらリサイズして揃える
    im = im.resize((params["canvasW"], params["canvasH"]))
    W, H = im.size

uni = params["uni"]
cx0, cy0, cw0, ch0 = uni["uDrawRect"]  # (x0,y0,w,h) トップダウン
cx0 = int(cx0); cy0 = int(cy0); cw = int(round(cw0)); ch = int(round(ch0))
x0, y0b, x1, y1t = uni["uEEBox"]
lonL, lonR = uni["uWinLon"]
rT, rB = uni["uRowRange"]

# CPU実装 (math.js の複製を最小限で: ここではPythonでEE逆変換)
import math
A1=1.340264; A2=-0.081106; A3=0.000893; A4=0.003796; SQ3=math.sqrt(3)
def ee_unproject(x, y):
    th = max(-math.pi/3, min(math.pi/3, y/A1))
    for _ in range(24):
        t2=th*th; t6=t2**3; t8=t6*t2
        p=A1*th+A2*th*t2+A3*th*t6+A4*th*t8-y
        dp=A1+3*A2*t2+7*A3*t6+9*A4*t8
        th-=p/dp
        th=max(-math.pi/3,min(math.pi/3,th))
    t2=th*th; t6=t2**3; t8=t6*t2
    den=A1+3*A2*t2+7*A3*t6+9*A4*t8
    lon=x*3*den/(2*SQ3*math.cos(th))*180/math.pi
    phi=math.asin(max(-1,min(1,2*math.sin(th)/SQ3)))
    return lon, phi*180/math.pi

def decode(px, py):
    r,g,b = im.getpixel((px, py))
    if r + g + b < 140:   # レターボックス背景 or 透明 → スキップ対象
        return None
    lon = r/255*360-180
    lat = g/255*180-90
    return lon, lat

errs2 = []
samples = []
step = 24
for gx in range(0, cw, step):
    for gy in range(0, ch, step):
        px = int(cx0 + gx); py = int(cy0 + gy)
        if px < 0 or py < 0 or px >= W or py >= H: continue
        nx = gx/cw; ny = gy/ch
        eex = x0 + nx*(x1-x0)
        eey = y1t - ny*(y1t-y0b)
        elon, elat = ee_unproject(eex, eey)
        if not (lonL - 3 <= elon <= lonR + 3 and -90 <= elat <= 90): continue
        d = decode(px, py)
        if d is None: continue
        dlon, dlat = d
        e_lon = abs((dlon - elon + 180) % 360 - 180)
        e_lat = abs(dlat - elat)
        errs2.append((e_lon, e_lat, px, py, dlon, dlat, elon, elat))
        samples.append((px,py))

print("sampled pixels:", len(errs2))
if errs2:
    import statistics
    lonerr = [e[0] for e in errs2]; laterr=[e[1] for e in errs2]
    print("mean lon err %.3f  max %.3f" % (statistics.mean(lonerr) if lonerr else -1, max(lonerr) if lonerr else -1))
    print("mean lat err %.3f  max %.3f" % (statistics.mean(laterr) if laterr else -1, max(laterr) if laterr else -1))
    # 代表サンプル(グリッド順に12個)詳細表示
    for row in errs2[:: max(1, len(errs2)//12)][:12]:
        print("px,py", row[2], row[3], "dec lon/lat", round(row[4],1), round(row[5],1), "cpu lon/lat", round(row[6],1), round(row[7],1), "err", round(row[0],1), round(row[1],1))
    errs2.sort(key=lambda z: max(z[0], z[1]), reverse=True)
    print("worst 5:", [(round(a,1), round(b2,1), p[2], p[3]) for a,b2,*p in errs2[:5]])
    ok = statistics.mean(lonerr) < 1.0 and statistics.mean(laterr) < 0.6 and max(lonerr) < 4.0 and max(laterr) < 2.5
    print("PIPELINE", "OK" if ok else "NG")
