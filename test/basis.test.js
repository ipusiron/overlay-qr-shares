/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vc = require('../vc-core.js');
const vectors = require('./vectors.json');
for (const [id, vector] of Object.entries(vectors.basis)) {
  test(`basis ${id}: exact matrices, dimensions, subsets and theory`, () => {
    const B = vc.basis(id);
    for (const field of ['m', 'r', 'c', 'k', 'n', 'code']) assert.equal(B[field], vector[field]);
    for (const field of ['S0', 'S1']) assert.deepEqual(B[field].map(row => row.join('')), vector[field]);
    assert.equal(vc.checkBasis(id).ok, vector.oneLessWhiteEqBlack);
    for (const subset of vc.subsets(B.n)) {
      const columns = matrix => matrix[0].map((_, col) => subset.map(row => matrix[row][col]).join('')).sort();
      if (subset.length < B.k) assert.deepEqual(columns(B.S0), columns(B.S1));
    }
    for (const [count, expected] of Object.entries(vector.theory)) {
      const actual = vc.theory(id, Number(count));
      assert.deepEqual({ white: actual.white, black: actual.black }, expected);
      assert.equal(actual.blackMin, expected.black[0]); assert.equal(actual.blackMax, expected.black[1]);
    }
  });
}
test('physical recovery is conditional on the two observed module sizes', () => {
  assert.equal(Object.keys(vc.SCHEMES).length, Object.keys(vectors.basis).length);
  assert.equal(vc.PHYSICAL_TRIALS.length, 2);
  const trial = vc.PHYSICAL_TRIALS[0];
  assert.deepEqual(vc.PHYSICAL_TRIALS, [
    { id: '2-2', version: 4, ecl: 'M', m: 2.54, date: '2026-10-24',
      camera: 'iPhone', light: 'light-box', diagnosis: 'adequate' },
    { id: '2-2', version: 4, ecl: 'M', m: 2.032, date: '2026-10-24',
      camera: 'iPhone', light: 'light-box', diagnosis: 'insufficient' }
  ]);
  assert.equal(vc.SCHEMES['2-2'].status, 'conditional');
  for (const id of Object.keys(vc.SCHEMES)) {
    if (id !== '2-2') assert.equal(vc.SCHEMES[id].status, 'untested');
    for (const version of [3, 4, 5, 6, 7]) for (const ecl of ['M', 'Q']) for (const m of [2.032, 2.54]) {
      const expected = id === '2-2' && version === 4 && ecl === 'M' ? 'tested' : 'untested';
      assert.equal(vc.physicalStatus({ id, version, ecl, m }), expected);
    }
  }
  for (const parameters of [undefined, null, {}, { id: '2-2' }, { ...trial, version: '4' }, { ...trial, m: '2.54' }, { ...trial, m: 2.5 }]) {
    assert.equal(vc.physicalStatus(parameters), 'untested');
  }
  assert.throws(() => { trial.version = 3; });
  assert.throws(() => { vc.PHYSICAL_TRIALS.push({}); });
});
test('invalid schemes and theory counts are rejected; callers cannot mutate registry', () => {
  for (const id of ['3-5', '', '__proto__']) assert.throws(() => vc.basis(id));
  for (const count of [0, -1, 6, 1.5, NaN]) assert.throws(() => vc.theory('2-5', count));
  assert.throws(() => { vc.SCHEMES['2-2'].status = 'tested'; });
});
