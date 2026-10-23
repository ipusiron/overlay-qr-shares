'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../qr.js');
const vc = require('../vc-core.js');
const vectors = require('./vectors.json');
const { seededRng } = require('./helpers.js');

function formatPositions(N) {
  const positions = [];
  for (let bit = 0; bit < 15; bit++) {
    positions.push([(bit < 6 ? bit : bit < 8 ? bit + 1 : N - 15 + bit), 8]);
    positions.push([8, bit < 8 ? N - bit - 1 : bit < 9 ? 15 - bit : 14 - bit]);
  }
  return positions;
}
function formatWord(mask) {
  let value = mask << 10;
  const bits = x => x ? 32 - Math.clz32(x) : 0;
  while (bits(value) >= bits(0x537)) value ^= 0x537 << (bits(value) - bits(0x537));
  return ((mask << 10) | value) ^ 0x5412;
}
function chosenMask(encoded) {
  let word = 0;
  for (let bit = 0; bit < 15; bit++) {
    const row = bit < 6 ? bit : bit < 8 ? bit + 1 : encoded.N - 15 + bit;
    word |= encoded.modules[row * encoded.N + 8] << bit;
  }
  const result = Array.from({ length: 8 }, (_, i) => i).find(i => formatWord(i) === word);
  assert.notEqual(result, undefined);
  return result;
}
function maskBit(mask, row, col) {
  const product = row * col;
  return [
    (row + col) % 2 === 0, row % 2 === 0, col % 3 === 0, (row + col) % 3 === 0,
    (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
    product % 2 + product % 3 === 0, (product % 2 + product % 3) % 2 === 0,
    (product % 3 + (row + col) % 2) % 2 === 0
  ][mask] ? 1 : 0;
}
// The attacker knows a byte length and XOR delta, never the original secret or its QR matrix.
function publicDelta(byteLength, byteIndex, xorByte, version) {
  const dummy = new Uint8Array(byteLength).fill(65), changed = dummy.slice();
  changed[byteIndex] ^= xorByte;
  const a = qr.encode(new TextDecoder().decode(dummy), version, 'M');
  const b = qr.encode(new TextDecoder().decode(changed), version, 'M');
  const ma = chosenMask(a), mb = chosenMask(b), plain = qr.plainMask(version);
  for (const [row, col] of formatPositions(a.N)) plain[row * a.N + col] = 1;
  return Uint8Array.from(a.modules, (value, i) => plain[i] ? 0 : value ^ b.modules[i]
    ^ maskBit(ma, Math.floor(i / a.N), i % a.N) ^ maskBit(mb, Math.floor(i / a.N), i % a.N));
}
function changeOneShare(sheet, delta, N, id) {
  const changed = sheet.slice(), B = vc.basis(id);
  for (let i = 0; i < delta.length; i++) if (delta[i]) {
    const row = Math.floor(i / N), col = i % N;
    for (let y = 0; y < B.r; y++) for (let x = 0; x < B.c; x++) {
      changed[(row * B.r + y) * N * B.c + col * B.c + x] ^= 1;
    }
  }
  return changed;
}
for (const id of ['2-2', '3-3']) {
  test(`${id}: a public byte delta changes an unknown secret without its QR mask or plaintext`, () => {
    const vector = vectors.sets.find(v => v.id === id);
    const byteLength = new TextEncoder().encode(vector.text).length;
    const delta = publicDelta(byteLength, byteLength - 1, 1, vector.version);
    const set = vc.makeSet(vector.text, id, vector.version, 'M', 1, seededRng());
    set.data[0] = changeOneShare(set.data[0], delta, set.N, id);
    assert.ok(vc.checkSheetWeights(set.data[0], set.N, set.plain, id));
    const selected = Array.from({ length: set.k }, (_, i) => i);
    const modules = vc.stackModules(set.data, selected, set.N, set.plain, id);
    const result = qr.decodeModules(modules, set.N);
    const expectedBytes = new TextEncoder().encode(vector.text);
    expectedBytes[byteLength - 1] ^= 1;
    assert.equal(result.ok, true);
    assert.deepEqual(result.bytes, expectedBytes);
    result.bytes.fill(0);
  });
}
