/* Overlay QR Shares - MIT (c) 2026 ipusiron. Visual cryptography. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rng.js'), require('./qr.js'), require('./layout-core.js'));
  else { root.OQS = root.OQS || {}; root.OQS.vc = factory(root.OQS.rng, root.OQS.qr, root.OQS.layout); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (random, qr, layoutCore) {
  'use strict';
  const PHYSICAL_STATUS = 'untested';
  const SCHEMES = Object.freeze(Object.fromEntries([
    ['2-2', 2, 2, 'primary'], ['2-3', 2, 3, 'experimental'], ['2-4', 2, 4, 'experimental'], ['2-5', 2, 5, 'experimental'],
    ['3-3', 3, 3, 'film'], ['4-4', 4, 4, 'film'], ['5-5', 5, 5, 'film']
  ].map(([id, k, n, group], index) => [id, Object.freeze({ k, n, code: index + 1, group, status: PHYSICAL_STATUS })])));
  const PAIRS = Object.freeze([[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]].map(Object.freeze));
  function basis(id) {
    const scheme = Object.hasOwn(SCHEMES, id) ? SCHEMES[id] : null; if (!scheme) throw new RangeError('scheme');
    const rowOf = indices => Array.from({ length: 4 }, (_, i) => indices.includes(i) ? 1 : 0);
    let S0, S1, m;
    if (id === '2-2') { m = 4; S0 = [rowOf([0, 1]), rowOf([0, 1])]; S1 = [rowOf([0, 1]), rowOf([2, 3])]; }
    else if (scheme.k === 2) { m = 4; S0 = Array.from({ length: scheme.n }, () => rowOf([0, 1])); S1 = PAIRS.slice(0, scheme.n).map(rowOf); }
    else {
      const even = [], odd = [];
      for (let value = 0; value < (1 << scheme.n); value++) {
        const bits = Array.from({ length: scheme.n }, (_, i) => (value >> (scheme.n - 1 - i)) & 1);
        (bits.reduce((a, b) => a + b, 0) % 2 ? odd : even).push(bits);
      }
      m = even.length; S0 = Array.from({ length: scheme.n }, (_, row) => even.map(col => col[row]));
      S1 = Array.from({ length: scheme.n }, (_, row) => odd.map(col => col[row]));
    }
    const [r, c] = { 4: [2, 2], 8: [2, 4], 16: [4, 4] }[m];
    return { id, S0, S1, m, r, c, k: scheme.k, n: scheme.n, code: scheme.code };
  }
  function subsets(n) {
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new RangeError('subset count');
    const out = [];
    for (let value = 1; value < (1 << n); value++) out.push(Array.from({ length: n }, (_, i) => i).filter(i => (value >> i) & 1));
    return out;
  }
  function orWeight(matrix, rows) {
    let weight = 0;
    for (let col = 0; col < matrix[0].length; col++) if (rows.some(row => matrix[row][col])) weight++;
    return weight;
  }
  function checkBasis(id) {
    const B = basis(id), detail = [];
    for (const rows of subsets(B.n)) {
      if (rows.length < B.k) {
        const multiset = matrix => matrix[0].map((_, col) => rows.map(row => matrix[row][col]).join('')).sort().join(',');
        if (multiset(B.S0) !== multiset(B.S1)) return { ok: false, detail: 'leak ' + rows.join(',') };
      } else {
        const white = orWeight(B.S0, rows), black = orWeight(B.S1, rows);
        const expectedWhite = B.k === 2 ? 2 : B.m - 1;
        const expectedBlack = id === '2-2' || B.k > 2 ? B.m : new Set(rows.flatMap(row => PAIRS[row])).size;
        if (white !== expectedWhite || black !== expectedBlack) return { ok: false, detail: 'contrast ' + rows.join(',') };
        detail.push({ rows, white, black });
      }
    }
    return { ok: true, detail };
  }
  function theory(id, count) {
    const B = basis(id);
    if (!Number.isInteger(count) || count < 1 || count > B.n) throw new RangeError('stack count');
    const sets = subsets(B.n).filter(rows => rows.length === count);
    const whites = sets.map(rows => orWeight(B.S0, rows)), blacks = sets.map(rows => orWeight(B.S1, rows));
    const white = [Math.min(...whites) / B.m, Math.max(...whites) / B.m], black = [Math.min(...blacks) / B.m, Math.max(...blacks) / B.m];
    return { white, black, whiteMin: white[0], whiteMax: white[1], blackMin: black[0], blackMax: black[1] };
  }
  function validBits(bits, length) { return bits instanceof Uint8Array && (length === undefined || bits.length === length) && !bits.some(value => value > 1); }
  function splitBits(bits, cols, plain, id, source) {
    const B = basis(id);
    if (!validBits(bits) || !bits.length || bits.length > 2025 || !Number.isInteger(cols) || cols < 1 || cols > 45 || bits.length % cols ||
      plain !== null && plain !== undefined && !validBits(plain, bits.length)) throw new RangeError('split dimensions or bits');
    const rows = bits.length / cols, W = cols * B.c;
    const sheets = Array.from({ length: B.n }, () => new Uint8Array(rows * B.r * W));
    try {
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const index = row * cols + col, isPlain = plain && plain[index], matrix = bits[index] ? B.S1 : B.S0;
        const order = isPlain ? null : random.shuffle(B.m, source);
        for (let sheet = 0; sheet < B.n; sheet++) for (let r = 0; r < B.r; r++) for (let c = 0; c < B.c; c++) {
          sheets[sheet][(row * B.r + r) * W + col * B.c + c] = isPlain ? bits[index] : matrix[sheet][order[r * B.c + c]];
        }
      }
      return sheets;
    } catch (error) { sheets.forEach(sheet => sheet.fill(0)); throw error; }
  }
  function splitModules(modules, N, plain, id, source) {
    if (!Number.isInteger(N) || N < 29 || N > 45 || (N - 17) % 4 || !validBits(modules, N * N) || !validBits(plain,
      N * N)) throw new RangeError('QR dimensions');
    return splitBits(modules, N, plain, id, source);
  }
  function splitCells(bits, id, source) { return splitBits(bits, layoutCore.CALIB_COLS, null, id, source); }
  function calibBits() { return Uint8Array.from({ length: 16 }, (_, i) => (Math.floor(i / 2) + i % 2) % 2); }
  function sheetWeightsOk(sheet, cols, rows, plain, id) {
    const B = basis(id), W = cols * B.c;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || !validBits(sheet, cols * rows * B.m) || plain &&
      !validBits(plain, cols * rows)) return false;
    const expected = B.m / 2;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      let count = 0;
      for (let r = 0; r < B.r; r++) for (let c = 0; c < B.c; c++) count += sheet[(row * B.r + r) * W + col * B.c + c];
      if (plain && plain[row * cols + col]) { if (count !== 0 && count !== B.m) return false; }
      else if (count !== expected) return false;
    }
    return true;
  }
  function checkSheetWeights(sheet, N, plain, id) { return sheetWeightsOk(sheet, N, N, plain, id); }
  function stack(sheets, indices) {
    if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > 5 || !Array.isArray(indices) || !indices.length ||
      new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= sheets.length)) throw new RangeError('stack indices');
    if (!validBits(sheets[0]) || !sheets[0].length || sheets[0].length > 32400 || sheets.some(sheet => !validBits(sheet,
      sheets[0].length))) throw new RangeError('stack sheets');
    const out = new Uint8Array(sheets[0].length);
    for (const index of indices) for (let i = 0; i < out.length; i++) out[i] |= sheets[index][i];
    return out;
  }
  function stackModules(sheets, indices, N, plain, id) {
    const B = basis(id);
    if (!validBits(plain, N * N) || sheets.some(sheet => !validBits(sheet, N * N * B.m))) throw new RangeError('stack dimensions');
    const stacked = stack(sheets, indices), modules = new Uint8Array(N * N), W = N * B.c;
    const theoretical = theory(id, B.k), threshold = (theoretical.white[1] + theoretical.black[0]) / 2;
    for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
      let count = 0;
      for (let r = 0; r < B.r; r++) for (let c = 0; c < B.c; c++) count += stacked[(row * B.r + r) * W + col * B.c + c];
      const index = row * N + col;
      modules[index] = count / B.m > (plain[index] ? 0.5 : threshold) ? 1 : 0;
    }
    stacked.fill(0); return modules;
  }
  function makeSet(text, id, version, ecl, msizeCode, source) {
    const B = basis(id);
    if (!Number.isInteger(msizeCode) || msizeCode < 0 || msizeCode > 1) return { error: 'parameters' };
    const m = layoutCore.MSIZES[msizeCode], pageLayout = layoutCore.layout(id, version, m);
    if (!pageLayout.fits) return { error: 'layout' };
    const encoded = qr.encode(text, version, ecl); if (encoded.error) return encoded;
    let checked, data, calib;
    try {
      checked = random.checkedRng(source || random.cryptoRng);
      const setId = Array.from({ length: 4 }, () => layoutCore.ALPHA[random.randbelow(32, checked)]).join('');
      const plain = qr.plainMask(version);
      data = splitModules(encoded.modules, encoded.N, plain, id, checked);
      calib = splitCells(calibBits(), id, checked);
      if (data.some(sheet => !checkSheetWeights(sheet, encoded.N, plain, id)) || calib.some(sheet => !sheetWeightsOk(sheet, 2, 8, null,
        id))) throw new Error('sheet structure');
      return { id, version, ecl, msizeCode, m, layout: pageLayout, setId, N: encoded.N, modules: encoded.modules, plain, data, calib,
        band: layoutCore.bandBits(id, version, ecl, msizeCode, setId), k: B.k, n: B.n };
    } catch (error) {
      encoded.modules.fill(0);
      if (data) data.forEach(sheet => sheet.fill(0));
      if (calib) calib.forEach(sheet => sheet.fill(0));
      throw error;
    } finally { if (checked) checked.destroy(); }
  }
  return Object.freeze({ PHYSICAL_STATUS, SCHEMES, PAIRS, basis, subsets, checkBasis, theory, splitBits, splitModules, splitCells, calibBits,
    sheetWeightsOk, checkSheetWeights, stack, stackModules, makeSet });
}));
