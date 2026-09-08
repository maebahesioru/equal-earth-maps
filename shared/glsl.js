/* ============================================================
 * WebGL シェーダ: 出力ピクセル(EE座標) → 逆EE → (lon,lat)
 *   → メルカトル行 → ソース(画面キャプチャ/タイルモザイク)をサンプル
 * Equal Earth 逆変換はニュートン法をGPU上で固定反復。
 * ============================================================ */

const EE_VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const EE_FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex;          // ソース画像 (キャプチャ or タイルモザイク)
uniform vec4  uTexRegion;        // ソース中の地図パネル矩形 (x,y,w,h / テクセル)
uniform vec2  uTexSize;          // テクスチャ全体サイズ
uniform vec2  uCanvasSize;       // キャンバス(=パネル)デバイスpxサイズ
uniform vec4  uDrawRect;         // キャンバス内でEE地図を描く矩形 (x,y,w,h デバイスpx)
uniform vec2  uPan;              // ジェスチャ追従: コンテンツ移動量 (デバイスpx)
uniform vec2  uZoomAnchor;       // ジェスチャ追従: ズーム中心 (デバイスpx)
uniform float uZoomScale;        // ジェスチャ追従: ズーム倍率 (1=なし)
uniform vec4  uEEBox;            // 描画窓のEE生座標 (x0, y0bottom, x1, y1top)
uniform vec2  uWinLon;           // 図郭判定用 経度範囲 (度)
uniform vec2  uRowRange;         // 図郭判定用 行範囲 (top, bottom) 0..1
uniform vec4  uSrcBox;           // ソース(タイル/モザイク)が覆う範囲 (lonL,rowTop,lonR,rowBot)
uniform float uMaxLat;           // ±85.05112878 (度)

const float PI  = 3.141592653589793;
const float SQ3 = 1.7320508075688772;
const float A1c = 1.340264;
const float A2c = -0.081106;
const float A3c = 0.000893;
const float A4c = 0.003796;
const float MAX_TH = 1.0471975511965976; // pi/3

float clampF(float v, float lo, float hi) {
  return min(max(v, lo), hi);
}

// Webメルカトルの行比率 (北端0, 南端1)
float rowFracOfLat(float latDeg) {
  float phi = latDeg * PI / 180.0;
  phi = clampF(phi, -uMaxLat * PI / 180.0, uMaxLat * PI / 180.0);
  float m = log(tan(PI / 4.0 + phi / 2.0));
  return (PI - m) / (2.0 * PI);
}

// Equal Earth 逆変換: EE生座標(eex, eey) → (lonDeg, latDeg)
void eeUnproject(float eex, float eey, out float lonDeg, out float latDeg) {
  float th = clampF(eey / A1c, -MAX_TH, MAX_TH);
  for (int i = 0; i < 24; i++) {
    float t2 = th * th;
    float t6 = t2 * t2 * t2;
    float t8 = t6 * t2;
    float p  = A1c * th + A2c * th * t2 + A3c * th * t6 + A4c * th * t8 - eey;
    float dp = A1c + 3.0 * A2c * t2 + 7.0 * A3c * t6 + 9.0 * A4c * t8;
    th -= p / dp;
    th = clampF(th, -MAX_TH, MAX_TH);
  }
  float t2 = th * th;
  float t6 = t2 * t2 * t2;
  float t8 = t6 * t2;
  float den = A1c + 3.0 * A2c * t2 + 7.0 * A3c * t6 + 9.0 * A4c * t8;
  float lonR = (3.0 * den * eex) / (2.0 * SQ3 * cos(th));
  float sinPhi = clampF((2.0 * sin(th)) / SQ3, -1.0, 1.0);
  float phi = asin(sinPhi);
  lonDeg = lonR * 180.0 / PI;
  latDeg = phi * 180.0 / PI;
}

void main() {
  // gl_FragCoordは下原点 → 上原点(キャンバス=パネル)に変換
  vec2 px = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
  // --- EE描画矩形内か (実pxで判定 = レターボックスは背景のまま) ---
  if (px.x < uDrawRect.x || px.x > uDrawRect.x + uDrawRect.z ||
      px.y < uDrawRect.y || px.y > uDrawRect.y + uDrawRect.w) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  // --- ジェスチャ追従: ズーム(アンカー中心) → パン(コンテンツ移動量) ---
  // 再構築までの間、ドラッグ/ホイールの動きをフレームへ反映して
  // 「手に追従する」見た目にする(ちらつき防止)
  vec2 q = (px - uZoomAnchor) / uZoomScale + uZoomAnchor - uPan;
  float nx = (q.x - uDrawRect.x) / uDrawRect.z;
  float ny = (q.y - uDrawRect.y) / uDrawRect.w;
  float eex = mix(uEEBox.x, uEEBox.z, nx);
  float eey = mix(uEEBox.w, uEEBox.y, ny);   // 上=y1

  float lonDeg, latDeg;
  eeUnproject(eex, eey, lonDeg, latDeg);

  // 窓外(数値端)は捨てる
  if (lonDeg < uWinLon.x || lonDeg > uWinLon.y) { discard; }
  float row = rowFracOfLat(latDeg);
  if (row < uRowRange.x || row > uRowRange.y) { discard; }

  // --- ソース(メルカトル画面)内の位置へ (ソース=uSrcBoxが覆う範囲) ---
  float sx = (lonDeg - uSrcBox.x) / (uSrcBox.z - uSrcBox.x) * uTexRegion.z;
  float sy = (row - uSrcBox.y) / (uSrcBox.w - uSrcBox.y) * uTexRegion.w;

  if (sx < 0.0 || sx > uTexRegion.z || sy < 0.0 || sy > uTexRegion.w) { discard; }

  vec2 uv = (uTexRegion.xy + vec2(sx, sy)) / uTexSize;
  gl_FragColor = texture2D(uTex, uv);
}
`;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EE_VERT: EE_VERT, EE_FRAG: EE_FRAG };
} else {
  (typeof globalThis !== 'undefined' ? globalThis : this).EEShaders = { EE_VERT: EE_VERT, EE_FRAG: EE_FRAG };
}
