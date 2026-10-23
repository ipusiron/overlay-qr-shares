'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reader = require('../reader-core.js');
const render = require('../render-core.js');
const vc = require('../vc-core.js');
const qr = require('../qr.js');
const { seededRng, detRng } = require('./helpers.js');
const vectors = require('./vectors.json');
const DEMO = vectors.sets[0].text;
function make(id = '2-2', version = 4, code = 1, options = {}) {
  const set = vc.makeSet(DEMO, id, version, 'M', code, seededRng(0x125cafe));
  const indices = Array.from({ length: set.k }, (_, i) => i);
  const image = render.synthStack(set, indices, { pxPerMm: 10, ink: 0.85, ...options });
  return { set, image, dispose() {
    image.gray.fill(0); set.modules.fill(0); set.data.forEach(array => array.fill(0));
    set.calib.forEach(array => array.fill(0)); set.band.fill(0);
  } };
}
function frame(image) { return { gray: image.gray, w: image.w, h: image.h }; }
function orient(image, rotation = 0, mirrored = false) {
  const odd = rotation % 2, w = odd ? image.h : image.w, h = odd ? image.w : image.h;
  const gray = new Uint8ClampedArray(w * h);
  for (let y = 0; y < image.h; y++) for (let x = 0; x < image.w; x++) {
    let xx, yy;
    if (rotation === 0) { xx = x; yy = y; }
    if (rotation === 1) { xx = image.h - 1 - y; yy = x; }
    if (rotation === 2) { xx = image.w - 1 - x; yy = image.h - 1 - y; }
    if (rotation === 3) { xx = y; yy = image.w - 1 - x; }
    if (mirrored) xx = w - 1 - xx;
    gray[yy * w + xx] = image.gray[y * image.w + x];
  }
  return { gray, w, h };
}
function corners(fixture) {
  const { set, image } = fixture, { originX, originY, pxPerMm } = image.geometry;
  const marks = set.layout.normal.marks;
  return [marks[0], marks[1], marks[3], marks[2]].map(mark => ({
    x: (mark.x + 1.5 - originX) * pxPerMm, y: (mark.y + 1.5 - originY) * pxPerMm
  }));
}
function rectangle(image, x, y, w, h, value) {
  for (let row = Math.max(0, Math.floor(y)); row < Math.min(image.h, Math.ceil(y + h)); row++) {
    for (let col = Math.max(0, Math.floor(x)); col < Math.min(image.w, Math.ceil(x + w)); col++) image.gray[row * image.w + col] = value;
  }
}
for (const id of Object.keys(vectors.basis)) {
  test(`image-only automatic reader recovers scheme ${id} and its metadata`, () => {
    const fixture = make(id);
    try {
      const result = reader.readFrame(frame(fixture.image));
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
      assert.equal(result.metadata.id, id); assert.equal(result.metadata.version, 4); assert.equal(result.metadata.setId, fixture.set.setId);
      assert.equal(result.diag.marks, 4); assert.equal(result.corners.length, 4);
    } finally { fixture.dispose(); }
  });
}
for (const [version, code] of [[3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [3, 1]]) {
  test(`finder spacing and metadata resolve version ${version}, size ${code}`, () => {
    const fixture = make('2-2', version, code);
    try {
      const result = reader.readFrame(frame(fixture.image));
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
      assert.equal(result.metadata.version, version); assert.equal(result.metadata.msizeCode, code);
    } finally { fixture.dispose(); }
  });
}
test('all four rotations and both reflections are detected from pixels', () => {
  const fixture = make();
  try {
    for (let rotation = 0; rotation < 4; rotation++) for (const mirrored of [false, true]) {
      const image = orient(fixture.image, rotation, mirrored);
      try {
        const result = reader.readFrame(image);
        assert.equal(result.ok, true, JSON.stringify({ rotation, mirrored, result })); assert.equal(result.text, DEMO);
      } finally { image.gray.fill(0); }
    }
  } finally { fixture.dispose(); }
});
test('projective camera geometry and a one-degree scene rotation are resolved without metadata', () => {
  const fixture = make('2-2', 4, 1, { pxPerMm: 8, sceneRotation: 1,
    projective: [0.92, 0.025, 15, 0.025, 0.92, 15, 0.000035, 0.00002, 1], blur: 1, dx: [0, 0.15], ink: 0.7, gain: 0.8, tilt: [0.15, -0.1] });
  try {
    const result = reader.readFrame(frame(fixture.image));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
  } finally { fixture.dispose(); }
});
test('full A4 contains eight registration marks and tolerates extra square distractors', () => {
  const fixture = make('2-2', 4, 1, { fullPage: true, pxPerMm: 6, blur: 1 });
  try {
    const image = fixture.image;
    for (let i = 0; i < 6; i++) {
      const x = 60 + i * 90, y = 80;
      rectangle(image, x, y, 18, 18, 15);
      if (i % 2 === 0) rectangle(image, x + 5, y + 5, 8, 8, 255);
    }
    const detection = reader.detectMarks(frame(image));
    assert.ok(detection.candidates.length > 8); assert.ok(detection.candidates.filter(candidate => candidate.hollow).length >= 2);
    assert.ok(detection.width <= 640 && detection.height <= 640);
    const result = reader.readFrame(frame(image));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
  } finally { fixture.dispose(); }
});
test('manual points and snapping use original image coordinates', () => {
  const fixture = make('2-2', 4, 1, { pxPerMm: 8 });
  try {
    const points = corners(fixture), image = frame(fixture.image);
    const snapped = reader.snapPoint(image, { x: points[0].x + 6, y: points[0].y - 4 }, 15);
    assert.equal(snapped.ok, true); assert.ok(Math.hypot(snapped.x - points[0].x, snapped.y - points[0].y) < 1);
    const result = reader.readFrame(image, { manualCorners: points });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
    assert.equal(reader.snapPoint(image, { x: 0, y: 0 }, 1).ok, false);
    assert.equal(reader.readFrame(image, { manualCorners: [points[0], points[2], points[1], points[3]] }).reason, 'manual');
    const wrong = points.map(point => ({ x: point.x + 80, y: point.y + 30 }));
    assert.equal(reader.readFrame(image, { manualCorners: wrong }).ok, false);
  } finally { fixture.dispose(); }
});
test('a supplied reduced frame locates marks while sampling uses the original frame', () => {
  const fixture = make('5-5', 4, 1, { pxPerMm: 12 });
  const image = frame(fixture.image), scale = 640 / Math.max(image.w, image.h), w = Math.round(image.w * scale), h = Math.round(image.h * scale);
  const detectImage = { gray: new Uint8ClampedArray(w * h), w, h };
  try {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      detectImage.gray[y * w + x] = image.gray[Math.floor((y + 0.5) * image.h / h) * image.w + Math.floor((x + 0.5) * image.w / w)];
    }
    const before = detectImage.gray.slice(), result = reader.readFrame(image, { detectImage });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, DEMO);
    assert.deepEqual(detectImage.gray, before); before.fill(0);
  } finally { detectImage.gray.fill(0); fixture.dispose(); }
});
test('missing hollow marker and damaged band never expose a result', () => {
  const fixture = make();
  try {
    const point = corners(fixture)[0]; rectangle(fixture.image, point.x - 20, point.y - 20, 40, 40, 255);
    assert.equal(reader.readFrame(frame(fixture.image)).ok, false);
  } finally { fixture.dispose(); }
  const set = vc.makeSet(DEMO, '2-2', 4, 'M', 1, detRng()); set.band[47] ^= 1;
  const image = render.synthStack(set, [0, 1], { pxPerMm: 8 });
  try {
    const result = reader.readFrame(frame(image)); assert.equal(result.ok, false); assert.equal(result.reason, 'band');
    assert.ok(!Object.hasOwn(result, 'text'));
  } finally { image.gray.fill(0); set.data.forEach(bytes => bytes.fill(0)); set.calib.forEach(bytes => bytes.fill(0)); }
});
test('a single sheet cannot become a successful automatic read', () => {
  const set = vc.makeSet(DEMO, '2-2', 4, 'M', 1, detRng()), image = render.synthStack(set, [0], { pxPerMm: 10 });
  try { assert.equal(reader.readFrame(frame(image)).ok, false); }
  finally { image.gray.fill(0); set.data.forEach(bytes => bytes.fill(0)); set.calib.forEach(bytes => bytes.fill(0)); }
});
test('center-only sampling fails for 5-of-5 while equal subpixel sampling succeeds', () => {
  const fixture = make('5-5', 4, 1, { pxPerMm: 12 }), { set, image } = fixture;
  const values = new Float64Array(set.N * set.N), modules = new Uint8Array(values.length), plain = qr.plainMask(set.version);
  try {
    const { originX, originY, pxPerMm } = image.geometry, q = set.layout.normal;
    for (let row = 0; row < set.N; row++) for (let col = 0; col < set.N; col++) {
      const x = Math.floor((q.x + (4.5 + col) * set.m - originX) * pxPerMm);
      const y = Math.floor((q.y + (4.5 + row) * set.m - originY) * pxPerMm);
      values[row * set.N + col] = 1 - image.gray[y * image.w + x] / 255;
    }
    const data = values.filter((_, i) => !plain[i]), threshold = reader.otsu(data); data.fill(0);
    for (let i = 0; i < modules.length; i++) modules[i] = values[i] > (plain[i] ? 0.5 : threshold) ? 1 : 0;
    assert.equal(qr.decodeModules(modules, set.N).ok, false);
    const result = reader.readFrame(frame(image)); assert.equal(result.ok, true); assert.equal(result.text, DEMO);
  } finally { values.fill(0); modules.fill(0); plain.fill(0); fixture.dispose(); }
});
test('degenerate frames and homographies fail explicitly', () => {
  assert.equal(reader.readFrame({ gray: new Uint8Array(2), w: 2, h: 2 }).reason, 'image');
  assert.equal(reader.detectMarks({}).candidates.length, 0);
  assert.equal(reader.homography([{ x: 0, y: 0 }], []), null);
});
