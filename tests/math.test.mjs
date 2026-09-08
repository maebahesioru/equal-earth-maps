import EE from '../shared/math.js';

let fails = 0;
function ok(cond, msg) {
  if (!cond) { fails++; console.error('FAIL: ' + msg); }
}
function close(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) { fails++; console.error(`FAIL: ${msg}  got=${a} want=${b} (tol=${tol})`); }
}

// ---- 1. 正投影/逆投影 ラウンドトリップ ----
for (let lat = -85; lat <= 85; lat += 5) {
  for (let lon = -180; lon <= 180; lon += 10) {
    const p = EE.project(lon, lat);
    const q = EE.unproject(p.x, p.y);
    let dLon = Math.abs(q.lonDeg - lon); if (dLon > 180) dLon = 360 - dLon;
    close(dLon, 0, 1e-7, `roundtrip lon ${lon},${lat}`);
    close(Math.abs(q.latDeg - lat), 0, 1e-7, `roundtrip lat ${lon},${lat}`);
  }
}
// 極付近
{
  const p = EE.project(120, 89.9999); const q = EE.unproject(p.x, p.y);
  close(Math.abs(q.latDeg - 89.9999), 0, 1e-5, 'pole roundtrip');
}

// ---- 2. 原点・既知点 ----
{
  const p = EE.project(0, 0);
  close(p.x, 0, 1e-12, 'x at origin'); close(p.y, 0, 1e-12, 'y at origin');
}
// 世界の縦横: y(90°)=A1θ+A2θ³+A3θ⁷+A4θ⁹, θ=π/3
{
  const top = EE.project(0, 90).y;
  const wantTop = EE.A1*(Math.PI/3) + EE.A2*Math.pow(Math.PI/3,3) + EE.A3*Math.pow(Math.PI/3,7) + EE.A4*Math.pow(Math.PI/3,9);
  close(top, wantTop, 1e-9, 'y at pole matches closed form');
  const east = EE.project(180, 0).x;
  console.log('world half-width x(180,0) =', east, ' y(90) =', top, ' aspect =', (2*east)/(2*top));
}
// 対称性
{
  const a = EE.project(45, 30), b = EE.project(-45, -30);
  close(a.x + b.x, 0, 1e-9, 'sym x'); close(a.y + b.y, 0, 1e-9, 'sym y');
}

// ---- 3. 等積性 (数値ヤコビアン = cosφ) ----
{
  // dA/d(λ,φ) が R²cosφ に比例すること: |J| / cosφ = const を確認
  let ratio = null, okr = true;
  for (const lat of [-60, 0, 45, 80]) {
    const d = 1e-6;
    const p0 = EE.project(0, lat);
    const pl = EE.project(d, lat), pu = EE.project(0, lat + d);
    const dxdL = (pl.x - p0.x) / d, dydL = (pl.y - p0.y) / d;
    const dxdP = (pu.x - p0.x) / d, dydP = (pu.y - p0.y) / d;
    const det = Math.abs(dxdL * dydP - dydL * dxdP);
    const r = det / Math.cos(lat * Math.PI / 180);
    if (ratio === null) ratio = r;
    else if (Math.abs(r - ratio) / ratio > 1e-6) okr = false;
    // 世界全幅(λ360°)の面積積分が地球半球面積に一致するかは det 定数性で十分
  }
  ok(okr, 'equal-area |J|/cosφ is constant');
  console.log('equal-area ratio (should be const across lat):', ratio);
}

// ---- 4. mercator rowFrac 相互変換 ----
{
  close(EE.rowFrac(EE.MAX_LAT), 0, 1e-9, 'rowFrac top');
  close(EE.rowFrac(-EE.MAX_LAT), 1, 1e-9, 'rowFrac bottom');
  close(EE.rowFrac(0), 0.5, 1e-9, 'rowFrac equator');
  for (const lat of [-80, -40, 0, 40, 80]) {
    close(EE.latFromRowFrac(EE.rowFrac(lat)), lat, 1e-7, 'rowFrac roundtrip ' + lat);
  }
}

// ---- 5. 投影結果の直観チェック (地図として妥当な範囲) ----
{
  const p = EE.project(0, 0); ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'finite');
  // グリーンランド中心(実スケール: xはλに比例するので、等積なら緯度帯の幅はcosθ依存)
  // 中央経線0上で、赤道付近と高緯度の縦スケール差を表示(参考値)
  const eq = EE.project(0, 10).y - EE.project(0, 0).y;
  const hi = EE.project(0, 70).y - EE.project(0, 60).y;
  console.log('10° band height at 0°:', eq.toFixed(5), ' at 60-70°:', hi.toFixed(5), ' (equal-area => 高緯度の帯が縦に広い)');
}

if (fails === 0) { console.log('\nALL MATH TESTS PASSED'); process.exit(0); }
else { console.log('\n' + fails + ' TEST(S) FAILED'); process.exit(1); }
