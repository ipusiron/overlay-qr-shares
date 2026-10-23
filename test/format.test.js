'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('maintained source files are readable and not minified', () => {
  const files = fs.readdirSync(root).filter(name => /\.(?:js|css|html|py)$/.test(name));
  files.push(...fs.readdirSync(path.join(root, 'test'))
    .filter(name => /\.(?:js|cjs|py)$/.test(name)).map(name => 'test/' + name));
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = text.split(/\r?\n/);
    const limit = file.endsWith('.html') ? 250 : 160;
    assert.ok(lines.length >= 10, `${file}: source should remain multiline`);
    for (const [index, line] of lines.entries()) {
      assert.ok(line.length <= limit, `${file}:${index + 1}: ${line.length} characters exceeds ${limit}`);
      assert.doesNotMatch(line, /[\t ]+$/, `${file}:${index + 1}: trailing whitespace`);
    }
    assert.ok(text.endsWith('\n'), `${file}: final newline`);
    assert.ok(!text.startsWith('\ufeff'), `${file}: UTF-8 without BOM`);
  }
});
