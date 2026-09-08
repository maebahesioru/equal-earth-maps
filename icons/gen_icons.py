# -*- coding: utf-8 -*-
"""アイコン生成 (Equal-Earth風の世界シルエット)"""
import math
from PIL import Image, ImageDraw

def make(size):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = size / 128.0
    # 背景: 角丸ダーク
    d.rounded_rectangle([2*s, 2*s, 126*s, 126*s], radius=22*s, fill=(13, 17, 23, 255))
    pad = 18 * s
    w = 128*s - 2*pad
    h = w * 0.62
    top = (128*s - h) / 2
    cx = 64*s
    # イコールアースらしい形状: 疑似円筒で上下を少し絞る
    def edge_x(u):  # u: -1..1 経度
        return cx + u * (w/2) * (1.0 - 0.18 * abs(u))
    def y_of(v):    # v: -1..1 緯度
        return top + h * (v + 1) / 2.0
    ocean = (22, 101, 180, 255)   # 海
    graticule = (88, 166, 255, 200)
    land = (46, 160, 67, 255)

    # 海面 (歪んだ矩形っぽく曲線で)
    pts = []
    N = 60
    for i in range(N + 1):
        u = -1 + 2*i/N
        pts.append((edge_x(u), y_of(-1)))
    for i in range(N + 1):
        u = 1 - 2*i/N
        pts.append((edge_x(u), y_of(1)))
    d.polygon(pts, fill=ocean)

    # 経線 (中央+曲線) ・ 緯線
    for uu in (-0.7, -0.35, 0.35, 0.7):
        pts = [(edge_x(uu), y_of(-1))]
        for i in range(1, N):
            u = -1 + 2*i/N
            pts.append((edge_x(uu), y_of(u*0.0 + (1-0.2)*uu)))  # 直線化(疑似)
        pts.append((edge_x(uu), y_of(1)))
        d.line(pts, fill=graticule, width=max(1, int(1.5*s)))
    # 緯線を単純直線で(平行線は真直ぐ)
    for vv in (-0.5, 0, 0.5):
        d.line([(edge_x(-1), y_of(vv)), (edge_x(1), y_of(vv))], fill=graticule, width=max(1, int(1.5*s)))
    # 大陸らしきブロブ (アフリカ+ユーラシア風)
    d.ellipse([edge_x(-0.28), y_of(-0.2), edge_x(0.05), y_of(0.35)], fill=land)
    d.ellipse([edge_x(0.05), y_of(-0.55), edge_x(0.62), y_of(0.28)], fill=land)
    d.ellipse([edge_x(-0.85), y_of(-0.25), edge_x(-0.45), y_of(0.28)], fill=land)
    d.ellipse([edge_x(0.05), y_of(-0.62), edge_x(0.4), y_of(-0.34)], fill=land)
    return im

for n in (16, 48, 128):
    make(n).save(f'icons/icon{n}.png')
    print('icons/icon%d.png' % n)
