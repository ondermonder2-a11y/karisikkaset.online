/**
 * admin.js — Karışık Kaset Yönetim Paneli
 *
 * Modüller:
 *  Toast       — bildirim sistemi
 *  api()       — kimlik doğrulamalı fetch yardımcısı
 *  Drag        — sürükle-bırak sıralama
 *  StationsUI  — radyo istasyonları sekme
 *  TapesUI     — kasetler sekme (önizleme + editör)
 *  RequestsUI  — şarkı istekleri sekme
 */

'use strict';

/* ═══════════════════════════════════════════════
   TOAST BİLDİRİM SİSTEMİ
   ═══════════════════════════════════════════════ */
const Toast = (() => {
  const container = document.getElementById('toast-container');

  function show(title, msg = '', type = 'info', duration = 4000) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `
      <span class="toast-icon" aria-hidden="true"></span>
      <div class="toast-body">
        ${title ? `<div class="toast-title">${esc(title)}</div>` : ''}
        ${msg    ? `<div class="toast-msg">${esc(msg)}</div>` : ''}
      </div>
    `;
    container.appendChild(el);
    const remove = () => {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 300); // fallback
    };
    el.addEventListener('click', remove);
    setTimeout(remove, duration);
  }

  return {
    success: (t, m) => show(t, m, 'success'),
    error:   (t, m) => show(t, m, 'error', 5500),
    info:    (t, m) => show(t, m, 'info'),
    warning: (t, m) => show(t, m, 'warning'),
  };
})();

/* ═══════════════════════════════════════════════
   YARDIMCILAR
   ═══════════════════════════════════════════════ */
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt(isoStr) {
  const d = new Date(isoStr);
  return isNaN(d) ? '' : d.toLocaleString('tr-TR');
}

/** Kimlik doğrulamalı fetch */
async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `İstek başarısız (HTTP ${res.status}).`);
  return body;
}

function makeBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `button ${cls || ''}`.trim();
  b.innerHTML = text;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function makeInput(labelTxt, value = '', opts = {}) {
  const lbl = document.createElement('label');
  lbl.textContent = labelTxt;
  const inp = document.createElement('input');
  inp.value = value ?? '';
  if (opts.type)      inp.type      = opts.type;
  if (opts.maxLength) inp.maxLength = opts.maxLength;
  if (opts.min)       inp.min       = opts.min;
  if (opts.max)       inp.max       = opts.max;
  if (opts.step)      inp.step      = opts.step;
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  if (opts.type === 'color') inp.value = /^#[0-9a-f]{6}$/i.test(inp.value) ? inp.value : '#1a237e';
  lbl.append(inp);
  return { lbl, inp };
}

/** Sürükle-bırak sıralama (HTML5 DnD) */
const Drag = {
  _dragging: null,
  init(list) {
    list.addEventListener('dragstart', e => {
      const card = e.target.closest('.item-card, .track-card');
      if (!card) return;
      Drag._dragging = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    list.addEventListener('dragend', () => {
      if (Drag._dragging) Drag._dragging.classList.remove('dragging');
      list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      Drag._dragging = null;
    });
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const card = e.target.closest('.item-card, .track-card');
      if (!card || card === Drag._dragging) return;
      list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      card.classList.add('drag-over');
      // Kartın alt yarısına sürüklendiyse sonrasına, üst yarısına sürüklendiyse öncesine yerleştir
      const rect = card.getBoundingClientRect();
      const isAfter = e.clientY > rect.top + rect.height / 2;
      list.insertBefore(Drag._dragging, isAfter ? card.nextSibling : card);
    });
    list.addEventListener('dragleave', e => {
      const card = e.target.closest('.item-card, .track-card');
      card?.classList.remove('drag-over');
    });
    list.addEventListener('drop', e => {
      e.preventDefault();
      list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
  }
};

/* ═══════════════════════════════════════════════
   UYGULAMA DURUMU
   ═══════════════════════════════════════════════ */
let stations       = [];
let tapes          = [];
let draftTape      = null;
let draftTapeId    = null;
let allRequests    = [];
let stationHealth  = new Map();
let healthPollTimer = null;

/* ═══════════════════════════════════════════════
   OTURUM YÖNETİMİ
   ═══════════════════════════════════════════════ */
const loginPanel   = document.getElementById('login-panel');
const workspace    = document.getElementById('workspace');
const loginForm    = document.getElementById('login-form');
const loginMsg     = document.getElementById('login-message');
const setupNote    = document.getElementById('setup-note');
const logoutBtn    = document.getElementById('logout-button');
const topbarUser   = document.getElementById('topbar-user');

function showWorkspace(show) {
  loginPanel.classList.toggle('hidden', show);
  workspace.classList.toggle('hidden', !show);
  logoutBtn.classList.toggle('hidden', !show);
}

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Giriş yapılıyor…';
  const fd = new FormData(loginForm);
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    });
    loginForm.reset();
    loginMsg.textContent = '';
    await loadDashboard();
    showWorkspace(true);
  } catch (err) {
    loginMsg.textContent = err.message;
    loginMsg.className = 'message error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Giriş yap';
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST', body: '{}' });
    stopLiveListeners();
    showWorkspace(false);
    Toast.info('Güvenli çıkış yapıldı.');
  } catch (err) {
    Toast.error('Çıkış yapılamadı.', err.message);
  }
});

/* ═══════════════════════════════════════════════
   TABS
   ═══════════════════════════════════════════════ */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== `${btn.dataset.tab}-panel`);
    });
  });
});

/* ═══════════════════════════════════════════════
   DASHBOARD — istatistik kartları
   ═══════════════════════════════════════════════ */
function updateStats() {
  document.getElementById('stat-stations').textContent  = stations.length;
  document.getElementById('stat-tapes').textContent     = tapes.length;
  document.getElementById('stat-tracks').textContent    = tapes.reduce((s, t) => s + (t.tracks?.length || 0), 0);

  const healthy   = [...stationHealth.values()].filter(r => r.healthy === true).length;
  const unhealthy = [...stationHealth.values()].filter(r => r.healthy === false).length;
  const indeterminate = [...stationHealth.values()].filter(r =>
    (r.checkedAt || r.testedAt) && r.healthy === null
  ).length;
  const statH = document.getElementById('stat-health');
  if (![...stationHealth.values()].some(r => r.checkedAt || r.testedAt)) {
    statH.textContent = 'Henüz test edilmedi';
  } else {
    statH.textContent = `${healthy} ✓ / ${unhealthy} ✗${indeterminate ? ` / ${indeterminate} ?` : ''}`;
    statH.style.color = unhealthy > 0 ? 'var(--red)' : indeterminate ? 'var(--amber)' : 'var(--green)';
  }
}

/* ═══════════════════════════════════════════════
   CANLI DİNLEYİCİ DURUMU
   Player'lar 20 sn'de bir /api/heartbeat gönderir,
   pano 5 sn'de bir /api/admin/listeners üzerinden ayrıntıları alır.
   ═══════════════════════════════════════════════ */
