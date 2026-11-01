'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const flow = require('../flow-core.js');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('a confirmation made at one module size cannot create sheets at another size', () => {
  const trialSizes = [2.032, 2.54];
  assert.equal(flow.canCreate({ trialSizes, confirmedSize: 2.54, size: 2.54 }), true);
  assert.equal(flow.canCreate({ trialSizes, confirmedSize: 2.54, size: 2.032 }), false);
  assert.equal(flow.canCreate({ trialSizes, confirmedSize: 2.032, size: 2.54 }), false);
  assert.equal(flow.canCreate({ trialSizes, confirmedSize: null, size: 2.54 }), false);
});

test('a confirmation requires a test set at the selected size', () => {
  assert.equal(flow.canConfirm({ trialSizes: [2.032], size: 2.54 }), false);
  assert.equal(flow.canCreate({ trialSizes: [2.032], confirmedSize: 2.54, size: 2.54 }), false);
  assert.equal(flow.canConfirm({ trialSizes: [], size: 2.54 }), false);
  assert.equal(flow.canConfirm({ size: 2.54 }), false);
  assert.equal(flow.canConfirm({ trialSizes: [2.032, 2.54], size: 2.032 }), true);
});

test('the current step follows test sets and the size-specific confirmation', () => {
  assert.equal(flow.currentStep({ trialSizes: [], confirmedSize: null, size: 2.54 }), 2);
  assert.equal(flow.currentStep({ trialSizes: [2.032, 2.54], confirmedSize: null, size: 2.54 }), 3);
  assert.equal(flow.currentStep({ trialSizes: [2.032, 2.54], confirmedSize: 2.54, size: 2.54 }), 4);
  assert.equal(flow.currentStep({ trialSizes: [2.032, 2.54], confirmedSize: 2.54, size: 2.032 }), 3);
});

test('the page keeps test sets on a size change but clears the confirmation', () => {
  const sizeHandler = app.match(/\$\('module-size'\)\.addEventListener\('change', \(\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(sizeHandler, 'module-size has its own change handler');
  assert.match(sizeHandler[1], /invalidate\(false\)/);
  assert.match(sizeHandler[1], /confirmedSize = null/);
  assert.doesNotMatch(sizeHandler[1], /invalidate\(true\)/);
  const generate = app.slice(app.indexOf('async function generate('), app.indexOf('function element('));
  assert.match(generate, /OQS\.flow\.canCreate\(/, 'production creation checks the size-specific confirmation');
});
