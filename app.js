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
  const t = key => OQS.messages[language][key];

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
  render();
})();