const LIVE_POLL_MS = 5_000;
const liveCard  = document.getElementById('live-card');
const liveCount = document.getElementById('live-count');
const liveSub   = document.getElementById('live-sub');
const liveList  = document.getElementById('live-list');
const livePulse = document.getElementById('live-pulse');

let liveTimer = null;

function liveModeLabel(mode) {
  if (mode === 'radio') return 'Radyo';
  if (mode === 'tape')  return 'Kaset';
  return 'Yayın';
}

function liveDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk`;
  return `${Math.floor(m / 60)} sa ${m % 60} dk`;
}

function renderLiveListeners(data) {
  const list  = Array.isArray(data?.listeners) ? data.listeners : [];
  const count = Number.isFinite(data?.count) ? data.count : list.length;
  const radio = Number.isFinite(data?.radio) ? data.radio : list.filter(item => item.mode === 'radio').length;
  const tape  = Number.isFinite(data?.tape)  ? data.tape  : list.filter(item => item.mode === 'tape').length;

  liveCount.textContent = count;
  liveCard.classList.toggle('is-live', count > 0);
  liveCard.classList.remove('is-stale');
  livePulse.classList.toggle('is-live', count > 0);

  const clock = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  liveSub.textContent = count === 0
    ? 'Şu anda kimse dinlemiyor.'
    : `${radio} radyo · ${tape} kaset · ${clock} itibarıyla`;

  liveList.textContent = '';
  const sorted = [...list].sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
  const shown  = sorted.slice(0, 8);

  shown.forEach(item => {
    const li = document.createElement('li');
    li.className = 'live-item';
    const badgeClass = item.mode === 'radio' ? 'radio' : 'tape';
    li.innerHTML = `
      <span class="live-badge ${badgeClass}">${esc(liveModeLabel(item.mode))}</span>
      <span class="live-label" title="${esc(item.label || '')}">${esc(item.label || 'Bilinmeyen yayın')}</span>
      <span class="live-time">${esc(liveDuration(item.seconds))}</span>
    `;
    liveList.appendChild(li);
  });

  if (sorted.length > shown.length) {
    const li = document.createElement('li');
    li.className = 'live-item live-more';
    li.textContent = `+${sorted.length - shown.length} kişi daha dinliyor`;
    liveList.appendChild(li);
  }
}

async function refreshLiveListeners() {
  try {
    const res = await fetch('/api/admin/listeners', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderLiveListeners(await res.json());
  } catch (err) {
    liveCard.classList.add('is-stale');
    liveSub.textContent = 'Canlı bilgi alınamadı, yeniden deneniyor…';
  }
}

function startLiveListeners() {
  refreshLiveListeners();
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(refreshLiveListeners, LIVE_POLL_MS);
}

function stopLiveListeners() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

// Sekme arka plandan dönünce sayaç gecikmesin
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && liveTimer) refreshLiveListeners();
});

/* ═══════════════════════════════════════════════
   İSTASYONLAR SEKMESİ
   ═══════════════════════════════════════════════ */
const stationsList = document.getElementById('stations-list');

function healthText(result) {
  if (!result) return 'Henüz test edilmedi.';
  const checkedAt = result.checkedAt || result.testedAt;
  if (typeof result.healthy !== 'boolean') {
    if (!checkedAt) return 'Henüz test edilmedi.';
    const time = fmt(checkedAt);
    return `Durum belirsiz — ${result.message || 'Bağlantı test edilemedi.'}${time ? ` · ${time}` : ''}`;
  }
  const time = checkedAt ? fmt(checkedAt) : '';
  return `${result.healthy ? 'Çevrimiçi' : 'Çevrimdışı'} — ${result.message || ''}${time ? ` · ${time}` : ''}`;
}

function healthClass(result) {
  if (!result) return '';
  if (result.healthy === null && (result.checkedAt || result.testedAt)) return 'uncertain';
  if (typeof result.healthy !== 'boolean') return '';
  return result.healthy ? 'good' : 'bad';
}

/** stations dizisini DOM'dan yeniden oku (sıralama için) */
function readStationsFromDOM() {
  const cards = stationsList.querySelectorAll('.item-card');
  return Array.from(cards).map(card => stations[Number(card.dataset.index)]).filter(Boolean);
}

function renderStations() {
  stationsList.replaceChildren();
  stations.forEach((st, idx) => {
    const card  = document.createElement('article');
    card.className = 'item-card';
    card.dataset.index = idx;
    card.draggable = true;

    const result = stationHealth.get(st.streamUrl);
    const health = document.createElement('p');
    health.className = `health ${healthClass(result)}`;
    health.textContent = healthText(result);

    // Now-playing
    const npBadge = document.createElement('div');
    npBadge.className = 'now-playing-badge hidden';
    npBadge.innerHTML = `<span class="now-playing-dot"></span><span class="np-title"></span>`;

    const top = document.createElement('div');
    top.className = 'item-card-top';

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="5" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="19" r="1" fill="currentColor"/><circle cx="15" cy="5" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="19" r="1" fill="currentColor"/></svg>`;

    const { lbl: freqLbl, inp: freqInp } = makeInput('MHz', st.frequency, { type:'number', min:'88', max:'108', step:'0.1' });
    const { lbl: nameLbl, inp: nameInp } = makeInput('İstasyon adı', st.name, { maxLength:120 });
    const { lbl: genreLbl, inp: genreInp } = makeInput('Tür', st.genre, { maxLength:80 });
    const { lbl: urlLbl,  inp: urlInp  } = makeInput('Yayın bağlantısı', st.streamUrl, { type:'url', maxLength:2048 });
    urlLbl.style.gridColumn = 'span 1';

    const updateStation = () => {
      st.frequency = Number(freqInp.value);
      st.name      = nameInp.value;
      st.genre     = genreInp.value;
      st.streamUrl = urlInp.value;
    };
    [freqInp, nameInp, genreInp, urlInp].forEach(inp => inp.addEventListener('input', updateStation));

    // Test butonu
    const testBtn = makeBtn(`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Test`, 'button-secondary btn-sm', async () => {
      health.textContent = 'Test ediliyor…';
      health.className = 'health checking';
      testBtn.disabled = true;
      try {
        const r = await api('/api/admin/check-link', { method:'POST', body: JSON.stringify({ url: st.streamUrl }) });
        health.textContent = healthText(r);
        health.className = `health ${healthClass(r)}`;
        stationHealth.set(st.streamUrl, r);
        updateStats();
      } catch (err) {
        health.textContent = err.message;
        health.className = 'health bad';
      } finally { testBtn.disabled = false; }
    });

    // Now playing butonu
    const npBtn = makeBtn(`♫ Çalınan`, 'button-secondary btn-sm', async () => {
      npBtn.disabled = true;
      try {
        const r = await api(`/api/now-playing?url=${encodeURIComponent(st.streamUrl)}`);
        if (r.metadata?.title) {
          npBadge.classList.remove('hidden');
          npBadge.querySelector('.np-title').textContent = r.metadata.title;
        } else {
          npBadge.classList.add('hidden');
          Toast.info('Yayın bilgisi yok', 'Bu kanal ICY metadata desteklemiyor.');
        }
      } catch (err) {
        Toast.warning('Yayın bilgisi alınamadı.', err.message);
      } finally { npBtn.disabled = false; }
    });

    const delBtn = makeBtn('Sil', 'button-danger btn-sm', () => {
      if (!confirm(`"${st.name}" silinsin mi?`)) return;
      stations = stations.filter((_, i) => i !== idx);
      renderStations();
      Toast.warning('Silindi', `"${st.name}" listeden kaldırıldı. Kalıcı olması için kaydedin.`);
    });

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    actions.append(testBtn, npBtn, delBtn);

    top.append(handle, freqLbl, nameLbl, genreLbl, urlLbl, actions);
    card.append(top, health, npBadge);
    stationsList.append(card);
  });

  Drag.init(stationsList);
}

