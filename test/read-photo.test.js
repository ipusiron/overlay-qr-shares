/* Overlay QR Shares - MIT (c) 2026 ipusiron. Python pipeline uses only public test fixtures. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const vc = require('../vc-core.js');
const qr = require('../qr.js');
const render = require('../render-core.js');
const jsQR = require('../vendor/jsQR.js');
const { detRng, hash } = require('./helpers.js');
const vectors = require('./vectors.json');
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'read_photo.py');
const TEMP_ROOT = path.join(ROOT, '.work');
const PYTHON = (process.env.OQS_PYTHON ? [process.env.OQS_PYTHON] : ['python', 'python3']).find(command => {
  const found = spawnSync(command, ['-B', '-c', 'import sys;sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { timeout: 10000 });
  return !found.error && found.status === 0;
});
const needsPython = { skip: PYTHON ? false : 'Python 3.8+ is unavailable; set OQS_PYTHON to run the independent photo-reader checks' };
function python(args, input) {
  return spawnSync(PYTHON, ['-B', ...args], { cwd: ROOT, encoding: 'utf8', input, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
}
function temporary(callback) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(TEMP_ROOT, 'qa-read-photo-'));
  try { return callback(folder); }
  finally {
    assert.equal(path.dirname(path.resolve(folder)), TEMP_ROOT);
    assert.ok(path.basename(folder).startsWith('qa-read-photo-'));
    fs.rmSync(folder, { recursive: true });
  }
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind, data) {
  const name = Buffer.from(kind), out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), out.length - 4);
  return out;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function header(w, h, color = 0, depth = 8, interlace = 0) {
  const bytes = Buffer.alloc(13); bytes.writeUInt32BE(w); bytes.writeUInt32BE(h, 4);
  bytes[8] = depth; bytes[9] = color; bytes[12] = interlace; return chunk('IHDR', bytes);
}
function paeth(a, b, c) {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
function png(pixels, w, h, color = 0, filter = 0) {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color], stride = w * channels, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const type = Array.isArray(filter) ? filter[y % filter.length] : filter;
    raw[y * (stride + 1)] = type;
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i, left = i >= channels ? pixels[at - channels] : 0;
      const above = y ? pixels[at - stride] : 0, upperLeft = y && i >= channels ? pixels[at - stride - channels] : 0;
      const predict = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][type] || 0;
      raw[y * (stride + 1) + 1 + i] = (pixels[at] - predict) & 255;
    }
  }
  try { return Buffer.concat([signature, header(w, h, color), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
  finally { raw.fill(0); }
}
function decodePbm(bytes) {
  const match = /^P4\n(\d+) (\d+)\n/.exec(bytes.subarray(0, 50).toString('ascii'));
  assert.ok(match, 'binary PBM header');
  const w = Number(match[1]), h = Number(match[2]), stride = Math.ceil(w / 8), offset = match[0].length;
  assert.equal(bytes.length - offset, stride * h);
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  try {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (bytes[offset + y * stride + Math.floor(x / 8)] & (0x80 >> (x % 8))) {
        const pos = (y * w + x) * 4; rgba[pos] = rgba[pos + 1] = rgba[pos + 2] = 0;
      }
    }
    const result = jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' });
    assert.ok(result, 'independent jsQR decodes Python PBM');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(result.binaryData)); }
    finally { result.binaryData.fill(0); }
  } finally { rgba.fill(0); }
}
function cornersFor(set, image, mirrored = false) {
  const { originX, originY, pxPerMm, transform } = image.geometry, marks = set.layout.normal.marks;
  return [marks[0], marks[1], marks[3], marks[2]].map(mark => {
    const x = (mark.x + 1.5 - originX) * pxPerMm;
    const y = ((mirrored ? 297 - mark.y - 1.5 : mark.y + 1.5) - originY) * pxPerMm;
    if (!transform) return { x, y };
    const d = transform[6] * x + transform[7] * y + transform[8];
    return { x: (transform[0] * x + transform[1] * y + transform[2]) / d,
      y: (transform[3] * x + transform[4] * y + transform[5]) / d };
  });
}
function cornerArgument(points) { return points.map(point => point.x.toFixed(6) + ',' + point.y.toFixed(6)).join(' '); }
function runPipeline(folder, set, image, corners, suffix = '', extra = []) {
  const input = path.join(folder, 'photo' + suffix + '.png'), output = path.join(folder, 'recovered' + suffix + '.pbm');
  const encoded = png(image.gray, image.w, image.h);
  try { fs.writeFileSync(input, encoded); } finally { encoded.fill(0); }
  const result = python([SCRIPT, input, '--corners', cornerArgument(corners), '--output', output, ...extra]);
  assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr, error: result.error }));
  assert.match(result.stdout, /secret text has not been verified/);
  assert.ok(!result.stdout.includes(set.text || vectors.sets[0].text));
  const pbm = fs.readFileSync(output);
  try { return decodePbm(pbm); } finally { pbm.fill(0); }
}
function clear(set, image) {
  image.gray.fill(0); set.modules.fill(0); set.plain.fill(0); set.band.fill(0);
  set.data.forEach(bytes => bytes.fill(0)); set.calib.forEach(bytes => bytes.fill(0));
}
for (const [index, vector] of vectors.sets.entries()) {
  test(`Python PNG to PBM to jsQR reproduces frozen vector ${index + 1} (${vector.id})`, needsPython, () => temporary(folder => {
    const set = vc.makeSet(vector.text, vector.id, vector.version, vector.ecl, vector.msizeCode, detRng());
    const image = render.synthStack(set, Array.from({ length: set.k }, (_, i) => i), { pxPerMm: 8, gain: 0.8 });
    try {
      assert.deepEqual(set.data.map(hash), vector.sheetSha256);
      assert.equal(runPipeline(folder, set, image, cornersFor(set, image)), vector.text);
    } finally { clear(set, image); }
  }));
}
for (const [index, id] of Object.keys(vc.SCHEMES).entries()) {
  const version = index < 5 ? index + 3 : index - 2, size = index < 5 ? 0 : 1;
  test(`Python covers scheme ${id}, layout version ${version}, size code ${size}`, needsPython, () => temporary(folder => {
    const set = vc.makeSet(vectors.sets[0].text, id, version, 'Q', size, detRng());
    const image = render.synthStack(set, Array.from({ length: set.k }, (_, i) => i), { pxPerMm: 10, gain: 0.8, tilt: 0.25 });
    try { assert.equal(runPipeline(folder, set, image, cornersFor(set, image)), vectors.sets[0].text); }
    finally { clear(set, image); }
  }));
}
test('Python accepts all eight corner rotations/reflections and explicit scaled PBM output', needsPython, () => temporary(folder => {
  const set = vc.makeSet(vectors.sets[0].text, '2-2', 4, 'M', 1, detRng());
  const image = render.synthStack(set, [0, 1], { pxPerMm: 6 });
  try {
    const original = cornersFor(set, image);
    for (let rotation = 0; rotation < 4; rotation++) {
      const points = original.map((_, i) => original[(i + rotation) % 4]);
      for (let reflected = 0; reflected < 2; reflected++) {
        const corners = reflected ? [points[0], points[3], points[2], points[1]] : points;
        assert.equal(runPipeline(folder, set, image, corners, rotation + '-' + reflected, ['--scale', '5']), vectors.sets[0].text);
      }
    }
  } finally { clear(set, image); }
}));
test('Python projective sampling handles scene rotation, independent shift/blur and a light slope', needsPython, () => temporary(folder => {
  const set = vc.makeSet(vectors.sets[0].text, '2-2', 4, 'M', 1, detRng());
  const image = render.synthStack(set, [0, 1], { pxPerMm: 8, dx: [0, 0.15], blur: 1, ink: 0.7, gain: 0.8, tilt: 0.2,
    sceneRotation: 1, projective: [1, 0.015, 0, -0.01, 1, 3, 0.00001, -0.00001, 1] });
  try { assert.equal(runPipeline(folder, set, image, cornersFor(set, image)), vectors.sets[0].text); }
  finally { clear(set, image); }
}));
test('Python reads the physical mirror half of a full A4 image', needsPython, () => temporary(folder => {
  const set = vc.makeSet(vectors.sets[0].text, '2-2', 4, 'M', 1, detRng());
  const image = render.synthStack(set, [0, 1], { pxPerMm: 6, fullPage: true });
  try { assert.equal(runPipeline(folder, set, image, cornersFor(set, image, true)), vectors.sets[0].text); }
  finally { clear(set, image); }
}));
test('independent Python public-pattern mask and values equal all QR versions for both error levels', needsPython, () => {
  const result = python(['-c', 'import json,read_photo;print(json.dumps([list(map(list,read_photo.fixed_patterns(v))) for v in range(3,8)]))']);
  assert.equal(result.status, 0, result.stderr);
  const patterns = JSON.parse(result.stdout);
  for (let version = 3; version <= 7; version++) {
    const [mask, bits] = patterns[version - 3];
    assert.deepEqual(mask, Array.from(qr.plainMask(version)));
    for (const ecl of ['M', 'Q']) {
      const encoded = qr.encode(vectors.sets[0].text, version, ecl);
      try { for (let i = 0; i < mask.length; i++) if (mask[i]) assert.equal(bits[i], encoded.modules[i], `${version}/${ecl} at ${i}`); }
      finally { encoded.modules.fill(0); }
    }
  }
});
test('PNG filters 0..4, grayscale/RGB/alpha, and split IDAT reconstruct exact pixel values', needsPython, () => temporary(folder => {
  const cases = [];
  for (const color of [0, 2, 4, 6]) for (let filter = 0; filter < 5; filter++) {
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color], pixels = Buffer.alloc(5 * 5 * channels), expected = [];
    for (let i = 0; i < 25; i++) {
      const r = i * 43 % 256, g = i * 61 % 256, b = i * 101 % 256, a = i * 37 % 256;
      const values = color === 0 ? [r] : color === 2 ? [r, g, b] : color === 4 ? [r, a] : [r, g, b, a];
      pixels.set(values, i * channels);
      const lum = color === 0 || color === 4 ? r : Math.floor((299 * r + 587 * g + 114 * b + 500) / 1000);
      const alpha = color === 4 || color === 6 ? a : 255;
      expected.push(Math.floor((lum * alpha + 255 * (255 - alpha) + 127) / 255));
    }
    const file = path.join(folder, `c${color}-f${filter}.png`), encoded = png(pixels, 5, 5, color, filter);
    fs.writeFileSync(file, encoded); cases.push({ file, expected }); pixels.fill(0); encoded.fill(0);
  }
  const sample = fs.readFileSync(cases[0].file), size = sample.readUInt32BE(33), body = sample.subarray(41, 41 + size);
  const split = Buffer.concat([sample.subarray(0, 33), chunk('IDAT', body.subarray(0, 2)), chunk('IDAT', body.subarray(2)),
    chunk('IEND', Buffer.alloc(0))]);
  const file = path.join(folder, 'split.png'); fs.writeFileSync(file, split); cases.push({ file, expected: cases[0].expected });
  const code = 'import json,sys,read_photo;print(json.dumps([list(read_photo.load_png(p)[0]) for p in json.load(sys.stdin)]))';
  const result = python(['-c', code], JSON.stringify(cases.map(item => item.file)));
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), cases.map(item => item.expected));
}));
test('PNG rejects malformed chunks, CRC, unsupported formats and bounded decompression failures', needsPython, () => temporary(folder => {
  const end = chunk('IEND', Buffer.alloc(0)), idat = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 42])));
  const valid = Buffer.concat([signature, header(1, 1), idat, end]), badCrc = Buffer.from(valid); badCrc[badCrc.length - 1] ^= 1;
  const malformed = [Buffer.from('JPEG'), valid.subarray(0, 20), badCrc,
    Buffer.concat([signature, header(0, 1), idat, end]), Buffer.concat([signature, header(24000001, 1), idat, end]),
    Buffer.concat([signature, header(6000, 6000), idat, end]),
    Buffer.concat([signature, header(1, 1, 3), idat, end]), Buffer.concat([signature, header(1, 1, 0, 16), idat, end]),
    Buffer.concat([signature, header(1, 1, 0, 8, 1), idat, end]), Buffer.concat([signature, header(1, 1), header(1, 1), idat, end]),
    Buffer.concat([signature, header(1, 1), chunk('ABCD', Buffer.alloc(0)), idat, end]),
    Buffer.concat([signature, header(1, 1), chunk('tRNS', Buffer.from([0, 0])), idat, end]),
    Buffer.concat([signature, header(1, 1), chunk('IDAT', zlib.deflateSync(Buffer.from([5, 42]))), end]),
    Buffer.concat([signature, header(1, 1), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 42, 0]))), end]),
    Buffer.concat([signature, header(1, 1), chunk('IDAT', zlib.deflateSync(Buffer.from([0]))), end]),
    Buffer.concat([signature, header(1, 1), chunk('IDAT', Buffer.concat([zlib.deflateSync(Buffer.from([0, 42])), Buffer.from([0])])), end]),
    Buffer.concat([signature, header(1, 1), idat, chunk('tEXt', Buffer.alloc(0)), idat, end]),
    Buffer.concat([valid, Buffer.from([0])]), valid.subarray(0, valid.length - 12)];
  const files = malformed.map((bytes, i) => { const file = path.join(folder, i + '.png'); fs.writeFileSync(file, bytes); return file; });
  const code = ['import json,sys,read_photo', 'results=[]', 'for p in json.load(sys.stdin):',
    ' try: read_photo.load_png(p);results.append(False)', ' except (ValueError,read_photo.zlib.error): results.append(True)',
    'print(json.dumps(results))'].join('\n');
  const result = python(['-c', code], JSON.stringify(files));
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), files.map(() => true));
}));

test('damaged band CRC is rejected before PBM output, with no recovered image written', needsPython, () => temporary(folder => {
  const set = vc.makeSet(vectors.sets[0].text, '2-2', 4, 'M', 1, detRng());
  const image = render.synthStack(set, [0, 1], { pxPerMm: 8 });
  try {
    const band = set.layout.normal.band, { originX, originY, pxPerMm } = image.geometry;
    const bit = 40, row = Math.floor(bit / 3), col = bit % 3;
    const x0 = Math.floor((band.x + col * set.m - originX) * pxPerMm);
    const x1 = Math.ceil((band.x + (col + 1) * set.m - originX) * pxPerMm);
    const y0 = Math.floor((band.y + row * set.m - originY) * pxPerMm);
    const y1 = Math.ceil((band.y + (row + 1) * set.m - originY) * pxPerMm);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) image.gray[y * image.w + x] = set.band[bit] ? 255 : 13;
    const input = path.join(folder, 'corrupted-band.png'), output = path.join(folder, 'corrupted-band.pbm');
    const encoded = png(image.gray, image.w, image.h);
    try { fs.writeFileSync(input, encoded); } finally { encoded.fill(0); }
    const result = python([SCRIPT, input, '--corners', cornerArgument(cornersFor(set, image)), '--output', output]);
    assert.equal(result.status, 1, result.stdout); assert.match(result.stderr, /no valid OQS band/);
    assert.equal(fs.existsSync(output), false);
  } finally { clear(set, image); }
}));

test('CLI validates corners and refuses output overwrite; failed band emits no PBM', needsPython, () => temporary(folder => {
  const image = path.join(folder, 'white.png'), output = path.join(folder, 'out.pbm');
  fs.writeFileSync(image, png(new Uint8Array(10000).fill(255), 100, 100));
  for (const corners of ['0,0 0,0 0,0 0,0', 'NaN,4 80,4 80,80 4,80', '4,4 80,80 80,4 4,80']) {
    const result = python([SCRIPT, image, '--corners', corners, '--output', output]);
    assert.equal(result.status, 2); assert.equal(fs.existsSync(output), false);
  }
  const args = [SCRIPT, image, '--corners', '4,4 80,4 80,80 4,80', '--output', output];
  const failure = python(args); assert.equal(failure.status, 1); assert.match(failure.stderr, /no valid OQS band/);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(output, 'KEEP'); const existing = python(args);
  assert.equal(existing.status, 1); assert.match(existing.stderr, /output already exists/); assert.equal(fs.readFileSync(output, 'utf8'), 'KEEP');
  assert.equal(python([SCRIPT, image, '--corners', '4,4 80,4 80,80 4,80', '--output', output, '--scale', '0']).status, 2);
}));
