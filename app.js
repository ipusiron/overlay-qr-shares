/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const settings = Object.freeze({ language: 'overlay-qr-shares.language', theme: 'overlay-qr-shares.theme' });
  function stored(key) {
    try { return localStorage.getItem(settings[key]); }
    catch (_) { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(settings[key], value); }
    catch (_) { /* Preferences are optional, including on file URLs. */ }
  }
  const langParam = new URLSearchParams(location.search).get('lang');
  const savedLanguage = stored('language');
  const savedTheme = stored('theme');
  let language = ['ja', 'en'].includes(langParam) ? langParam
    : ['ja', 'en'].includes(savedLanguage) ? savedLanguage
      : navigator.language.startsWith('ja') ? 'ja' : 'en';
  let theme = ['light', 'dark'].includes(savedTheme) ? savedTheme
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const tabs = ['split', 'read', 'guide'];
  let active = 'split';
  let generation = 0;
  let busy = false;
  let trials = [];
  let outputs = [];
  let message = null;
  let testMessage = null;
  let progress = null;
  const pending = new Set();
  const basisChecks = Object.keys(OQS.vc.SCHEMES).map(id => OQS.vc.checkBasis(id).ok);
  const t = (key, ...args) => {
    const value = OQS.messages[language][key];
    return typeof value === 'function' ? value(...args) : value;
  };
  // file URLs cannot inspect linked stylesheet rules in Chromium.
  // A constructed sheet keeps dimensions in CSSOM without inline styles.
  if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
    const sheet = new CSSStyleSheet();
    const printRule = sheet.cssRules[sheet.insertRule('.print-sheet {}')];
    printRule.style.setProperty('width', '210mm');
    printRule.style.setProperty('height', '297mm');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }

  function parameters() {
    const n = Number($('sheet-count').value);
    const k = $('recover-all').checked && n > 2 ? n : 2;
    return { id: k + '-' + n, version: Number($('qr-version').value), ecl: $('error-correction').value,
      m: Number($('module-size').value), n, k };
  }
  function zeroSet(set) {
    for (const array of [...set.data, ...set.calib, set.modules, set.plain, set.band]) array.fill(0);
  }
  function discard(records) {
    records.forEach(record => { zeroSet(record.set); record.testText = ''; });
    records.length = 0;
  }
  function cancelWork() {
    generation++;
    busy = false;
    progress = null;
    for (const set of pending) zeroSet(set);
    pending.clear();
  }
  function invalidate(all) {
    const existed = outputs.length || busy || all && trials.length;
    cancelWork();
    discard(outputs);
    if (all) {
      discard(trials);
      $('test-read-confirm').checked = false;
      testMessage = null;
    }
    for (const id of ['check-all-sheets', 'check-ruler', 'check-disposal']) $(id).checked = false;
    if (existed) message = { key: 'changed', args: [] };
    clearPrintSelection();
    renderCards();
  }
  function fitVersions() {
    const p = parameters();
    const versions = [3, 4, 5, 6, 7].filter(version => OQS.layout.layout(p.id, version, p.m).fits);
    const old = p.version;
    $('qr-version').replaceChildren(...versions.map(version => {
      const option = document.createElement('option');
      option.value = String(version);
      option.textContent = String(version);
      return option;
    }));
    $('qr-version').value = String(versions.includes(old) ? old : versions[versions.length - 1]);
    $('recover-all').disabled = p.n === 2;
    if (p.n === 2) $('recover-any').checked = true;
  }
  function inputState() {
    const p = parameters(), value = $('secret-input').value;
    const capacity = OQS.qr.capacity(p.version, p.ecl);
    const bytes = new TextEncoder().encode(value);
    const count = bytes.length;
    bytes.fill(0);
    const surrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
    const error = surrogate ? 'inputSurrogate' : count > capacity ? 'inputCapacity' : !count ? 'inputEmpty' : null;
    return { capacity, count, error };
  }
  function renderInput() {
    const state = inputState(), value = $('secret-input').value;
    const invalid = state.error && state.error !== 'inputEmpty';
    $('byte-status').textContent = invalid ? t(state.error) : t('bytesRemaining', state.capacity - state.count, state.capacity);
    $('byte-status').classList.toggle('input-error', !!invalid);
    $('secret-input').setAttribute('aria-invalid', String(!!invalid));
    const warnings = [];
    if (/^\s*[a-z][a-z0-9+.-]*:\/\//i.test(value)) warnings.push(t('urlWarning'));
    if (value && value !== value.trim()) warnings.push(t('spaceWarning'));
    $('input-warnings').textContent = warnings.join(' ');
    $('input-warnings').hidden = warnings.length === 0;
    $('split-button').disabled = busy || !!state.error || !$('test-read-confirm').checked;
    $('test-button').disabled = busy;
    $('test-read-confirm').disabled = busy || !trials.some(record => record.set.m === parameters().m);
  }
  function renderSplit() {
    const p = parameters(), basis = OQS.vc.basis(p.id);
    $('scheme-status').textContent = t(p.k > 2 ? 'schemeFilm' : p.n > 2 ? 'schemeExperimental' : 'schemePrimary', p.n);
    $('size-hint').textContent = t('sizeHint', basis.r, basis.c, p.m / basis.r, p.m / basis.c,
      OQS.qr.capacity(p.version, p.ecl)) + ' ' + t('fitNote');
    $('split-status').textContent = message ? t(message.key, ...message.args) : '';
    $('test-status').textContent = testMessage ? t(testMessage.key, ...testMessage.args) : '';
    $('split-progress').hidden = !progress;
    if (progress) {
      $('progress-bar').value = progress.done;
      $('progress-bar').max = progress.total;
      $('progress-text').textContent = t(progress.image ? 'checkImage' : 'checkProgressText', progress.done, progress.total);
    }
    $('print-checks').hidden = !outputs.length;
    const checked = ['check-all-sheets', 'check-ruler', 'check-disposal'].every(id => $(id).checked);
    $('clear-reminder').textContent = t(checked ? 'clearReady' : 'clearPending');
    renderInput();
  }
  function status(key, args, isTest) {
    if (isTest) testMessage = { key, args: args || [] };
    else message = { key, args: args || [] };
    renderSplit();
  }
  async function pause(ticket) {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (ticket !== generation) throw new Error('cancelled');
  }
  async function checkSet(set, text, ticket) {
    const basis = OQS.vc.basis(set.id);
    if (basisChecks.some(ok => !ok) || set.data.some(data => !OQS.vc.checkSheetWeights(data, set.N, set.plain, set.id))) {
      throw new Error('structure');
    }
    const groups = OQS.vc.subsets(set.n).filter(indices => indices.length === set.k || indices.length === set.k - 1);
    progress = { done: 0, total: groups.length, image: false };
    renderSplit();
    for (const indices of groups) {
      await pause(ticket);
      const modules = OQS.vc.stackModules(set.data, indices, set.N, set.plain, set.id);
      let decoded;
      try {
        decoded = OQS.qr.decodeModules(modules, set.N);
        if (indices.length === set.k ? !decoded.ok || decoded.text !== text : decoded.ok) throw new Error('group');
      } finally {
        modules.fill(0);
        if (decoded && decoded.bytes) decoded.bytes.fill(0);
        if (decoded) decoded.text = '';
      }
      progress.done++;
      renderSplit();
    }
    await pause(ticket);
    progress.image = true;
    renderSplit();
    const indices = Array.from({ length: set.k }, (_, i) => i);
    // The 3x3 sampling patch plus radius-one blur spans five pixels.
    // Use at least six per subpixel for this functional check, not a physical robustness claim.
    // The one-pixel blur is 1 / pxPerMm millimetres in this synthetic scene.
    const pxPerMm = Math.max(6, Math.ceil(6 * Math.max(basis.r, basis.c) / set.m));
    const image = OQS.render.synthStack(set, indices, { pxPerMm, fullPage: true, blur: 1, ink: .85 });
    try {
      const metadata = { id: set.id, version: set.version, m: set.m, ecl: set.ecl, setId: set.setId };
      for (const mirrored of [false, true]) {
        await pause(ticket);
        const result = OQS.reader.readSample(image, { ...image.geometry, mirrored }, metadata, jsQR);
        const matches = result.ok && result.text === text;
        result.text = '';
        if (!matches) throw new Error('image');
      }
    } finally { image.gray.fill(0); }
  }
  function testValue() {
    const bytes = OQS.rng.cryptoRng(6);
    try { return 'TEST-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase(); }
    finally { bytes.fill(0); }
  }
  async function generate(isTest) {
    if (busy) return;
    if (!isTest && (!$('test-read-confirm').checked || !trials.some(record => record.set.m === parameters().m))) {
      status('trialRequired', [], false);
      return;
    }
    if (!isTest && inputState().error) { status(inputState().error, [], false); return; }
    invalidate(isTest);
    const ticket = generation, p = parameters(), started = performance.now();
    busy = true;
    message = null;
    status('working', [], isTest);
    const made = [];
    let secret = isTest ? '' : $('secret-input').value;
    try {
      if (!globalThis.crypto || typeof crypto.getRandomValues !== 'function') throw new Error('crypto');
      const sizes = isTest ? OQS.layout.MSIZES.filter(m => OQS.layout.layout(p.id, p.version, m).fits) : [p.m];
      for (let number = 0; number < sizes.length; number++) {
        await pause(ticket);
        if (isTest) secret = testValue();
        const set = OQS.vc.makeSet(secret, p.id, p.version, p.ecl, OQS.layout.MSIZES.indexOf(sizes[number]), OQS.rng.cryptoRng);
        if (set.error) throw new Error(set.error);
        pending.add(set);
        await checkSet(set, secret, ticket);
        made.push({ set, type: isTest ? 'test' : 'secret', testText: isTest ? secret : '', token: `${ticket}-${number}`, printed: new Set() });
      }
      await pause(ticket);
      for (const record of made) pending.delete(record.set);
      if (isTest) trials = made;
      else outputs = made;
      busy = false;
      progress = null;
      status(isTest ? 'testsCompleted' : 'completed', isTest ? [] : [p.n, ((performance.now() - started) / 1000).toFixed(2)], isTest);
      renderCards();
    } catch (error) {
      for (const record of made) { pending.delete(record.set); zeroSet(record.set); record.testText = ''; }
      if (ticket === generation) {
        for (const set of pending) zeroSet(set);
        pending.clear();
        busy = false;
        progress = null;
        status(error.message === 'crypto' ? 'cryptoFailed' : 'generateFailed', [], isTest);
      }
    } finally { secret = ''; }
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svgElement(tag, attributes, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function printLabels(record, symbol, index, mirrored) {
    const set = record.set;
    const group = svgElement('g', { fill: '#000', 'font-family': 'sans-serif' });
    if (mirrored) group.setAttribute('transform', 'translate(0 297) scale(1 -1)');
    const text = (x, y, size, content, weight) => {
      group.append(svgElement('text', { x, y, 'font-size': size, 'font-weight': weight || 400 }, content));
    };
    text(13 + index * 19, 20, 11, symbol, 700);
    text(112, 12, 4, 'Overlay QR Shares', 700);
    text(112, 16, 2.8, t('printSheetLine', symbol, set.id, set.setId));
    text(135, 20, 2.6, `${set.m} mm / V${set.version} / ${set.ecl} / ${t('printUntested')}`);
    text(13, 24, 2.7, t(mirrored ? 'printMirror' : 'printFlip'), mirrored ? 700 : 400);
    if (record.type === 'test') text(163, 24, 2.5, t('printTest'), 700);
    text(13, 27.5, 2.1, 'https://ipusiron.github.io/overlay-qr-shares/');
    return group;
  }
  function makePrintSheet(record, index, symbol, key) {
    const paths = OQS.render.sheetPaths(record.set, index);
    const wrapper = element('article', 'print-sheet');
    wrapper.dataset.printKey = key;
    wrapper.dataset.sheet = symbol;
    const svg = svgElement('svg', { viewBox: '0 0 210 297', class: 'print-svg', 'aria-hidden': 'true' });
    svg.append(svgElement('path', { d: paths.normalPath, fill: '#000', class: 'sample-normal' }));
    svg.append(svgElement('path', { d: paths.mirrorPath, fill: '#000', transform: paths.mirrorTransform, class: 'sample-mirror' }));
    svg.append(svgElement('path', { d: paths.rulerPath, fill: '#000', class: 'rulers' }));
    svg.append(printLabels(record, symbol, index, false), printLabels(record, symbol, index, true));
    svg.append(svgElement('text', { x: 194.5, y: 150, transform: 'rotate(-90 194.5 150)', fill: '#000',
      'font-size': 2.7, 'text-anchor': 'middle', class: 'ruler-label' }, '100 mm'));
    svg.append(svgElement('text', { x: 105, y: 19, fill: '#000', 'font-size': 2.2, 'text-anchor': 'middle' }, '50 mm'));
    svg.append(svgElement('text', { x: 105, y: 149.3, fill: '#000', 'font-size': 2.2,
      'text-anchor': 'middle' }, t('printAlign')));
    wrapper.append(svg);
    return wrapper;
  }
  function renderCards() {
    $('test-cards').replaceChildren();
    $('share-cards').replaceChildren();
    $('print-root').replaceChildren();
    for (const record of [...trials, ...outputs]) {
      const set = record.set, basis = OQS.vc.basis(set.id);
      for (let index = 0; index < set.n; index++) {
        const symbol = (record.type === 'test' ? 'T' : '') + String.fromCharCode(65 + index);
        const key = record.token + '-' + symbol;
        const card = element('article', 'sheet-card');
        card.dataset.sheet = symbol;
        card.dataset.moduleSize = String(set.m);
        card.append(element('h4', 'sheet-symbol', symbol));
        card.append(element('p', 'sheet-title', t('sheetTitle', symbol)));
        card.append(element('p', 'note', t('sheetInfo', set.id, set.setId, set.m)));
        card.append(element('p', 'note', t('sheetMeasure', set.m / basis.c, set.m / basis.r)));
        if (record.type === 'test') card.append(element('p', 'test-value', t('testText', record.testText)));
        const button = element('button', 'button-secondary', t('sheetPrint', symbol));
        button.type = 'button';
        button.dataset.printKey = key;
        button.addEventListener('click', () => printOne(record, index, symbol, key));
        card.append(button);
        if (record.printed.has(index)) card.append(element('p', 'note print-attempted', t('printAttempted')));
        $(record.type === 'test' ? 'test-cards' : 'share-cards').append(card);
        $('print-root').append(makePrintSheet(record, index, symbol, key));
      }
    }
    renderSplit();
  }
  function clearPrintSelection() {
    delete document.body.dataset.printSheet;
    document.querySelectorAll('.print-sheet').forEach(node => { delete node.dataset.selected; });
  }
  function printOne(record, index, symbol, key) {
    clearPrintSelection();
    const target = [...$('print-root').children].find(node => node.dataset.printKey === key);
    if (!target) return;
    document.body.dataset.printSheet = key;
    target.dataset.selected = 'true';
    record.printed.add(index);
    const button = [...document.querySelectorAll('button[data-print-key]')].find(node => node.dataset.printKey === key);
    if (button && !button.parentElement.querySelector('.print-attempted')) {
      button.parentElement.append(element('p', 'note print-attempted', t('printAttempted')));
    }
    status('printRequested', [symbol], record.type === 'test');
    window.print();
  }

  function render() {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-i18n]').forEach(element => {
      element.textContent = t(element.dataset.i18n);
    });
    document.querySelectorAll('[data-label]').forEach(element => {
      element.setAttribute('aria-label', t(element.dataset.label));
    });
    $('language').textContent = language === 'ja' ? 'EN' : 'JA';
    $('theme').setAttribute('aria-pressed', String(theme === 'dark'));
    tabs.forEach(name => {
      const selected = name === active;
      $('tab-' + name).setAttribute('aria-selected', String(selected));
      $('tab-' + name).tabIndex = selected ? 0 : -1;
      $('panel-' + name).hidden = !selected;
    });
    renderSplit();
    renderCards();
  }

  tabs.forEach((name, index) => {
    const tab = $('tab-' + name);
    tab.addEventListener('click', () => {
      active = name;
      render();
    });
    tab.addEventListener('keydown', event => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!delta && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + delta + tabs.length) % tabs.length;
      const nextTab = $('tab-' + tabs[next]);
      nextTab.click();
      nextTab.focus();
    });
  });
  $('theme').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    save('theme', theme);
    render();
  });
  $('language').addEventListener('click', () => {
    language = language === 'ja' ? 'en' : 'ja';
    save('language', language);
    render();
  });
  $('help').addEventListener('click', () => {
    $('help-dialog').showModal();
    $('help-content').scrollTop = 0;
    $('help-title').focus({ preventScroll: true });
  });
  $('help-close').addEventListener('click', () => $('help-dialog').close());
  $('help-dialog').addEventListener('close', () => $('help').focus());
  $('help-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      $('help-dialog').close();
      return;
    }
    if (event.key !== 'Tab') return;
    const first = $('help-close');
    const last = $('help-content');
    if (event.shiftKey && [first, $('help-title')].includes(document.activeElement)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  for (const id of ['sheet-count', 'recover-any', 'recover-all', 'module-size', 'qr-version', 'error-correction']) {
    $(id).addEventListener('change', () => {
      invalidate(true);
      fitVersions();
      render();
    });
  }
  $('secret-input').addEventListener('input', () => {
    invalidate(false);
    render();
  });
  $('test-button').addEventListener('click', () => { generate(true); });
  $('split-button').addEventListener('click', () => { generate(false); });
  $('test-read-confirm').addEventListener('change', renderSplit);
  $('open-reader').addEventListener('click', () => { active = 'read'; render(); $('tab-read').focus(); });
  for (const id of ['check-all-sheets', 'check-ruler', 'check-disposal']) $(id).addEventListener('change', renderSplit);
  $('clear-all').addEventListener('click', () => {
    invalidate(true);
    $('secret-input').value = '';
    message = { key: 'cleared', args: [] };
    testMessage = null;
    render();
  });
  window.addEventListener('afterprint', clearPrintSelection);
  window.addEventListener('pagehide', () => {
    invalidate(true);
    $('secret-input').value = '';
    $('print-root').replaceChildren();
    $('share-cards').replaceChildren();
    $('test-cards').replaceChildren();
  });
  fitVersions();
  render();
})();
