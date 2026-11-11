const loginPanel = document.getElementById('login-panel');
const workspace = document.getElementById('workspace');
const loginForm = document.getElementById('login-form');
const loginMessage = document.getElementById('login-message');
const setupNote = document.getElementById('setup-note');
const globalMessage = document.getElementById('global-message');
const logoutButton = document.getElementById('logout-button');
const stationsList = document.getElementById('stations-list');
const tapePicker = document.getElementById('tape-picker');
const tapeForm = document.getElementById('tape-form');
const tracksList = document.getElementById('tracks-list');
const requestsList = document.getElementById('requests-list');

let stations = [];
let tapes = [];
let draftTape = null;
let draftTapeId = null;
let stationHealth = new Map();
let stationHealthPollTimer = null;

function message(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle('error', isError);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `İstek başarısız (HTTP ${response.status}).`);
  return body;
}

function showWorkspace(visible) {
  loginPanel.classList.toggle('hidden', visible);
  workspace.classList.toggle('hidden', !visible);
  logoutButton.classList.toggle('hidden', !visible);
}

function makeButton(text, className, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button ${className || ''}`.trim();
  button.textContent = text;
  if (action) button.addEventListener('click', action);
  return button;
}

function makeField(labelText, value, options = {}) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.value = value ?? '';
  input.type = options.type || 'text';
  if (options.type === 'number') {
    input.min = '88';
    input.max = '108';
    input.step = '0.1';
  }
  if (options.type === 'color') input.value = /^#[0-9a-f]{6}$/i.test(input.value) ? input.value : '#1a237e';
  if (options.maxLength) input.maxLength = options.maxLength;
  if (options.url) {
    input.type = 'url';
    input.maxLength = 2048;
  }
  label.append(input);
  return { label, input };
}

async function checkLink(url, resultElement, button) {
  if (!url) {
    resultElement.textContent = 'Önce bağlantı girin.';
    resultElement.className = 'health bad';
    return;
  }
  button.disabled = true;
  resultElement.textContent = 'Bağlantı test ediliyor…';
  resultElement.className = 'health';
  try {
    const result = await api('/api/admin/check-link', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    resultElement.textContent = `${result.message}${result.statusCode ? ` (HTTP ${result.statusCode})` : ''}${result.contentType ? ` · ${result.contentType}` : ''}`;
    resultElement.className = `health ${result.healthy ? 'good' : 'bad'}`;
    return result;
  } catch (error) {
    resultElement.textContent = error.message;
    resultElement.className = 'health bad';
    return null;
  } finally {
    button.disabled = false;
  }
}

function formatStationHealth(result) {
  if (!result || typeof result.healthy !== 'boolean') return 'Henüz test edilmedi.';
  const checkedAt = result.checkedAt ? new Date(result.checkedAt).toLocaleString('tr-TR') : '';
  return `${result.healthy ? 'Çevrimiçi' : 'Çevrimdışı'} — ${result.message || 'Durum bilinmiyor.'}${checkedAt ? ` · ${checkedAt}` : ''}`;
}

function updateStationHealthCards() {
  stationsList.querySelectorAll('.item-card[data-station-index]').forEach(card => {
    const station = stations[Number(card.dataset.stationIndex)];
    if (!station) return;
    const result = stationHealth.get(station.streamUrl);
    const health = card.querySelector('.health');
    if (!health) return;
    health.textContent = formatStationHealth(result);
    health.className = `health${result?.healthy === true ? ' good' : result?.healthy === false ? ' bad' : ''}`;
  });
}

async function refreshStationHealth() {
  try {
    const result = await api('/api/admin/station-health');
    stationHealth = new Map(result.stations.map(station => [station.streamUrl, station]));
    updateStationHealthCards();
    const progress = document.getElementById('station-check-progress');
    const checkButton = document.getElementById('check-all-stations');
    if (result.running) {
      progress.textContent = `Toplu kontrol sürüyor: ${result.completed}/${result.total} istasyon tamamlandı. Toplu kontrol kayıtlı istasyonları test eder.`;
      checkButton.disabled = true;
      clearTimeout(stationHealthPollTimer);
      stationHealthPollTimer = setTimeout(refreshStationHealth, 2000);
    } else {
      const checked = result.stations.filter(station => typeof station.healthy === 'boolean').length;
      progress.textContent = `${checked}/${result.total} istasyonun son kontrolü mevcut. Otomatik kontrol 15 dakikada bir yapılır.`;
      checkButton.disabled = false;
      clearTimeout(stationHealthPollTimer);
      stationHealthPollTimer = null;
    }
  } catch (error) {
    message(globalMessage, error.message, true);
  }
}

function renderStations() {
  stationsList.replaceChildren();
  stations.forEach((station, index) => {
    const card = document.createElement('article');
    card.className = 'item-card';
    card.dataset.stationIndex = String(index);
    const fields = document.createElement('div');
    fields.className = 'item-fields';
    const health = document.createElement('p');
    health.className = 'health';
    health.textContent = formatStationHealth(stationHealth.get(station.streamUrl));
    const controls = [
      makeField('MHz', station.frequency, { type: 'number' }),
      makeField('İstasyon adı', station.name, { maxLength: 120 }),
      makeField('Tür', station.genre, { maxLength: 80 }),
      makeField('Yayın bağlantısı', station.streamUrl, { url: true }),
    ];
    controls.forEach(({ label, input }, fieldIndex) => {
      input.addEventListener('input', () => {
        const key = ['frequency', 'name', 'genre', 'streamUrl'][fieldIndex];
        station[key] = key === 'frequency' ? Number(input.value) : input.value;
        health.textContent = 'Bilgi değişti; bağlantıyı yeniden test edin.';
        health.className = 'health';
      });
      fields.append(label);
    });
    const actions = document.createElement('div');
    actions.className = 'actions';
    const testButton = makeButton('Bağlantıyı test et', 'button-secondary', () => {
      checkLink(station.streamUrl, health, testButton).then(result => {
        if (!result) return;
        const checkedAt = new Date().toISOString();
        stationHealth.set(station.streamUrl, { ...result, checkedAt });
        updateStationHealthCards();
      });
    });
    const deleteButton = makeButton('Sil', 'button-danger', () => {
      stations.splice(index, 1);
      renderStations();
    });
    actions.append(testButton, deleteButton);
    card.append(fields, actions, health);
    stationsList.append(card);
  });
}

function updateTapeField(name, value) {
  draftTape[name] = value;
}

function renderTracks() {
  tracksList.replaceChildren();
  document.getElementById('track-count').textContent = `${draftTape.tracks.length} parça`;
  draftTape.tracks.forEach((track, index) => {
    const card = document.createElement('article');
    card.className = 'item-card track-card';
    const fields = document.createElement('div');
    fields.className = 'track-fields';
    const health = document.createElement('p');
    health.className = 'health';
    health.textContent = 'Henüz test edilmedi.';
    const controls = [
      makeField('Parça adı', track.title, { maxLength: 160 }),
      makeField('Sanatçı', track.subtitle, { maxLength: 120 }),
      makeField('SoundCloud bağlantısı', track.soundcloudUrl, { url: true }),
    ];
    controls.forEach(({ label, input }, fieldIndex) => {
      input.addEventListener('input', () => {
        track[['title', 'subtitle', 'soundcloudUrl'][fieldIndex]] = input.value;
        health.textContent = 'Bilgi değişti; bağlantıyı yeniden test edin.';
        health.className = 'health';
      });
      fields.append(label);
    });
    const testButton = makeButton('Test', 'button-secondary', () => {
      checkLink(track.soundcloudUrl, health, testButton);
    });
    const deleteButton = makeButton('Sil', 'button-danger', () => {
      draftTape.tracks.splice(index, 1);
      renderTracks();
    });
    fields.append(testButton, deleteButton);
    card.append(fields, health);
    tracksList.append(card);
  });
}

function renderTapePicker() {
  tapePicker.replaceChildren();
  tapes.forEach(tape => {
    const option = document.createElement('option');
    option.value = tape.id;
    option.textContent = `${tape.label} · ${tape.category}`;
    tapePicker.append(option);
  });
  if (!tapes.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Henüz kaset yok';
    tapePicker.append(option);
  }
}

function setTapeDraft(tape, id = null) {
  draftTape = JSON.parse(JSON.stringify(tape));
  draftTapeId = id;
  tapeForm.elements.label.value = draftTape.label || '';
  tapeForm.elements.category.value = draftTape.category || '';
  tapeForm.elements.color.value = draftTape.color || '#1a237e';
  document.getElementById('delete-tape').classList.toggle('hidden', !id);
  document.getElementById('save-tape').textContent = id ? 'Kaseti kaydet' : 'Kaseti oluştur';
  renderTracks();
}

function renderRequests(requests) {
  requestsList.replaceChildren();
  if (!requests.length) {
    const empty = document.createElement('p');
    empty.className = 'request-note';
    empty.textContent = 'Henüz şarkı isteği yok.';
    requestsList.append(empty);
    return;
  }
  requests.forEach(request => {
    const card = document.createElement('article');
    card.className = 'request-card';
    const head = document.createElement('div');
    head.className = 'request-card-head';
    const song = document.createElement('strong');
    song.textContent = `${request.song || 'İsimsiz'}${request.artist ? ` — ${request.artist}` : ''}`;
    const time = document.createElement('time');
    time.dateTime = request.submittedAt || '';
    const date = new Date(request.submittedAt);
    time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('tr-TR');
    head.append(song, time);
    card.append(head);
    if (request.name) {
      const name = document.createElement('p');
      name.textContent = `İsteyen: ${request.name}`;
      card.append(name);
    }
    if (request.note) {
      const note = document.createElement('p');
      note.textContent = request.note;
      card.append(note);
    }
    requestsList.append(card);
  });
}

async function loadDashboard() {
  const data = await api('/api/admin/data');
  stations = data.stations;
  tapes = data.tapes;
  renderStations();
  await refreshStationHealth();
  renderTapePicker();
  if (tapes.length) {
    setTapeDraft(tapes[0], tapes[0].id);
    tapePicker.value = tapes[0].id;
  } else {
    setTapeDraft({ label: '', category: '', color: '#1a237e', tracks: [] });
  }
  await loadRequests();
}

async function loadRequests() {
  const result = await api('/api/admin/requests');
  renderRequests(result.requests);
}

document.querySelectorAll('.tab').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab === button));
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('hidden', panel.id !== `${button.dataset.tab}-panel`);
    });
  });
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  message(loginMessage, 'Giriş yapılıyor…');
  const form = new FormData(loginForm);
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
    });
    loginForm.reset();
    await loadDashboard();
    showWorkspace(true);
    message(loginMessage, '');
  } catch (error) {
    message(loginMessage, error.message, true);
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST', body: '{}' });
    showWorkspace(false);
    message(loginMessage, 'Güvenli çıkış yapıldı.');
  } catch (error) {
    message(globalMessage, error.message, true);
  }
});

document.getElementById('add-station-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  stations.push({
    frequency: Number(form.get('frequency')),
    name: String(form.get('name')).trim(),
    genre: String(form.get('genre')).trim(),
    streamUrl: String(form.get('streamUrl')).trim(),
  });
  event.currentTarget.reset();
  renderStations();
  message(globalMessage, 'İstasyon listeye eklendi. Kalıcı olması için istasyonları kaydedin.');
});

document.getElementById('save-stations').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api('/api/admin/stations', {
      method: 'PUT',
      body: JSON.stringify({ stations }),
    });
    stations = result.stations;
    renderStations();
    message(globalMessage, 'İstasyonlar kaydedildi.');
    await refreshStationHealth();
  } catch (error) {
    message(globalMessage, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('check-all-stations').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  document.getElementById('station-check-progress').textContent = 'Toplu kontrol başlatılıyor…';
  try {
    await api('/api/admin/check-stations', { method: 'POST', body: '{}' });
    await refreshStationHealth();
  } catch (error) {
    message(globalMessage, error.message, true);
    await refreshStationHealth();
  } finally {
    if (!stationHealthPollTimer) button.disabled = false;
  }
});

document.getElementById('new-tape').addEventListener('click', () => {
  tapePicker.value = '';
  setTapeDraft({ label: '', category: '', color: '#1a237e', tracks: [] });
});

tapePicker.addEventListener('change', () => {
  const tape = tapes.find(item => item.id === tapePicker.value);
  if (tape) setTapeDraft(tape, tape.id);
});

tapeForm.elements.label.addEventListener('input', event => updateTapeField('label', event.currentTarget.value));
tapeForm.elements.category.addEventListener('input', event => updateTapeField('category', event.currentTarget.value));
tapeForm.elements.color.addEventListener('input', event => updateTapeField('color', event.currentTarget.value));

document.getElementById('add-track').addEventListener('click', () => {
  draftTape.tracks.push({ title: '', subtitle: '', soundcloudUrl: '' });
  renderTracks();
});

tapeForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('save-tape');
  button.disabled = true;
  try {
    const isNew = !draftTapeId;
    const result = await api(isNew ? '/api/admin/tapes' : `/api/admin/tapes/${encodeURIComponent(draftTapeId)}`, {
      method: isNew ? 'POST' : 'PUT',
      body: JSON.stringify({ tape: draftTape }),
    });
    const saved = result.tape;
    tapes = isNew ? [...tapes, saved].sort((a, b) => a.id.localeCompare(b.id)) : tapes.map(tape => tape.id === saved.id ? saved : tape);
    renderTapePicker();
    tapePicker.value = saved.id;
    setTapeDraft(saved, saved.id);
    message(globalMessage, 'Kaset ve parçalar kaydedildi.');
  } catch (error) {
    message(globalMessage, error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('delete-tape').addEventListener('click', async () => {
  if (!draftTapeId || !window.confirm(`"${draftTape.label}" kaseti ve parça listesi silinsin mi?`)) return;
  try {
    await api(`/api/admin/tapes/${encodeURIComponent(draftTapeId)}`, { method: 'DELETE' });
    tapes = tapes.filter(tape => tape.id !== draftTapeId);
    renderTapePicker();
    if (tapes.length) {
      tapePicker.value = tapes[0].id;
      setTapeDraft(tapes[0], tapes[0].id);
    } else {
      setTapeDraft({ label: '', category: '', color: '#1a237e', tracks: [] });
    }
    message(globalMessage, 'Kaset silindi.');
  } catch (error) {
    message(globalMessage, error.message, true);
  }
});

document.getElementById('refresh-requests').addEventListener('click', async () => {
  try {
    await loadRequests();
    message(globalMessage, 'Şarkı istekleri yenilendi.');
  } catch (error) {
    message(globalMessage, error.message, true);
  }
});

async function init() {
  try {
    const session = await api('/api/admin/session');
    if (!session.enabled) {
      setupNote.classList.remove('hidden');
      loginForm.classList.add('hidden');
      return;
    }
    if (session.authenticated) {
      await loadDashboard();
      showWorkspace(true);
    }
  } catch (error) {
    message(loginMessage, error.message, true);
  }
}

init();
