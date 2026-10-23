/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const qr = require('../qr.js');
const random = require('../rng.js');
const vectors = require('./vectors.json');
const { detRng, hash } = require('./helpers.js');
for (const [ecl, versions] of Object.entries(vectors.capacity)) for (const [versionString, expected] of Object.entries(versions)) {
  const version = Number(versionString);
  test(`fixed QR v${version}/${ecl} capacity matches vector`, () => {
    assert.equal(qr.capacity(version, ecl), expected);
    assert.equal(qr.encode('A'.repeat(expected), version, ecl).N, 17 + 4 * version);
    assert.equal(qr.encode('A'.repeat(expected + 1), version, ecl).error, 'capacity');
    assert.equal(qr.encode('A', version, ecl).N, 17 + 4 * version);
  });
}
test('UTF-8 Japanese boundary note and round trips, isolated surrogates, empty input', () => {
  assert.equal(vectors.utf8_note, "\u79d8\u00d720=60\u30d0\u30a4\u30c8\u306f\u72484\u30fbM \u306b\u5165\u308a\u3001\u79d8" +
    "\u00d721=63\u30d0\u30a4\u30c8\u306f\u5165\u3089\u306a\u3044");
  assert.equal(new TextEncoder().encode('\u79d8'.repeat(20)).length, 60);
  assert.ok(!qr.encode('\u79d8'.repeat(20), 4, 'M').error); assert.equal(qr.encode('\u79d8'.repeat(21), 4, 'M').error, 'capacity');
  for (const text of [
    '\ufeffTEST-OQS-1', ' \nTEST-OQS-1\n ', '\u{1f340}', vectors.sets[0].text,
    '\u79d8\u5bc6\u306e\u30e1\u30e2', '\u{1f340}\u30fbe\u0301'
  ]) {
    const encoded = qr.encode(text, 4, 'Q'), decoded = qr.decodeModules(encoded.modules, encoded.N);
    assert.ok(decoded.ok); assert.equal(decoded.text, text); assert.deepEqual(decoded.bytes, new TextEncoder().encode(text));
  }
  for (const text of ['\ud800', '\udc00', 'x\ud800x', '\udc00\ud800']) assert.equal(qr.encode(text, 4, 'M').error, 'surrogate');
  assert.equal(qr.encode('', 4, 'M').error, 'empty'); assert.equal(qr.encode(3, 4, 'M').error, 'text');
  for (const version of [0, 2, 8, '4']) assert.equal(qr.encode('X', version, 'M').error, 'parameters');
  assert.equal(qr.encode('X', 4, 'L').error, 'parameters');
});
test('vendor default low-byte encoding corrupts Japanese without global UTF-8 initialization', () => {
  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../vendor/qrcode.min.js'), 'utf8'), context);
  const vendor = context.module.exports, expected = [...new TextEncoder().encode('\u79d8\u5bc6\u306e\u30e1\u30e2')];
  assert.notDeepEqual(Array.from(vendor.stringToBytes('\u79d8\u5bc6\u306e\u30e1\u30e2')), expected);
  vendor.stringToBytes = vendor.stringToBytesFuncs['UTF-8']; assert.deepEqual(Array.from(vendor.stringToBytes('\u79d8\u5bc6\u306e\u30e1\u30e2')), expected);
});
test('decoder fatal UTF-8, fresh explicit options, mirror retry, and temporary RGBA cleanup', () => {
  const encoded = qr.encode(vectors.sets[0].text, 4, 'M'), buffers = [], opts = []; let calls = 0;
  const decoder = (rgba, w, h, options) => { assert.equal(w, h); buffers.push(rgba); opts.push(options); return ++calls === 1 ? null : { binaryData: [65] }; };
  const decoded = qr.decodeModules(encoded.modules, encoded.N, decoder);
  assert.equal(decoded.text, 'A'); assert.equal(decoded.mirrored, true); assert.equal(calls, 2);
  assert.notEqual(opts[0], opts[1]); for (const option of opts) assert.deepEqual(option, { inversionAttempts: 'attemptBoth' });
  for (const buffer of buffers) assert.ok(buffer.every(value => value === 0));
  assert.equal(qr.decodeModules(encoded.modules, encoded.N, () => ({ binaryData: [0xc0, 0xaf] })).reason, 'utf8');
  const mirror = encoded.modules.map((_, i) => encoded.modules[i % encoded.N * encoded.N + Math.floor(i / encoded.N)]);
  assert.equal(qr.decodeModules(mirror, encoded.N).text, vectors.sets[0].text);
});
for (const [versionString, expected] of Object.entries(vectors.plainMask)) {
  const version = Number(versionString);
  test(`plain mask v${version} count, hash and all 200 reference invariants`, () => {
    const mask = qr.plainMask(version), N = 17 + 4 * version, source = detRng();
    assert.equal(mask.reduce((a, b) => a + b), expected.count); assert.equal(hash(mask), expected.sha256);
    let first; const invariant = new Uint8Array(N * N).fill(1);
    for (let i = 0; i < 200; i++) {
      const text = Array.from({ length: 1 + random.randbelow(vectors.capacity.M[version] - 1, source) }, () =>
        String.fromCharCode(33 + random.randbelow(90, source))).join('');
      const modules = qr.encode(text, version, 'M').modules;
      if (!first) first = modules; else for (let j = 0; j < modules.length; j++) if (modules[j] !== first[j]) invariant[j] = 0;
    }
    assert.equal(invariant.reduce((a, b) => a + b), expected.invariantCount);
    assert.ok(mask.every((value, i) => !value || invariant[i]));
    assert.equal(mask[8 * N], 0); assert.equal(mask[8], 0); // Format data is secret, including the chosen mask.
  });
}
