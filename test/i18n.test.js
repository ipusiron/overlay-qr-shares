'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const messages = require('../messages.js');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('Japanese and English dictionaries have the same nonempty keys and value types', () => {
  assert.deepEqual(Object.keys(messages.ja).sort(), Object.keys(messages.en).sort());
  for (const language of ['ja', 'en']) {
    for (const [key, value] of Object.entries(messages[language])) {
      assert.ok(typeof value === 'string' || typeof value === 'function', `${language}.${key}`);
      if (typeof value === 'string') assert.ok(value.trim(), `${language}.${key} is empty`);
      assert.equal(typeof value, typeof messages[language === 'ja' ? 'en' : 'ja'][key], key);
    }
  }
});

test('every text and accessible-label reference has both translations', () => {
  const keys = [...html.matchAll(/data-(?:i18n|label)="([^"]+)"/g)].map(match => match[1]);
  assert.ok(keys.length > 20);
  for (const key of keys) {
    assert.ok(Object.hasOwn(messages.ja, key), key);
    assert.ok(Object.hasOwn(messages.en, key), key);
  }
});

test('English strings contain no untranslated Japanese or fullwidth punctuation', () => {
  for (const [key, value] of Object.entries(messages.en)) {
    if (typeof value === 'string') assert.doesNotMatch(value, /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/u, key);
  }
});

test('language selection covers hidden content and accessible labels', () => {
  assert.match(app, /querySelectorAll\('\[data-i18n\]'\)/);
  assert.match(app, /querySelectorAll\('\[data-label\]'\)/);
  assert.match(app, /document\.documentElement\.lang\s*=\s*language/);
  assert.match(app, /new URLSearchParams\(location\.search\)\.get\('lang'\)/);
});

test('navigation labels repeat the destination names exactly and show an arrow', () => {
  const { ja, en } = messages;
  for (const [key, target] of [['openReader', 'readTab'], ['openGuide', 'guideTab'], ['readerCameraJump', 'readerCameraTitle']]) {
    assert.equal(ja[key], `「${ja[target]}」へ`, 'ja ' + key);
    assert.equal(en[key], `Go to “${en[target]}”`, 'en ' + key);
  }
  const buttons = [...html.matchAll(/<button id="([^"]+)" class="nav-link" type="button" data-tab-target="(\w+)">([\s\S]*?)<\/button>/g)];
  assert.equal(buttons.length, 2, 'two tab-switch buttons');
  for (const [, id, target, body] of buttons) {
    assert.match(html, new RegExp(`id="tab-${target}"`), id);
    assert.match(body, /<span class="nav-arrow" aria-hidden="true">→<\/span>/, id);
  }
  assert.match(html, /<a class="nav-link" href="#reader-camera" data-jump>[\s\S]*?aria-hidden="true">↓<\/span><\/a>/);
});
