/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else { root.OQS = root.OQS || {}; root.OQS.rng = factory(root); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const MAX_BYTES = 0x1000000;
  function countOk(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_BYTES) throw new RangeError('rng count');
  }
  function cryptoRng(count, provider) {
    countOk(count);
    const source = provider || root.crypto;
    if (!source || typeof source.getRandomValues !== 'function') throw new Error('secure randomness unavailable');
    const out = new Uint8Array(count);
    try {
      for (let i = 0; i < count; i += 65536) source.getRandomValues(out.subarray(i, Math.min(i + 65536, count)));
      return out;
    } catch (error) { out.fill(0); throw error; }
  }
  function read(count, source) {
    if (typeof source !== 'function') throw new TypeError('rng function');
    const out = source(count);
    if (!(out instanceof Uint8Array) || out.length !== count) throw new TypeError('rng bytes');
    return out;
  }
  // Buffer and replay the first 64 bytes: the health check consumes no extra entropy.
  function checkedRng(source) {
    const prefix = read(64, source);
    if (prefix.every(value => value === prefix[0])) { prefix.fill(0); throw new Error('rng health check'); }
    let offset = 0, destroyed = false;
    function checked(count) {
      countOk(count);
      if (destroyed) throw new Error('rng destroyed');
      const out = new Uint8Array(count), take = Math.min(count, prefix.length - offset);
      out.set(prefix.subarray(offset, offset + take));
      prefix.fill(0, offset, offset + take); offset += take;
      if (take < count) {
        const tail = read(count - take, source);
        out.set(tail, take); tail.fill(0);
      }
      return out;
    }
    checked.destroy = function () { prefix.fill(0); destroyed = true; };
    return checked;
  }
  function randbelow(k, source) {
    if (!Number.isInteger(k) || k < 1 || k > 4294967296) throw new RangeError('randbelow bound');
    const limit = 4294967296 - (4294967296 % k);
    for (let attempt = 0; attempt < 64; attempt++) {
      const bytes = read(4, source);
      const value = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
      bytes.fill(0);
      if (value < limit) return value % k;
    }
    throw new Error('randbelow: too many rejections');
  }
  function shuffle(length, source) {
    if (!Number.isInteger(length) || length < 1 || length > 65536) throw new RangeError('shuffle length');
    const result = Array.from({ length }, (_, i) => i);
    for (let i = length - 1; i > 0; i--) {
      const j = randbelow(i + 1, source), value = result[i];
      result[i] = result[j]; result[j] = value;
    }
    return result;
  }
  return Object.freeze({ cryptoRng, checkedRng, randbelow, shuffle });
}));
