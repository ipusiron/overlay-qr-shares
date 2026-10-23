'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

function variables(selector) {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, selector);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})/g)]
    .map(match => [match[1], match[2]]));
}
function luminance(hex) {
  const digits = hex.slice(1);
  const values = (digits.length === 3 ? [...digits].map(c => c + c) : digits.match(/../g))
    .map(pair => parseInt(pair, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
function ratio(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
for (const selector of [':root', ':root[data-theme="dark"]']) {
  test(`${selector}: text contrast meets 4.5:1`, () => {
    const colors = variables(selector);
    for (const [foreground, background] of [
      ['--ink', '--paper'], ['--ink', '--card'], ['--ink', '--wash'],
      ['--muted', '--paper'], ['--muted', '--card'], ['--accent', '--card'],
      ['--accent', '--paper'], ['--button-ink', '--button']
    ]) {
      const measured = ratio(colors[foreground], colors[background]);
      assert.ok(measured >= 4.5, `${foreground}/${background}: ${measured.toFixed(2)}`);
    }
  });
  test(`${selector}: control borders and focus meet 3:1`, () => {
    const colors = variables(selector);
    for (const foreground of ['--line', '--accent']) {
      for (const background of ['--paper', '--card', '--wash']) {
        const measured = ratio(colors[foreground], colors[background]);
        assert.ok(measured >= 3, `${foreground}/${background}: ${measured.toFixed(2)}`);
      }
    }
  });
}
