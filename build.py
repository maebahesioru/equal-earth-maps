# -*- coding: utf-8 -*-
"""dist/chrome と dist/firefox を生成する。"""
import json, os, shutil, zipfile, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

SHARED = ['math.js', 'glsl.js', 'engine.js', 'sites.js', 'sources.js', 'eeslippy.js']
FILES = [('background.js', 'background.js'), ('content/content.js', 'content.js')]

def build(manifest_src, out):
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, 'lib'))
    os.makedirs(os.path.join(out, 'popup'))
    os.makedirs(os.path.join(out, 'icons'))
    shutil.copy(manifest_src, os.path.join(out, 'manifest.json'))
    for src, dst in FILES:
        shutil.copy(src, os.path.join(out, dst))
    for f in SHARED:
        shutil.copy(os.path.join('shared', f), os.path.join(out, 'lib', f))
    for f in os.listdir('popup'):
        shutil.copy(os.path.join('popup', f), os.path.join(out, 'popup', f))
    for f in os.listdir('icons'):
        if f.endswith('.png'):
            shutil.copy(os.path.join('icons', f), os.path.join(out, 'icons', f))
    # 妥当性チェック
    with open(os.path.join(out, 'manifest.json'), encoding='utf-8') as fp:
        m = json.load(fp)
    for js in m['content_scripts'][0]['js']:
        assert os.path.exists(os.path.join(out, js)), js
    shutil.copy('README.md', os.path.join(out, 'README.md'))
    return out

chrome = build('manifest.chrome.json', 'dist/chrome')
firefox = build('manifest.firefox.json', 'dist/firefox')

for name, folder in (('equal-earth-maps-chrome.zip', chrome), ('equal-earth-maps-firefox.zip', firefox)):
    zpath = os.path.join('dist', name)
    if os.path.exists(zpath):
        os.remove(zpath)
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(folder):
            for f in files:
                full = os.path.join(base, f)
                z.write(full, os.path.relpath(full, folder))
    print('built', zpath)
print('done')
