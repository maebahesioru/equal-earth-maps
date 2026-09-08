/* ============================================================
 * 対応サイト定義
 * mode:
 *   'leaflet'  — Leaflet/OSMタイル系。タイルDOMから正確な窓と
 *                モザイク画像を組み立てる(OSM / 国土地理院)
 * ============================================================ */
(function (root) {
  'use strict';

  function endsWithHost(h, suffix) { return h === suffix || h.endsWith('.' + suffix); }

  const SITES = [
    { id: 'osm', name: 'OpenStreetMap', mode: 'leaflet',
      detect() {
        const h = location.hostname.toLowerCase();
        return endsWithHost(h, 'openstreetmap.org') && !document.body.classList.contains('edit_') &&
               !!document.querySelector('.leaflet-container');
      },
      panes: ['.leaflet-container'] },
    { id: 'gsi', name: '国土地理院地図', mode: 'leaflet',
      detect() {
        const h = location.hostname.toLowerCase();
        return /(^|\.)gsi\.go\.jp$/.test(h) && !!document.querySelector('.leaflet-container');
      },
      panes: ['.leaflet-container'] }
  ];

  /** 現在ページのサイト定義を返す。無ければ汎用Leaflet検出 */
  function detect() {
    if (!location.protocol.startsWith('http')) return null;
    for (const s of SITES) { if (s.detect()) return s; }
    if (document.querySelector('.leaflet-container')) {
      return { id: 'generic-leaflet', name: 'この地図ページ (Leaflet)', mode: 'leaflet', panes: ['.leaflet-container'] };
    }
    return null;
  }

  /** 地図パネル要素を探す */
  function findPane(cfg) {
    const cands = (cfg && cfg.panes) || [];
    for (const sel of cands) {
      const list = document.querySelectorAll(sel);
      for (const el of list) {
        const r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 200 && r.bottom > 0 && r.right > 0) return el;
      }
    }
    // Google Maps等: 大きなcanvasの親ビューポートを地図パネルとして使う
    for (const cv of document.querySelectorAll('canvas')) {
      const r = cv.getBoundingClientRect();
      if (r.width < 300 || r.height < 300) continue;
      const vw = window.innerWidth, vh = window.innerHeight;
      let el = cv.parentElement;
      while (el && el !== document.body) {
        const er = el.getBoundingClientRect();
        if (er.width >= vw * 0.5 && er.height >= vh * 0.5 && er.right <= vw + 40 && er.bottom <= vh + 40) {
          const cs = getComputedStyle(el);
          if (cs.visibility !== 'hidden' && cs.display !== 'none') return el;
        }
        el = el.parentElement;
      }
    }
    // 汎用: ビューポート中央を覆う最大のdiv
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    let best = null, bestArea = 0;
    const all = document.querySelectorAll('div');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 300) continue;
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        const a = r.width * r.height;
        if (a > bestArea) { bestArea = a; best = el; }
      }
    }
    return best;
  }

  root.EESites = { SITES: SITES, detect: detect, findPane: findPane };
})(typeof globalThis !== 'undefined' ? globalThis : this);