function updateHealthCards() {
  stationsList.querySelectorAll('.item-card[data-index]').forEach(card => {
    const st = stations[Number(card.dataset.index)];
    if (!st) return;
    const r = stationHealth.get(st.streamUrl);
    const h = card.querySelector('.health');
    if (!h) return;
    h.textContent = healthText(r);
    h.className = `health ${healthClass(r)}`;
  });
  updateStats();
}

async function refreshStationHealth() {
  try {
    const result = await api('/api/admin/station-health');
    stationHealth = new Map(result.stations.map(s => [s.streamUrl, s]));
    updateHealthCards();

    const prog  = document.getElementById('station-check-progress');
    const chkBtn = document.getElementById('check-all-stations');

    if (result.running) {
      const pct = result.total > 0 ? Math.round((result.completed / result.total) * 100) : 0;
      prog.innerHTML = `
        <span>Toplu kontrol: ${result.completed}/${result.total} istasyon</span>
        <div class="health-progress-bar"><div class="health-progress-fill" style="width:${pct}%"></div></div>
      `;
      chkBtn.disabled = true;
      clearTimeout(healthPollTimer);
      healthPollTimer = setTimeout(refreshStationHealth, 2000);
    } else {
      const checkedStations = result.stations.filter(s => s.checkedAt);
      const indeterminate = checkedStations.filter(s => s.healthy === null).length;
      prog.innerHTML = `<span>${checkedStations.length}/${result.total} istasyon kontrol edildi.${indeterminate ? ` ${indeterminate} sonuç belirsiz.` : ''} Otomatik kontrol 15 dk'da bir yapılır.</span>`;
      chkBtn.disabled = false;
      clearTimeout(healthPollTimer);
      healthPollTimer = null;
    }
  } catch (err) {
    Toast.error('İstasyon sağlığı alınamadı.', err.message);
  }
}

// ── Radyo Arama ─────────────────────────────────────────────────────────────
const radioSearchModal = document.getElementById('radio-search-modal');
const rsName      = document.getElementById('rs-name');
const rsCountry   = document.getElementById('rs-country');
const rsTag       = document.getElementById('rs-tag');
const rsStatus    = document.getElementById('rs-status');
const rsResults   = document.getElementById('rs-results');
const rsAddBtn    = document.getElementById('rs-add-selected');
const rsCountSpan = document.getElementById('rs-selected-count');

let rsFoundStations = [];
let rsSelected = new Set();

document.getElementById('search-radio-btn').addEventListener('click', () => {
  rsName.value = rsCountry.value = rsTag.value = '';
  rsStatus.textContent = '';
  rsResults.innerHTML = '';
  rsFoundStations = [];
  rsSelected.clear();
  rsAddBtn.disabled = true;
  rsCountSpan.textContent = '0';
  radioSearchModal.showModal();
  setTimeout(() => rsName.focus(), 100);
});

document.getElementById('rs-close').addEventListener('click', () => radioSearchModal.close());
radioSearchModal.addEventListener('click', e => { if (e.target === radioSearchModal) radioSearchModal.close(); });

[rsName, rsCountry, rsTag].forEach(inp => {
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('rs-search-btn').click(); });
});

document.getElementById('rs-search-btn').addEventListener('click', async () => {
  const q       = rsName.value.trim();
  const country = rsCountry.value.trim();
  const tag     = rsTag.value.trim();
  if (!q && !country && !tag) {
    rsStatus.textContent = '⚠ Arama için en az bir kriter girin.';
    return;
  }
  const btn = document.getElementById('rs-search-btn');
  btn.disabled = true;
  rsStatus.textContent = '⏳ Aranıyor…';
  rsResults.innerHTML = '';
  rsSelected.clear();
  rsAddBtn.disabled = true;
  rsCountSpan.textContent = '0';

  try {
    const params = new URLSearchParams();
    if (q)       params.set('q', q);
    if (country) params.set('country', country);
    if (tag)     params.set('tag', tag);
    params.set('limit', '40');
    const result = await api(`/api/admin/search-radio?${params}`);
    rsFoundStations = result.stations || [];

    if (!rsFoundStations.length) {
      rsStatus.textContent = 'Sonuç bulunamadı. Farklı arama kriteri deneyin.';
      return;
    }
    rsStatus.textContent = `${rsFoundStations.length} istasyon bulundu. Frekans girin ve eklemek istediklerinizi seçin.`;
    renderRsResults();
  } catch (err) {
    rsStatus.textContent = `✕ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function renderRsResults() {
  rsResults.innerHTML = '';
  rsFoundStations.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = `rs-result-item${rsSelected.has(i) ? ' selected' : ''}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'rs-checkbox';
    cb.checked = rsSelected.has(i);
    cb.addEventListener('change', () => {
      if (cb.checked) rsSelected.add(i); else rsSelected.delete(i);
      item.classList.toggle('selected', cb.checked);
      rsCountSpan.textContent = rsSelected.size;
      rsAddBtn.disabled = rsSelected.size === 0;
    });

    const favicon = document.createElement('img');
    favicon.className = 'rs-favicon';
    favicon.alt = '';
    // radio-browser bazı istasyonlarda "300?cb=..." gibi köksüz favicon
    // yolları döndürebilir. Bunlar panel origin'inde 404 üretir; yalnızca
    // gerçekten harici HTTP(S) URL'lerini yükle.
    const faviconUrl = typeof s._meta.favicon === 'string' ? s._meta.favicon.trim() : '';
    const hasFavicon = /^https?:\/\/[^\s]+$/i.test(faviconUrl);
    if (hasFavicon) {
      favicon.src = faviconUrl;
      favicon.onerror = () => { favicon.remove(); };
    }

    const info = document.createElement('div');
    info.className = 'rs-info';
    info.innerHTML = `
      <span class="rs-name">${esc(s.name)}</span>
      <span class="rs-meta">${esc(s.genre)}${s._meta.country ? ` · ${esc(s._meta.country)}` : ''}${s._meta.codec ? ` · ${s._meta.codec}` : ''}${s._meta.bitrate ? ` ${s._meta.bitrate}k` : ''} · 👍 ${s._meta.votes}</span>
    `;

    const badge = document.createElement('span');
    badge.className = `rs-badge ${s._meta.isHttps ? 'https' : 'http'}`;
    badge.textContent = s._meta.isHttps ? 'HTTPS' : 'HTTP';

    const freqInp = document.createElement('input');
    freqInp.type = 'number';
    freqInp.className = 'rs-freq-input';
    freqInp.min = '88'; freqInp.max = '108'; freqInp.step = '0.1';
    freqInp.placeholder = 'MHz';
    freqInp.title = 'Frekans (88–108 MHz)';
    freqInp.addEventListener('click', e => e.stopPropagation());
    freqInp.addEventListener('input', () => { s._freq = parseFloat(freqInp.value) || null; });

    item.addEventListener('click', e => {
      if (e.target === freqInp) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });

    item.append(cb, ...(hasFavicon ? [favicon] : []), info, badge, freqInp);
    rsResults.appendChild(item);
  });
}

