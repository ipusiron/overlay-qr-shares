/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../layout-core.js');
const vc = require('../vc-core.js');
const vectors = require('./vectors.json');
const rounded = value => Number(value.toFixed(3));
const xy = object => ({ x: rounded(object.x), y: rounded(object.y) });
test('every supplied layout vector field matches exactly', () => {
  const actual = layout.layout('2-2', 4, 2.54);
  assert.deepEqual({ fits: actual.fits, Q: actual.Q, W: rounded(actual.W), H: rounded(actual.H), normal: xy(actual.normal), mirror: xy(actual.mirror),
    calib: xy(actual.normal.calib), band: xy(actual.normal.band), marksNormal: actual.normal.marks,
    marksMirror: actual.mirror.marks.map(mark => ({ ...xy(mark), hollow: mark.hollow })) }, vectors.layout_2_2_v4_m254);
  assert.deepEqual(layout.fitTable(), vectors.fitTable);
});
test('all fitting layouts reflect every component and stay eight millimetres inside A4', () => {
  for (const id of Object.keys(vc.SCHEMES)) for (const m of layout.MSIZES) for (let version = 3; version <= 7; version++) {
    const page = layout.layout(id, version, m);
    assert.equal(page.fits, vectors.fitTable[m].includes(version));
    assert.ok(Math.abs(page.normal.y + page.H + page.mirror.y - 297) < 1e-9);
    for (const field of ['calib', 'band']) assert.ok(Math.abs(page.normal[field].y + page.normal[field].rows * m + page.mirror[field].y - 297) < 1e-9);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(page.normal.marks[i].y + 3 + page.mirror.marks[i].y - 297) < 1e-9);
    if (page.fits) for (const side of [page.normal, page.mirror]) for (const mark of side.marks) {
      assert.ok(mark.x >= 8 && mark.x + 3 <= 202); assert.ok(mark.y >= 8 && mark.y + 3 <= 289);
    }
  }
});
test('every known metadata band round-trips and every one-bit corruption fails CRC', () => {
  for (const expected of vectors.sets) {
    const bits = layout.bandBits(expected.id, expected.version, expected.ecl, expected.msizeCode, expected.setId);
    assert.equal([...bits].join(''), expected.band); assert.ok(layout.parseBand(bits).ok);
    for (let i = 0; i < bits.length; i++) { const corrupted = bits.slice(); corrupted[i] ^= 1; assert.equal(layout.parseBand(corrupted).ok, false); }
  }
});
test('valid CRC does not admit unknown format, scheme, version, dimensions or reserved bits', () => {
  const source = Uint8Array.from(vectors.sets[0].band, Number);
  for (const [start, count, value] of [[0, 4, 2], [4, 4, 0], [8, 4, 15], [13, 3, 7], [36, 4, 1]]) {
    const bits = source.slice();
    for (let i = 0; i < count; i++) bits[start + i] = (value >> (count - i - 1)) & 1;
    const bytes = Array.from({ length: 5 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0)), crc = layout.crc8(bytes);
    for (let i = 0; i < 8; i++) bits[40 + i] = (crc >> (7 - i)) & 1;
    assert.equal(layout.parseBand(bits).ok, false);
  }
  assert.equal(layout.parseBand(new Uint8Array(47)).ok, false);
  assert.throws(() => layout.layout('2-2', 4, 0.5)); assert.throws(() => layout.bandBits('2-2', 4, 'M', 1, '!!!?'));
});
