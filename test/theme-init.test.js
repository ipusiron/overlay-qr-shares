'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

// Run theme-init.js with a stub window and return the data-theme it sets.
function run({ saved = null, prefersDark = false, storageThrows = false } = {}) {
  const attributes = {};
  const window = {
    localStorage: { getItem: key => {
      if (storageThrows) throw new Error('blocked');
      return key === 'overlay-qr-shares.theme' ? saved : null;
    } },
    matchMedia: () => ({ matches: prefersDark }),
    document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } }
  };
  vm.runInNewContext(read('theme-init.js'), { window });
  return attributes['data-theme'];
}

test('theme-init follows the OS setting without a saved choice', () => {
  assert.equal(run({ prefersDark: true }), 'dark');
  assert.equal(run({ prefersDark: false }), 'light');
});

test('theme-init prefers the saved choice over the OS setting', () => {
  assert.equal(run({ saved: 'light', prefersDark: true }), 'light');
  assert.equal(run({ saved: 'dark', prefersDark: false }), 'dark');
});

test('theme-init ignores unexpected saved values and follows the OS setting', () => {
  assert.equal(run({ saved: 'blue', prefersDark: true }), 'dark');
  assert.equal(run({ saved: 'blue', prefersDark: false }), 'light');
});

test('theme-init does not fail without localStorage and follows the OS setting', () => {
  assert.equal(run({ storageThrows: true, prefersDark: false }), 'light');
  assert.equal(run({ storageThrows: true, prefersDark: true }), 'dark');
});

test('index.html loads theme-init.js synchronously in <head> after style.css', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('<script src="theme-init.js"></script>'), 'theme-init.js is missing from <head>');
  assert.ok(head.indexOf('style.css') < head.indexOf('theme-init.js'));
  assert.ok(head.indexOf('theme-init.js') < head.indexOf('app.js'));
});