document.getElementById('rs-add-selected').addEventListener('click', () => {
  const toAdd = [...rsSelected].map(i => rsFoundStations[i]);
  const existingUrls = new Set(stations.map(s => s.streamUrl));
  // Frekanslar 0.1 MHz adımlı sanal tuner aralığında tutulur.
  // Kullanıcı girmese bile sistem ilk boş frekansı sırayla atar.
  const usedFrequencies = new Set(
    stations
      .map(s => Math.round(Number(s.frequency) * 10))
      .filter(f => Number.isInteger(f) && f >= 880 && f <= 1080)
  );
  let nextFrequency = 880;
  const takeAvailableFrequency = preferred => {
    const preferredKey = Math.round(Number(preferred) * 10);
    if (Number.isInteger(preferredKey) && preferredKey >= 880 && preferredKey <= 1080 && !usedFrequencies.has(preferredKey)) {
      usedFrequencies.add(preferredKey);
      return preferredKey / 10;
    }
    while (nextFrequency <= 1080 && usedFrequencies.has(nextFrequency)) nextFrequency++;
    if (nextFrequency > 1080) return null;
    const assigned = nextFrequency / 10;
    usedFrequencies.add(nextFrequency++);
    return assigned;
  };

  let added = 0;
  let skipped = 0;
  for (const s of toAdd) {
    if (!existingUrls.has(s.streamUrl)) {
      const frequency = takeAvailableFrequency(s._freq);
      if (frequency == null) {
        skipped++;
        continue;
      }
      stations.push({ frequency, name: s.name, genre: s.genre, streamUrl: s.streamUrl });
      existingUrls.add(s.streamUrl);
      added++;
    }
  }

  renderStations();
  radioSearchModal.close();

  if (added === 0) {
    Toast.info('Zaten mevcut', 'Seçilen istasyonlar zaten listede var.');
  } else {
    const skippedText = skipped ? ` Frekans aralığı dolu olduğu için ${skipped} istasyon eklenemedi.` : '';
    Toast.success(`${added} istasyon eklendi`, `Frekanslar otomatik atandı. Kalıcı olması için "Kaydet" butonuna basın.${skippedText}`);
  }
});

// İstasyon kaydet
document.getElementById('save-stations').addEventListener('click', async btn => {
  const button = btn.currentTarget;
  button.disabled = true;
  // DOM'dan sırayı oku (sürükleme sonrası sıra değişmiş olabilir)
  const ordered = readStationsFromDOM();
  try {
    const result = await api('/api/admin/stations', {
      method: 'PUT',
      body: JSON.stringify({ stations: ordered }),
    });
    stations = result.stations;
    renderStations();
    await refreshStationHealth();
    Toast.success('Kaydedildi', `${stations.length} istasyon kaydedildi.`);
  } catch (err) {
    Toast.error('Kayıt başarısız.', err.message);
  } finally { button.disabled = false; }
});

// Toplu kontrol
document.getElementById('check-all-stations').addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  document.getElementById('station-check-progress').innerHTML = '<span>Toplu kontrol başlatılıyor…</span>';
  try {
    await api('/api/admin/check-stations', { method: 'POST', body: '{}' });
    await refreshStationHealth();
  } catch (err) {
    Toast.error('Toplu kontrol başlatılamadı.', err.message);
    if (!healthPollTimer) btn.disabled = false;
  }
});

// Yeni istasyon form
document.getElementById('add-station-form').addEventListener('submit', e => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const st = {
    frequency: Number(fd.get('frequency')),
    name:      String(fd.get('name')).trim(),
    genre:     String(fd.get('genre')).trim(),
    streamUrl: String(fd.get('streamUrl')).trim(),
  };
  stations.push(st);
  e.currentTarget.reset();
  renderStations();
  document.getElementById('add-station-wrap').removeAttribute('open');
  Toast.info('Eklendi', `"${st.name}" listeye eklendi. Kaydetmeyi unutmayın.`);
});

/* ═══════════════════════════════════════════════
   KASETLER SEKMESİ
   ═══════════════════════════════════════════════ */
const tapeShelf     = document.getElementById('tape-shelf-preview');
const tapeForm      = document.getElementById('tape-form');
const tracksList    = document.getElementById('tracks-list');
const tapeEditorTitle = document.getElementById('tape-editor-title');
const saveTapeOrderBtn = document.getElementById('save-tape-order');
const backupTapesBtn = document.getElementById('backup-tapes');
const tapeBackupSelect = document.getElementById('tape-backup-select');
const restoreTapeBackupBtn = document.getElementById('restore-tape-backup');
const tapeBackupStatus = document.getElementById('tape-backup-status');
let tapeOrderDirty = false;

async function loadTapeBackups() {
  if (!tapeBackupSelect) return;
  try {
    const data = await api('/api/admin/tapes/backups');
    tapeBackupSelect.replaceChildren(new Option('Yedek seç…', ''));
    (data.backups || []).forEach(backup => {
      const option = new Option(
        `${fmt(backup.createdAt)} · ${backup.tapeCount} kaset · ${backup.reason}`,
        backup.id
      );
      tapeBackupSelect.append(option);
    });
  } catch (error) {
    if (tapeBackupStatus) tapeBackupStatus.textContent = `Yedekler okunamadı: ${error.message}`;
  }
}

