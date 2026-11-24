// ==UserScript==
// @name         Google Maps - shared location "Notify me"
// @namespace    https://github.com/JeMasLT/gmaps-location-notify
// @author       JeMasLT
// @version      1.1.0
// @license      MIT
// @homepageURL  https://github.com/JeMasLT/gmaps-location-notify
// @downloadURL  https://raw.githubusercontent.com/JeMasLT/gmaps-location-notify/main/maps-location-notify.user.js
// @updateURL    https://raw.githubusercontent.com/JeMasLT/gmaps-location-notify/main/maps-location-notify.user.js
// @description  Adds a "Notify me" toggle to a shared-location panel and beeps when the person's address changes.
// @match        https://www.google.com/maps*
// @match        https://www.google.lt/maps*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== SETTINGS ===================== */

  // Beep used when the new address matches none of the rules below.
  const DEFAULT_TONE = { freq: 440, durationMs: 250, repeat: 1 };

  // First matching rule wins. Names are matched as "contains", ignoring case and accents
  // ("Liepų" also matches "liepu", "LIEPŲ g. 12, Example City").
  //   freq       - pitch in Hz (higher number = higher tone)
  //   durationMs - length of one beep
  //   repeat     - how many beeps
  const TONE_RULES = [
    { names: ['Example St', 'Liepų', 'Klevų'], freq: 1200, durationMs: 300, repeat: 2 },
    // { names: ['Ąžuolų'], freq: 800, durationMs: 200, repeat: 3 },
  ];

  const VOLUME = 0.3;        // 0.0 - 1.0
  const GAP_MS = 150;        // pause between repeated beeps
  const PANEL_LOST_MS = 3000; // panel gone this long -> notifications switch off

  // Google Maps UI texts (English UI). Change these if Maps is in another language.
  const UI = {
    hideOnMapAria: 'Hide on map',
    addressAria: 'Address',
    buttonLabel: 'Notify me',
  };

  /* ==================================================== */

  const LOG = (...a) => console.log('[NotifyMe]', ...a);
  const BTN_ID = 'tm-notify-me-btn';

  // Button modes, in click order: off -> all -> streets -> off
  const MODES = {
    off:     { next: 'all',     bg: '',        fg: '',        status: 'OFF - click for: beep on every address change' },
    all:     { next: 'streets', bg: '#c4eed0', fg: '#0d652d', status: 'ON (every address change) - click for: special streets only' },
    streets: { next: 'off',     bg: '#feefc3', fg: '#7a4f01', status: 'SPECIAL STREETS ONLY - click to turn off' },
  };

  const state = {
    mode: 'off',
    person: null,
    lastAddress: null,
    lostSince: null,
    audio: null,
  };

  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /* ---------- reading the page ---------- */

  function getContext() {
    const hideBtn = document.querySelector(`button[aria-label="${UI.hideOnMapAria}"]`);
    if (!hideBtn) return null;
    const hideWrap = hideBtn.parentElement;   // one button "cell"
    const row = hideWrap && hideWrap.parentElement; // row with Directions / Nearby / Hide
    if (!row) return null;

    // Walk up to the panel that holds the person's name (h1).
    let panel = row;
    while (panel && !panel.querySelector('h1')) panel = panel.parentElement;
    if (!panel) return null;

    const name = panel.querySelector('h1').innerText.trim();
    const addrIcon = panel.querySelector(`span[role="img"][aria-label="${UI.addressAria}"]`);
    let address = null;
    if (addrIcon) {
      const cell = addrIcon.parentElement;
      const textSpan = cell && [...cell.children].find((c) => c !== addrIcon && c.innerText.trim());
      address = textSpan ? textSpan.innerText.trim() : null;
    }
    return { row, hideWrap, name, address };
  }

  /* ---------- sound ---------- */

  function ensureAudio() {
    if (!state.audio) state.audio = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audio.state === 'suspended') state.audio.resume();
    return state.audio;
  }

  // Matching TONE_RULES entry, or null if the address is on none of those streets.
  function ruleFor(address) {
    const a = norm(address);
    return TONE_RULES.find((r) => r.names.some((n) => a.includes(norm(n)))) || null;
  }

  function toneFor(address) {
    return ruleFor(address) || DEFAULT_TONE;
  }

  function beep(tone) {
    const ctx = ensureAudio();
    const dur = tone.durationMs / 1000;
    const step = (tone.durationMs + GAP_MS) / 1000;
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < (tone.repeat || 1); i++, t += step) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(VOLUME, t + 0.01);
      gain.gain.setValueAtTime(VOLUME, t + dur - 0.02);
      gain.gain.linearRampToValueAtTime(0, t + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.01);
    }
  }

  /* ---------- button ---------- */

  function bellSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z');
    svg.appendChild(path);
    return svg;
  }

  function buildButton(hideWrap) {
    // Copy Google's own "Hide on map" button so layout and spacing match exactly.
    const wrap = hideWrap.cloneNode(true);
    wrap.id = BTN_ID;
    wrap.querySelectorAll('*').forEach((el) => {
      ['jsaction', 'jslog', 'data-value', 'aria-label', 'data-tooltip'].forEach((a) => el.removeAttribute(a));
    });
    ['jsaction', 'jslog'].forEach((a) => wrap.removeAttribute(a));

    const btn = wrap.querySelector('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', UI.buttonLabel);

    // Replace the icon glyph with a bell, sized and centred like the original glyph.
    const icon = btn.querySelector('span[aria-hidden="true"]');
    if (icon) {
      icon.textContent = '';
      icon.style.display = 'inline-flex';
      icon.style.alignItems = 'center';
      icon.style.justifyContent = 'center';
      icon.appendChild(bellSvg());
    }

    const label = btn.querySelector('.fontLabelMedium') || btn.lastElementChild;
    label.textContent = UI.buttonLabel;

    // Keep Google's own click handlers away from this button.
    ['mousedown', 'mouseup', 'keydown'].forEach((ev) =>
      btn.addEventListener(ev, (e) => e.stopPropagation()));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = MODES[state.mode].next;
      next === 'off' ? disable('button clicked') : setMode(next);
    });
    return wrap;
  }

  // Hover text: on/off status + every street from TONE_RULES with its tone.
  function tooltipText() {
    const lines = [`Notifications: ${MODES[state.mode].status}`, ''];
    if (TONE_RULES.length) {
      lines.push('Special streets:');
      TONE_RULES.forEach((r) => {
        const tone = `${r.freq} Hz, ${r.durationMs} ms x${r.repeat || 1}`;
        r.names.forEach((n) => lines.push(`  • ${n}  (${tone})`));
      });
    } else {
      lines.push('No special streets configured.');
    }
    lines.push(`Any other address: ${DEFAULT_TONE.freq} Hz, ${DEFAULT_TONE.durationMs} ms x${DEFAULT_TONE.repeat || 1}` +
      (state.mode === 'streets' ? '  (silent in this mode)' : ''));
    return lines.join('\n');
  }

  function paintButton() {
    const wrap = document.getElementById(BTN_ID);
    if (!wrap) return;
    const btn = wrap.querySelector('button');
    const circle = btn.querySelector('span');
    const m = MODES[state.mode];
    btn.setAttribute('aria-pressed', state.mode === 'off' ? 'false' : 'true');
    btn.dataset.mode = state.mode;
    btn.title = tooltipText();
    circle.style.backgroundColor = m.bg;
    circle.style.borderColor = m.bg;
    circle.style.color = m.fg;
    const label = btn.querySelector('.fontLabelMedium') || btn.lastElementChild;
    label.style.color = m.fg;
  }

  /* ---------- modes ---------- */

  function setMode(mode) {
    const ctx = getContext();
    if (!ctx) return;
    ensureAudio(); // the click unlocks sound in Chrome
    if (state.mode === 'off') {
      state.person = ctx.name;
      state.lastAddress = ctx.address; // starting point, no beep for it
    }
    state.mode = mode;
    state.lostSince = null;
    LOG(`Mode "${mode}" for "${ctx.name}", current address: ${ctx.address}`);
    paintButton();
  }

  function disable(reason) {
    if (state.mode === 'off') return;
    state.mode = 'off';
    LOG(`OFF (${reason})`);
    state.person = null;
    state.lastAddress = null;
    state.lostSince = null;
    paintButton();
  }

  /* ---------- main loop ---------- */

  function tick() {
    const ctx = getContext();

    if (ctx && !document.getElementById(BTN_ID)) {
      ctx.hideWrap.after(buildButton(ctx.hideWrap));
      paintButton();
    }

    if (state.mode === 'off') return;

    if (!ctx) {
      state.lostSince = state.lostSince || Date.now();
      if (Date.now() - state.lostSince > PANEL_LOST_MS) disable('panel closed');
      return;
    }
    state.lostSince = null;

    if (ctx.name !== state.person) {
      disable(`switched to "${ctx.name}"`);
      return;
    }

    if (ctx.address && ctx.address !== state.lastAddress) {
      const rule = ruleFor(ctx.address);
      const tone = rule || DEFAULT_TONE;
      const silent = state.mode === 'streets' && !rule;
      LOG(`Address changed: "${state.lastAddress}" -> "${ctx.address}"` +
        (silent ? ' (not a special street - silent)' : ` (tone ${tone.freq} Hz x${tone.repeat || 1})`));
      state.lastAddress = ctx.address;
      if (!silent) beep(tone);
    }
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; tick(); }, 200);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(tick, 2000);
  tick();

  // Handy for testing from DevTools console: NotifyMeTest('Liepų g. 5, Example City')
  window.NotifyMeTest = (address) => { const t = toneFor(address); beep(t); return t; };

  LOG('loaded');
})();
