/* Overlay QR Shares - MIT (c) 2026 ipusiron. */
/*
 * Decide the theme before the first paint. Load synchronously in <head> after style.css.
 * style.css is light by default and switches to dark with data-theme="dark" on <html>.
 * A saved choice (key overlay-qr-shares.theme) wins; otherwise follow the OS setting.
 * app.js reads the attribute set here and only keeps the toggle and saving.
 */
(function (global) {
  'use strict';
  let saved = null;
  try { saved = global.localStorage.getItem('overlay-qr-shares.theme'); }
  catch (_) { /* Preferences are optional, including on file URLs. */ }
  const prefersDark = !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = ['light', 'dark'].includes(saved) ? saved : prefersDark ? 'dark' : 'light';
  global.document.documentElement.setAttribute('data-theme', theme);
})(typeof window !== 'undefined' ? window : globalThis);