function downloadBackup(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `karisik-kaset-yedek-${data.id || Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

backupTapesBtn?.addEventListener('click', async () => {
  backupTapesBtn.disabled = true;
  try {
    const result = await api('/api/admin/tapes/backups', { method: 'POST' });
    downloadBackup(result.data);
    Toast.success('Yedek alındı', `${result.backup.tapeCount} kaset yedeklendi ve indirildi.`);
    await loadTapeBackups();
  } catch (error) {
    Toast.error('Yedek alınamadı', error.message);
  } finally {
    backupTapesBtn.disabled = false;
  }
});

tapeBackupSelect?.addEventListener('change', () => {
  if (restoreTapeBackupBtn) restoreTapeBackupBtn.disabled = !tapeBackupSelect.value;
});

restoreTapeBackupBtn?.addEventListener('click', async () => {
  const id = tapeBackupSelect.value;
  if (!id || !confirm('Seçilen yedek mevcut kaset listesinin yerine geri yüklensin mi?')) return;
  restoreTapeBackupBtn.disabled = true;
  try {
    const result = await api(`/api/admin/tapes/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    const data = await api('/api/admin/data');
    tapes = data.tapes || [];
    renderShelfPreview();
    if (tapes.length) setTapeDraft(tapes[0], tapes[0].id);
    updateStats();
    Toast.success('Yedek geri yüklendi', `${result.tapeCount} kaset geri yüklendi.`);
    await loadTapeBackups();
  } catch (error) {
    Toast.error('Geri yükleme başarısız', error.message);
  } finally {
    restoreTapeBackupBtn.disabled = !tapeBackupSelect.value;
  }
});

/** Raf önizlemesini render et */
function renderShelfPreview() {
  tapeShelf.replaceChildren();
  saveTapeOrderBtn.disabled = !tapeOrderDirty;
  if (!tapes.length) {
    const em = document.createElement('div');
    em.className = 'shelf-tape-empty';
    em.textContent = 'Henüz kaset yok';
    tapeShelf.append(em);
    return;
  }
  tapes.forEach((tape, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `shelf-tape-item${tape.id === draftTapeId ? ' active' : ''}`;
    btn.setAttribute('aria-label', tape.label);
    btn.setAttribute('aria-describedby', 'tape-order-help');
    btn.dataset.tapeId = tape.id;
    btn.draggable = true;
    btn.innerHTML = `
      <div class="stape-body" style="--tape-color:${esc(tape.color || '#1a237e')}">
        <div class="stape-window">
          <div class="stape-reel"></div>
          <div class="stape-reel"></div>
        </div>
        <div class="stape-label">
          <span class="stape-label-title">${esc(tape.label)}</span>
          <span class="stape-label-cat">${esc(tape.category || '')} · ${tape.tracks?.length || 0}</span>
        </div>
      </div>
    `;
    btn.addEventListener('click', () => setTapeDraft(tape, tape.id));
    btn.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tape.id);
      btn.classList.add('dragging');
    });
    btn.addEventListener('dragover', event => {
      event.preventDefault();
      const dragged = tapeShelf.querySelector('.shelf-tape-item.dragging');
      if (!dragged || dragged === btn) return;
      const horizontal = getComputedStyle(tapeShelf).flexDirection === 'row';
      const rect = btn.getBoundingClientRect();
      const pointer = horizontal ? event.clientX : event.clientY;
      const midpoint = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      tapeShelf.insertBefore(dragged, pointer > midpoint ? btn.nextSibling : btn);
    });
    btn.addEventListener('drop', event => event.preventDefault());
    btn.addEventListener('dragend', () => {
      btn.classList.remove('dragging');
      const reordered = Array.from(tapeShelf.querySelectorAll('.shelf-tape-item'))
        .map(item => item.dataset.tapeId);
      if (reordered.every((id, index) => id === tapes[index]?.id)) return;
      tapes = reordered.map(id => tapes.find(tapeEntry => tapeEntry.id === id));
      tapeOrderDirty = true;
      renderShelfPreview();
    });
    btn.addEventListener('keydown', event => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const index = tapes.findIndex(item => item.id === tape.id);
      const target = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (target < 0 || target >= tapes.length) return;
      [tapes[index], tapes[target]] = [tapes[target], tapes[index]];
      tapeOrderDirty = true;
      renderShelfPreview();
      tapeShelf.querySelectorAll('.shelf-tape-item')[target].focus();
    });
    tapeShelf.append(btn);
  });
}

saveTapeOrderBtn.addEventListener('click', async () => {
  saveTapeOrderBtn.disabled = true;
  saveTapeOrderBtn.textContent = 'Kaydediliyor…';
  try {
    const result = await api('/api/admin/tape-order', {
      method: 'PUT',
      body: JSON.stringify({ order: tapes.map(tape => tape.id) }),
    });
    tapes = result.tapes;
    tapeOrderDirty = false;
    renderShelfPreview();
    Toast.success('Sıralama kaydedildi', 'Yeni kaset sırası ana sayfaya uygulandı.');
  } catch (err) {
    Toast.error('Sıralama kaydedilemedi.', err.message);
  } finally {
    saveTapeOrderBtn.textContent = 'Sıralamayı Kaydet';
    saveTapeOrderBtn.disabled = !tapeOrderDirty;
  }
});

