# -*- coding: utf-8 -*-
"""Google Maps ページの地図パネル要素調査"""
import json, time
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width":1400,"height":900}, locale="ja-JP")
    pg.goto("https://www.google.com/maps", wait_until="domcontentloaded", timeout=60000)
    time.sleep(6)
    # 同意ポップアップがあれば閉じる試行
    for sel in ["button:has-text('同意')", "button:has-text('Accept')", "button:has-text('同意して続行')", "[aria-label*='同意']"]:
        try:
            b2 = pg.locator(sel).first
            if b2.count() and b2.is_visible():
                b2.click(timeout=2500); time.sleep(3); break
        except Exception:
            pass
    r = pg.evaluate("""(() => {
      const out = { url: location.href, title: document.title };
      const cand = ['#map','#map-canvas','.gm-style','[aria-label*="地図"]','[aria-label*="Map"]','.widget-zoom','canvas'];
      const found = [];
      for (const s of cand) {
        document.querySelectorAll(s).forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width>100 && r.height>100) found.push({s, cls: (el.className||'').toString().slice(0,60), x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height)});
        });
      }
      out.found = found.slice(0, 12);
      // ビューポート中央を覆う大きなdiv上位
      const cx=window.innerWidth/2, cy=window.innerHeight/2;
      const big=[];
      document.querySelectorAll('div').forEach(el=>{
        const r=el.getBoundingClientRect();
        if(r.width>300&&r.height>300&&cx>=r.left&&cx<=r.right&&cy>=r.top&&cy<=r.bottom){
          const cs=getComputedStyle(el);
          if(cs.visibility==='hidden'||cs.display==='none') return;
          big.push({tag:el.tagName,id:el.id,cls:(el.className||'').toString().slice(0,80),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),bg:cs.backgroundColor,ov:cs.overflow});
        }
      });
      big.sort((a,b)=>(b.w*b.h)-(a.w*a.h));
      out.big = big.slice(0,10);
      return out;
    })()""")
    print(json.dumps(r, ensure_ascii=False, indent=1))
    pg.screenshot(path="gmaps_probe.png")
    b.close()
