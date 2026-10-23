/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/qrcode.min.js'), require('./vendor/jsQR.js'));
  else { root.OQS = root.OQS || {}; root.OQS.qr = factory(root.qrcode, root.jsQR); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (qrcode, decoderModule) {
  'use strict';
  const defaultDecoder = decoderModule.default || decoderModule;
  // qrcode-generator shares this global encoder; its default drops high bytes.
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const CAPACITY = Object.freeze({
    M: Object.freeze({ 3: 42, 4: 62, 5: 84, 6: 106, 7: 122 }),
    Q: Object.freeze({ 3: 32, 4: 46, 5: 60, 6: 74, 7: 86 })
  });
  const ALIGN = { 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38] };
  function validVersion(version) { return Number.isInteger(version) && version >= 3 && version <= 7; }
  function capacity(version, ecl) {
    if (!validVersion(version) || (ecl !== 'M' && ecl !== 'Q')) throw new RangeError('QR parameters');
    return CAPACITY[ecl][version];
  }
  function encode(text, version, ecl) {
    if (typeof text !== 'string') return { error: 'text' };
    if (!validVersion(version) || (ecl !== 'M' && ecl !== 'Q')) return { error: 'parameters' };
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) return { error: 'surrogate' };
    if (!text.length) return { error: 'empty' };
    if (new TextEncoder().encode(text).length > capacity(version, ecl)) return { error: 'capacity' };
    const code = qrcode(version, ecl); code.addData(text, 'Byte');
    try { code.make(); } catch (_) { return { error: 'capacity' }; }
    const N = code.getModuleCount(), modules = new Uint8Array(N * N);
    for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) modules[row * N + col] = code.isDark(row, col) ? 1 : 0;
    return { N, modules };
  }
  function plainMask(version) {
    if (!validVersion(version)) throw new RangeError('QR version');
    const N = 17 + 4 * version, mask = new Uint8Array(N * N);
    const set = (row, col) => { if (row >= 0 && col >= 0 && row < N && col < N) mask[row * N + col] = 1; };
    for (const [r0, c0] of [[0, 0], [0, N - 8], [N - 8, 0]]) {
      for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) set(r0 + row, c0 + col);
    }
    for (let i = 0; i < N; i++) { set(6, i); set(i, 6); }
    const centers = ALIGN[version], last = centers[centers.length - 1];
    for (const cy of centers) for (const cx of centers) {
      if ((cy === 6 && cx === 6) || (cy === 6 && cx === last) || (cy === last && cx === 6)) continue;
      for (let row = -2; row <= 2; row++) for (let col = -2; col <= 2; col++) set(cy + row, cx + col);
    }
    set(4 * version + 9, 8);
    if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(i, N - 11 + j); set(N - 11 + j, i); }
    return mask;
  }
  function decodeModules(modules, N, decoder) {
    if (!Number.isInteger(N) || N < 29 || N > 45 || (N - 17) % 4 || !(modules instanceof Uint8Array) || modules.length !== N * N ||
      modules.some(v => v > 1)) return { ok: false, reason: 'modules' };
    const scan = decoder || defaultDecoder;
    if (typeof scan !== 'function') return { ok: false, reason: 'decoder' };
    const scale = 4, quiet = 4, width = (N + 2 * quiet) * scale;
    for (let transposed = 0; transposed < 2; transposed++) {
      const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
      let result;
      try {
        for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) {
          if (!modules[transposed ? col * N + row : row * N + col]) continue;
          for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
            const pos = (((row + quiet) * scale + y) * width + (col + quiet) * scale + x) * 4;
            rgba[pos] = rgba[pos + 1] = rgba[pos + 2] = 0;
          }
        }
        result = scan(rgba, width, width, { inversionAttempts: 'attemptBoth' });
      } catch (_) { return { ok: false, reason: 'decoder' }; }
      finally { rgba.fill(0); }
      if (!result) continue;
      if (!Array.isArray(result.binaryData) && !(result.binaryData instanceof Uint8Array)) return { ok: false, reason: 'utf8' };
      if (Array.from(result.binaryData).some(v => !Number.isInteger(v) || v < 0 || v > 255)) return { ok: false, reason: 'utf8' };
      const bytes = Uint8Array.from(result.binaryData);
      result.binaryData.fill(0);
      try {
        return { ok: true, bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), mirrored: !!transposed };
      } catch (_) { bytes.fill(0); return { ok: false, reason: 'utf8' }; }
    }
    return { ok: false, reason: 'decode' };
  }
  return Object.freeze({ CAPACITY, capacity, encode, plainMask, decodeModules });
}));
