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
  let cameraStream = null;
  let cameraGeneration = 0;
  let cameraPending = false;
  let frameHandle = null;
  let frameCount = 0;
  let cameraMessage = { key: 'cameraIdle', args: [] };
  let recovered = '';
  let revealed = false;
  let diagnosis = null;
  let frozen = null;
  let corners = [];
  let cursor = { x: 0, y: 0 };
  let manualMessage = null;
  let copyMessage = null;
  const fullCanvas = document.createElement('canvas');
  const detectCanvas = document.createElement('canvas');
  const manualBase = document.createElement('canvas');
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
    const primaryKey = OQS.vc.physicalStatus(p) === 'tested' ? 'schemePrimaryTested' : 'schemePrimary';
    $('scheme-status').textContent = t(p.k > 2 ? 'schemeFilm' : p.n > 2 ? 'schemeExperimental' : primaryKey, p.n);
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
    const physicalKey = OQS.vc.physicalStatus(set) === 'tested' ? 'printTested' : 'printUntested';
    text(135, 20, 2.6, `${set.m} mm / V${set.version} / ${set.ecl} / ${t(physicalKey)}`);
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
  function setCameraMessage(key, args) {
    cameraMessage = { key, args: args || [] };
    renderReader();
  }
  function stopCamera(announce) {
    cameraGeneration++;
    cameraPending = false;
    if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    frameHandle = null;
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    $('camera-video').srcObject = null;
    fullCanvas.width = fullCanvas.height = detectCanvas.width = detectCanvas.height = 0;
    if (announce) cameraMessage = { key: 'cameraStopped', args: [] };
    renderReader();
  }
  function clearFrozen() {
    if (frozen) frozen.gray.fill(0);
    frozen = null;
    corners = [];
    manualMessage = null;
    manualBase.width = manualBase.height = 0;
    $('manual-canvas').width = $('manual-canvas').height = 0;
    $('manual-zoom').width = $('manual-zoom').height = 0;
  }
  function clearRead(announce) {
    stopCamera(false);
    clearFrozen();
    recovered = '';
    revealed = false;
    diagnosis = null;
    copyMessage = null;
    cameraMessage = { key: announce ? 'readCleared' : 'cameraIdle', args: [] };
    renderReader();
  }
  function frameImage(canvas, source, w, h) {
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, w, h);
    const rgba = context.getImageData(0, 0, w, h);
    try {
      const gray = new Uint8ClampedArray(w * h);
      for (let i = 0; i < gray.length; i++) {
        gray[i] = Math.round(.2126 * rgba.data[i * 4] + .7152 * rgba.data[i * 4 + 1] + .0722 * rgba.data[i * 4 + 2]);
      }
      return { gray, w, h };
    } finally { rgba.data.fill(0); }
  }
  function currentFrame() {
    const video = $('camera-video');
    if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
    return frameImage(fullCanvas, video, video.videoWidth, video.videoHeight);
  }
  function applyReading(result) {
    diagnosis = result.diag || null;
    if (result.ok) {
      recovered = result.text;
      result.text = '';
      revealed = false;
      stopCamera(false);
      clearFrozen();
      cameraMessage = { key: 'readSuccess', args: [] };
    } else {
      const reasons = { marks: 'reasonMarks', band: 'reasonBand', metadata: 'reasonBand', geometry: 'reasonGeometry',
        finder: 'reasonGeometry', manual: 'reasonGeometry', image: 'reasonGeometry', illumination: 'reasonIllumination',
        calibration: 'reasonCalibration', decode: 'reasonDecode' };
      cameraMessage = { key: reasons[result.reason] || 'reasonDecode', args: [] };
    }
    renderReader();
  }
  function nextFrame(ticket) {
    if (ticket !== cameraGeneration || !cameraStream) return;
    frameHandle = requestAnimationFrame(() => {
      if (ticket !== cameraGeneration || !cameraStream) return;
      frameCount++;
      if (frameCount % 4 === 0 && $('camera-video').readyState >= 2) {
        let image = null, small = null;
        try {
          image = currentFrame();
          if (image) {
            const scale = Math.min(1, 640 / Math.max(image.w, image.h));
            small = frameImage(detectCanvas, fullCanvas, Math.round(image.w * scale), Math.round(image.h * scale));
            const result = OQS.reader.readFrame(image, { detectImage: small });
            if (ticket === cameraGeneration) applyReading(result);
          }
        } catch (_) {
          if (ticket === cameraGeneration) { stopCamera(false); setCameraMessage('reasonGeometry'); }
        } finally {
          if (image) image.gray.fill(0);
          if (small) small.gray.fill(0);
          fullCanvas.width = fullCanvas.height = detectCanvas.width = detectCanvas.height = 0;
        }
      }
      nextFrame(ticket);
    });
  }
  async function startCamera() {
    if (cameraPending || cameraStream || !$('reader-camera').open) return;
    clearRead(false);
    $('camera-fallback').hidden = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      $('camera-fallback').hidden = false;
      setCameraMessage('cameraError');
      return;
    }
    const ticket = ++cameraGeneration;
    cameraPending = true;
    setCameraMessage('cameraRequest');
    // Touch browsers may leave focus on an off-screen tab; anchor it before the permission prompt.
    $('stop-camera').focus({ preventScroll: true });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: {
        facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }
      }, audio: false });
      if (ticket !== cameraGeneration || active !== 'read' || document.hidden || !$('reader-camera').open) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      cameraStream = stream;
      cameraPending = false;
      $('camera-video').srcObject = stream;
      renderReader();
      await $('camera-video').play();
      if (ticket !== cameraGeneration) return;
      frameCount = 0;
      setCameraMessage('cameraScanning', [0]);
      nextFrame(ticket);
    } catch (_) {
      if (ticket !== cameraGeneration) return;
      stopCamera(false);
      $('camera-fallback').hidden = location.protocol === 'https:';
      setCameraMessage('cameraError');
    }
  }
  function freezeFrame() {
    let image = null;
    try {
      image = currentFrame();
      if (!image) { setCameraMessage('manualEmpty'); return; }
      stopCamera(false);
      clearFrozen();
      frozen = image;
      cursor = { x: image.w / 2, y: image.h / 2 };
      manualBase.width = image.w;
      manualBase.height = image.h;
      const context = manualBase.getContext('2d');
      const rgba = context.createImageData(image.w, image.h);
      try {
        for (let i = 0; i < image.gray.length; i++) {
          rgba.data[i * 4] = rgba.data[i * 4 + 1] = rgba.data[i * 4 + 2] = image.gray[i];
          rgba.data[i * 4 + 3] = 255;
        }
        context.putImageData(rgba, 0, 0);
      } finally { rgba.data.fill(0); }
      renderReader();
      drawManual();
      $('manual-canvas').focus();
    } catch (_) {
      if (image) image.gray.fill(0);
      stopCamera(false);
      clearFrozen();
      setCameraMessage('reasonGeometry');
    }
  }
  function drawManual() {
    if (!frozen) return;
    const canvas = $('manual-canvas');
    canvas.width = frozen.w;
    canvas.height = frozen.h;
    const context = canvas.getContext('2d');
    context.drawImage(manualBase, 0, 0);
    const radius = Math.max(8, frozen.w / 100);
    for (const [index, point] of [...corners, cursor].entries()) {
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.lineWidth = Math.max(3, frozen.w / 320);
      context.strokeStyle = '#ffffff';
      context.stroke();
      context.lineWidth = Math.max(1, frozen.w / 640);
      context.strokeStyle = '#000000';
      context.stroke();
      if (index < corners.length) {
        context.font = `${Math.max(20, frozen.w / 40)}px sans-serif`;
        context.fillStyle = '#000000';
        context.fillText(String(index + 1), point.x + radius, point.y - radius);
      }
    }
    const zoom = $('manual-zoom');
    zoom.width = zoom.height = 160;
    const lens = zoom.getContext('2d');
    lens.imageSmoothingEnabled = false;
    lens.drawImage(manualBase, cursor.x - 20, cursor.y - 20, 40, 40, 0, 0, 160, 160);
    lens.strokeStyle = '#ffffff';
    lens.lineWidth = 3;
    lens.strokeRect(77, 77, 6, 6);
    lens.strokeStyle = '#000000';
    lens.lineWidth = 1;
    lens.strokeRect(77, 77, 6, 6);
  }
  function selectCorner() {
    if (!frozen || corners.length >= 4) return;
    const point = OQS.reader.snapPoint(frozen, cursor);
    if (!point.ok) { manualMessage = 'manualNoSnap'; renderReader(); return; }
    corners.push({ x: point.x, y: point.y });
    manualMessage = null;
    drawManual();
    if (corners.length === 4) {
      const result = OQS.reader.readFrame(frozen, { manualCorners: corners });
      applyReading(result);
      // The frozen frame is no longer needed once all four points have been processed.
      clearFrozen();
    }
    renderReader();
  }
  function renderReader() {
    $('camera-status').textContent = t(cameraMessage.key, ...cameraMessage.args);
    if (cameraStream && diagnosis) $('camera-status').textContent += ' ' + t('cameraScanning', Number(diagnosis.marks) || 0);
    const cameraBusy = cameraPending || !!cameraStream;
    const start = $('camera-button'), stop = $('stop-camera');
    // Move focus before disabling/hiding its current control, without moving the viewport.
    if (cameraBusy) {
      stop.hidden = false;
      if (document.activeElement === start) stop.focus({ preventScroll: true });
      start.disabled = true;
    } else {
      start.disabled = false;
      if (document.activeElement === stop) start.focus({ preventScroll: true });
      stop.hidden = true;
    }
    $('camera-view').hidden = !cameraStream;
    $('manual-button').disabled = !cameraStream || $('camera-video').readyState < 2;
    $('manual-view').hidden = !frozen;
    if (frozen) {
      const names = ['cornerTL', 'cornerTR', 'cornerBR', 'cornerBL'];
      $('manual-status').textContent = manualMessage ? t(manualMessage) : t('manualPoint', t(names[Math.min(3, corners.length)]));
    }
    $('read-result').hidden = !recovered;
    $('read-mask').hidden = revealed;
    $('read-value').hidden = !revealed;
    $('read-value').textContent = revealed ? recovered : '';
    $('reveal').textContent = t(revealed ? 'hide' : 'reveal');
    $('copy-result').hidden = !revealed;
    $('copy-status').textContent = copyMessage ? t(copyMessage) : '';
    $('diagnostic').hidden = !diagnosis;
    $('diagnostic-detail').replaceChildren();
    if (diagnosis) {
      const levels = { adequate: 'diagAdequate', marginal: 'diagBorderline', borderline: 'diagBorderline', insufficient: 'diagInsufficient' };
      $('diagnostic-summary').textContent = t(levels[diagnosis.level] || 'diagInsufficient');
      const number = value => Number.isFinite(value) ? value.toFixed(3) : '—';
      $('diagnostic-detail').append(element('p', '', t('diagNumbers', number(diagnosis.white), number(diagnosis.black),
        number(diagnosis.margin), number(diagnosis.threshold), diagnosis.attempts || 0)));
      const flags = { faintToner: 'flagFaintToner', inkSpread: 'flagInkSpread', misaligned: 'flagMisaligned', glare: 'flagGlare' };
      for (const flag of diagnosis.flags || []) if (flags[flag]) $('diagnostic-detail').append(element('p', '', t(flags[flag])));
      for (const [index, region] of (diagnosis.perRegion || []).entries()) {
        $('diagnostic-detail').append(element('p', 'note', t('diagRegion', index + 1, number(region.margin))));
      }
      $('diagnostic-detail').append(element('p', 'note', t('diagTemporary')));
    }
  }
  function renderEducation() {
    const figure = (name, draw, target, legends = []) => {
      const container = element('figure', 'instruction-figure');
      const svg = svgElement('svg', { viewBox: '0 0 256 170', width: 256, height: 170, role: 'img',
        'aria-label': t(name), 'font-family': "Meiryo, 'Yu Gothic', sans-serif" });
      svg.append(svgElement('rect', { x: 0, y: 0, width: 256, height: 170, fill: '#fff' }));
      draw(svg);
      const caption = element('figcaption');
      caption.append(element('strong', '', t(name)), element('p', '', t(name + 'Body')));
      if (legends.length) {
        container.classList.add('alignment-figure');
        const list = element('ol', 'diagram-legend');
        list.append(...legends.map(key => element('li', '', t(key))));
        caption.append(list);
      }
      container.append(svg, caption);
      $(target).append(container);
    };
    const rect = (svg, x, y, w, h, fill, stroke) => svg.append(svgElement('rect', {
      x, y, width: w, height: h, fill: fill || '#fff', stroke: stroke || '#111', 'stroke-width': 2
    }));
    const line = (svg, x1, y1, x2, y2) => svg.append(svgElement('line', { x1, y1, x2, y2, stroke: '#111', 'stroke-width': 3 }));
    const letter = (svg, x, y, text, fill) => svg.append(svgElement('text', {
      x, y, fill: fill || '#111', 'font-size': 30, 'font-weight': 700, 'text-anchor': 'middle'
    }, text));
    const label = (svg, x, y, text) => svg.append(svgElement('text', {
      x, y, fill: '#111', 'font-size': 15, 'font-weight': 700, 'text-anchor': 'middle'
    }, text));
    const finder = (svg, x, y) => { rect(svg, x, y, 30, 30, '#111'); rect(svg, x + 6, y + 6, 18, 18, '#fff');
      rect(svg, x + 11, y + 11, 8, 8, '#111'); };
    $('setup-diagrams').replaceChildren();
    figure('diagramFlip', svg => {
      label(svg, 63, 23, t('diagramFaceUp')); label(svg, 200, 23, t('diagramFaceDown'));
      rect(svg, 32, 42, 64, 102); rect(svg, 169, 42, 64, 102);
      svg.append(svgElement('rect', { x: 32, y: 42, width: 64, height: 5, fill: '#111' }));
      svg.append(svgElement('rect', { x: 169, y: 139, width: 64, height: 5, fill: '#111' }));
      label(svg, 20, 51, '1'); label(svg, 20, 144, '2');
      label(svg, 157, 51, '2'); label(svg, 157, 144, '1');
      letter(svg, 64, 105, 'B');
      const back = svgElement('g', { transform: 'translate(0 186) scale(1 -1)' });
      letter(back, 201, 105, 'B'); svg.append(back);
      line(svg, 108, 92, 133, 92);
      svg.append(svgElement('polygon', { points: '133,86 133,98 145,92', fill: '#111' }));
    }, 'setup-diagrams');
    figure('diagramLight', svg => {
      rect(svg, 102, 12, 52, 30, '#111'); rect(svg, 122, 19, 14, 14, '#fff');
      letter(svg, 24, 80, 'B'); letter(svg, 24, 104, 'A');
      rect(svg, 48, 62, 180, 20); rect(svg, 48, 82, 180, 20);
      svg.append(svgElement('rect', { x: 48, y: 79, width: 180, height: 6, fill: '#111' }));
      rect(svg, 48, 143, 180, 15);
      for (const x of [80, 138, 196]) {
        line(svg, x, 136, x, 122);
        svg.append(svgElement('polygon', { points: `${x - 6},122 ${x + 6},122 ${x},110`, fill: '#111' }));
      }
    }, 'setup-diagrams');
    figure('diagramAlign', svg => {
      rect(svg, 61, 30, 115, 115);
      finder(svg, 66, 35); finder(svg, 141, 35); finder(svg, 66, 110);
      rect(svg, 184, 30, 19, 115);
      for (let row = 0; row < 10; row++) {
        svg.append(svgElement('rect', { x: 187, y: 34 + row * 11, width: row % 3 ? 13 : 6, height: 5, fill: '#111' }));
      }
      for (const [x, y] of [[44, 13], [210, 13], [210, 152], [44, 152]]) rect(svg, x, y, 9, 9, '#111');
      rect(svg, 46, 15, 5, 5, '#fff', '#fff');
      svg.append(svgElement('rect', { x: 38, y: 80, width: 12, height: 5, fill: '#111' }));
      svg.append(svgElement('rect', { x: 38, y: 86, width: 12, height: 5, fill: '#111' }));
      label(svg, 122, 94, '1'); line(svg, 133, 81, 145, 69);
      label(svg, 238, 156, '2'); line(svg, 228, 153, 223, 153);
      label(svg, 16, 91, '3'); line(svg, 25, 85, 31, 85);
    }, 'setup-diagrams', ['diagramAlignFinder', 'diagramAlignCorner', 'diagramAlignRectangle']);
    figure('diagramWrongFour', svg => {
      for (const [x, y] of [[43, 25], [183, 25], [43, 115], [183, 115]]) finder(svg, x, y);
      line(svg, 111, 72, 145, 106); line(svg, 145, 72, 111, 106);
    }, 'setup-diagrams');
    figure('diagramWrongFace', svg => {
      rect(svg, 32, 26, 192, 118);
      letter(svg, 88, 101, 'A'); letter(svg, 167, 101, 'B', '#aaa');
      line(svg, 35, 127, 221, 127); line(svg, 35, 135, 221, 135);
    }, 'setup-diagrams');
    const pattern = (svg, bits, x, y, size) => {
      rect(svg, x, y, size, size);
      bits.forEach((bit, index) => {
        if (bit) svg.append(svgElement('rect', { x: x + index % 2 * size / 2,
          y: y + Math.floor(index / 2) * size / 2, width: size / 2, height: size / 2, fill: '#111' }));
      });
    };
    $('principle-diagrams').replaceChildren();
    for (const black of [false, true]) figure(black ? 'diagramBlack' : 'diagramWhite', svg => {
      pattern(svg, [1, 1, 0, 0], 12, 56, 52);
      pattern(svg, black ? [0, 0, 1, 1] : [1, 1, 0, 0], 102, 56, 52);
      pattern(svg, black ? [1, 1, 1, 1] : [1, 1, 0, 0], 192, 56, 52);
      letter(svg, 82, 93, '+'); letter(svg, 172, 93, '=');
    }, 'principle-diagrams');
    $('six-patterns').replaceChildren();
    for (const pair of OQS.vc.PAIRS) {
      const svg = svgElement('svg', { viewBox: '0 0 60 60', width: 60, height: 60, 'aria-hidden': 'true' });
      pattern(svg, [0, 1, 2, 3].map(index => Number(pair.includes(index))), 2, 2, 56);
      $('six-patterns').append(svg);
    }
    $('comparison-rows').replaceChildren();
    for (const key of ['comparePrinciple', 'compareNeeds', 'compareCapacity', 'compareTamper', 'compareCount', 'comparePlain']) {
      const row = element('tr');
      const heading = element('th', '', t(key));
      heading.scope = 'row';
      row.append(heading, element('td', '', t(key + 'O')), element('td', '', t(key + 'S')));
      $('comparison-rows').append(row);
    }
    for (const [target, keys] of [['limits-list', ['limitMalleable', 'limitFake', 'limitPartial', 'limitRevoke',
      'limitMaterial', 'limitDevice', 'limitTrust', 'limitScreen']], ['storage-list', ['storeFlat', 'storeSeparate', 'storeCopies', 'storeOffline']]]) {
      $(target).replaceChildren(...keys.map(key => element('li', '', t(key))));
    }
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
    renderReader();
    renderEducation();
  }

  tabs.forEach((name, index) => {
    const tab = $('tab-' + name);
    tab.addEventListener('click', () => {
      if (name !== 'read') { stopCamera(false); clearFrozen(); revealed = false; }
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
  function closeHelp() {
    $('help-dialog').close();
    $('help').focus();
  }
  $('help-close').addEventListener('click', closeHelp);
  $('help-dialog').addEventListener('close', () => $('help').focus());
  $('help-dialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeHelp();
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
    clearRead(true);
    render();
  });
  $('reader-camera').addEventListener('toggle', () => {
    if ($('reader-camera').open) return;
    if (cameraPending || cameraStream) stopCamera(true);
    clearFrozen();
    revealed = false;
    renderReader();
  });
  $('camera-button').addEventListener('click', startCamera);
  $('stop-camera').addEventListener('click', () => stopCamera(true));
  $('manual-button').addEventListener('click', freezeFrame);
  $('manual-retry').addEventListener('click', () => {
    corners = []; manualMessage = null; renderReader(); drawManual(); $('manual-canvas').focus();
  });
  $('manual-cancel').addEventListener('click', () => { clearFrozen(); setCameraMessage('readCleared'); });
  $('clear-read').addEventListener('click', () => $('clear-all').click());
  $('reveal').addEventListener('click', () => { revealed = !revealed; renderReader(); });
  $('copy-result').addEventListener('click', async () => {
    if (!revealed || !recovered) return;
    try { await navigator.clipboard.writeText(recovered); copyMessage = 'copied'; }
    catch (_) { copyMessage = 'copyFailed'; }
    renderReader();
  });
  function positionPointer(event) {
    if (!frozen) return;
    const bounds = $('manual-canvas').getBoundingClientRect();
    cursor = { x: Math.max(0, Math.min(frozen.w - 1, (event.clientX - bounds.left) * frozen.w / bounds.width)),
      y: Math.max(0, Math.min(frozen.h - 1, (event.clientY - bounds.top) * frozen.h / bounds.height)) };
    drawManual();
  }
  $('manual-canvas').addEventListener('pointermove', positionPointer);
  $('manual-canvas').addEventListener('pointerdown', event => { positionPointer(event); selectCorner(); });
  $('manual-canvas').addEventListener('keydown', event => {
    if (!frozen) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectCorner(); return; }
    const keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!keys[event.key]) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : Math.max(1, Math.round(frozen.w / 100));
    cursor.x = Math.max(0, Math.min(frozen.w - 1, cursor.x + keys[event.key][0] * step));
    cursor.y = Math.max(0, Math.min(frozen.h - 1, cursor.y + keys[event.key][1] * step));
    drawManual();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopCamera(false); clearFrozen(); revealed = false; renderReader(); }
  });
  window.addEventListener('afterprint', clearPrintSelection);
  window.addEventListener('pagehide', () => {
    clearRead(false);
    invalidate(true);
    $('secret-input').value = '';
    $('print-root').replaceChildren();
    $('share-cards').replaceChildren();
    $('test-cards').replaceChildren();
  });
  fitVersions();
  render();
})();
