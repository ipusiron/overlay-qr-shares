/* Overlay QR Shares - MIT (c) 2026 ipusiron. Geometry and synthetic transmission images. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vc-core.js'), require('./layout-core.js'));
  else { root.OQS = root.OQS || {}; root.OQS.render = factory(root.OQS.vc, root.OQS.layout); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (vc, layouts) {
  'use strict';
  const MIRROR_TRANSFORM = 'translate(0 297) scale(1 -1)';
  function checked(set, index) {
    if (!set || !Number.isInteger(index)) throw new TypeError('sheet');
    const B = vc.basis(set.id), page = layouts.layout(set.id, set.version, set.m);
    if (!page.fits || set.N !== 17 + 4 * set.version || index < 0 || index >= B.n) throw new RangeError('sheet parameters');
    const valid = (bits, length) => bits instanceof Uint8Array && bits.length === length && !bits.some(v => v > 1);
    if (!Array.isArray(set.data) || !Array.isArray(set.calib) || set.data.length !== B.n || set.calib.length !== B.n
      || !valid(set.data[index], set.N * set.N * B.m) || !valid(set.calib[index], 16 * B.m)
      || !valid(set.band, 48)) throw new RangeError('sheet bits');
    return { B, page };
  }
  function addRuns(rectangles, bits, cols, x, y, cellWidth, cellHeight) {
    const rows = bits.length / cols;
    for (let row = 0; row < rows; row++) {
      let col = 0;
      while (col < cols) {
        if (!bits[row * cols + col]) { col++; continue; }
        const start = col;
        while (col < cols && bits[row * cols + col]) col++;
        rectangles.push({ x: x + start * cellWidth, y: y + row * cellHeight, w: (col - start) * cellWidth, h: cellHeight });
      }
    }
  }
  function fixedRectangles(page, B, index) {
    const out = [], block = page.normal, line = 0.12;
    for (const mark of block.marks) {
      if (!mark.hollow) out.push({ x: mark.x, y: mark.y, w: 3, h: 3 });
      else {
        out.push({ x: mark.x, y: mark.y, w: 3, h: 0.8 }, { x: mark.x, y: mark.y + 2.2, w: 3, h: 0.8 });
        out.push({ x: mark.x, y: mark.y + 0.8, w: 0.8, h: 1.4 }, { x: mark.x + 2.2, y: mark.y + 0.8, w: 0.8, h: 1.4 });
      }
    }
    for (const right of [false, true]) for (const bottom of [false, true]) {
      const x = right ? block.x + block.w + 6 : block.x - 7, y = bottom ? block.y + block.h + 6 : block.y - 7;
      out.push({ x, y, w: 1, h: line }, { x, y, w: line, h: 1 });
    }
    // A public black basis cell: complementary for 2-2; other schemes retain their actual union pattern.
    addRuns(out, B.S1[index], B.c, block.x - 7, block.y + block.h / 2 - 2, 4 / B.c, 4 / B.r);
    return out;
  }
  function sampleRectangles(set, index, B, page) {
    const rectangles = fixedRectangles(page, B, index), block = page.normal, m = set.m;
    addRuns(rectangles, set.data[index], set.N * B.c, block.x + 4 * m, block.y + 4 * m, m / B.c, m / B.r);
    addRuns(rectangles, set.calib[index], 2 * B.c, block.calib.x, block.calib.y, m / B.c, m / B.r);
    addRuns(rectangles, set.band, 3, block.band.x, block.band.y, m, m);
    return rectangles;
  }
  function rulerRectangles() {
    const out = [{ x: 197, y: 100, w: 0.12, h: 100 }, { x: 80, y: 20, w: 50, h: 0.12 }];
    for (let i = 0; i <= 100; i++) out.push({ x: 197, y: 100 + i, w: i % 10 === 0 ? 3 : i % 5 === 0 ? 2 : 1, h: 0.12 });
    for (let i = 0; i <= 50; i++) out.push({ x: 80 + i, y: 20, w: 0.12, h: i % 10 === 0 ? 3 : i % 5 === 0 ? 2 : 1 });
    return out;
  }
  const number = value => String(Number(value.toFixed(5)));
  function pathOf(rectangles) {
    return rectangles.map(rect => 'M' + number(rect.x) + ' ' + number(rect.y) + 'h' + number(rect.w)
      + 'v' + number(rect.h) + 'h' + number(-rect.w) + 'z').join('');
  }
  function clearRectangles(rectangles) {
    for (const rectangle of rectangles) { rectangle.x = 0; rectangle.y = 0; rectangle.w = 0; rectangle.h = 0; }
    rectangles.fill(0);
  }
  // Paths use full A4 coordinates. Apply mirrorTransform to the second path. The app supplies text labels.
  function sheetPaths(set, index) {
    const { B, page } = checked(set, index), rectangles = sampleRectangles(set, index, B, page);
    try {
      const normalPath = pathOf(rectangles);
      return { normalPath, mirrorPath: normalPath, mirrorTransform: MIRROR_TRANSFORM, rulerPath: pathOf(rulerRectangles()),
        page: { w: 210, h: 297 }, normal: page.normal, mirror: page.mirror };
    } finally { clearRectangles(rectangles); }
  }
  function valueAt(option, index, fallback) {
    const value = Array.isArray(option) ? option[index] : option;
    return value === undefined ? fallback : value;
  }
  function finite(value, min, max, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RangeError(label);
    return value;
  }
  function reflect(rectangle) { return { x: rectangle.x, y: 297 - rectangle.y - rectangle.h, w: rectangle.w, h: rectangle.h }; }
  function rasterize(rectangles, width, height, geometry) {
    const coverage = new Float32Array(width * height), scale = geometry.pxPerMm;
    for (const rect of rectangles) {
      const x0 = (rect.x - geometry.originX) * scale, x1 = x0 + rect.w * scale;
      const y0 = (rect.y - geometry.originY) * scale, y1 = y0 + rect.h * scale;
      const left = Math.max(0, Math.floor(x0)), right = Math.min(width, Math.ceil(x1));
      const top = Math.max(0, Math.floor(y0)), bottom = Math.min(height, Math.ceil(y1));
      for (let y = top; y < bottom; y++) {
        const yy = Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
        for (let x = left; x < right; x++) {
          const xx = Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0));
          coverage[y * width + x] = Math.min(1, coverage[y * width + x] + xx * yy);
        }
      }
    }
    return coverage;
  }
  function bilinear(values, width, height, x, y, outside) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (xx, yy) => xx < 0 || yy < 0 || xx >= width || yy >= height ? outside : values[yy * width + xx];
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy)
      + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  }
  function moveLayer(source, width, height, dx, dy, degrees, centerX, centerY) {
    if (!dx && !dy && !degrees) return source;
    const out = new Float32Array(source.length), rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const xx = x - centerX - dx, yy = y - centerY - dy;
      out[y * width + x] = bilinear(source, width, height, cos * xx + sin * yy + centerX,
        -sin * xx + cos * yy + centerY, 0);
    }
    source.fill(0); return out;
  }
  // Blur each physical layer before multiplication; the old research vector blurred the finished stack.
  function blurLayer(source, width, height, radius) {
    if (!radius) return source;
    const temporary = new Float32Array(source.length), out = new Float32Array(source.length), divisor = radius * 2 + 1;
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) if (x >= 0 && x < width) sum += source[y * width + x];
      for (let x = 0; x < width; x++) {
        temporary[y * width + x] = sum / divisor;
        if (x - radius >= 0) sum -= source[y * width + x - radius];
        if (x + radius + 1 < width) sum += source[y * width + x + radius + 1];
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) if (y >= 0 && y < height) sum += temporary[y * width + x];
      for (let y = 0; y < height; y++) {
        out[y * width + x] = sum / divisor;
        if (y - radius >= 0) sum -= temporary[(y - radius) * width + x];
        if (y + radius + 1 < height) sum += temporary[(y + radius + 1) * width + x];
      }
    }
    source.fill(0); temporary.fill(0); return out;
  }
  function multiplyMatrix(A, B) {
    return Array.from({ length: 9 }, (_, i) => {
      const row = Math.floor(i / 3), col = i % 3;
      return A[row * 3] * B[col] + A[row * 3 + 1] * B[col + 3] + A[row * 3 + 2] * B[col + 6];
    });
  }
  function inverseMatrix(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const out = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g,
      c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
    const determinant = a * out[0] + b * out[3] + c * out[6];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new RangeError('projective matrix');
    return out.map(value => value / determinant);
  }
  function sceneTransform(options, width, height) {
    const angle = finite(options.sceneRotation === undefined ? 0 : options.sceneRotation, -180, 180, 'scene rotation') * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle), cx = (width - 1) / 2, cy = (height - 1) / 2;
    const rotation = [cos, -sin, cx - cos * cx + sin * cy, sin, cos, cy - sin * cx - cos * cy, 0, 0, 1];
    if (!options.projective) return rotation;
    if (!Array.isArray(options.projective) || options.projective.length !== 9
      || options.projective.some(value => !Number.isFinite(value))) throw new RangeError('projective matrix');
    const transform = multiplyMatrix(options.projective, rotation); inverseMatrix(transform); return transform;
  }
  function warp(source, width, height, matrix) {
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (matrix.every((value, i) => value === identity[i])) return source;
    const inverse = inverseMatrix(matrix), out = new Float32Array(source.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const denominator = inverse[6] * x + inverse[7] * y + inverse[8];
      const xx = (inverse[0] * x + inverse[1] * y + inverse[2]) / denominator;
      const yy = (inverse[3] * x + inverse[4] * y + inverse[5]) / denominator;
      out[y * width + x] = Number.isFinite(xx) && Number.isFinite(yy) ? bilinear(source, width, height, xx, yy, 1) : 1;
    }
    source.fill(0); return out;
  }
  // Options: dx/dy in mm, rot in degrees, blur integer pixels. Arrays use original sheet indices.
  // projective maps base image pixels to output pixels with a row-major 3x3 matrix.
  // Explicitly seeded synthetic noise affects only images, never the generation of shares.
  function synthStack(set, indices, options) {
    const opts = options || {}, { B, page } = checked(set, 0);
    if (!Array.isArray(indices) || !indices.length || new Set(indices).size !== indices.length
      || indices.some(index => !Number.isInteger(index) || index < 0 || index >= B.n)) throw new RangeError('synthesis indices');
    const pxPerMm = finite(opts.pxPerMm === undefined ? 6 : opts.pxPerMm, 1, 16, 'pixel density');
    const fullPage = !!opts.fullPage, padding = 8;
    const geometry = { originX: fullPage ? 0 : page.normal.x - padding, originY: fullPage ? 0 : page.normal.y - padding,
      pxPerMm, normal: page.normal, mirror: page.mirror, fullPage };
    const w = Math.ceil((fullPage ? 210 : page.W + 2 * padding) * pxPerMm);
    const h = Math.ceil((fullPage ? 297 : page.H + 2 * padding) * pxPerMm);
    if (w * h > 12000000) throw new RangeError('synthesis pixels');
    const gain = finite(opts.gain === undefined ? 1 : opts.gain, 0, 2, 'gain');
    const floor = finite(opts.floor === undefined ? 0.05 : opts.floor, 0, 0.5, 'floor');
    const noise = finite(opts.noise === undefined ? 0 : opts.noise, 0, 0.5, 'noise');
    if (noise && !Number.isInteger(opts.noiseSeed)) throw new RangeError('noise requires explicit seed');
    const tilt = Array.isArray(opts.tilt) ? opts.tilt : [opts.tilt === undefined ? 0 : opts.tilt, 0];
    if (tilt.length !== 2) throw new RangeError('tilt');
    tilt.forEach(value => finite(value, -0.8, 0.8, 'tilt'));
    let state = (opts.noiseSeed >>> 0) || 1, transmission = new Float32Array(w * h).fill(1), layer;
    try {
      for (const index of indices) {
        checked(set, index);
        const dx = finite(valueAt(opts.dx, index, 0), -20, 20, 'shift');
        const dy = finite(valueAt(opts.dy, index, 0), -20, 20, 'shift');
        const rot = finite(valueAt(opts.rot, index, 0), -20, 20, 'rotation');
        const ink = finite(valueAt(opts.ink, index, 0.85), 0, 1, 'ink');
        const blur = finite(valueAt(opts.blur, index, 0), 0, 12, 'blur');
        if (!Number.isInteger(blur)) throw new RangeError('blur radius');
        const normal = sampleRectangles(set, index, B, page);
        let rectangles = normal.concat(normal.map(reflect));
        if (fullPage) rectangles.push(...rulerRectangles());
        if (valueAt(opts.flipped, index, false)) {
          const flipped = rectangles.map(reflect); clearRectangles(rectangles); rectangles = flipped;
        }
        try { layer = rasterize(rectangles, w, h, geometry); }
        finally { clearRectangles(rectangles); normal.fill(0); }
        layer = moveLayer(layer, w, h, dx * pxPerMm, dy * pxPerMm, rot,
          (page.normal.x + page.W / 2 - geometry.originX) * pxPerMm,
          (page.normal.y + page.H / 2 - geometry.originY) * pxPerMm);
        layer = blurLayer(layer, w, h, blur);
        for (let i = 0; i < transmission.length; i++) transmission[i] *= 1 - ink * layer[i];
        layer.fill(0); layer = null;
      }
      geometry.transform = sceneTransform(opts, w, h);
      transmission = warp(transmission, w, h, geometry.transform);
      const gray = new Uint8ClampedArray(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let jitter = 0;
        if (noise) {
          state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
          jitter = ((state >>> 0) / 4294967296 - 0.5) * noise;
        }
        const illumination = gain * (1 + tilt[0] * (2 * x / (w - 1) - 1) + tilt[1] * (2 * y / (h - 1) - 1));
        gray[y * w + x] = Math.round(255 * ((floor + (1 - floor) * transmission[y * w + x]) * illumination + jitter));
      }
      return { gray, w, h, W: w, H: h, geometry };
    } finally { transmission.fill(0); if (layer) layer.fill(0); }
  }
  return Object.freeze({ sheetPaths, synthStack, MIRROR_TRANSFORM });
}));
