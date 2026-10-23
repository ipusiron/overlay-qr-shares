'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vc = require('../vc-core.js');
const vectors = require('./vectors.json');
const { SEEDS, BASE, AXES, tableMarkdown } = require('./robustness.js');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const docs = { ja: read('README.md'), en: read('README.en.md') };
const report = JSON.parse(read('test/robustness.json'));
const sourceFiles = ['rng.js', 'vc-core.js', 'qr.js', 'layout-core.js', 'render-core.js', 'reader-core.js',
  'test/helpers.js', 'test/robustness.js'];
const captures = ['screenshot.png', 'sheets.png', 'print-sheet.png', 'overlay-read.png', 'limits.png'];
const ignored = new Set(['.git', '.work', 'backups', 'logs', '__pycache__']);

function filesUnder(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name) || entry.name.endsWith('.pyc')) return [];
    const name = prefix + entry.name;
    return entry.isDirectory() ? filesUnder(path.join(directory, entry.name), name + '/') : [name];
  }).sort();
}
function sections(text) {
  const matches = [...text.matchAll(/^## (.+)$/gm)];
  return matches.map((match, index) => ({
    title: match[1], body: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length)
  }));
}
function treeFiles(text) {
  const section = sections(text).find(item => item.title.startsWith('📁'));
  assert.ok(section, 'directory section');
  const blocks = [...section.body.matchAll(/```text\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1, 'one directory tree');
  const parents = [], files = [];
  for (const line of blocks[0][1].trim().split('\n')) {
    assert.match(line, / # \S/, 'each tree entry has a description: ' + line);
    const entry = line.split(' # ')[0], match = entry.match(/^([ │├└─]*)([A-Za-z.][^ ]*)\s*$/u);
    assert.ok(match, 'a real, unabridged tree entry: ' + line);
    const depth = match[1].length / 4, name = match[2];
    assert.ok(Number.isInteger(depth), 'four-column tree indentation: ' + line);
    if (depth === 0) {
      assert.equal(name, 'overlay-qr-shares/');
      parents[0] = '';
      continue;
    }
    assert.ok(parents[depth - 1] !== undefined, 'tree parent exists: ' + line);
    const relative = parents[depth - 1] + name;
    assert.ok(fs.existsSync(path.join(root, relative)), 'present tree entry: ' + relative);
    if (name.endsWith('/')) {
      assert.ok(fs.statSync(path.join(root, relative)).isDirectory(), relative);
      parents[depth] = relative;
      parents.length = depth + 1;
    } else files.push(relative);
  }
  assert.equal(new Set(files).size, files.length, 'no duplicate tree files');
  return files.sort();
}
function paeth(a, b, c) {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
function pngBrightness(file) {
  const bytes = fs.readFileSync(path.join(root, file));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), color = bytes[25];
  assert.equal(bytes[24], 8, '8-bit screenshot: ' + file);
  assert.equal(bytes[28], 0, 'noninterlaced screenshot: ' + file);
  assert.ok(color === 2 || color === 6, 'RGB/RGBA screenshot: ' + file);
  assert.ok(width >= 600 && width <= 2000 && height >= 150 && height <= 4000, 'readable image dimensions: ' + file);
  const packed = [];
  for (let position = 8; position + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(position), type = bytes.subarray(position + 4, position + 8).toString('ascii');
    assert.ok(position + size + 12 <= bytes.length, 'PNG chunk bounds: ' + file);
    if (type === 'IDAT') packed.push(bytes.subarray(position + 8, position + 8 + size));
    position += size + 12;
  }
  const channels = color === 2 ? 3 : 4, stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(packed), { maxOutputLength: (stride + 1) * height });
  assert.equal(raw.length, (stride + 1) * height);
  let previous = Buffer.alloc(stride), bright = 0;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = raw[start], row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    assert.ok(filter <= 4, file);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0, above = previous[i], corner = i >= channels ? previous[i - channels] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, corner)][filter];
      row[i] = (row[i] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const offset = x * channels;
      if ((299 * row[offset] + 587 * row[offset + 1] + 114 * row[offset + 2]) / 1000 > 170) bright++;
      if (channels === 4) assert.equal(row[offset + 3], 255, 'opaque light screenshot: ' + file);
    }
    previous = row;
  }
  return bright / (width * height);
}

test('README has Japanese-only commented metadata with the requested categories, difficulty and hub', () => {
  const metadata = docs.ja.match(/^<!--\n---\n([\s\S]*?)\n---\n-->/);
  assert.ok(metadata, 'valid HTML-commented frontmatter');
  assert.match(metadata[1], /^id: day125$/m);
  assert.match(metadata[1], /^slug: overlay-qr-shares$/m);
  assert.match(metadata[1], /^title: "Overlay QR Shares"$/m);
  assert.match(metadata[1], /^category_ja:\n  - QRコード\n  - プレッパー$/m);
  assert.match(metadata[1], /^category_en:\n  - QR Code\n  - Prepping \/ Survival$/m);
  assert.match(metadata[1], /^difficulty: 3$/m);
  assert.match(metadata[1], /^hub: true$/m);
  assert.match(metadata[1], /^repo_url: "https:\/\/github\.com\/ipusiron\/overlay-qr-shares"$/m);
  assert.match(metadata[1], /^demo_url: "https:\/\/ipusiron\.github\.io\/overlay-qr-shares\/"$/m);
  for (const key of ['subtitle_ja', 'subtitle_en', 'description_ja', 'description_en']) {
    assert.match(metadata[1], new RegExp('^' + key + ': "[^"]+"$', 'm'), key);
  }
  assert.doesNotMatch(docs.en, /^(?:id: day125|category_ja:|category_en:|hub: true)/m, 'no English YAML frontmatter');
});

test('README headings retain complete corresponding sections and the series order', () => {
  const pairs = [
    [2, '🌐 デモページ', '🌐 Demo'],
    [2, '📸 スクリーンショット', '📸 Screenshots'],
    [2, '✨ できること', '✨ Features'],
    [2, '📖 使い方', '📖 Usage'],
    [3, '1. テスト印刷と読み取り', '1. Print and read a test'],
    [3, '2. 本番のシートを作る', '2. Create production sheets'],
    [3, '3. 重ねて読む', '3. Read the overlay'],
    [3, '4. 印刷後の確認と消去', '4. Check and clear after printing'],
    [3, '印刷の設定', 'Print settings'],
    [2, '🧾 方式と実物の試験状況', '🧾 Schemes and physical test status'],
    [3, '作者の印刷試験予定', 'Planned physical trials'],
    [2, '🔬 重ねると戻る仕組み', '🔬 How overlay recovery works'],
    [3, '平文の部分と分ける部分', 'Public and shared modules'],
    [3, '乱数と作成直後の確認', 'Randomness and creation checks'],
    [2, '⚖️ Day124との交換条件', '⚖️ Tradeoffs with Day124'],
    [2, '⚠️ 限界と改ざん', '⚠️ Limits and tampering'],
    [2, '🖨️ 印刷の経路とネットワーク盗聴', '🖨️ Printing route and network interception'],
    [2, '🔒 保管の指針', '🔒 Storage guidance'],
    [2, '🎯 ユースケース', '🎯 Use cases'],
    [2, '📐 OQS v1の書式', '📐 OQS v1 format'],
    [3, 'A4の配置と容量', 'A4 layout and capacity'],
    [3, '機械読み取り帯のビット列', 'Machine-readable metadata bits'],
    [2, '🐍 ブラウザーツールを使わずに戻す', '🐍 Recovery without the browser tool'],
    [2, '🧪 合成画像での耐性', '🧪 Synthetic image robustness'],
    [3, '測定の条件と範囲', 'Measurement conditions and scope'],
    [3, '作成直後の画像確認の標本密度', 'Sampling density for the creation image check'],
    [2, '🧪 テスト', '🧪 Tests'],
    [3, '自動テスト', 'Automated tests'],
    [3, 'ブラウザーでの確認', 'Browser checks'],
    [2, '🔗 先行研究と関連ツール', '🔗 Prior work and related tools'],
    [2, '📁 ディレクトリー構造', '📁 Directory structure'],
    [2, '💻 動作環境', '💻 Requirements'],
    [2, '📄 ライセンス', '📄 License'],
    [2, '🛠️ このツールについて', '🛠️ About this tool']
  ];
  for (const [column, language] of [[1, 'ja'], [2, 'en']]) {
    const text = docs[language], actual = [...text.matchAll(/^(#{2,3}) (.+)$/gm)].map(match => [match[1].length, match[2]]);
    assert.deepEqual(actual, pairs.map(pair => [pair[0], pair[column]]), language + ': complete heading correspondence');
    const blocks = sections(text);
    assert.equal(blocks.length, 20);
    for (const section of blocks) {
      assert.match(section.title, /^\p{Extended_Pictographic}/u, language + ': icon');
      assert.ok(section.body.trim().length > 20, language + ': substantive section ' + section.title);
    }
    assert.equal([...text.matchAll(/^# /gm)].length, 1);
    assert.match(text, /^# Overlay QR Shares [–—-] /m);
    assert.equal([...text.matchAll(/!\[GitHub/g)].length, 5);
    assert.match(text, /Day125/); assert.match(text, /200/);
    assert.doesNotMatch(text, /\bTODO\b|\bTBD\b|準備中/);
  }
});


test('README images exist, have captions, are independently displayed in light mode and leave no orphan assets', () => {
  const referenced = [];
  for (const [language, text] of Object.entries(docs)) {
    const images = [...text.matchAll(/!\[([^\]]+)\]\(([^)\s]+)\)/g)].filter(match => !/^(?:https?:|data:)/.test(match[2]));
    const expected = captures.map(name => 'assets/' + (language === 'en' ? 'en/' : '') + name);
    assert.deepEqual(images.map(match => match[2]), expected, language);
    for (const match of images) {
      const file = match[2], lineStart = text.lastIndexOf('\n', match.index) + 1;
      const lineEnd = text.indexOf('\n', match.index), line = text.slice(lineStart, lineEnd).trim();
      assert.equal(line, match[0], 'one full-width image per line: ' + file);
      const caption = text.slice(lineEnd).trimStart().split('\n')[0];
      assert.match(caption, /^> \*[^*\n]+\*$/, 'one-line caption: ' + file);
      assert.ok(fs.existsSync(path.join(root, file)), file);
      assert.ok(pngBrightness(file) > 0.55, 'light image pixels: ' + file);
      referenced.push(file);
    }
    assert.doesNotMatch(text, /<table|<img[^>]*(?:width|height)\s*=|assets\/[^)\s]*dark/i);
  }
  assert.deepEqual([...new Set(referenced)].sort(), filesUnder(path.join(root, 'assets'), 'assets/'), 'all assets used');
  const capture = read('test/screenshot.browser.py');
  assert.match(capture, /color_scheme='light'/);
  assert.match(capture, /get_attribute\('data-theme'\) == 'light'/);
  assert.match(capture, /\['sets'\]\[0\]\['text'\]/, 'screenshots use only the reference demo');
});

test('README directory trees describe every actual release file and the test lists cover all test programs', () => {
  const actual = filesUnder(root);
  for (const [language, text] of Object.entries(docs)) {
    assert.deepEqual(treeFiles(text), actual, language + ': complete real directory tree');
    const testing = sections(text)[14].body;
    for (const file of actual.filter(name => /^test\/.*(?:\.test\.js|\.browser\.py)$/.test(name))) {
      assert.ok(testing.includes(path.basename(file)), language + ': documented test ' + file);
    }
    assert.ok(testing.includes('robustness.js') && testing.includes('robustness.json'), language + ': separate robustness command');
    assert.match(testing, /npm test/);
    assert.match(testing, /npm run robustness/);
    assert.match(testing, /Node(?:\.js)? 22/);
  }
});

test('all seven physical scheme states stay untested and author trials are explicitly planned', () => {
  const ids = Object.keys(vc.SCHEMES);
  assert.equal(ids.length, 7);
  for (const scheme of Object.values(vc.SCHEMES)) assert.equal(scheme.status, 'untested');
  for (const [language, text] of Object.entries(docs)) {
    const section = sections(text)[4].body, split = section.indexOf('### ');
    assert.ok(split > 0, language + ': independent planned trial subsection');
    const states = section.slice(0, split), planned = section.slice(split);
    for (const id of ids) {
      const name = '(' + id.replace('-', ',') + ')';
      const state = states.split('\n').find(line => line.startsWith('| ' + name + ' |'));
      const trial = planned.split('\n').find(line => line.startsWith('| ' + name + ' |'));
      assert.ok(state, language + ': status row ' + name); assert.ok(trial, language + ': trial row ' + name);
      assert.match(state, language === 'ja' ? /未試験/ : /Untested/i);
      assert.match(trial, language === 'ja' ? /試験予定/ : /Planned/i);
      assert.doesNotMatch(state, language === 'ja' ? /試験済み/ : /\|\s*Tested\s*\|/i);
    }
  }
});

test('synthetic robustness metadata, all results and eight source hashes remain consistent', () => {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.model, 'independent-layer-transmission-v1');
  assert.equal(report.secret, vectors.sets[0].text);
  assert.match(report.node, /^v22\./);
  assert.ok(Number.isFinite(Date.parse(report.generatedAt)));
  assert.deepEqual(report.seeds, SEEDS); assert.deepEqual(report.baseline, BASE); assert.deepEqual(report.axes, AXES);
  assert.deepEqual(report.qr, { version: 4, ecl: 'M', moduleMm: 2.54 });
  assert.deepEqual(Object.keys(report.sourceHashes).sort(), sourceFiles.slice().sort());
  for (const file of sourceFiles) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    assert.equal(report.sourceHashes[file], digest, file + ': remeasure robustness after source changes');
  }
  const conditions = 1 + Object.values(AXES).reduce((sum, axis) => sum + axis.values.length, 0);
  assert.equal(report.distinctConditions, conditions * Object.keys(vc.SCHEMES).length);
  assert.equal(report.rows.length, report.distinctConditions);
  assert.equal(report.trialsPerCondition, SEEDS.length);
  assert.equal(report.imageTrials, report.distinctConditions * SEEDS.length);
  assert.equal(report.baselinePass, true);
  for (const id of Object.keys(vc.SCHEMES)) {
    const rows = report.rows.filter(row => row.scheme === id);
    assert.equal(rows.length, conditions, id);
    const baseline = rows.filter(row => row.axis === 'baseline');
    assert.equal(baseline.length, 1); assert.equal(baseline[0].passed, SEEDS.length);
    for (const [axis, details] of Object.entries(AXES)) {
      assert.deepEqual(rows.filter(row => row.axis === axis).map(row => row.value), details.values, id + '/' + axis);
    }
    for (const row of rows) {
      assert.equal(row.total, SEEDS.length);
      assert.deepEqual(row.trials.map(trial => trial.seed), SEEDS);
      assert.equal(row.passed, row.trials.filter(trial => trial.ok === true).length);
      for (const trial of row.trials) {
        assert.equal(typeof trial.ok, 'boolean');
        assert.ok(trial.ok ? trial.reason === null : typeof trial.reason === 'string' && trial.reason.length > 0);
      }
    }
  }
});

test('both README robustness tables are generated exactly from the saved measured JSON', () => {
  for (const [language, text] of Object.entries(docs)) {
    const blocks = [...text.matchAll(/<!-- robustness:start -->\n([\s\S]*?)\n<!-- robustness:end -->/g)];
    assert.equal(blocks.length, 1, language);
    assert.equal(blocks[0][1].trim(), tableMarkdown(report, language));
    const section = sections(text)[13].body;
    for (const term of ['126', '2', '12', '0.85', '0.8', '0.05', '2.54']) assert.ok(section.includes(term), language + ': condition ' + term);
    assert.match(section, language === 'ja' ? /合成画像/ : /synthetic/i);
    assert.match(section, language === 'ja' ? /実物|実際の印刷/ : /physical/i);
  }
});

test('README records frozen OQS dimensions, band ordering and standalone Python contract', () => {
  const layout = vectors.layout_2_2_v4_m254;
  for (const [language, text] of Object.entries(docs)) {
    const format = sections(text)[11].body, python = sections(text)[12].body;
    for (const value of [layout.Q, layout.W, layout.H, layout.normal.x, layout.normal.y,
      layout.mirror.x, layout.mirror.y, layout.calib.x, layout.calib.y, layout.band.x, layout.band.y]) {
      assert.ok(format.includes(String(value)), language + ': frozen layout ' + value);
    }
    for (const term of ['297', '210', '2.032', '2.54', '48', '40', '0x07', 'CRC-8']) assert.ok(format.includes(term), term);
    const reserved = language === 'ja' ? format.indexOf('予備') : format.toLowerCase().indexOf('reserved');
    assert.ok(reserved >= 0 && format.indexOf('CRC-8', reserved) > reserved, 'reserved bits precede CRC');
    for (const term of ['read_photo.py', '--corners', '--output', 'PNG', 'PBM']) assert.ok(python.includes(term), language + ': ' + term);
    assert.match(python, language === 'ja' ? /標準ライブラリー/ : /standard library/i);
    assert.match(python, language === 'ja' ? /未検証|検証しません/ : /not verif|unverified/i);
  }
});

test('README names, privacy boundaries, print route, related tools and inclusive uses remain explicit', () => {
  assert.match(docs.ja, /Overlay QR Sharesは、[^。\n]+するツールです。/);
  for (const [language, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /照合|突き合わせ|効く|走る|向き|分かる|絶対に安全|完全に安全/);
    for (const match of text.matchAll(/overlay qr shares/gi)) assert.equal(match[0], 'Overlay QR Shares');
    assert.doesNotMatch(text, /1回の印刷ジョブに全シート|all sheets in (?:a|one|a single) print job/i);
    for (const term of ['overlay', 'shares', 'QR', '2011', 'Day124', 'Day070', 'Day102']) assert.ok(text.includes(term), term);
    for (const slug of ['scatter-seeds', 'visual-cryptography-cipherlab', 'qrcrashtest']) {
      assert.ok(text.includes('https://ipusiron.github.io/' + slug + '/'), language + ': ' + slug);
    }
    const usage = sections(text)[3].body;
    if (language === 'ja') {
      assert.ok(/作者の紙による予備試験.*標準のカメラ.*読み取れませんでした/.test(usage), 'record the failed paper-camera observation');
      assert.ok(usage.includes('標準のカメラで読める保証はありません'), 'no standard-camera guarantee');
      assert.ok(/公開版OQS v1.*全方式が未試験/.test(usage), 'prototype observation does not certify the release');
    } else {
      assert.ok(/preliminary paper trial.*standard camera.*could not read/i.test(usage), 'record the failed paper-camera observation');
      assert.ok(/standard camera apps is not guaranteed/i.test(usage), 'no standard-camera guarantee');
      assert.ok(/all schemes.*OQS v1.*remain untested/i.test(usage), 'prototype observation does not certify the release');
    }
    const print = sections(text)[8].body;
    for (const term of ['USB', 'Wi-Fi', 'LAN', 'WSD', 'HTTP', 'PDF']) assert.ok(print.includes(term), language + ': print route ' + term);
    assert.match(print, language === 'ja' ? /スプーラー/ : /spooler/i);
    assert.match(print, language === 'ja' ? /ジョブ.*記憶|ジョブ.*保存/ : /job.*memor|job.*retain|job.*history|job.*storage|stored.*job/i);
    assert.match(text, language === 'ja' ? /悪用を勧めません/ : /does not encourage misuse/i);
    const uses = sections(text)[10].body;
    assert.match(uses, language === 'ja' ? /^\s*このツールならではの使い方\n/ : /^\s*Ways of using this tool in particular\n/i);
    assert.ok([...uses.matchAll(/^- /gm)].length >= 3, language + ': concrete uses');
  }
});


test('README capacity, public masks, area fractions, fitting sizes and examples follow the frozen vectors', () => {
  const rowCells = (body, first) => {
    const line = body.split('\n').find(value => value.startsWith('| ' + first + ' |'));
    assert.ok(line, 'table row ' + first);
    return line.split('|').slice(1, -1).map(value => value.trim());
  };
  const range = value => {
    const values = value.split(/[〜–]/).map(Number);
    return values.length === 1 ? [values[0], values[0]] : values;
  };
  for (const [language, text] of Object.entries(docs)) {
    const blocks = sections(text), schemes = blocks[4].body, format = blocks[11].body, uses = blocks[10].body;
    for (const [id, basis] of Object.entries(vectors.basis)) {
      const cells = rowCells(schemes, '(' + id.replace('-', ',') + ')'), theory = basis.theory[basis.k];
      assert.equal(Number(cells[1]), basis.k, language + '/' + id);
      assert.equal(cells[2], basis.r + '×' + basis.c);
      assert.deepEqual(range(cells[3]), theory.white, language + '/' + id + ': white');
      assert.deepEqual(range(cells[4]), theory.black, language + '/' + id + ': black');
    }
    for (const version of Object.keys(vectors.capacity.M)) {
      const cells = rowCells(format, version);
      assert.deepEqual(cells.slice(1).map(Number),
        [vectors.capacity.M[version], vectors.capacity.Q[version], vectors.plainMask[version].count], language + ': version ' + version);
    }
    for (const [size, versions] of Object.entries(vectors.fitTable)) {
      const cells = rowCells(format, size + 'mm');
      assert.equal(cells[1], Number(size) / vectors.basis['2-2'].c + 'mm');
      const ends = range(cells[2]);
      assert.deepEqual(Array.from({ length: ends[1] - ends[0] + 1 }, (_, i) => ends[0] + i), versions);
    }
    assert.ok(format.includes(vectors.sets[0].band), language + ': known band bits');
    assert.equal(vc.subsets(vectors.basis['2-3'].n).filter(rows => rows.length === vectors.basis['2-3'].k).length, 3);
    assert.ok(uses.includes('(2,3)') && /(?:全3組|all three pairs)/.test(uses), language + ': all pairs example');
    assert.equal(vectors.capacity.M['4'], 62);
    assert.ok(/62(?:バイト| bytes)/.test(uses), language + ': capacity example');
    const basis = vectors.basis['2-2'], black = [...basis.S0[0]].filter(bit => bit === '1').length;
    assert.equal(vc.subsets(basis.m).filter(cells => cells.length === black).length, 6);
    assert.ok(/(?:6種類|six)/.test(uses) && uses.includes('0.5'), language + ': six-pattern contrast example');
  }
});
