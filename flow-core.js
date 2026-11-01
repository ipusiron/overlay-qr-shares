/* Overlay QR Shares - MIT (c) 2026 ipusiron. Workflow decisions for the Split tab. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.OQS = root.OQS || {}; root.OQS.flow = factory(); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Module sizes are compared as numbers. A test confirmation belongs to exactly one size.
  function sizeList(sizes) {
    return Array.isArray(sizes) ? sizes.filter(Number.isFinite) : [];
  }
  function canConfirm(state) {
    return sizeList(state && state.trialSizes).includes(state.size);
  }
  function canCreate(state) {
    return canConfirm(state) && state.confirmedSize === state.size;
  }
  // Steps: 1 scheme, 2 make test, 3 read test, 4 make production sheets.
  function currentStep(state) {
    if (!canConfirm(state)) return 2;
    return canCreate(state) ? 4 : 3;
  }
  return Object.freeze({ canConfirm, canCreate, currentStep });
}));
