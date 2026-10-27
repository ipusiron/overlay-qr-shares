'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const app = read('app.js');
const scripts = fs.readdirSync(root).filter(name => name.endsWith('.js'));
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'";

test('HTML has the exact CSP, referrer policy, viewport and local resources', () => {
  const actual = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.equal(actual && actual[1], csp);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.doesNotMatch(html, /\s(?:style|on\w+)\s*=|<style\b|type="module"/i);
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scriptTags.length >= 8);
  for (const [, attributes, body] of scriptTags) {
    const source = attributes.match(/src="([^"]+)"/);
    assert.ok(source);
    assert.doesNotMatch(source[1], /^(?:https?:|\/\/)/);
    assert.equal(body.trim(), '');
    assert.ok(fs.existsSync(path.join(root, source[1])), source[1]);
  }
});

test('maintained JavaScript has no external transport or HTML injection', () => {
  for (const file of scripts) {
    const prohibited = /\b(?:fetch\s*\(|XMLHttpRequest\b|WebSocket\b|EventSource\b|sendBeacon\b|innerHTML\b|outerHTML\b)/;
    assert.doesNotMatch(read(file), prohibited, file);
    assert.doesNotMatch(read(file), /\beval\s*\(|\bnew\s+Function\b|WebAssembly/, file);
  }
});

test('production code uses cryptographic randomness without deterministic fallback', () => {
  for (const file of scripts) {
    assert.doesNotMatch(read(file), /Math\.random|\.sort\s*\([^)]*rand|\bdetRng\b/, file);
  }
  assert.match(read('rng.js'), /getRandomValues/);
});

test('only language and theme preferences can be written to browser storage', () => {
  assert.match(app, /language:\s*'overlay-qr-shares\.language'/);
  assert.match(app, /theme:\s*'overlay-qr-shares\.theme'/);
  const saved = [...app.matchAll(/\bsave\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(saved.sort(), ['language', 'theme']);
  for (const file of scripts) {
    const source = read(file);
    assert.doesNotMatch(source, /sessionStorage|indexedDB|document\.cookie|history\.(?:pushState|replaceState)/, file);
    assert.doesNotMatch(source, /location\.(?:hash|search|href)\s*=/, file);
    // theme-init.js reads only the saved theme in <head> before the first paint.
    if (file === 'theme-init.js') {
      const uses = [...source.matchAll(/localStorage\.(\w+)\('([^']+)'/g)].map(match => match[1] + ' ' + match[2]);
      assert.deepEqual(uses, ['getItem overlay-qr-shares.theme'], file);
      assert.equal((source.match(/localStorage/g) || []).length, 1, file);
    } else if (file !== 'app.js') assert.doesNotMatch(source, /localStorage/, file);
  }
});

test('core modules have UMD exports and no DOM or browser storage access', () => {
  const pageScripts = ['app.js', 'messages.js', 'theme-init.js'];
  for (const file of scripts.filter(name => !pageScripts.includes(name))) {
    const source = read(file);
    assert.match(source, /module\.exports/, file);
    assert.doesNotMatch(source, /\bdocument\b|\bHTMLElement\b|localStorage|sessionStorage|\.getContext\(/, file);
  }
});

test('vendored QR code libraries and licenses retain their supplied SHA-256 hashes', () => {
  const expected = {
    'qrcode.min.js': 'bb2365e4902f4f84852cf4025e6f6a60325a682aeafa43fb63b7fc8f098d1ef2',
    'jsQR.js': 'bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859',
    'LICENSE-qrcode-generator.txt': '3a850fa5f08101db6f40676c2786e10bd2cd5fff7b12ffdf1e0c434d4e49d90c',
    'LICENSE-jsQR.txt': 'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'
  };
  for (const [file, hash] of Object.entries(expected)) {
    const bytes = fs.readFileSync(path.join(root, 'vendor', file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), hash, file);
  }
});

test('visible copy avoids prohibited words and unnecessary development badges', () => {
  for (const file of ['index.html', 'messages.js']) {
    assert.doesNotMatch(read(file), /照合|突き合わせ|効く|走る|向き|分かる|絶対に安全|完全に安全/, file);
  }
  assert.doesNotMatch(html, />\s*(?:DAY\s*125|MIT)\s*</i);
});

test('tabs, dialog, focus and reduced-motion styles are present', () => {
  assert.equal([...html.matchAll(/role="tab"/g)].length, 3);
  assert.equal([...html.matchAll(/role="tabpanel"/g)].length, 3);
  assert.match(html, /<dialog id="help-dialog" aria-labelledby="help-title">/);
  assert.match(read('style.css'), /\[hidden\]\s*\{\s*display:\s*none !important;/);
  assert.match(read('style.css'), /:focus-visible/);
  assert.match(read('style.css'), /prefers-reduced-motion:\s*reduce/);
  assert.match(read('theme-init.js'), /prefers-color-scheme: dark/);
});
