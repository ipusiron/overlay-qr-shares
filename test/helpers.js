/* Test-only deterministic sources and reference reader; never loaded by the page. */
'use strict';
const crypto = require('node:crypto');
const vc = require('../vc-core.js');
const qr = require('../qr.js');
function detRng() {
  let position = 0;
  const rng = count => Uint8Array.from({ length: count }, () => (37 * position++ + 11) & 255);
  rng.count = () => position;
  return rng;
}
function seededRng(seed = 0x25ab19d3) {
  let state = seed >>> 0;
  return count => Uint8Array.from({ length: count }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state >>> 24;
  });
}
function u32Rng(values) {
  let i = 0;
  return count => {
    if (count !== 4 || i >= values.length) throw new Error('test rng exhausted');
    const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, values[i++], true); return out;
  };
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const basis = vc.basis;
function blockPattern(sheet, row, col, N, B) {
  let value = '';
  for (let r = 0; r < B.r; r++) for (let c = 0; c < B.c; c++) value += sheet[(row * B.r + r) * N * B.c + col * B.c + c];
  return value;
}
function synth(sheetList, Wsub, Hsub, opt) {
  const s = opt.px, W = Wsub * s, H = Hsub * s, T = new Float64Array(W * H).fill(1);
  for (const [sheet, dx] of sheetList) {               // dx＝サブピクセル単位の横ずれ
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = Math.floor((x - dx * s) / s), sy = Math.floor(y / s);
      const cov = (sx >= 0 && sx < Wsub && sheet[sy * Wsub + sx]) ? opt.ink : 0;
      T[y * W + x] *= (1 - cov);
    }
  }
  if (opt.blur) {                                         // 箱型のぼけ（半径 blur 画素）
    const r = opt.blur, U = new Float64Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let a = 0, n = 0; for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++) {
      const X = x + u, Y = y + v; if (X >= 0 && Y >= 0 && X < W && Y < H) { a += T[Y * W + X]; n++; } } U[y * W + x] = a / n; }
    T.set(U);
  }
  const g = new Uint8ClampedArray(W * H); for (let i = 0; i < g.length; i++) g[i] = Math.round(255 * (opt.floor + (1 - opt.floor) * T[i]));
  return { gray: g, W, H };
}
function otsu(vals) {
  const h = new Array(256).fill(0); for (const v of vals) h[Math.max(0, Math.min(255, Math.round(v * 255)))]++;
  const tot = vals.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
  let sB = 0, wB = 0, best = 0, th = 0;
  for (let i = 0; i < 256; i++) { wB += h[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += i * h[i]; const mB = sB / wB, mF =
    (sum - sB) / wF, b = wB * wF * (mB - mF) ** 2; if (b > best) { best = b; th = i; } }
  return (th + 0.5) / 255;
}
function readRectified(img, N, plain, id, px) {           // img＝QR 本体（余白なし）の正面化画像、1サブピクセル＝px 画素
  const B = basis(id), W = img.W;
  const at = (x, y) => { let a = 0, n = 0; for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) { a += img.gray[(y + v) * W + (x + u)];
    n++; } return a / n; };
  const raw = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    let a = 0; for (let r = 0; r < B.r; r++) for (let c = 0; c < B.c; c++) a += at(Math.floor((j * B.c + c + 0.5) * px), Math.floor((i * B.r + r + 0.5) * px));
    raw[i * N + j] = a / (B.r * B.c);
  }
  const pw = [], pb = []; for (let i = 0; i < N * N; i++) if (plain[i]) (raw[i] > 128 ? pw : pb).push(raw[i]);
  const white = pw.reduce((a, b) => a + b, 0) / pw.length, black = pb.reduce((a, b) => a + b, 0) / pb.length;
  const dark = Array.from(raw, v => Math.max(0, Math.min(1, (white - v) / (white - black))));
  const data = dark.filter((_, i) => !plain[i]); const th = otsu(data);
  const mod = new Uint8Array(N * N); for (let i = 0; i < N * N; i++) mod[i] = plain[i] ? (dark[i] > 0.5 ? 1 : 0) : (dark[i] > th ? 1 : 0);
  return { modules: mod, threshold: th };
}

module.exports = { detRng, seededRng, u32Rng, hash, blockPattern, synth, readRectified, decodeModules: qr.decodeModules };
