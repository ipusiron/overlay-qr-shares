/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rng = require('../rng.js');
const vectors = require('./vectors.json');
const { detRng, u32Rng } = require('./helpers.js');
test('test-only deterministic source matches the provided byte vector', () => assert.deepEqual(Array.from(detRng()(16)), vectors.detRng_first16));
test('Uint32 little-endian and rejection avoid modulo bias', () => {
  assert.equal(rng.randbelow(4294967296, u32Rng([0x12345678])), 0x12345678);
  assert.equal(rng.randbelow(3, u32Rng([0xffffffff, 0xfffffffe])), 2);
  assert.equal(rng.randbelow(6, u32Rng([0xffffffff, 0xfffffffc, 17])), 5);
  assert.throws(() => rng.randbelow(3, u32Rng(Array(64).fill(0xffffffff))), /too many/);
});
for (const length of [3, 4, 6, 8]) {
  test(`Fisher-Yates exhaustive ${length}! accepted paths are bijective`, () => {
    const permutations = new Map(); let leaves = 0;
    function visit(bound, values) {
      if (bound === 1) {
        const value = rng.shuffle(length, u32Rng(values)).join(',');
        permutations.set(value, (permutations.get(value) || 0) + 1); leaves++; return;
      }
      for (let value = 0; value < bound; value++) visit(bound - 1, [...values, value]);
    }
    visit(length, []);
    const factorial = Array.from({ length }, (_, i) => i + 1).reduce((a, b) => a * b, 1);
    assert.equal(leaves, factorial); assert.equal(permutations.size, factorial);
    assert.ok([...permutations.values()].every(count => count === 1));
  });
}
test('secure source splits getRandomValues requests at 65536 bytes', () => {
  const calls = [], provider = { getRandomValues(bytes) { calls.push(bytes.length); bytes.fill(71); return bytes; } };
  const bytes = rng.cryptoRng(131073, provider);
  assert.deepEqual(calls, [65536, 65536, 1]); assert.equal(bytes.length, 131073); assert.ok(bytes.every(v => v === 71));
  assert.throws(() => rng.cryptoRng(1, {}), /unavailable/);
});
test('health check buffers and replays exactly first 64 bytes', () => {
  const source = detRng(), checked = rng.checkedRng(source), expected = detRng();
  assert.equal(source.count(), 64);
  for (const count of [4, 4, 10, 47, 257]) assert.deepEqual(checked(count), expected(count));
  assert.equal(source.count(), expected.count()); checked.destroy(); assert.throws(() => checked(1), /destroyed/);
  assert.throws(() => rng.checkedRng(count => new Uint8Array(count)), /health/);
  assert.throws(() => rng.checkedRng(count => new Uint8Array(count).fill(255)), /health/);
});
test('four equal bytes alone are valid; short and nonbyte sources are rejected', () => {
  assert.equal(rng.randbelow(4, count => new Uint8Array(count)), 0);
  assert.throws(() => rng.randbelow(4, () => new Uint8Array(3)), /bytes/);
  assert.throws(() => rng.checkedRng(() => Array(64).fill(1)), /bytes/);
  for (const value of [0, -1, 1.2, NaN, 4294967297]) assert.throws(() => rng.randbelow(value, detRng()));
  for (const value of [-1, 1.2, NaN, Infinity, 0x1000001]) assert.throws(() => rng.cryptoRng(value));
});
