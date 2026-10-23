/* Overlay QR Shares - MIT (c) 2026 ipusiron. Sample reading; automatic location is a separate layer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./qr.js'), require('./vc-core.js'), require('./layout-core.js'));
  } else { root.OQS = root.OQS || {}; root.OQS.reader = factory(root.OQS.qr, root.OQS.vc, root.OQS.layout); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (qr, vc, layoutCore) {
  'use strict';
  const LEVELS = Object.freeze({ adequate: 0.6, marginal: 0.35 });
  const RETRIES = Object.freeze([0, -0.1, 0.1, -0.2, 0.2]);
  const clamp = value => Math.max(0, Math.min(1, value));
  const level = margin => margin >= LEVELS.adequate ? 'adequate' : margin >= LEVELS.marginal ? 'marginal' : 'insufficient';
  function features(x, y) { return [1, x, y, x * x, x * y, y * y]; }
  function solve(matrix, rhs) {
    const n = rhs.length, work = Array.from({ length: n }, (_, row) => Float64Array.from([...matrix[row], rhs[row]]));
    try {
      for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) if (Math.abs(work[row][col]) > Math.abs(work[pivot][col])) pivot = row;
        if (Math.abs(work[pivot][col]) < 1e-10) return null;
        [work[col], work[pivot]] = [work[pivot], work[col]];
        const divisor = work[col][col];
        for (let j = col; j <= n; j++) work[col][j] /= divisor;
        for (let row = 0; row < n; row++) if (row !== col) {
          const factor = work[row][col];
          for (let j = col; j <= n; j++) work[row][j] -= factor * work[col][j];
        }
      }
      return Float64Array.from(work, row => row[n]);
    } finally { work.forEach(row => row.fill(0)); }
  }
  function fitSurface(points) {
    if (points.length < 6) return null;
    const matrix = Array.from({ length: 6 }, () => new Float64Array(6)), rhs = new Float64Array(6);
    try {
      for (const [x, y, value] of points) {
        const f = features(x, y);
        for (let row = 0; row < 6; row++) {
          rhs[row] += f[row] * value;
          for (let col = 0; col < 6; col++) matrix[row][col] += f[row] * f[col];
        }
        f.fill(0);
      }
      return solve(matrix, rhs);
    } finally { matrix.forEach(row => row.fill(0)); rhs.fill(0); }
  }
  function surface(coefficients, x, y) {
    return coefficients[0] + coefficients[1] * x + coefficients[2] * y + coefficients[3] * x * x
      + coefficients[4] * x * y + coefficients[5] * y * y;
  }
  function otsu(values) {
    if (!values.length) return 0.5;
    const histogram = new Uint32Array(256);
    try {
      for (const value of values) histogram[Math.round(clamp(value) * 255)]++;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * histogram[i];
      let weight = 0, partial = 0, best = -1, threshold = 127;
      for (let i = 0; i < 256; i++) {
        weight += histogram[i]; partial += i * histogram[i];
        if (!weight || weight === values.length) continue;
        const remaining = values.length - weight, difference = partial / weight - (sum - partial) / remaining;
        const variance = weight * remaining * difference * difference;
        if (variance > best) { best = variance; threshold = i; }
      }
      return (threshold + 0.5) / 255;
    } finally { histogram.fill(0); }
  }
  // Input pixels remain owned by the caller; every temporary image/value array here is cleared in finally.
  function readSample(image, geometry, metadata, decoder) {
    const buffers = [], points = [];
    const keep = array => { buffers.push(array); return array; };
    let diag = { level: 'insufficient', flags: [], attempts: 0 };
    try {
      const w = image && (image.w || image.W), h = image && (image.h || image.H);
      if (!image || !(image.gray instanceof Uint8Array || image.gray instanceof Uint8ClampedArray)
        || !Number.isInteger(w) || !Number.isInteger(h) || w < 3 || h < 3 || w * h > 24000000
        || image.gray.length !== w * h || !geometry || !metadata) return { ok: false, reason: 'image', diag };
      const { originX, originY, pxPerMm } = geometry;
      if (![originX, originY, pxPerMm].every(Number.isFinite) || pxPerMm <= 0) return { ok: false, reason: 'geometry', diag };
      const { id, version, m, ecl } = metadata, B = vc.basis(id), page = layoutCore.layout(id, version, m);
      if (!page.fits || !['M', 'Q'].includes(ecl)) return { ok: false, reason: 'metadata', diag };
      const normal = page.normal, N = 17 + 4 * version, Q = N + 8, plain = keep(qr.plainMask(version));
      // Only the public fixed pattern from this encoding is used. No expected secret enters the reader.
      const fixed = keep(qr.encode('TEST-OQS-1', version, ecl).modules);
      const raw = keep(new Float64Array(N * N)), dark = keep(new Float64Array(N * N));
      const samples = keep(new Float64Array(N * N * B.m)), modules = keep(new Uint8Array(N * N));
      const whitePoints = [], blackPoints = []; points.push(whitePoints, blackPoints);
      function at(mmX, mmY) {
        const x = Math.floor((mmX - originX) * pxPerMm);
        const y = Math.floor(((geometry.mirrored ? 297 - mmY : mmY) - originY) * pxPerMm);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) throw new RangeError('sample outside image');
        let total = 0;
        for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) total += image.gray[(y + v) * w + x + u];
        return total / 9;
      }
      const coordinates = (col, row) => [(col + 4.5) / Q - 0.5, (row + 4.5) / Q - 0.5];
      for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
        const index = row * N + col;
        let total = 0;
        for (let r = 0; r < B.r; r++) for (let c = 0; c < B.c; c++) {
          const value = at(normal.x + (4 + col + (c + 0.5) / B.c) * m, normal.y + (4 + row + (r + 0.5) / B.r) * m);
          samples[index * B.m + r * B.c + c] = value; total += value;
        }
        raw[index] = total / B.m;
        if (plain[index]) {
          const [x, y] = coordinates(col, row);
          (fixed[index] ? blackPoints : whitePoints).push([x, y, raw[index]]);
        }
      }
      // Quiet-zone points surround the symbol so the white surface is supported in every corner.
      for (let i = 1; i < Q; i += 2) for (const [col, row] of [[i, 1], [i, Q - 2], [1, i], [Q - 2, i]]) {
        whitePoints.push([(col + 0.5) / Q - 0.5, (row + 0.5) / Q - 0.5,
          at(normal.x + (col + 0.5) * m, normal.y + (row + 0.5) * m)]);
      }
      const whiteFit = fitSurface(whitePoints), blackFit = fitSurface(blackPoints);
      if (whiteFit) keep(whiteFit);
      if (blackFit) keep(blackFit);
      if (!whiteFit || !blackFit) return { ok: false, reason: 'illumination', diag };
      function darkness(value, x, y) {
        const white = surface(whiteFit, x, y), black = surface(blackFit, x, y);
        if (white - black < 8) throw new RangeError('insufficient light contrast');
        return clamp((white - value) / (white - black));
      }
      const data = keep(new Float64Array(plain.reduce((count, bit) => count + 1 - bit, 0)));
      let position = 0;
      for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
        const index = row * N + col;
        let total = 0;
        for (let r = 0; r < B.r; r++) for (let c = 0; c < B.c; c++) {
          const x = (4 + col + (c + 0.5) / B.c) / Q - 0.5, y = (4 + row + (r + 0.5) / B.r) / Q - 0.5;
          total += darkness(samples[index * B.m + r * B.c + c], x, y);
        }
        dark[index] = total / B.m;
        if (!plain[index]) data[position++] = dark[index];
      }
      function cellDarkness(x0, y0, row, col, rows, cols) {
        let total = 0;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const mmX = x0 + (col + (c + 0.5) / cols) * m, mmY = y0 + (row + (r + 0.5) / rows) * m;
          total += darkness(at(mmX, mmY), (mmX - normal.x) / (Q * m) - 0.5, (mmY - normal.y) / (Q * m) - 0.5);
        }
        return total / (rows * cols);
      }
      const band = keep(new Uint8Array(48));
      for (let i = 0; i < 48; i++) band[i] = cellDarkness(normal.band.x, normal.band.y, Math.floor(i / 3), i % 3, 1, 1) > 0.5 ? 1 : 0;
      const parsed = layoutCore.parseBand(band);
      if (!parsed.ok) return { ok: false, reason: 'band', diag };
      if (parsed.id !== id || parsed.version !== version || parsed.ecl !== ecl || layoutCore.MSIZES[parsed.msizeCode] !== m
        || metadata.setId !== undefined && parsed.setId !== metadata.setId) return { ok: false, reason: 'metadata', diag };
      const calibration = keep(new Float64Array(16));
      let white = 0, black = 0;
      for (let i = 0; i < 16; i++) {
        const row = Math.floor(i / 2), col = i % 2;
        calibration[i] = cellDarkness(normal.calib.x, normal.calib.y, row, col, B.r, B.c);
        if ((row + col) % 2) black += calibration[i] / 8; else white += calibration[i] / 8;
      }
      const theory = vc.theory(id, B.k), theoreticalGap = theory.blackMin - theory.whiteMax;
      const margin = (black - white) / theoreticalGap, threshold = otsu(data);
      const regions = Array.from({ length: 9 }, () => ({ white: 0, black: 0, whites: 0, blacks: 0 }));
      for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
        const index = row * N + col; if (plain[index]) continue;
        const region = regions[Math.min(2, Math.floor(row * 3 / N)) * 3 + Math.min(2, Math.floor(col * 3 / N))];
        if (dark[index] > threshold) { region.black += dark[index]; region.blacks++; }
        else { region.white += dark[index]; region.whites++; }
      }
      const perRegion = regions.map(region => {
        const value = region.whites && region.blacks ? (region.black / region.blacks - region.white / region.whites) / theoreticalGap : 0;
        return { margin: value, level: level(value) };
      });
      regions.forEach(region => { region.white = 0; region.black = 0; });
      const flags = [];
      if (surface(blackFit, 0, 0) > 128) flags.push('faintToner');
      if (white > theory.whiteMax + theoreticalGap * 0.4) flags.push('inkSpread');
      if (margin < LEVELS.adequate) flags.push('misaligned');
      if (blackPoints.some(point => point[2] > 230)) flags.push('glare');
      diag = { white, black, margin, threshold, perRegion, flags, level: level(margin), attempts: 0, setId: parsed.setId };
      if (black <= white) return { ok: false, reason: 'calibration', diag };
      for (const offset of RETRIES) {
        const adjusted = threshold + offset * (black - white);
        for (let i = 0; i < modules.length; i++) modules[i] = dark[i] > (plain[i] ? 0.5 : adjusted) ? 1 : 0;
        diag.attempts++;
        const result = qr.decodeModules(modules, N, decoder);
        if (result.ok) {
          if (result.bytes) result.bytes.fill(0);
          return { ok: true, text: result.text, diag };
        }
      }
      return { ok: false, reason: 'decode', diag };
    } catch (_) { return { ok: false, reason: 'geometry', diag }; }
    finally {
      buffers.forEach(array => array.fill(0));
      points.forEach(group => { group.forEach(point => point.fill(0)); group.length = 0; });
    }
  }
  return Object.freeze({ LEVELS, RETRIES, solve, fitSurface, surface, otsu, readSample });
}));