/** Parça listesini render et */
function renderTracks() {
  tracksList.replaceChildren();
  const countLbl = document.getElementById('track-count-label');
  countLbl.textContent = `${draftTape.tracks.length} parça`;

  draftTape.tracks.forEach((track, idx) => {
    const card = document.createElement('article');
    card.className = 'track-card';
    card.dataset.trackIdx = idx;  // orijinal indeks — kaydetmede sıra için
    card.draggable = true;

    const top = document.createElement('div');
    top.className = 'track-card-top';

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/></svg>`;

    const numBadge = document.createElement('span');
    numBadge.className = 'track-num-badge';
    numBadge.textContent = String(idx + 1).padStart(2, '0');

    const { lbl: titleLbl, inp: titleInp } = makeInput('Parça adı', track.title, { maxLength:160 });
    const { lbl: subLbl,   inp: subInp   } = makeInput('Sanatçı',   track.subtitle, { maxLength:120 });
    const { lbl: urlLbl,   inp: urlInp   } = makeInput('SoundCloud URL', track.soundcloudUrl, { type:'url', maxLength:2048 });
    urlLbl.style.gridColumn = 'span 1';

    titleInp.addEventListener('input', () => { track.title    = titleInp.value; });
    subInp  .addEventListener('input', () => { track.subtitle = subInp.value;   });
    urlInp  .addEventListener('input', () => { track.soundcloudUrl = urlInp.value; });

    const health = document.createElement('p');
    health.className = 'health';
    health.textContent = 'Henüz test edilmedi.';

    const testBtn = makeBtn('Test', 'button-secondary btn-sm', async () => {
      health.textContent = 'Test ediliyor…';
      health.className = 'health checking';
      testBtn.disabled = true;
      try {
        const r = await api('/api/admin/check-link', { method:'POST', body: JSON.stringify({ url: track.soundcloudUrl }) });
        health.textContent = `${r.healthy ? 'Erişilebilir' : 'Erişilemiyor'} — ${r.message}`;
        health.className = `health ${r.healthy ? 'good' : 'bad'}`;
      } catch (err) {
        health.textContent = err.message;
        health.className = 'health bad';
      } finally { testBtn.disabled = false; }
    });

    const delBtn = makeBtn('Sil', 'button-danger btn-sm', () => {
      draftTape.tracks.splice(idx, 1);
      renderTracks();
    });

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    actions.append(testBtn, delBtn);

    top.append(handle, numBadge, titleLbl, subLbl, urlLbl, actions);
    card.append(top, health);
    tracksList.append(card);
  });

  // Sürükle-bırak init
  Drag.init(tracksList);

  // Sürükleme bitince draftTape.tracks sırasını güncelle
  tracksList.addEventListener('dragend', () => {
    const cards = tracksList.querySelectorAll('.track-card');
    const reordered = Array.from(cards).map(card => {
      const numBadge = card.querySelector('.track-num-badge');
      const origIdx  = Number(numBadge?.dataset.origIdx ?? numBadge?.textContent) - 1;
      return draftTape.tracks[origIdx];
    }).filter(Boolean);
    // origIdx data yoksa indeks bazlı yeniden sırala
    if (reordered.length === draftTape.tracks.length) {
      draftTape.tracks = reordered;
    }
  }, { once: false });
}

function setTapeDraft(tape, id = null) {
  draftTape   = JSON.parse(JSON.stringify(tape));
  draftTapeId = id;

  tapeEditorTitle.textContent = id ? `Düzenle: ${tape.label}` : 'Yeni Kaset';
  tapeForm.elements.label.value    = draftTape.label    || '';
  tapeForm.elements.category.value = draftTape.category || '';
  tapeForm.elements.color.value    = /^#[0-9a-f]{6}$/i.test(draftTape.color || '') ? draftTape.color : '#1a237e';
  document.getElementById('color-hex').textContent = tapeForm.elements.color.value;

  document.getElementById('delete-tape').classList.toggle('hidden', !id);
  renderShelfPreview();
  renderTracks();
}

// Renk hex güncelle
tapeForm.elements.color.addEventListener('input', e => {
  if (draftTape) draftTape.color = e.currentTarget.value;
  document.getElementById('color-hex').textContent = e.currentTarget.value;
});
tapeForm.elements.label.addEventListener('input',    e => { if (draftTape) draftTape.label    = e.currentTarget.value; });
tapeForm.elements.category.addEventListener('input', e => { if (draftTape) draftTape.category = e.currentTarget.value; });

// Yeni kaset
document.getElementById('new-tape').addEventListener('click', () => {
  setTapeDraft({ label:'', category:'', color:'#1a237e', tracks:[] });
});

// ── SoundCloud Playlist İçe Aktarma ──────────────────────────────────────────
const scImportModal    = document.getElementById('sc-import-modal');
const scImportUrl      = document.getElementById('sc-import-url');
const scImportLabel    = document.getElementById('sc-import-label');
const scImportCategory = document.getElementById('sc-import-category');
const scImportColor    = document.getElementById('sc-import-color');
const scImportColorHex = document.getElementById('sc-import-color-hex');
const scImportStatus   = document.getElementById('sc-import-status');
const scraperBar       = document.getElementById('scraper-status-bar');
const scraperText      = document.getElementById('scraper-status-text');
const scraperIcon      = document.getElementById('scraper-status-icon');
const scraperCmd       = document.getElementById('scraper-status-cmd');

/** Scraper servisini ping'le (Node.js /api/admin/scraper-status üzerinden) */
async function checkScraperStatus() {
  scraperBar.className = 'scraper-status-bar';
  scraperIcon.textContent = '⏳';
  scraperText.textContent = 'Scraper servisi kontrol ediliyor…';
  scraperCmd.classList.add('hidden');
  try {
    const r = await api('/api/admin/scraper-status');
    if (r.ok) {
      scraperBar.classList.add('ok');
      scraperIcon.textContent = '✓';
      scraperText.textContent = 'Scraper servisi çalışıyor (port 5001).';
    } else {
      throw new Error('down');
    }
  } catch {
    scraperBar.classList.add('error');
    scraperIcon.textContent = '✕';
    scraperText.textContent = 'Scraper servisi çalışmıyor. Docker ile başlatmak için:';
    scraperCmd.textContent  = 'docker compose up scraper';
    scraperCmd.classList.remove('hidden');
  }
}

document.getElementById('import-playlist-btn').addEventListener('click', () => {
  scImportUrl.value      = '';
  scImportLabel.value    = '';
  scImportCategory.value = '';
  scImportColor.value    = '#1a237e';
  scImportColorHex.textContent = '#1a237e';
  scImportStatus.textContent = '';
  scImportStatus.className = 'sc-import-status';
  scImportModal.showModal();
  checkScraperStatus();
  setTimeout(() => scImportUrl.focus(), 100);
});

document.getElementById('sc-import-cancel').addEventListener('click', () => scImportModal.close());

scImportColor.addEventListener('input', () => {
  scImportColorHex.textContent = scImportColor.value;
});

// URL girilince label otomatik doldur
scImportUrl.addEventListener('blur', () => {
  if (!scImportLabel.value && scImportUrl.value) {
    try {
      const parts = new URL(scImportUrl.value).pathname.split('/').filter(Boolean);
      const slug = parts[parts.length - 1] || '';
      const label = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      scImportLabel.value = label.slice(0, 120);
    } catch {}
  }
});

document.getElementById('sc-import-confirm').addEventListener('click', async () => {
  const url      = scImportUrl.value.trim();
  const label    = scImportLabel.value.trim();
  const category = scImportCategory.value.trim() || 'İçe Aktarılan';
  const color    = scImportColor.value;
  const btn      = document.getElementById('sc-import-confirm');

  if (!url)   { scImportStatus.textContent = '⚠ URL gerekli.'; return; }
  if (!label) { scImportStatus.textContent = '⚠ Kaset adı gerekli.'; return; }

  btn.disabled = true;
  scImportStatus.className = 'sc-import-status running';
  scImportStatus.innerHTML = `
    <div>⏳ SoundCloud sayfası indiriliyor, parçalar analiz ediliyor…</div>
    <div>Büyük playlist'ler için bu 20-60 saniye sürebilir.</div>
    <div class="sc-import-progress"><div class="sc-import-progress-fill"></div></div>
  `;

  try {
    const result = await api('/api/admin/import-playlist', {
      method: 'POST',
      body: JSON.stringify({ url, label, category, color }),
    });

    const saved = result.tape;
    const exists = tapes.findIndex(t => t.id === saved.id);
    if (exists >= 0) tapes[exists] = saved;
    else tapes = [...tapes, saved];

    setTapeDraft(saved, saved.id);
    updateStats();
    scImportModal.close();
    const truncNote = result.truncated ? ` (toplam ${result.totalFound} parça bulundu, 300 ile sınırlandırıldı)` : '';
    Toast.success(
      `"${saved.label}" oluşturuldu`,
      `${result.imported} parça içe aktarıldı.${truncNote}`
    );
  } catch (err) {
    scImportStatus.className = 'sc-import-status error';
    // Scraper kapalıysa özel mesaj
    if (err.message.includes('çalışmıyor') || err.message.includes('python')) {
      scImportStatus.innerHTML = `✕ ${err.message.replace(/\n/g, '<br>')}`;
      await checkScraperStatus();
    } else {
      scImportStatus.innerHTML = `✕ ${err.message}`;
    }
  } finally {
    btn.disabled = false;
  }
});

// Parça ekle
document.getElementById('add-track').addEventListener('click', () => {
  draftTape.tracks.push({ title:'', subtitle:'', soundcloudUrl:'' });
  renderTracks();
  setTimeout(() => {
    const cards = tracksList.querySelectorAll('.track-card');
    cards[cards.length - 1]?.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }, 50);
});

// Toplu içe aktarma
const importModal    = document.getElementById('import-modal');
const importTextarea = document.getElementById('import-textarea');
document.getElementById('import-tracks').addEventListener('click', () => {
  importTextarea.value = '';
  importModal.showModal();
});
document.getElementById('import-cancel').addEventListener('click', () => importModal.close());
document.getElementById('import-confirm').addEventListener('click', () => {
  const urls = importTextarea.value
    .split(/\n/)
    .map(l => l.trim())
    .filter(l => l.startsWith('http'));
  if (!urls.length) { Toast.warning('URL bulunamadı.'); return; }
  urls.forEach(url => {
    // SoundCloud URL'sinden basit başlık çıkar
    const parts = url.split('/').filter(Boolean);
    const slug  = parts[parts.length - 1] || '';
    const title = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 80);
    draftTape.tracks.push({ title, subtitle: '', soundcloudUrl: url });
  });
  importModal.close();
  renderTracks();
  Toast.success('İçe aktarıldı', `${urls.length} parça eklendi.`);
});

// Kaset doğrulama
document.getElementById('validate-tape').addEventListener('click', async () => {
  if (!draftTapeId) { Toast.warning('Önce kayıtlı bir kaset seçin.'); return; }
  const btn = document.getElementById('validate-tape');
  btn.disabled = true;
  btn.innerHTML = '⏳ Kontrol ediliyor…';
  try {
    // Önce sadece kontrol et (autoClean: false)
    const result = await api(`/api/admin/validate-tape/${encodeURIComponent(draftTapeId)}`, {
      method: 'POST',
      body: JSON.stringify({ autoClean: false }),
    });

    if (result.dead === 0) {
      Toast.success('Tüm parçalar erişilebilir', `${result.total} parçanın tamamı çalışıyor.`);
      return;
    }

    // Ölü linkler varsa kullanıcıya sor
    const msg = `${result.dead} parça erişilemiyor:\n\n` +
      result.deadTracks.slice(0, 10).map(t => `• ${t.title} (${t.statusCode || t.error})`).join('\n') +
      (result.dead > 10 ? `\n… ve ${result.dead - 10} tane daha` : '') +
      `\n\nBu ${result.dead} parça listeden silinsin mi?`;

    if (!confirm(msg)) return;

    // Temizle
    const cleaned = await api(`/api/admin/validate-tape/${encodeURIComponent(draftTapeId)}`, {
      method: 'POST',
      body: JSON.stringify({ autoClean: true }),
    });

    // Güncel kaseti yeniden yükle
    const data = await api('/api/admin/data');
    tapes = data.tapes || [];
    const updated = tapes.find(t => t.id === draftTapeId);
    if (updated) setTapeDraft(updated, updated.id);
    updateStats();
    Toast.success(
      'Temizlendi',
      `${cleaned.dead} ölü link silindi, ${cleaned.alive} parça kaldı.`
    );
  } catch (err) {
    Toast.error('Doğrulama başarısız.', err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Doğrula`;
  }
});

