/* Overlay QR Shares - MIT (c) 2026 ipusiron. Demonstrate lack of authentication. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vc = require('../vc-core.js');
const qr = require('../qr.js');
const vectors = require('./vectors.json');
const { seededRng } = require('./helpers.js');
for (const id of ['2-2', '3-3']) {
  test(`${id}: complementing one share at public delta positions changes the decoded QR including ECC`, () => {
    const source = vectors.sets.find(v => v.id === id), target = vectors.sets.find(v => v.id === id && v.text !== source.text);
    const set = vc.makeSet(source.text, id, source.version, source.ecl, source.msizeCode, seededRng()), B = vc.basis(id);
    const targetModules = Uint8Array.from(Buffer.from(target.modulesHex, 'hex'));
    const delta = set.modules.map((bit, i) => bit ^ targetModules[i]);
    // The modifying function receives only one share and delta, not either message.
    function modify(sheet, difference, N) {
      const changed = sheet.slice();
      for (let i = 0; i < difference.length; i++) if (difference[i]) {
        const row = Math.floor(i / N), col = i % N;
        for (let r = 0; r < B.r; r++) for (let c = 0; c < B.c; c++) changed[(row * B.r + r) * N * B.c + col * B.c + c] ^= 1;
      }
      return changed;
    }
    assert.ok(delta.every((bit, i) => !bit || !set.plain[i]));
    set.data[0] = modify(set.data[0], delta, set.N);
    assert.ok(vc.checkSheetWeights(set.data[0], set.N, set.plain, id));
    const modules = vc.stackModules(set.data, Array.from({ length: B.n }, (_, i) => i), set.N, set.plain, id);
    assert.deepEqual(modules, targetModules);
    assert.equal(qr.decodeModules(modules, set.N).text, target.text);
  });
}
