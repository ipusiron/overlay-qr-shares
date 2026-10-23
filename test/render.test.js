/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vc = require('../vc-core.js');
const render = require('../render-core.js');
const { detRng, hash } = require('./helpers.js');
const vectors = require('./vectors.json');
function setFor(id = '2-2', version = 4, msizeCode = 1) {
  return vc.makeSet(vectors.sets[0].text, id, version, 'M', msizeCode, detRng());
}
function rectangles(path) {
  const pattern = /M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)z/g;
  const matches = [...path.matchAll(pattern)];
  assert.equal(matches.map(match => match[0]).join(''), path);
  return matches.map(([, x, y, w, h, back]) => {
    assert.equal(Number(w), -Number(back)); return { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
  });
}
function covered(rects, x, y) { return rects.some(rect => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h); }
function at(image, xMm, yMm) {
  const { originX, originY, pxPerMm } = image.geometry;
  const x = Math.floor((xMm - originX) * pxPerMm), y = Math.floor((yMm - originY) * pxPerMm);
  return image.gray[y * image.w + x];
}
for (const id of Object.keys(vc.SCHEMES)) {
  test(`${id}: SVG runs reproduce every QR/calibration subpixel and all 48 metadata bits`, () => {
    const set = setFor(id), B = vc.basis(id), block = set.layout.normal;
    for (let index = 0; index < B.n; index++) {
      const paths = render.sheetPaths(set, index), rects = rectangles(paths.normalPath);
      assert.equal(paths.mirrorPath, paths.normalPath); assert.equal(paths.mirrorTransform, 'translate(0 297) scale(1 -1)');
      for (let row = 0; row < set.N * B.r; row++) for (let col = 0; col < set.N * B.c; col++) {
        const x = block.x + 4 * set.m + (col + 0.5) * set.m / B.c;
        const y = block.y + 4 * set.m + (row + 0.5) * set.m / B.r;
        assert.equal(Number(covered(rects, x, y)), set.data[index][row * set.N * B.c + col]);
      }
      for (let row = 0; row < 8 * B.r; row++) for (let col = 0; col < 2 * B.c; col++) {
        const x = block.calib.x + (col + 0.5) * set.m / B.c, y = block.calib.y + (row + 0.5) * set.m / B.r;
        assert.equal(Number(covered(rects, x, y)), set.calib[index][row * 2 * B.c + col]);
      }
      for (let i = 0; i < 48; i++) {
        const x = block.band.x + (i % 3 + 0.5) * set.m, y = block.band.y + (Math.floor(i / 3) + 0.5) * set.m;
        assert.equal(Number(covered(rects, x, y)), set.band[i]);
      }
      assert.ok(!covered(rects, block.x + set.m, block.y + set.m));
    }
  });
}
test('paths include exactly positioned hollow/solid marks and are inside the eight millimetre margin', () => {
  for (const [version, msizeCode] of [[3, 1], [4, 1], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0]]) {
    const set = setFor('2-2', version, msizeCode), paths = render.sheetPaths(set, 0), rects = rectangles(paths.normalPath);
    for (const mark of set.layout.normal.marks) {
      assert.equal(covered(rects, mark.x + 1.5, mark.y + 1.5), !mark.hollow);
      assert.ok(covered(rects, mark.x + 0.3, mark.y + 0.3));
    }
    for (const rect of [...rects, ...rectangles(paths.rulerPath)]) {
      assert.ok(rect.x >= 8 && rect.x + rect.w <= 202 + 1e-8);
      assert.ok(rect.y >= 8 && rect.y + rect.h <= 289 + 1e-8);
    }
    for (const rect of rects) {
      const mirroredY = 297 - rect.y - rect.h;
      assert.ok(mirroredY >= 8 && mirroredY + rect.h <= 289 + 1e-8);
    }
  }
});
test('ruler SVG contains a 100mm vertical baseline and 50mm horizontal baseline', () => {
  const list = rectangles(render.sheetPaths(setFor(), 0).rulerPath);
  assert.ok(list.some(rect => rect.x === 197 && rect.y === 100 && rect.w === 0.12 && rect.h === 100));
  assert.ok(list.some(rect => rect.x === 80 && rect.y === 20 && rect.w === 50 && rect.h === 0.12));
});
test('normal and mirror samples coincide after physically turning a sheet over vertically', () => {
  const set = setFor(), original = render.synthStack(set, [1], { pxPerMm: 4, ink: 1, floor: 0 });
  const turned = render.synthStack(set, [1], { pxPerMm: 4, ink: 1, floor: 0, flipped: [false, true] });
  assert.deepEqual(turned.gray, original.gray);
  const full = render.synthStack(set, [0], { pxPerMm: 4, fullPage: true, ink: 1, floor: 0 });
  assert.equal(full.w, 840); assert.equal(full.h, 1188);
  const B = vc.basis(set.id), block = set.layout.normal;
  for (let row = 0; row < set.N * B.r; row++) for (let col = 0; col < set.N * B.c; col++) {
    const x = block.x + 4 * set.m + (col + 0.5) * set.m / B.c;
    const y = block.y + 4 * set.m + (row + 0.5) * set.m / B.r;
    assert.equal(at(full, x, y), at(full, x, 297 - y));
  }
  for (const mark of block.marks) assert.equal(at(full, mark.x + 1.5, mark.y + 1.5), at(full, mark.x + 1.5, 297 - mark.y - 1.5));
});
test('production synthesis blurs each layer before multiplying transmittance', () => {
  const set = setFor(), opts = { pxPerMm: 4, ink: [0.6, 0.8], blur: [1, 2], dx: [0, 0.15], floor: 0 };
  const a = render.synthStack(set, [0], opts), b = render.synthStack(set, [1], opts), both = render.synthStack(set, [0, 1], opts);
  assert.equal(a.w, both.W); assert.equal(a.h, both.H);
  let differing = 0;
  for (let i = 0; i < both.gray.length; i++) {
    const product = Math.round(a.gray[i] * b.gray[i] / 255);
    assert.ok(Math.abs(product - both.gray[i]) <= 1);
    if (a.gray[i] !== b.gray[i]) differing++;
  }
  assert.ok(differing > 1000);
  assert.deepEqual(render.synthStack(set, [1, 0], opts).gray, both.gray);
});
test('zero ink, per-sheet translations and rotations are image operations without changing shares', () => {
  const set = setFor(), before = set.data.map(hash), base = render.synthStack(set, [0, 1]);
  const white = render.synthStack(set, [0, 1], { ink: 0 });
  assert.ok(white.gray.every(value => value === 255));
  const shifted = render.synthStack(set, [0, 1], { dx: [0, 0.2], dy: [0, 0.1], rot: [0, 0.1] });
  assert.notEqual(hash(base.gray), hash(shifted.gray)); assert.deepEqual(set.data.map(hash), before);
});
test('scene rotation, projective transform, illumination and explicitly seeded noise are reproducible', () => {
  const set = setFor(), opts = { pxPerMm: 3, sceneRotation: 1, projective: [1, 0.01, 0, 0, 1, 0, 0.00001, 0.00002, 1],
    tilt: [0.08, -0.06], gain: 0.9, noise: 0.01, noiseSeed: 125 };
  const a = render.synthStack(set, [0, 1], opts), b = render.synthStack(set, [0, 1], opts);
  assert.deepEqual(a.gray, b.gray); assert.equal(a.geometry.transform.length, 9);
  assert.ok(a.geometry.transform.every(Number.isFinite));
  assert.notEqual(hash(a.gray), hash(render.synthStack(set, [0, 1], { pxPerMm: 3 }).gray));
});
test('untrusted dimensions, malformed sheets and invalid synthesis options stop before output', () => {
  const set = setFor();
  assert.throws(() => render.sheetPaths(set, -1)); assert.throws(() => render.sheetPaths({ ...set, N: 34 }, 0));
  assert.throws(() => render.synthStack(set, [0, 0])); assert.throws(() => render.synthStack(set, []));
  for (const opts of [{ pxPerMm: 0 }, { ink: 2 }, { blur: 0.5 }, { noise: 0.1 }, { tilt: [1, 0] }, { dx: NaN },
    { projective: [0, 0, 0, 0, 0, 0, 0, 0, 0] }]) assert.throws(() => render.synthStack(set, [0, 1], opts));
});