// Kaset kaydet
document.getElementById('save-tape').addEventListener('click', async () => {
  const btn = document.getElementById('save-tape');
  btn.disabled = true;

  // draftTape.tracks zaten input event'leriyle canlı güncelleniyor.
  // Sadece DOM sıralamasını (sürükleme sonrası) yansıt:
  const cards = tracksList.querySelectorAll('.track-card[data-track-idx]');
  if (cards.length === draftTape.tracks.length) {
    const snapshot = [...draftTape.tracks]; // klonla
    const reordered = Array.from(cards).map(card => {
      const idx = Number(card.dataset.trackIdx);
      return snapshot[idx];
    }).filter(Boolean);
    if (reordered.length === draftTape.tracks.length) draftTape.tracks = reordered;
  }

  try {
    const isNew = !draftTapeId;
    const result = await api(
      isNew ? '/api/admin/tapes' : `/api/admin/tapes/${encodeURIComponent(draftTapeId)}`,
      { method: isNew ? 'POST' : 'PUT', body: JSON.stringify({ tape: draftTape }) }
    );
    const saved = result.tape;
    tapes = isNew ? [...tapes, saved] : tapes.map(t => t.id === saved.id ? saved : t);
    setTapeDraft(saved, saved.id);
    updateStats();
    Toast.success('Kaydedildi', `"${saved.label}" kaseti kaydedildi.`);
  } catch (err) {
    Toast.error('Kayıt başarısız.', err.message);
  } finally { btn.disabled = false; }
});

// Kaset sil
document.getElementById('delete-tape').addEventListener('click', async () => {
  if (!draftTapeId || !confirm(`"${draftTape.label}" kaseti silinsin mi?`)) return;
  try {
    await api(`/api/admin/tapes/${encodeURIComponent(draftTapeId)}`, { method:'DELETE' });
    tapes = tapes.filter(t => t.id !== draftTapeId);
    updateStats();
    if (tapes.length) setTapeDraft(tapes[0], tapes[0].id);
    else setTapeDraft({ label:'', category:'', color:'#1a237e', tracks:[] });
    Toast.success('Silindi', 'Kaset silindi.');
  } catch (err) {
    Toast.error('Silme başarısız.', err.message);
  }
});

/* ═══════════════════════════════════════════════
   ŞARKI İSTEKLERİ SEKMESİ
   ═══════════════════════════════════════════════ */
const requestsList   = document.getElementById('requests-list');
const requestsSearch = document.getElementById('requests-search');

async function deleteSongRequest(request, button) {
  if (!request.id) {
    Toast.error('Silinemedi.', 'Bu isteğin kimliği bulunamadı. Listeyi yenileyin.');
    return;
  }
  if (!window.confirm(`“${request.song || 'İsimsiz şarkı'}” isteği silinsin mi?`)) return;

  button.disabled = true;
  try {
    await api(`/api/admin/requests/${encodeURIComponent(request.id)}`, { method: 'DELETE' });
    allRequests = allRequests.filter(item => item.id !== request.id);
    document.getElementById('stat-requests').textContent = allRequests.length;
    filterRequests();
    Toast.success('İstek silindi.');
  } catch (error) {
    button.disabled = false;
    Toast.error('İstek silinemedi.', error.message);
  }
}

