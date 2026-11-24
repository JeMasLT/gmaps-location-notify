// ==UserScript==
// @name         Google Maps - shared location "Notify me"
// @namespace    https://github.com/JeMasLT/gmaps-location-notify
// @author       JeMasLT
// @version      1.2.0
// @license      MIT
// @homepageURL  https://github.com/JeMasLT/gmaps-location-notify
// @downloadURL  https://raw.githubusercontent.com/JeMasLT/gmaps-location-notify/main/maps-location-notify.user.js
// @updateURL    https://raw.githubusercontent.com/JeMasLT/gmaps-location-notify/main/maps-location-notify.user.js
// @description  Adds "Notify me" and "Follow" toggles to a shared-location panel: beeps when the person's address changes and can keep the map centred on them.
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
  const PANEL_LOST_MS = 3000; // panel gone this long -> everything switches off
  const FOLLOW_MIN_INTERVAL_MS = 10000; // Follow re-centres the map at most this often

  // Google Maps UI texts (English UI). Change these if Maps is in another language.
  const UI = {
    hideOnMapAria: 'Hide on map',
    addressAria: 'Address',
    menuAria: 'Menu',
    buttonLabel: 'Notify me',
    followLabel: 'Follow',
  };

  /* ==================================================== */

  const LOG = (...a) => console.log('[NotifyMe]', ...a);
  const BTN_ID = 'tm-notify-me-btn';
  const FOLLOW_ID = 'tm-follow-btn';
  const GREEN = { bg: '#c4eed0', fg: '#0d652d' };

  // Notify button modes, in click order: off -> all -> streets -> off
  const MODES = {
    off:     { next: 'all',     bg: '',        fg: '',        status: 'OFF - click for: beep on every address change' },
    all:     { next: 'streets', bg: GREEN.bg,  fg: GREEN.fg,  status: 'ON (every address change) - click for: special streets only' },
    streets: { next: 'off',     bg: '#feefc3', fg: '#7a4f01', status: 'SPECIAL STREETS ONLY - click to turn off' },
  };

  const state = {
    mode: 'off',          // notify mode
    follow: false,        // keep map centred on the person
    person: null,         // name being watched
    personId: null,       // Maps id of the person (from the URL), used by Follow
    lastAddress: null,
    lostSince: null,
    recentering: false,
    lastRecenter: 0,
    recenterPending: false,
    audio: null,
  };

  const isActive = () => state.mode !== 'off' || state.follow;
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // Person id from a location-sharing URL like .../data=!4m4!7m3!1m1!1s<id>!2e2
  function personIdFromUrl() {
    const m = location.href.match(/!1s(\d+)!2e2/);
    return m ? m[1] : null;
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

  /* ---------- follow (re-centre the map) ---------- */

  async function waitFor(selector, tries = 25) {
    for (let i = 0; i < tries; i++) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(200);
    }
    return null;
  }

  // Maps re-centres on a person when you open them from the Location sharing list.
  // So: Menu -> Location sharing (no page reload), then click the person in the list.
  async function recenter() {
    if (state.recentering || !state.personId) return;
    state.recentering = true;
    state.lastRecenter = Date.now();
    state.recenterPending = false;
    try {
      const itemSel = `button[data-list-id="${state.personId}"]`;
      let item = document.querySelector(itemSel);
      if (!item) {
        const menu = document.querySelector(`button[aria-label="${UI.menuAria}"]`);
        if (!menu) throw new Error('Menu button not found');
        menu.click();
        const sharing = await waitFor('button[jsaction*="settings.friends"]'); // "Location sharing" menu item
        if (!sharing) throw new Error('"Location sharing" menu item not found');
        sharing.click();
        item = await waitFor(itemSel);
      }
      if (!item) throw new Error('person not found in the Location sharing list');
      item.click();

      for (let i = 0; i < 25; i++) {
        await sleep(200);
        const ctx = getContext();
        if (ctx && ctx.name === state.person) break;
      }
      LOG('Map re-centred');
    } catch (err) {
      LOG(`Re-centre failed: ${err.message}`);
    } finally {
      state.lostSince = null;
      state.recentering = false;
    }
  }

  function requestRecenter() {
    if (!state.follow) return;
    if (Date.now() - state.lastRecenter >= FOLLOW_MIN_INTERVAL_MS) recenter();
    else state.recenterPending = true; // done by tick() when the interval has passed
  }

  /* ---------- buttons ---------- */

  function svgIcon(d) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  const BELL_PATH = 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z';
  const TARGET_PATH = 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z';

  function buildButton(hideWrap, id, labelText, iconPath, onClick) {
    // Copy Google's own "Hide on map" button so layout and spacing match exactly.
    const wrap = hideWrap.cloneNode(true);
    wrap.id = id;
    wrap.querySelectorAll('*').forEach((el) => {
      ['jsaction', 'jslog', 'data-value', 'aria-label', 'data-tooltip'].forEach((a) => el.removeAttribute(a));
    });
    ['jsaction', 'jslog'].forEach((a) => wrap.removeAttribute(a));

    const btn = wrap.querySelector('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', labelText);

    // Replace the icon glyph with our SVG, sized and centred like the original glyph.
    const icon = btn.querySelector('span[aria-hidden="true"]');
    if (icon) {
      icon.textContent = '';
      icon.style.display = 'inline-flex';
      icon.style.alignItems = 'center';
      icon.style.justifyContent = 'center';
      icon.appendChild(svgIcon(iconPath));
    }

    const label = btn.querySelector('.fontLabelMedium') || btn.lastElementChild;
    label.textContent = labelText;

    // Keep Google's own click handlers away from this button.
    ['mousedown', 'mouseup', 'keydown'].forEach((ev) =>
      btn.addEventListener(ev, (e) => e.stopPropagation()));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
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

  function paint(id, colors, pressed, title, mode) {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    const btn = wrap.querySelector('button');
    const circle = btn.querySelector('span');
    btn.setAttribute('aria-pressed', String(pressed));
    btn.dataset.mode = mode;
    btn.title = title;
    circle.style.backgroundColor = colors.bg;
    circle.style.borderColor = colors.bg;
    circle.style.color = colors.fg;
    const label = btn.querySelector('.fontLabelMedium') || btn.lastElementChild;
    label.style.color = colors.fg;
  }

  function paintButtons() {
    paint(BTN_ID, MODES[state.mode], state.mode !== 'off', tooltipText(), state.mode);
    paint(FOLLOW_ID, state.follow ? GREEN : { bg: '', fg: '' }, state.follow,
      state.follow
        ? `Follow: ON - the map re-centres on ${state.person} when the address changes (at most every ${FOLLOW_MIN_INTERVAL_MS / 1000} s). Click to turn off.`
        : 'Follow: OFF - click to keep the map centred on this person',
      state.follow ? 'on' : 'off');
  }

  /* ---------- on / off ---------- */

  // Called when the first of Notify / Follow is switched on: remember who we watch.
  function startWatching(ctx) {
    if (isActive()) return;
    state.person = ctx.name;
    state.personId = personIdFromUrl();
    state.lastAddress = ctx.address; // starting point, no beep for it
    state.lostSince = null;
  }

  function stopIfIdle() {
    if (isActive()) return;
    state.person = null;
    state.personId = null;
    state.lastAddress = null;
    state.lostSince = null;
    state.recenterPending = false;
  }

  function setMode(mode) {
    const ctx = getContext();
    if (!ctx) return;
    ensureAudio(); // the click unlocks sound in Chrome
    startWatching(ctx);
    state.mode = mode;
    LOG(`Notify mode "${mode}" for "${ctx.name}", current address: ${ctx.address}`);
    stopIfIdle();
    paintButtons();
  }

  function setFollow(on) {
    const ctx = getContext();
    if (!ctx) return;
    if (on) {
      startWatching(ctx);
      if (!state.personId) state.personId = personIdFromUrl();
      if (!state.personId) {
        LOG('Follow: could not find this person\'s id in the URL - open them from the Location sharing list first');
        stopIfIdle();
        return;
      }
    }
    state.follow = on;
    LOG(`Follow ${on ? 'ON' : 'OFF'} for "${ctx.name}"`);
    stopIfIdle();
    paintButtons();
    if (on) { state.lastRecenter = 0; requestRecenter(); }
  }

  function stopAll(reason) {
    if (!isActive()) return;
    state.mode = 'off';
    state.follow = false;
    LOG(`OFF (${reason})`);
    stopIfIdle();
    paintButtons();
  }

  /* ---------- main loop ---------- */

  function tick() {
    const ctx = getContext();

    if (ctx && !document.getElementById(BTN_ID)) {
      const notify = buildButton(ctx.hideWrap, BTN_ID, UI.buttonLabel, BELL_PATH,
        () => setMode(MODES[state.mode].next));
      const follow = buildButton(ctx.hideWrap, FOLLOW_ID, UI.followLabel, TARGET_PATH,
        () => setFollow(!state.follow));
      ctx.hideWrap.after(notify, follow);
      paintButtons();
    }

    if (!isActive() || state.recentering) return;

    if (!ctx) {
      state.lostSince = state.lostSince || Date.now();
      if (Date.now() - state.lostSince > PANEL_LOST_MS) stopAll('panel closed');
      return;
    }
    state.lostSince = null;

    if (ctx.name !== state.person) {
      stopAll(`switched to "${ctx.name}"`);
      return;
    }

    if (ctx.address && ctx.address !== state.lastAddress) {
      LOG(`Address changed: "${state.lastAddress}" -> "${ctx.address}"`);
      state.lastAddress = ctx.address;
      if (state.mode !== 'off') {
        const rule = ruleFor(ctx.address);
        const tone = rule || DEFAULT_TONE;
        const silent = state.mode === 'streets' && !rule;
        LOG(silent ? '  not a special street - silent' : `  beep ${tone.freq} Hz x${tone.repeat || 1}`);
        if (!silent) beep(tone);
      }
      requestRecenter();
    }

    if (state.follow && state.recenterPending &&
        Date.now() - state.lastRecenter >= FOLLOW_MIN_INTERVAL_MS) {
      recenter();
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
