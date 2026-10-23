/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vc = require('../vc-core.js');
const qr = require('../qr.js');
const layout = require('../layout-core.js');
const vectors = require('./vectors.json');
const { detRng, seededRng, hash, blockPattern, synth, readRectified } = require('./helpers.js');
for (const vector of vectors.sets) {
  test(`known set ${vector.id}/${vector.text}: every vector field and all threshold groups`, () => {
    const source = detRng(), set = vc.makeSet(vector.text, vector.id, vector.version, vector.ecl, vector.msizeCode, source);
    assert.equal(set.setId, vector.setId); assert.equal(set.N, vector.N);
    assert.equal(Buffer.from(set.modules).toString('hex'), vector.modulesHex);
    assert.deepEqual(set.data.map(hash), vector.sheetSha256); assert.deepEqual(set.calib.map(hash), vector.calibSha256);
    assert.equal([...set.band].join(''), vector.band); assert.equal(source.count(), vector.rngBytesUsed);
    const B = vc.basis(vector.id);
    for (const sheet of set.data) assert.ok(vc.checkSheetWeights(sheet, set.N, set.plain, vector.id));
    for (const sheet of set.calib) assert.ok(vc.sheetWeightsOk(sheet, 2, 8, null, vector.id));
    const groups = vc.subsets(B.n), ok = [], fail = [];
    for (const group of groups.filter(group => group.length === B.k || group.length === B.k - 1)) {
      const mod = vc.stackModules(set.data, group, set.N, set.plain, vector.id), decoded = qr.decodeModules(mod, set.N);
      if (group.length === B.k) { assert.ok(decoded.ok); assert.equal(decoded.text, vector.text); ok.push(group.join('')); }
      else { assert.ok(!decoded.ok || decoded.text !== vector.text); fail.push(group.join('')); }
      mod.fill(0); if (decoded.bytes) decoded.bytes.fill(0);
    }
    assert.deepEqual(ok.sort(), vector.combosOk.slice().sort()); assert.deepEqual(fail.sort(), vector.lesserFail.slice().sort());
    assert.deepEqual(layout.parseBand(set.band), { ok: true, fmt: 1, id: vector.id, version: vector.version, ecl: vector.ecl,
      msizeCode: vector.msizeCode, setId: vector.setId });
  });
}
test('all schemes reconstruct every authorized group and reject one fewer', () => {
  for (const id of Object.keys(vc.SCHEMES)) {
    const B = vc.basis(id), set = vc.makeSet(vectors.sets[0].text, id, 4, 'M', 1, seededRng());
    for (const group of vc.subsets(B.n).filter(g => g.length === B.k || g.length === B.k - 1)) {
      const decoded = qr.decodeModules(vc.stackModules(set.data, group, set.N, set.plain, id), set.N);
      assert.equal(decoded.ok && decoded.text === vectors.sets[0].text, group.length === B.k, id + group);
    }
  }
});
test('single-sheet distributions for white and black are independent within one generation (fixed seed chi-square)', () => {
  const source = seededRng(0x114455ee), hist = [new Map(), new Map()], B = vc.basis('2-2');
  for (let batch = 0; batch < 10; batch++) {
    const bits = Uint8Array.from({ length: 2000 }, (_, i) => i % 2);
    const sheet = vc.splitBits(bits, 40, null, '2-2', source)[1];
    for (let i = 0; i < bits.length; i++) {
      const pattern = blockPattern(sheet, Math.floor(i / 40), i % 40, 40, B), h = hist[bits[i]];
      h.set(pattern, (h.get(pattern) || 0) + 1);
    }
  }
  assert.equal(hist[0].size, 6); assert.equal(hist[1].size, 6);
  let statistic = 0;
  for (const [pattern, first] of hist[0]) { const second = hist[1].get(pattern), mean = (first + second) / 2; statistic +=
    (first - mean) ** 2 / mean + (second - mean) ** 2 / mean; }
  assert.ok(statistic < 15.086, `chi-square=${statistic}; df=5, p > 0.01`);
});
test('most-frequent projected-pattern and complement attacks cannot decode k-1 sheets', () => {
  for (const id of Object.keys(vc.SCHEMES)) {
    const B = vc.basis(id), set = vc.makeSet(vectors.sets[0].text, id, 4, 'M', 1, seededRng());
    for (const group of vc.subsets(B.n).filter(g => g.length === B.k - 1)) {
      const patterns = [], counts = new Map();
      for (let i = 0; i < set.N * set.N; i++) {
        const pattern = group.map(g => blockPattern(set.data[g], Math.floor(i / set.N), i % set.N, set.N, B)).join('|');
        patterns.push(pattern); if (!set.plain[i]) counts.set(pattern, (counts.get(pattern) || 0) + 1);
      }
      const most = [...counts].sort((a, b) => b[1] - a[1])[0][0], complement = most.replace(/[01]/g, bit => bit === '0' ? '1' : '0');
      for (const candidate of [most, complement]) for (const invert of [0, 1]) {
        const guessed = Uint8Array.from(patterns, (pattern, i) => set.plain[i] ? set.modules[i] : Number(pattern === candidate) ^ invert);
        const decoded = qr.decodeModules(guessed, set.N);
        assert.ok(!decoded.ok || decoded.text !== vectors.sets[0].text, id + group + candidate);
      }
    }
  }
});
test('faulty inputs and changed sheet weights are rejected', () => {
  const set = vc.makeSet(vectors.sets[0].text, '2-2', 4, 'M', 1, detRng());
  const bad = set.data[0].slice(), i = set.plain.findIndex(v => !v), row = Math.floor(i / set.N), col = i % set.N;
  bad[row * 2 * set.N * 2 + col * 2] ^= 1;
  assert.equal(vc.checkSheetWeights(bad, set.N, set.plain, '2-2'), false);
  assert.throws(() => vc.splitBits(Uint8Array.of(2), 1, null, '2-2', detRng()));
  assert.throws(() => vc.stack(set.data, [0, 0])); assert.throws(() => vc.stack(set.data, [2]));
  assert.throws(() => vc.makeSet('TEST-OQS-1', '2-2', 4, 'M', 1, n => new Uint8Array(n)), /health/);
  assert.equal(vc.makeSet('TEST-OQS-1', '2-2', 7, 'M', 1, detRng()).error, 'layout');
});
test('stage 1a reference reader representative consumes the complete supplied vector', () => {
  const expected = vectors.reader_2_2, set = vc.makeSet(vectors.sets[0].text, '2-2', 4, 'M', 1, detRng()), Wsub = set.N * 2;
  const read = readRectified(synth([[set.data[0], 0], [set.data[1], expected.shift]], Wsub, Wsub, expected.opt), set.N, set.plain, '2-2', expected.opt.px);
  assert.equal(read.modules.reduce((sum, value, i) => sum + Number(value !== set.modules[i]), 0), expected.errors);
  assert.equal(Number(read.threshold.toFixed(3)), expected.threshold);
  assert.equal(qr.decodeModules(read.modules, set.N).text === vectors.sets[0].text, expected.decoded);
  const one = readRectified(synth([[set.data[0], 0]], Wsub, Wsub, expected.opt), set.N, set.plain, '2-2', expected.opt.px);
  assert.equal(qr.decodeModules(one.modules, set.N).ok, expected.oneSheetDecoded);
});