function renderRequests(list) {
  requestsList.replaceChildren();
  document.getElementById('request-stats').innerHTML = list.length
    ? `<span>${list.length} istek</span>` : '';

  if (!list.length) {
    const em = document.createElement('p');
    em.className = 'request-empty';
    em.textContent = allRequests.length && requestsSearch.value
      ? 'Aramanızla eşleşen istek yok.'
      : 'Henüz şarkı isteği yok.';
    requestsList.append(em);
    return;
  }

  list.forEach(req => {
    const card = document.createElement('article');
    card.className = 'request-card';

    const head = document.createElement('div');
    head.className = 'request-card-head';
    head.innerHTML = `
      <div class="request-song">${esc(req.song || 'İsimsiz')}${req.artist ? ` <span style="color:var(--text-dim);font-weight:400">— ${esc(req.artist)}</span>` : ''}</div>
      <time class="request-time" datetime="${esc(req.submittedAt || '')}">${req.submittedAt ? fmt(req.submittedAt) : ''}</time>
    `;
    const headActions = document.createElement('div');
    headActions.className = 'request-card-actions';
    const time = head.querySelector('.request-time');
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'request-delete-button';
    deleteButton.textContent = 'Sil';
    deleteButton.setAttribute('aria-label', `${req.song || 'Şarkı'} isteğini sil`);
    deleteButton.addEventListener('click', () => deleteSongRequest(req, deleteButton));
    if (time) headActions.append(time);
    headActions.append(deleteButton);
    head.append(headActions);

    const meta = document.createElement('div');
    meta.className = 'request-meta';
    if (req.name) meta.innerHTML += `<span>👤 ${esc(req.name)}</span>`;
    card.append(head, meta);

    if (req.note) {
      const note = document.createElement('p');
      note.className = 'request-note';
      note.textContent = req.note;
      card.append(note);
    }
    requestsList.append(card);
  });
}

function filterRequests() {
  const q = requestsSearch.value.toLowerCase().trim();
  if (!q) return renderRequests(allRequests);
  const filtered = allRequests.filter(r =>
    [r.song, r.artist, r.name, r.note].some(f => f?.toLowerCase().includes(q))
  );
  renderRequests(filtered);
}

requestsSearch.addEventListener('input', filterRequests);

async function loadRequests() {
  try {
    const result = await api('/api/admin/requests');
    allRequests = result.requests || [];
    document.getElementById('stat-requests').textContent = allRequests.length;
    filterRequests();
  } catch (err) {
    Toast.error('İstekler yüklenemedi.', err.message);
  }
}

document.getElementById('refresh-requests').addEventListener('click', async () => {
  await loadRequests();
  Toast.info('Yenilendi');
});

// CSV indir
document.getElementById('export-requests').addEventListener('click', () => {
  if (!allRequests.length) { Toast.warning('Dışa aktarılacak istek yok.'); return; }
  const header = 'Şarkı,Sanatçı,İsteyen,Not,Tarih';
  const rows = allRequests.map(r =>
    [r.song, r.artist, r.name, r.note, r.submittedAt]
      .map(v => `"${(v || '').replace(/"/g, '""')}"`)
      .join(',')
  );
  const csv  = [header, ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `sarki-istekleri-${new Date().toISOString().slice(0,10)}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  Toast.success('CSV indirildi', `${allRequests.length} kayıt`);
});

/* ═══════════════════════════════════════════════
   ANA SAYFA KODLARI
   ═══════════════════════════════════════════════ */
const adsenseCodeInput = document.getElementById('adsense-code');
const trackerCodeInput = document.getElementById('tracker-code');
const siteCodeMessage = document.getElementById('site-code-message');

async function loadSiteCode() {
  try {
    const siteCode = await api('/api/admin/site-code');
    adsenseCodeInput.value = siteCode.adsense || '';
    trackerCodeInput.value = siteCode.tracker || '';
  } catch (err) {
    siteCodeMessage.textContent = `Kodlar yüklenemedi: ${err.message}`;
    siteCodeMessage.className = 'message error';
  }
}

document.getElementById('save-site-code').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  siteCodeMessage.textContent = '';
  try {
    await api('/api/admin/site-code', {
      method: 'PUT',
      body: JSON.stringify({
        adsense: adsenseCodeInput.value,
        tracker: trackerCodeInput.value,
      }),
    });
    siteCodeMessage.textContent = 'Kodlar kaydedildi ve ana sayfada etkinleştirildi.';
    siteCodeMessage.className = 'message';
    Toast.success('Site kodları kaydedildi.');
  } catch (err) {
    siteCodeMessage.textContent = `Kaydedilemedi: ${err.message}`;
    siteCodeMessage.className = 'message error';
    Toast.error('Site kodları kaydedilemedi.', err.message);
  } finally {
    button.disabled = false;
  }
});

/* ═══════════════════════════════════════════════
   KLAVYE KISAYOLLARI
   ═══════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (!workspace.classList.contains('hidden') && (e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    // Aktif sekmeye göre kaydet
    const activeTab = document.querySelector('.tab.active');
    if (activeTab?.dataset.tab === 'stations') {
      document.getElementById('save-stations').click();
    } else if (activeTab?.dataset.tab === 'tapes') {
      document.getElementById('save-tape').click();
    } else if (activeTab?.dataset.tab === 'site-code') {
      document.getElementById('save-site-code').click();
    }
  }
});

/* ═══════════════════════════════════════════════
   DASHBOARD YÜKLE
   ═══════════════════════════════════════════════ */
async function loadDashboard() {
  const data = await api('/api/admin/data');
  stations = data.stations || [];
  tapes    = data.tapes    || [];
  tapeOrderDirty = false;

  renderStations();
  await refreshStationHealth();

  if (tapes.length) setTapeDraft(tapes[0], tapes[0].id);
  else              setTapeDraft({ label:'', category:'', color:'#1a237e', tracks:[] });

  await loadRequests();
  await loadSiteCode();
  await loadTapeBackups();
  updateStats();
}

/* ═══════════════════════════════════════════════
   BAŞLAT
   ═══════════════════════════════════════════════ */
(async function init() {
  try {
    const session = await api('/api/admin/session');
    if (!session.enabled) {
      setupNote.classList.remove('hidden');
      loginForm.querySelector('button[type="submit"]').disabled = true;
      return;
    }
    if (session.authenticated) {
      await loadDashboard();
      showWorkspace(true);
    }
  } catch (err) {
    loginMsg.textContent = err.message;
    loginMsg.className = 'message error';
  }
})();
