/* ============================================================
 * Equal Earth + Web-Mercator 投影数学 (共有モジュール)
 * Equal Earth は Šavrič/Patterson/Jenny 2018 の正積図法。
 * 式の出典: en.wikipedia.org/wiki/Equal_Earth_projection
 * 整合性: x の分母 = y の θ 微分(3(9A4θ^8+7A3θ^6+3A2θ^2+A1)) を
 *         満たす等積条件 X(θ)·Y'(θ) = (2/√3)cosθ を確認済み。
 * ============================================================ */
(function (root) {
  'use strict';

  const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
  const SQ3 = Math.sqrt(3);
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  // Webメルカトルの表示上限緯度 (±85.05112878°)
  const MAX_LAT = R2D * (2 * Math.atan(Math.exp(Math.PI)) - Math.PI / 2);
  const MAX_THETA = Math.asin(SQ3 / 2); // π/3

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Equal Earth 正投影。lon/lat は度。戻り値 x,y は生スケール(度→ラジアン換算済み) */
  function project(lonDeg, latDeg) {
    const lam = lonDeg * D2R, phi = latDeg * D2R;
    const th = Math.asin(clamp(0.5 * SQ3 * Math.sin(phi), -1, 1));
    const t2 = th * th, t6 = t2 * t2 * t2, t8 = t6 * t2;
    const den = A1 + 3 * A2 * t2 + 7 * A3 * t6 + 9 * A4 * t8;
    const x = (2 * SQ3 * lam * Math.cos(th)) / (3 * den);
    const y = A1 * th + A2 * th * t2 + A3 * th * t6 + A4 * th * t8; // A1θ + A2θ^3 + A3θ^7 + A4θ^9
    return { x: x, y: y };
  }

  /** Equal Earth 逆投影 (Newton法・実用的に十分収束) */
  function unproject(x, y) {
    let th = clamp(y / A1, -MAX_THETA, MAX_THETA);
    for (let i = 0; i < 20; i++) {
      const t2 = th * th, t6 = t2 * t2 * t2, t8 = t6 * t2;
      const p = A1 * th + A2 * th * t2 + A3 * th * t6 + A4 * th * t8 - y;
      const dp = A1 + 3 * A2 * t2 + 7 * A3 * t6 + 9 * A4 * t8;
      const d = p / dp;
      th -= d;
      if (th > MAX_THETA) th = MAX_THETA; else if (th < -MAX_THETA) th = -MAX_THETA;
      if (Math.abs(d) < 1e-12) break;
    }
    const t2 = th * th, t6 = t2 * t2 * t2, t8 = t6 * t2;
    const den = A1 + 3 * A2 * t2 + 7 * A3 * t6 + 9 * A4 * t8;
    const cosT = Math.cos(th);
    const lam = (3 * den * x) / (2 * SQ3 * cosT);
    const sinPhi = clamp((2 * Math.sin(th)) / SQ3, -1, 1);
    const phi = Math.asin(sinPhi);
    return { lonDeg: lam * R2D, latDeg: phi * R2D };
  }

  /* ---- Web メルカトル (screen行の算出用) ---- */
  /** 緯度 → mercator縦座標 (北端=+π, 南端=-π) */
  function mercY(latDeg) {
    const phi = clamp(latDeg * D2R, -MAX_LAT * D2R, MAX_LAT * D2R);
    return Math.log(Math.tan(Math.PI / 4 + phi / 2));
  }
  /** 世界タイルの上端からの行比率 (0..1)。rowFrac = (π - mercY)/(2π) */
  function rowFrac(latDeg) {
    return (Math.PI - mercY(latDeg)) / (2 * Math.PI);
  }
  function latFromRowFrac(f) {
    const merc = Math.PI - 2 * Math.PI * clamp(f, 0, 1);
    return R2D * (2 * Math.atan(Math.exp(merc)) - Math.PI / 2);
  }

  const EE = {
    A1: A1, A2: A2, A3: A3, A4: A4,
    MAX_LAT: MAX_LAT,
    D2R: D2R, R2D: R2D,
    project: project,
    unproject: unproject,
    mercY: mercY,
    rowFrac: rowFrac,
    latFromRowFrac: latFromRowFrac,
    clamp: clamp,
    EPS: 1e-9
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = EE;
  root.EEMath = EE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
