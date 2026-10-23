/* Overlay QR Shares - MIT (c) 2026 ipusiron. OQS v1, millimetres. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.OQS = root.OQS || {}; root.OQS.layout = factory(); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MSIZES = Object.freeze([2.032, 2.54]);
  const IDS = Object.freeze(['2-2', '2-3', '2-4', '2-5', '3-3', '4-4', '5-5']);
  const CALIB_ROWS = 8, CALIB_COLS = 2;
  function valid(id, version) { return IDS.includes(id) && Number.isInteger(version) && version >= 3 && version <= 7; }
  function crc8(bytes) {
    let value = 0;
    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new TypeError('CRC bytes');
      value ^= byte;
      for (let i = 0; i < 8; i++) value = (value & 0x80) ? ((value << 1) ^ 0x07) & 255 : (value << 1) & 255;
    }
    return value;
  }
  function bandBits(id, version, ecl, msizeCode, setId) {
    if (!valid(id, version) || !['M', 'Q'].includes(ecl) || !Number.isInteger(msizeCode) || msizeCode < 0 || msizeCode > 1 || typeof setId !==
      'string' || setId.length !== 4 || [...setId].some(ch => !ALPHA.includes(ch))) throw new RangeError('band parameters');
    if (!layout(id, version, MSIZES[msizeCode]).fits) throw new RangeError('band layout');
    const fields = [[1, 4], [IDS.indexOf(id) + 1, 4], [version - 3, 4], [ecl === 'Q' ? 1 : 0, 1], [msizeCode, 3]];
    for (const ch of setId) fields.push([ALPHA.indexOf(ch), 5]);
    fields.push([0, 4]); // Reserved bits precede CRC, as fixed by the known vectors.
    const bits = [];
    for (const [value, count] of fields) for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
    const bytes = [];
    for (let i = 0; i < 40; i += 8) bytes.push(bits.slice(i, i + 8).reduce((v, bit) => (v << 1) | bit, 0));
    const crc = crc8(bytes);
    for (let i = 7; i >= 0; i--) bits.push((crc >> i) & 1);
    return Uint8Array.from(bits);
  }
  function parseBand(bits) {
    if (!(bits instanceof Uint8Array) || bits.length !== 48 || bits.some(v => v > 1)) return { ok: false, reason: 'length' };
    let position = 0;
    const take = count => { let value = 0; for (let i = 0; i < count; i++) value = (value << 1) | bits[position++]; return value; };
    const bytes = Array.from({ length: 5 }, () => take(8)), checksum = take(8);
    if (crc8(bytes) !== checksum) return { ok: false, reason: 'crc' };
    position = 0;
    const fmt = take(4), code = take(4), version = take(4) + 3, ecl = take(1) ? 'Q' : 'M', msizeCode = take(3);
    let setId = ''; for (let i = 0; i < 4; i++) setId += ALPHA[take(5)];
    const reserved = take(4), id = IDS[code - 1];
    if (fmt !== 1 || !valid(id, version) || msizeCode > 1 || reserved || !layout(id, version, MSIZES[msizeCode]).fits) return { ok: false, reason: 'fields' };
    return { ok: true, fmt, id, version, ecl, msizeCode, setId };
  }
  function layout(id, version, m) {
    if (!valid(id, version) || !MSIZES.includes(m)) throw new RangeError('layout parameters');
    const Q = 17 + 4 * version + 8, W = (Q + 7) * m, H = Q * m;
    const x0 = (210 - W) / 2, y0 = 148.5 - 1 - 5 - H;
    const fits = W <= 184 + 1e-9 && y0 - 5 >= 25 - 1e-9;
    const block = y => ({ x: x0, y, w: W, h: H, qr: { x: x0, y, side: Q * m },
      calib: { x: x0 + (Q + 1) * m, y: y + 4 * m, cols: CALIB_COLS, rows: CALIB_ROWS },
      band: { x: x0 + (Q + 4) * m, y: y + 4 * m, cols: 3, rows: 16 },
      marks: [{ x: x0 - 5, y: y - 5, hollow: true }, { x: x0 + W + 2, y: y - 5 }, { x: x0 - 5, y: y + H + 2 }, { x: x0 + W + 2, y: y + H + 2 }] });
    const normal = block(y0), mirror = block(297 - y0 - H);
    mirror.calib.y = 297 - normal.calib.y - CALIB_ROWS * m;
    mirror.band.y = 297 - normal.band.y - 16 * m;
    mirror.marks = normal.marks.map(mark => ({ x: mark.x, y: 297 - mark.y - 3, hollow: !!mark.hollow }));
    return { fits, reason: fits ? null : 'a4', Q, m, W, H, page: { w: 210, h: 297, margin: 8 }, normal, mirror,
      labels: [{ x: 13, y: 8, w: 184, h: 12, mirrored: false }, { x: 13, y: 277, w: 184, h: 12, mirrored: true }],
      rulers: [{ x: 197, y: 100, length: 100, vertical: true }, { x: 80, y: 20, length: 50, vertical: false }] };
  }
  function fitTable() {
    const table = {};
    for (const m of MSIZES) table[m] = [3, 4, 5, 6, 7].filter(version => layout('2-2', version, m).fits);
    return table;
  }
  return Object.freeze({ ALPHA, MSIZES, CALIB_ROWS, CALIB_COLS, crc8, bandBits, parseBand, layout, fitTable });
}));
