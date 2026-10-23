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
      const projective = geometry.homography;
      if (projective && (!Array.isArray(projective) && !(projective instanceof Float64Array)
        || projective.length !== 9 || !Array.from(projective).every(Number.isFinite))) return { ok: false, reason: 'geometry', diag };
      if (!projective && (![originX, originY, pxPerMm].every(Number.isFinite) || pxPerMm <= 0)) {
        return { ok: false, reason: 'geometry', diag };
      }
      const { id, version, m, ecl } = metadata, B = vc.basis(id), page = layoutCore.layout(id, version, m);
      if (!page.fits || !['M', 'Q'].includes(ecl)) return { ok: false, reason: 'metadata', diag };
      const normal = page.normal, N = 17 + 4 * version, Q = N + 8, plain = keep(qr.plainMask(version));
      // Only the public fixed pattern from this encoding is used. No expected secret enters the reader.
      const fixed = keep(qr.encode('TEST-OQS-1', version, ecl).modules);
      const raw = keep(new Float64Array(N * N)), dark = keep(new Float64Array(N * N));
      const samples = keep(new Float64Array(N * N * B.m)), modules = keep(new Uint8Array(N * N));
      const whitePoints = [], blackPoints = []; points.push(whitePoints, blackPoints);
      function at(mmX, mmY) {
        const point = projective ? project(projective, mmX, mmY) : {
          x: (mmX - originX) * pxPerMm, y: ((geometry.mirrored ? 297 - mmY : mmY) - originY) * pxPerMm
        };
        const x = Math.floor(point.x), y = Math.floor(point.y);
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
  function validImage(image) {
    return image && (image.gray instanceof Uint8Array || image.gray instanceof Uint8ClampedArray)
      && Number.isInteger(image.w) && Number.isInteger(image.h) && image.w >= 3 && image.h >= 3
      && image.w * image.h <= 24000000 && image.gray.length === image.w * image.h;
  }
  function pixel(image, x, y) {
    const left = Math.floor(x), top = Math.floor(y), dx = x - left, dy = y - top;
    if (!Number.isFinite(x) || !Number.isFinite(y) || left < 0 || top < 0 || left + 1 >= image.w || top + 1 >= image.h) return 255;
    const at = (xx, yy) => image.gray[yy * image.w + xx];
    return (at(left, top) * (1 - dx) + at(left + 1, top) * dx) * (1 - dy)
      + (at(left, top + 1) * (1 - dx) + at(left + 1, top + 1) * dx) * dy;
  }
  function grayThreshold(gray) {
    const histogram = new Uint32Array(256);
    try {
      let sum = 0;
      for (const value of gray) { histogram[value]++; sum += value; }
      let weight = 0, partial = 0, best = -1, threshold = 127;
      for (let i = 0; i < 256; i++) {
        weight += histogram[i]; partial += histogram[i] * i;
        if (!weight || weight === gray.length) continue;
        const rest = gray.length - weight, difference = partial / weight - (sum - partial) / rest;
        const score = weight * rest * difference * difference;
        if (score > best) { best = score; threshold = i; }
      }
      return threshold + 0.5;
    } finally { histogram.fill(0); }
  }
  function refineMark(image, candidate) {
    const pad = Math.max(2, candidate.size * 0.18);
    const x0 = Math.max(0, Math.floor(candidate.left - pad)), x1 = Math.min(image.w - 1, Math.ceil(candidate.right + pad));
    const y0 = Math.max(0, Math.floor(candidate.top - pad)), y1 = Math.min(image.h - 1, Math.ceil(candidate.bottom + pad));
    let low = 255, high = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const value = image.gray[y * image.w + x]; low = Math.min(low, value); high = Math.max(high, value);
    }
    if (high - low < 20) return candidate;
    let mass = 0, sx = 0, sy = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const weight = clamp((high - image.gray[y * image.w + x]) / (high - low));
      mass += weight; sx += weight * (x + 0.5); sy += weight * (y + 0.5);
    }
    if (!mass) return candidate;
    const x = sx / mass, y = sy / mass;
    const center = pixel(image, x - 0.5, y - 0.5);
    return { ...candidate, x, y, hollow: center > (high + low) / 2, contrast: high - low };
  }
  function detectMarks(image, options) {
    if (!validImage(image)) return { candidates: [], width: 0, height: 0, reason: 'image' };
    const opts = options || {}, supplied = opts.detectImage;
    const scale = Math.min(1, 640 / Math.max(image.w, image.h));
    const w = Math.max(3, Math.round(image.w * scale)), h = Math.max(3, Math.round(image.h * scale));
    const useSupplied = validImage(supplied) && Math.max(supplied.w, supplied.h) <= 640
      && Math.abs(supplied.w / supplied.h - image.w / image.h) < 0.02;
    const width = useSupplied ? supplied.w : w, height = useSupplied ? supplied.h : h;
    const gray = useSupplied ? supplied.gray : new Uint8ClampedArray(width * height);
    const visited = new Uint8Array(width * height), queue = new Int32Array(width * height), candidates = [];
    const scaleX = image.w / width, scaleY = image.h / height;
    try {
      if (!useSupplied) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        gray[y * width + x] = pixel(image, (x + 0.5) * scaleX - 0.5, (y + 0.5) * scaleY - 0.5);
      }
      const threshold = grayThreshold(gray);
      for (let start = 0; start < gray.length; start++) {
        if (visited[start] || gray[start] > threshold) continue;
        let head = 0, tail = 1, area = 0, left = width, right = 0, top = height, bottom = 0;
        queue[0] = start; visited[start] = 1;
        while (head < tail) {
          const index = queue[head++], x = index % width, y = Math.floor(index / width);
          area++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
          for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
            for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
              const next = yy * width + xx;
              if (!visited[next] && gray[next] <= threshold) { visited[next] = 1; queue[tail++] = next; }
            }
          }
        }
        const bw = right - left + 1, bh = bottom - top + 1, fill = area / (bw * bh), ratio = bw / bh;
        if (area < 6 || bw < 3 || bh < 3 || bw > width * 0.15 || bh > height * 0.15
          || ratio < 0.45 || ratio > 2.2 || fill < 0.48 || fill > 1) continue;
        const candidate = { x: (left + right + 1) * scaleX / 2, y: (top + bottom + 1) * scaleY / 2,
          left: left * scaleX, right: (right + 1) * scaleX, top: top * scaleY, bottom: (bottom + 1) * scaleY,
          size: Math.sqrt(bw * bh * scaleX * scaleY), area: area * scaleX * scaleY, fill };
        const refined = refineMark(image, candidate);
        if (refined.contrast >= 20) candidates.push(refined);
      }
      candidates.sort((a, b) => Number(b.hollow) - Number(a.hollow) || Math.abs(a.fill - 0.9) - Math.abs(b.fill - 0.9));
      return { candidates: candidates.slice(0, 96), width, height, threshold };
    } finally { if (!useSupplied) gray.fill(0); visited.fill(0); queue.fill(0); }
  }
  function snapPoint(image, point, radiusPx) {
    if (!validImage(image) || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false };
    if (radiusPx !== undefined && (!Number.isFinite(radiusPx) || radiusPx <= 0)) return { ok: false };
    const found = detectMarks(image).candidates.map(candidate => ({
      candidate, distance: Math.hypot(candidate.x - point.x, candidate.y - point.y),
      radius: radiusPx === undefined ? candidate.size * 5 / 3 : radiusPx
    })).filter(item => item.distance <= item.radius).sort((a, b) => a.distance - b.distance)[0];
    return found ? { ok: true, x: found.candidate.x, y: found.candidate.y, candidate: found.candidate } : { ok: false };
  }
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function convex(points) {
    if (!Array.isArray(points) || points.length !== 4 || points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return false;
    }
    const signs = points.map((point, i) => {
      const next = points[(i + 1) % 4], last = points[(i + 2) % 4];
      return (next.x - point.x) * (last.y - next.y) - (next.y - point.y) * (last.x - next.x);
    });
    return signs.every(value => value > 1) || signs.every(value => value < -1);
  }
  function markGroups(candidates) {
    const groups = [], seen = new Set();
    for (const anchor of candidates.filter(candidate => candidate.hollow)) {
      const pool = candidates.filter(candidate => candidate !== anchor && candidate.size / anchor.size > 0.55
        && candidate.size / anchor.size < 1.8 && distance(anchor, candidate) > anchor.size * 8);
      for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i], b = pool[j], da = distance(anchor, a), db = distance(anchor, b);
        const cosine = ((a.x - anchor.x) * (b.x - anchor.x) + (a.y - anchor.y) * (b.y - anchor.y)) / (da * db);
        if (Math.abs(cosine) > 0.55 || da / db < 0.45 || da / db > 2.2) continue;
        const predicted = { x: a.x + b.x - anchor.x, y: a.y + b.y - anchor.y };
        for (const opposite of pool) {
          if (opposite === a || opposite === b || opposite.hollow) continue;
          const error = distance(predicted, opposite) / Math.max(da, db);
          if (error > 0.25) continue;
          const points = [anchor, a, opposite, b]; if (!convex(points)) continue;
          const key = points.map(point => candidates.indexOf(point)).sort((x, y) => x - y).join(',');
          if (seen.has(key)) continue; seen.add(key);
          const aspectError = Math.min(Math.abs(Math.log(da / db / 1.17)), Math.abs(Math.log(db / da / 1.17)));
          groups.push({ points, score: error * 4 + Math.abs(cosine) + aspectError });
        }
      }
    }
    return groups.sort((a, b) => a.score - b.score).slice(0, 40);
  }
  function homography(source, destination) {
    if (!convex(source) || !convex(destination)) return null;
    const matrix = [], rhs = [];
    try {
      for (let i = 0; i < 4; i++) {
        const { x, y } = source[i], { x: u, y: v } = destination[i];
        matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.push(u, v);
      }
      const result = solve(matrix, rhs);
      if (!result) return null;
      const output = [...result, 1]; result.fill(0); return output;
    } finally { matrix.forEach(row => row.fill(0)); rhs.fill(0); }
  }
  function project(matrix, x, y) {
    const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
    return { x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
      y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator };
  }
  function mappedPixel(image, matrix, x, y) {
    const point = project(matrix, x, y); return pixel(image, point.x - 0.5, point.y - 0.5);
  }
  function finderLine(image, matrix, x, y, m, vertical) {
    const samples = new Float64Array(72);
    try {
      let low = 255, high = 0;
      for (let i = 0; i < samples.length; i++) {
        const offset = ((i + 0.5) / 8 - 4.5) * m;
        samples[i] = mappedPixel(image, matrix, x + (vertical ? 0 : offset), y + (vertical ? offset : 0));
        low = Math.min(low, samples[i]); high = Math.max(high, samples[i]);
      }
      if (high - low < 20) return false;
      const threshold = (low + high) / 2, runs = [];
      for (let i = 0; i < samples.length; i++) {
        const bit = samples[i] < threshold ? 1 : 0;
        if (!runs.length || runs[runs.length - 1].bit !== bit) runs.push({ bit, start: i, length: 1 });
        else runs[runs.length - 1].length++;
      }
      const center = runs.findIndex(run => run.start <= 36 && run.start + run.length > 36);
      if (center < 2 || center + 2 >= runs.length || runs[center].bit !== 1) return false;
      const selected = runs.slice(center - 2, center + 3), unit = selected.reduce((sum, run) => sum + run.length, 0) / 7;
      return unit > 5.5 && unit < 10.5 && selected.every((run, i) => run.bit === (i % 2 ? 0 : 1)
        && Math.abs(run.length - unit * (i === 2 ? 3 : 1)) <= unit * 0.55);
    } finally { samples.fill(0); }
  }
  function findersMatch(image, matrix, page, m, version) {
    const N = 17 + 4 * version, p = page.normal;
    for (const [col, row] of [[7.5, 7.5], [N + 0.5, 7.5], [7.5, N + 0.5]]) {
      if (!finderLine(image, matrix, p.x + col * m, p.y + row * m, m, false)
        || !finderLine(image, matrix, p.x + col * m, p.y + row * m, m, true)) return false;
    }
    return true;
  }
  function readBand(image, matrix, page, m) {
    const values = new Float64Array(48), bits = new Uint8Array(48), band = page.normal.band;
    try {
      for (let i = 0; i < 48; i++) {
        const row = Math.floor(i / 3), col = i % 3, y = band.y + (row + 0.5) * m;
        const value = mappedPixel(image, matrix, band.x + (col + 0.5) * m, y);
        const white = mappedPixel(image, matrix, band.x - 0.5 * m, y);
        values[i] = clamp((white - value) / Math.max(1, white));
      }
      const threshold = otsu(values);
      for (let i = 0; i < 48; i++) bits[i] = values[i] > threshold ? 1 : 0;
      return layoutCore.parseBand(bits);
    } finally { values.fill(0); bits.fill(0); }
  }
  function readFrame(image, options, decoder) {
    const opts = options || {}, baseDiag = { marks: 0, level: 'insufficient', flags: [], attempts: 0 };
    if (!validImage(image)) return { ok: false, reason: 'image', diag: baseDiag };
    let groups, detection;
    if (opts.manualCorners !== undefined) {
      const points = opts.manualCorners;
      if (!convex(points) || points.some(point => point.x < 1 || point.y < 1 || point.x >= image.w - 1 || point.y >= image.h - 1)) {
        return { ok: false, reason: 'manual', diag: baseDiag };
      }
      groups = [{ points, manual: true }]; baseDiag.marks = 4;
    } else {
      detection = detectMarks(image, opts); groups = markGroups(detection.candidates);
      baseDiag.marks = Math.min(4, detection.candidates.length);
      if (!groups.length) return { ok: false, reason: 'marks', diag: baseDiag, marks: detection.candidates };
    }
    let best = { ok: false, reason: 'finder', diag: baseDiag };
    const fit = layoutCore.fitTable();
    for (const group of groups) {
      const orientations = [];
      for (let rotation = 0; rotation < (group.manual ? 4 : 1); rotation++) {
        const points = group.points.map((_, index) => group.points[(index + rotation) % 4]);
        orientations.push(points, [points[0], points[3], points[2], points[1]]);
      }
      for (const corners of orientations) for (const size of Object.keys(fit)) for (const version of fit[size]) {
        const m = Number(size), page = layoutCore.layout('2-2', version, m), marks = page.normal.marks;
        const source = [marks[0], marks[1], marks[3], marks[2]].map(mark => ({ x: mark.x + 1.5, y: mark.y + 1.5 }));
        const matrix = homography(source, corners); if (!matrix) continue;
        try {
          if (!findersMatch(image, matrix, page, m, version)) continue;
          const metadata = readBand(image, matrix, page, m);
          if (!metadata.ok || metadata.version !== version || layoutCore.MSIZES[metadata.msizeCode] !== m) {
            if (best.reason === 'finder') best = { ok: false, reason: 'band', diag: { ...baseDiag, marks: 4 } };
            continue;
          }
          const result = readSample(image, { homography: matrix }, { ...metadata, m }, decoder);
          result.diag.marks = 4; result.metadata = { ...metadata, m };
          result.corners = corners.map(point => ({ x: point.x, y: point.y }));
          if (result.ok) return result;
          best = result;
        } finally { matrix.fill(0); }
      }
    }
    return best;
  }
  return Object.freeze({ LEVELS, RETRIES, solve, fitSurface, surface, otsu, readSample, detectMarks, snapPoint, homography, project, readFrame });
}));
