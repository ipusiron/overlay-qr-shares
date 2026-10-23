/* Overlay QR Shares - MIT (c) 2026 ipusiron. Explicit synthetic robustness measurement. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vc = require('../vc-core.js');
const render = require('../render-core.js');
const reader = require('../reader-core.js');
const { seededRng } = require('./helpers.js');
const vectors = require('./vectors.json');
const ROOT = path.resolve(__dirname, '..');
const SEEDS = Object.freeze([125001, 125002]);
const BASE = Object.freeze({ pxPerMm: 12, ink: 0.85, blur: 0, floor: 0.05, gain: 0.8, tilt: 0 });
const AXES = Object.freeze({
  shift: Object.freeze({ unit: 'mm', baseline: 0, values: [0.25, 0.75] }),
  blur: Object.freeze({ unit: 'px', baseline: 0, values: [1, 3] }),
  ink: Object.freeze({ unit: 'fraction', baseline: 0.85, values: [0.65, 0.4] }),
  tilt: Object.freeze({ unit: 'fraction', baseline: 0, values: [0.25, 0.55] })
});
function sourceHashes() {
  return Object.fromEntries(['rng.js', 'vc-core.js', 'qr.js', 'layout-core.js', 'render-core.js', 'reader-core.js',
    'test/helpers.js', 'test/robustness.js']
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
}
function optionsFor(axis, value, n) {
  const opts = { ...BASE };
  if (axis === 'shift') { opts.dx = Array(n).fill(0); opts.dx[1] = value; }
  else if (axis !== 'baseline') opts[axis] = value;
  return opts;
}
function clearSet(set) {
  set.modules.fill(0); set.plain.fill(0); set.data.forEach(bytes => bytes.fill(0));
  set.calib.forEach(bytes => bytes.fill(0)); set.band.fill(0);
}
function finiteMetric(value) { return Number.isFinite(value) ? Number(value.toFixed(6)) : null; }
function buildReport(onProgress) {
  if (typeof reader.readFrame !== 'function') throw new Error('Automatic image-only reader is not ready');
  const sources = sourceHashes(), rows = [], definitions = [{ axis: 'baseline', value: null, unit: 'baseline' }];
  for (const [axis, details] of Object.entries(AXES)) for (const value of details.values) definitions.push({ axis, value, unit: details.unit });
  for (const id of Object.keys(vc.SCHEMES)) {
    const cases = definitions.map(definition => ({ scheme: id, ...definition, passed: 0, total: SEEDS.length, trials: [] }));
    for (const seed of SEEDS) {
      const set = vc.makeSet(vectors.sets[0].text, id, 4, 'M', 1, seededRng(seed));
      try {
        const indices = Array.from({ length: set.k }, (_, i) => i);
        for (const row of cases) {
          const options = optionsFor(row.axis, row.value, set.n);
          row.options = options;
          const image = render.synthStack(set, indices, options);
          try {
            // Only original pixels enter readFrame. Geometry, metadata and the expected secret stay outside it.
            const result = reader.readFrame({ gray: image.gray, w: image.w, h: image.h });
            const ok = result.ok === true && result.text === vectors.sets[0].text;
            const diag = result.diag || {};
            row.trials.push({ seed, ok, reason: ok ? null : result.ok ? 'unexpected-text' : result.reason || 'unknown',
              diag: { margin: finiteMetric(diag.margin), threshold: finiteMetric(diag.threshold), level: diag.level || null,
                attempts: Number.isInteger(diag.attempts) ? diag.attempts : null, flags: Array.isArray(diag.flags) ? diag.flags : [] } });
            if (ok) row.passed++;
          } finally { image.gray.fill(0); }
        }
      } finally { clearSet(set); }
    }
    rows.push(...cases);
    if (onProgress) onProgress(id, cases.reduce((sum, row) => sum + row.passed, 0), cases.length * SEEDS.length);
  }
  if (JSON.stringify(sourceHashes()) !== JSON.stringify(sources)) throw new Error('Source changed during measurement; repeat after edits finish');
  const baselinePass = rows.filter(row => row.axis === 'baseline').every(row => row.passed === row.total);
  return { schemaVersion: 1, model: 'independent-layer-transmission-v1', sourceHashes: sources,
    generatedAt: new Date().toISOString(), node: process.version, secret: vectors.sets[0].text,
    qr: { version: 4, ecl: 'M', moduleMm: 2.54 }, seeds: SEEDS, baseline: BASE, axes: AXES,
    sample: 'cropped normal sample, including registration marks; automatic image-only reader',
    trialsPerCondition: SEEDS.length, distinctConditions: rows.length, imageTrials: rows.length * SEEDS.length,
    baselinePass, rows };
}
function tableMarkdown(report, language) {
  const header = language === 'ja'
    ? '| \u65b9\u5f0f | \u57fa\u6e96 | \u6a2a\u305a\u308c 0.25 / 0.75 mm |'
      + ' \u307c\u3051 1 / 3 px | \u30a4\u30f3\u30af 0.65 / 0.40 | \u7167\u660e\u50be\u304d 0.25 / 0.55 |'
    : '| Scheme | Baseline | Shift 0.25 / 0.75 mm | Blur 1 / 3 px | Ink 0.65 / 0.40 | Light slope 0.25 / 0.55 |';
  const out = [header, '|---|---|---|---|---|---|'];
  const score = row => row.passed + '/' + row.total;
  for (const id of Object.keys(vc.SCHEMES)) {
    const own = report.rows.filter(row => row.scheme === id);
    const values = [score(own.find(row => row.axis === 'baseline'))];
    for (const axis of Object.keys(AXES)) values.push(own.filter(row => row.axis === axis).map(score).join('; '));
    out.push('| (' + id.replace('-', ',') + ') | ' + values.join(' | ') + ' |');
  }
  return out.join('\n');
}
function main() {
  const started = performance.now();
  const report = buildReport((id, passed, total) => process.stderr.write(id + ': ' + passed + '/' + total + '\n'));
  const file = path.join(__dirname, 'robustness.json');
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
  const compact = stamp.replace(/[^0-9]/g, '');
  if (fs.existsSync(file)) {
    const backup = path.join(ROOT, 'backups', 'robustness.json_' + compact + '_' + process.pid + '.bak');
    fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  const log = path.join(ROOT, 'logs', 'changes', 'robustness_' + compact.slice(0, 8) + '.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, '[' + stamp + '] [CREATE/UPDATE] [test/robustness.json] [robustness] Measured '
    + report.imageTrials + ' images\n');
  process.stdout.write(tableMarkdown(report, 'en') + '\n');
  process.stderr.write('Measured ' + report.imageTrials + ' images in ' + ((performance.now() - started) / 1000).toFixed(2) + 's\n');
  if (!report.baselinePass) process.exitCode = 1;
}
// Node's test discovery includes ordinary .js files under test/. Measurement must be explicitly requested.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  try { main(); } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
}
module.exports = { SEEDS, BASE, AXES, optionsFor, buildReport, tableMarkdown };
