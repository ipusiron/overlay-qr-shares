'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reader = require('../reader-core.js');
const vc = require('../vc-core.js');
const render = require('../render-core.js');
const { detRng, seededRng } = require('./helpers.js');
const vectors = require('./vectors.json');
const DEMO = vectors.sets[0].text;
function metadata(set) {
  return { id: set.id, version: set.version, m: set.m, ecl: set.ecl, setId: set.setId };
}
function clear(set, image) {
  image.gray.fill(0); set.modules.fill(0); set.data.forEach(bytes => bytes.fill(0));
  set.calib.forEach(bytes => bytes.fill(0)); set.band.fill(0);
}
for (const id of Object.keys(vectors.basis)) {
  test(`sample reader reconstructs ${id} from image, without expected text or modules`, () => {
    const set = vc.makeSet(DEMO, id, 4, 'M', 1, detRng());
    const image = render.synthStack(set, Array.from({ length: set.k }, (_, i) => i), { pxPerMm: 8, ink: 0.85 });
    try {
      const result = reader.readSample(image, image.geometry, metadata(set));
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
      assert.equal(result.diag.perRegion.length, 9); assert.ok(result.diag.attempts >= 1 && result.diag.attempts <= 5);
      assert.ok(Number.isFinite(result.diag.margin)); assert.ok(!Object.hasOwn(result, 'bytes'));
    } finally { clear(set, image); }
  });
}
for (const id of ['2-2', '2-5', '5-5']) {
  test(`one sheet of ${id} does not reconstruct`, () => {
    const set = vc.makeSet(DEMO, id, 4, 'M', 1, detRng()), image = render.synthStack(set, [0], { pxPerMm: 8 });
    try { assert.equal(reader.readSample(image, image.geometry, metadata(set)).ok, false); }
    finally { clear(set, image); }
  });
}
test('whole-page normal and mirrored samples recover the same text', () => {
  const set = vc.makeSet(DEMO, '2-2', 4, 'M', 1, detRng());
  const image = render.synthStack(set, [0, 1], { pxPerMm: 6, fullPage: true, ink: 0.85 });
  try {
    for (const mirrored of [false, true]) {
      const result = reader.readSample(image, { ...image.geometry, mirrored }, metadata(set));
      assert.equal(result.ok, true, JSON.stringify({ mirrored, result })); assert.equal(result.text, DEMO);
    }
  } finally { clear(set, image); }
});
test('quadratic illumination is fitted from public white and black samples', () => {
  const set = vc.makeSet(DEMO, '2-2', 4, 'M', 1, detRng());
  const image = render.synthStack(set, [0, 1], { pxPerMm: 6, ink: 0.85 });
  try {
    for (let y = 0; y < image.h; y++) for (let x = 0; x < image.w; x++) {
      const nx = x / image.w - 0.5, ny = y / image.h - 0.5;
      const gain = 0.72 + 0.18 * nx - 0.12 * ny + 0.1 * nx * nx + 0.08 * nx * ny;
      image.gray[y * image.w + x] = 20 + image.gray[y * image.w + x] * gain;
    }
    const result = reader.readSample(image, image.geometry, metadata(set));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
  } finally { clear(set, image); }
});
test('5-of-5 small subpixels use all sixteen centers at equal weight', () => {
  const set = vc.makeSet(DEMO, '5-5', 7, 'M', 0, detRng());
  const image = render.synthStack(set, [0, 1, 2, 3, 4], { pxPerMm: 10, ink: 0.85 });
  try {
    const result = reader.readSample(image, image.geometry, metadata(set));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
  } finally { clear(set, image); }
});
test('a damaged metadata band or different set identifier fails before QR decode', () => {
  const set = vc.makeSet(DEMO, '2-2', 4, 'M', 1, detRng());
  const image = render.synthStack(set, [0, 1], { pxPerMm: 6 });
  try {
    let calls = 0;
    const decoder = () => { calls++; return null; };
    const other = reader.readSample(image, image.geometry, { ...metadata(set), setId: 'AAAA' }, decoder);
    assert.equal(other.reason, 'metadata'); assert.equal(calls, 0);
    const band = set.layout.normal.band, { originX, originY, pxPerMm } = image.geometry;
    for (let y = Math.floor((band.y - originY) * pxPerMm); y < Math.ceil((band.y + 16 * set.m - originY) * pxPerMm); y++) {
      for (let x = Math.floor((band.x - originX) * pxPerMm); x < Math.ceil((band.x + 3 * set.m - originX) * pxPerMm); x++) {
        image.gray[y * image.w + x] = 255;
      }
    }
    const damaged = reader.readSample(image, image.geometry, metadata(set), decoder);
    assert.equal(damaged.reason, 'band'); assert.equal(calls, 0);
  } finally { clear(set, image); }
});
test('decoder buffers are cleared and threshold retries are bounded', () => {
  const set = vc.makeSet(DEMO, '2-2', 4, 'M', 1, detRng()), image = render.synthStack(set, [0, 1], { pxPerMm: 6 });
  const buffers = [];
  try {
    const result = reader.readSample(image, image.geometry, metadata(set), rgba => { buffers.push(rgba); return null; });
    assert.equal(result.ok, false); assert.equal(result.diag.attempts, 5);
    assert.equal(buffers.length, 10); // Each threshold gets a normal and transposed QR attempt.
    for (const rgba of buffers) assert.ok(rgba.every(value => value === 0));
  } finally { clear(set, image); }
});
test('invalid or cropped geometry fails without returning a plaintext result', () => {
  const set = vc.makeSet(DEMO, '2-2', 4, 'M', 1, detRng()), image = render.synthStack(set, [0, 1], { pxPerMm: 6 });
  try {
    assert.equal(reader.readSample(image, { ...image.geometry, pxPerMm: 0 }, metadata(set)).ok, false);
    assert.equal(reader.readSample(image, { ...image.geometry, originX: 10000 }, metadata(set)).ok, false);
    assert.equal(reader.readSample({ gray: new Uint8Array(2), w: 2, h: 2 }, image.geometry, metadata(set)).ok, false);
  } finally { clear(set, image); }
});
test('quadratic surface fitting and data Otsu handle a measured polynomial and empty input', () => {
  const samples = [];
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) samples.push([x, y, 4 + x + 2 * y + 3 * x * x + x * y - y * y]);
  const fit = reader.fitSurface(samples);
  try { assert.ok(Math.abs(reader.surface(fit, 0.25, -0.75) - 2.1875) < 1e-8); }
  finally { fit.fill(0); samples.forEach(point => point.fill(0)); }
  assert.equal(reader.otsu([]), 0.5); assert.equal(reader.fitSurface([]), null);
});
for (const code of [0, 1]) {
  test(`5-of-5 blurred full-page check retains six pixels per subpixel, size code ${code}`, () => {
    for (const seed of [0x5a125, 0x5a126, 0x5a127]) {
      const set = vc.makeSet(DEMO, '5-5', 4, 'M', code, seededRng(seed));
      const B = vc.basis(set.id), pxPerMm = Math.max(6, Math.ceil(6 * Math.max(B.r, B.c) / set.m));
      const image = render.synthStack(set, [0, 1, 2, 3, 4], { fullPage: true, pxPerMm, ink: 0.85, blur: 1 });
      try {
        for (const mirrored of [false, true]) {
          const result = reader.readSample(image, { ...image.geometry, mirrored }, metadata(set));
          assert.equal(result.ok, true, JSON.stringify({ seed, mirrored, result })); assert.equal(result.text, DEMO);
        }
      } finally { clear(set, image); }
    }
  });
}
