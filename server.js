/**
 * server.js — Karışık Kaset | Retro Radyo + Kaset Çalar
 * Node.js + Express backend
 *
 * Özellikler:
 *  - Statik dosya sunumu (/public)
 *  - /api/stations  → config/stations.json
 *  - /api/tracks    → config/tracks.json
 *  - /api/resolve   → PLS/M3U playlist dosyasını çözerek gerçek stream URL'ini döner
 *  - /api/stream    → Radyo stream proxy (beyaz liste korumalı, redirect takipli)
 */

import express from 'express';
import { createServer } from 'http';
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { lookup } from 'dns/promises';
import https from 'https';
import http from 'http';
import { isIP } from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
const PORT = process.env.PORT || 3000;
const ADMIN_COOKIE = 'kk_admin_session';
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

function adminIsConfigured() {
  return Boolean(
    process.env.ADMIN_USERNAME &&
    (process.env.ADMIN_PASSWORD?.length || 0) >= 16 &&
    process.env.ADMIN_SESSION_SECRET &&
    Buffer.byteLength(process.env.ADMIN_SESSION_SECRET) >= 32
  );
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signAdminSession(expires, nonce) {
  return createHmac('sha256', process.env.ADMIN_SESSION_SECRET)
    .update(`${process.env.ADMIN_USERNAME}:${expires}:${nonce}`)
    .digest('base64url');
}

function adminSessionIsValid(req) {
  if (!adminIsConfigured()) return false;
  const cookie = (req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(`${ADMIN_COOKIE}=`));
  if (!cookie) return false;
  const [, token] = cookie.split('=', 2);
  const [expiresText, nonce, signature] = (token || '').split('.');
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000) || !nonce || !signature) {
    return false;
  }
  return safeEqual(signature, signAdminSession(expires, nonce));
}

function setAdminCookie(res, token, maxAge) {
  const value = token ? `${ADMIN_COOKIE}=${token}` : `${ADMIN_COOKIE}=`;
  res.setHeader('Set-Cookie', `${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

function requireAdmin(req, res, next) {
  if (!adminIsConfigured()) {
    return res.status(503).json({ error: 'Admin girişi sunucuda yapılandırılmamış.' });
  }
  if (!adminSessionIsValid(req)) return res.status(401).json({ error: 'Oturum açmanız gerekiyor.' });
  next();
}

function requireSameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'İstek kaynağı doğrulanamadı.' });
  try {
    if (new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ error: 'Siteler arası istek reddedildi.' });
    }
  } catch {
    return res.status(403).json({ error: 'İstek kaynağı geçersiz.' });
  }
  next();
}

const adminLoginAttempts = new Map();
const stationHealth = new Map();
let stationCheckRun = null;
const STATION_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const STATION_CHECK_CONCURRENCY = 4;

// ─────────────────────────────────────────────
// Yardımcı: JSON dosyasını diskten oku (önbelleksiz)
// data: array veya obje olabilir
// ─────────────────────────────────────────────
async function readJSON(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return { data: null, warning: 'Dosya boş.' };
    const data = JSON.parse(trimmed);
    return { data };
  } catch (err) {
    if (err.code === 'ENOENT') return { data: null, warning: 'Dosya bulunamadı.' };
    if (err instanceof SyntaxError) return { data: null, warning: 'JSON sözdizimi hatası.' };
    return { data: null, warning: err.message };
  }
}

async function writeJSONAtomic(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, filePath);
}

function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const value = (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
    const inRange = (network, mask) => ((value & mask) >>> 0) === network;
    const ranges = [
      [0x00000000, 0xff000000], [0x0a000000, 0xff000000], [0x64400000, 0xffc00000],
      [0x7f000000, 0xff000000], [0xa9fe0000, 0xffff0000], [0xac100000, 0xfff00000],
      [0xc0000000, 0xffffff00], [0xc0000200, 0xffffff00], [0xc0a80000, 0xffff0000],
      [0xc6120000, 0xfffe0000], [0xc6336400, 0xffffff00], [0xcb007100, 0xffffff00],
      [0xe0000000, 0xf0000000], [0xf0000000, 0xf0000000],
    ];
    return !ranges.some(([network, mask]) => inRange(network, mask));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return false;
    return !(
      normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      /^fe[89abcdef]/.test(normalized) || normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

async function assertPublicHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL biçimi geçersiz.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Yalnızca kullanıcı bilgisi içermeyen HTTP/HTTPS bağlantıları kullanılabilir.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal')
  ) {
    throw new Error('Yerel ağ adresleri test edilemez.');
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Bağlantı genel internet adresine çözülmüyor.');
  }
  return { url, addresses };
}

async function probeExternalLink(value, redirectsLeft = 5) {
  if (redirectsLeft < 0) throw new Error('Çok fazla yönlendirme.');
  const { url, addresses } = await assertPublicHttpUrl(value);
  const response = await makeStreamRequest(url.toString(), {}, addresses);
  const result = {
    statusCode: response.statusCode,
    contentType: response.headers['content-type'] || 'Belirtilmedi',
    stationName: response.headers['icy-name'] || null,
    finalUrl: url.toString(),
  };
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    const nextUrl = new URL(response.headers.location, url).toString();
    response.on('error', () => {});
    response.resume();
    return probeExternalLink(nextUrl, redirectsLeft - 1);
  }
  if (response.statusCode < 200 || response.statusCode >= 400) {
    response.destroy();
    return { ...result, healthy: false, message: `Kaynak HTTP ${response.statusCode} döndürdü.` };
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(false, 'Yanıt geldi ancak akış verisi zamanında alınamadı.'), 7000);
    const finish = (healthy, message, bytes = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      response.destroy();
      resolve({ ...result, healthy, message, bytes });
    };
    response.once('data', chunk => finish(true, 'Bağlantı çalışıyor; akış verisi alındı.', chunk.length));
    response.once('end', () => finish(false, 'Kaynak bağlantıyı açtı ancak akış verisi göndermedi.'));
    response.once('error', error => finish(false, error.message));
  });
}

function validateStations(value) {
  if (!Array.isArray(value) || value.length > 500) throw new Error('İstasyon listesi geçersiz veya 500 kayıttan fazla.');
  return value.map((station, index) => {
    if (!station || typeof station !== 'object' || Array.isArray(station)) {
      throw new Error(`${index + 1}. istasyon kaydı geçersiz.`);
    }
    const frequency = Number(station.frequency);
    const name = typeof station.name === 'string' ? station.name.trim() : '';
    const genre = typeof station.genre === 'string' ? station.genre.trim() : '';
    const streamUrl = typeof station.streamUrl === 'string' ? station.streamUrl.trim() : '';
    if (!Number.isFinite(frequency) || frequency < 88 || frequency > 108) {
      throw new Error(`${index + 1}. istasyonun frekansı 88–108 MHz arasında olmalı.`);
    }
    if (!name || name.length > 120 || genre.length > 80 || !streamUrl || streamUrl.length > 2048) {
      throw new Error(`${index + 1}. istasyonun adı, türü veya bağlantısı geçersiz.`);
    }
    let url;
    try { url = new URL(streamUrl); } catch { throw new Error(`${index + 1}. istasyon bağlantısı geçersiz.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${index + 1}. istasyon yalnızca kullanıcı bilgisi içermeyen HTTP/HTTPS bağlantısı kullanabilir.`);
    }
    return { frequency, name, genre, streamUrl };
  });
}

function validateTape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Kaset bilgileri geçersiz.');
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const category = typeof value.category === 'string' ? value.category.trim() : '';
  const color = typeof value.color === 'string' && value.color.trim() ? value.color.trim() : '#1a237e';
  if (!label || label.length > 120 || !category || category.length > 80 || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error('Kaset adı, kategorisi veya rengi geçersiz.');
  }
  if (!Array.isArray(value.tracks) || value.tracks.length > 300) throw new Error('Kasette en fazla 300 parça olabilir.');
  const tracks = value.tracks.map((track, index) => {
    const title = typeof track?.title === 'string' ? track.title.trim() : '';
    const subtitle = typeof track?.subtitle === 'string' ? track.subtitle.trim() : '';
    const soundcloudUrl = typeof track?.soundcloudUrl === 'string' ? track.soundcloudUrl.trim() : '';
    if (!title || title.length > 160 || subtitle.length > 120 || !soundcloudUrl || soundcloudUrl.length > 2048) {
      throw new Error(`${index + 1}. parçanın bilgileri geçersiz.`);
    }
    let url;
    try { url = new URL(soundcloudUrl); } catch { throw new Error(`${index + 1}. parçanın bağlantısı geçersiz.`); }
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (hostname !== 'soundcloud.com' && !hostname.endsWith('.soundcloud.com'))) {
      throw new Error(`${index + 1}. parça HTTPS SoundCloud bağlantısı olmalı.`);
    }
    return { title, subtitle, soundcloudUrl };
  });
  return { label, category, color, tracks };
}

function tapeSlug(label) {
  const slug = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  if (!slug) throw new Error('Kaset adı dosya adı olarak kullanılamıyor.');
  return slug;
}

async function readAdminTapes() {
  const tapesDir = join(__dirname, 'config', 'tapes');
  const files = (await readdir(tapesDir)).filter(file => file.endsWith('.json')).sort();
  const tapes = [];
  for (const file of files) {
    const { data, warning } = await readJSON(join(tapesDir, file));
    if (warning) throw new Error(`${file}: ${warning}`);
    const tape = Array.isArray(data)
      ? { label: file.replace(/\.json$/i, ''), category: 'Diğer', color: '#1a237e', tracks: data }
      : data;
    tapes.push({ id: file.replace(/\.json$/i, ''), ...validateTape({ ...tape, category: tape.category || 'Diğer' }) });
  }
  return tapes;
}

async function probeStation(station) {
  const streamUrls = await resolveStreamUrl(station.streamUrl);
  let lastResult = null;
  for (const streamUrl of streamUrls.slice(0, 5)) {
    try {
      lastResult = await probeExternalLink(streamUrl);
      if (lastResult.healthy) return lastResult;
    } catch (error) {
      lastResult = { healthy: false, message: error.message || 'Bağlantı test edilemedi.' };
    }
  }
  return lastResult || { healthy: false, message: 'Çalışan bir yayın adresi bulunamadı.' };
}

async function persistStationHealth() {
  const dataDir = join(__dirname, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeJSONAtomic(join(dataDir, 'station-health.json'), Object.fromEntries(stationHealth));
}

async function loadStationHealth() {
  const { data, warning } = await readJSON(join(__dirname, 'data', 'station-health.json'));
  if (warning === 'Dosya bulunamadı.') return;
  if (warning || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(warning || 'İstasyon durum dosyası geçersiz.');
  }
  for (const [url, result] of Object.entries(data)) {
    if (typeof url === 'string' && result && typeof result.healthy === 'boolean') {
      stationHealth.set(url, result);
    }
  }
}

function stationHealthPayload(stations) {
  return stations.map(station => ({
    frequency: station.frequency,
    name: station.name,
    streamUrl: station.streamUrl,
    ...(stationHealth.get(station.streamUrl) || { healthy: null, message: 'Henüz kontrol edilmedi.', checkedAt: null }),
  }));
}

async function runStationHealthSweep() {
  if (stationCheckRun) return stationCheckRun;
  const run = { startedAt: new Date().toISOString(), total: 0, completed: 0 };
  stationCheckRun = run;
  let stations;
  try {
    const result = await readJSON(join(__dirname, 'config', 'stations.json'));
    if (result.warning || !Array.isArray(result.data)) {
      throw new Error(result.warning || 'İstasyon listesi geçersiz.');
    }
    stations = result.data;
    run.total = stations.length;
  } catch (error) {
    if (stationCheckRun === run) stationCheckRun = null;
    throw error;
  }
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < stations.length) {
      const index = nextIndex++;
      const station = stations[index];
      let result;
      try {
        result = await probeStation(station);
      } catch (error) {
        result = { healthy: false, message: error.message || 'Bağlantı test edilemedi.' };
      }
      stationHealth.set(station.streamUrl, {
        healthy: result.healthy,
        message: result.message,
        statusCode: result.statusCode || null,
        contentType: result.contentType || null,
        checkedAt: new Date().toISOString(),
      });
      run.completed++;
    }
  };
  run.promise = Promise.all(Array.from(
    { length: Math.min(STATION_CHECK_CONCURRENCY, stations.length) },
    worker
  )).then(async () => {
    await persistStationHealth();
  }).catch(error => {
    run.error = error.message;
    console.error('[station-health] Durumlar kaydedilemedi:', error.message);
  }).finally(() => {
    if (stationCheckRun === run) stationCheckRun = null;
  });
  return run;
}

// ─────────────────────────────────────────────
// Yardımcı: HTTP/HTTPS GET — Promise tabanlı (metin yanıt)
// Redirect'leri takip eder (en fazla 5 yönlendirme).
// ─────────────────────────────────────────────
async function fetchText(value, redirectsLeft = 5) {
  if (redirectsLeft <= 0) throw new Error('Çok fazla yönlendirme.');
  const { url, addresses } = await assertPublicHttpUrl(value);
  const response = await makeStreamRequest(url.toString(), {}, addresses);
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    const nextUrl = new URL(response.headers.location, url).toString();
    response.resume();
    return fetchText(nextUrl, redirectsLeft - 1);
  }
  if (response.statusCode < 200 || response.statusCode >= 400) {
    response.resume();
    throw new Error(`HTTP ${response.statusCode}`);
  }
  return new Promise((resolve, reject) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        response.destroy();
        reject(new Error('Playlist dosyası 1 MB sınırını aştı.'));
      }
    });
    response.on('end', () => resolve(body));
    response.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// PLS içeriğini ayrıştır → [url, url, ...]
// ─────────────────────────────────────────────
function parsePLS(text) {
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^File\d+=(.+)$/i);
    if (m) urls.push(m[1].trim());
  }
  return urls;
}

// ─────────────────────────────────────────────
// M3U/M3U8 içeriğini ayrıştır → [url, url, ...]
// ─────────────────────────────────────────────
function parseM3U(text) {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

// ─────────────────────────────────────────────
// Verilen URL bir playlist mi? → Gerçek stream URL'lerini döner.
// Playlist değilse URL'nin kendisini dizi içinde döner.
// ─────────────────────────────────────────────
async function resolveStreamUrl(url) {
  const lower = url.toLowerCase().split('?')[0];

  // Uzantıya göre karar ver
  const isPls  = lower.endsWith('.pls');
  const isM3u  = lower.endsWith('.m3u') || lower.endsWith('.m3u8');

  if (!isPls && !isM3u) return [url]; // Zaten doğrudan stream URL'si

  try {
    const text = await fetchText(url);
    const urls = isPls ? parsePLS(text) : parseM3U(text);
    if (urls.length === 0) throw new Error('Playlist boş veya ayrıştırılamadı.');
    console.log(`[resolve] ${url} → ${urls.length} giriş bulundu`);
    return urls;
  } catch (err) {
    console.warn(`[resolve] Playlist çözümlenemedi (${err.message}), URL olduğu gibi kullanılıyor.`);
    return [url];
  }
}

// ─────────────────────────────────────────────
// Yardımcı: HTTP isteği gönder (timeout destekli), Promise
// Sadece response nesnesi döner; body okunmaz (stream için).
// ─────────────────────────────────────────────
function makeStreamRequest(url, extraHeaders = {}, pinnedAddresses = null) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    // URL'den host ve path ayır (port dahil)
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KarisikKaset/1.0)',
        'Icy-MetaData': '0',
        ...extraHeaders,
      },
      timeout: 10000,
    };
    if (pinnedAddresses) {
      options.lookup = (hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === 'function') callback = lookupOptions;
        if (lookupOptions?.all) callback(null, pinnedAddresses);
        else callback(null, pinnedAddresses[0].address, pinnedAddresses[0].family);
      };
    }
    const req = proto.request(options, resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Stream bağlantı zaman aşımı.')); });
    req.end();
  });
}

function readIcyMetadata(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) {
      reject(new Error('Çok fazla yönlendirme.'));
      return;
    }

    let response = null;
    let settled = false;
    let bytesUntilMetadata = null;
    let metadataBytesRemaining = null;
    const metadataChunks = [];
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      response?.destroy();
      reject(new Error('Radyo bilgisi zaman aşımına uğradı.'));
    }, 7000);

    const finish = (error, metadata = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (response && !response.destroyed) response.destroy();
      if (error) reject(error);
      else resolve(metadata);
    };

    assertPublicHttpUrl(url)
      .then(({ url: safeUrl, addresses }) => makeStreamRequest(safeUrl.toString(), { 'Icy-MetaData': '1' }, addresses))
      .then((upstream) => {
      response = upstream;
      if (settled) {
        upstream.destroy();
        return;
      }
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        const nextUrl = new URL(upstream.headers.location, url).toString();
        upstream.resume();
        clearTimeout(timeout);
        settled = true;
        readIcyMetadata(nextUrl, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (upstream.statusCode < 200 || upstream.statusCode >= 400) {
        finish(new Error(`Radyo sunucusu HTTP ${upstream.statusCode} döndürdü.`));
        return;
      }

      const interval = Number(upstream.headers['icy-metaint']);
      if (!Number.isSafeInteger(interval) || interval <= 0) {
        finish(null);
        return;
      }
      bytesUntilMetadata = interval;

      upstream.on('data', (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (bytesUntilMetadata > 0) {
            const audioBytes = Math.min(bytesUntilMetadata, chunk.length - offset);
            bytesUntilMetadata -= audioBytes;
            offset += audioBytes;
            continue;
          }

          if (metadataBytesRemaining === null) {
            metadataBytesRemaining = chunk[offset] * 16;
            offset++;
            if (metadataBytesRemaining === 0) {
              bytesUntilMetadata = interval;
              metadataBytesRemaining = null;
            }
            continue;
          }

          const metadataBytes = Math.min(metadataBytesRemaining, chunk.length - offset);
          metadataChunks.push(chunk.subarray(offset, offset + metadataBytes));
          metadataBytesRemaining -= metadataBytes;
          offset += metadataBytes;

          if (metadataBytesRemaining === 0) {
            const raw = Buffer.concat(metadataChunks).toString('utf8').replace(/\0+$/, '');
            const title = raw.match(/StreamTitle=['"]([^'"]*)['"]/i)?.[1]?.trim();
            finish(null, title ? { title } : null);
            return;
          }
        }
      });
      upstream.on('end', () => finish(null));
      upstream.on('error', (err) => finish(err));
    }).catch((err) => finish(err));
  });
}

// ─────────────────────────────────────────────
// Statik dosyalar
// ─────────────────────────────────────────────
app.use(express.json({ limit: '512kb' }));
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(join(__dirname, 'public')));
app.use('/arkaplan', express.static(join(__dirname, 'arkaplan')));

app.use('/api/admin', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/admin/session', (req, res) => {
  res.json({ enabled: adminIsConfigured(), authenticated: adminSessionIsValid(req) });
});

app.post('/api/admin/login', requireSameOrigin, (req, res) => {
  if (!adminIsConfigured()) {
    return res.status(503).json({ error: 'Admin girişi sunucuda yapılandırılmamış.' });
  }
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempt = adminLoginAttempts.get(key);
  if (attempt && attempt.resetAt > now && attempt.count >= 5) {
    return res.status(429).json({ error: 'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.' });
  }
  if (adminLoginAttempts.size > 1000) {
    for (const [ip, entry] of adminLoginAttempts) {
      if (entry.resetAt <= now) adminLoginAttempts.delete(ip);
    }
  }

  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const usernameValid = safeEqual(username, process.env.ADMIN_USERNAME);
  const passwordValid = safeEqual(password, process.env.ADMIN_PASSWORD);
  const valid = usernameValid && passwordValid;
  if (!valid) {
    const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + 15 * 60 * 1000 };
    current.count++;
    adminLoginAttempts.set(key, current);
    return res.status(401).json({ error: 'Kullanıcı adı veya parola hatalı.' });
  }

  adminLoginAttempts.delete(key);
  const expires = Math.floor(now / 1000) + ADMIN_SESSION_SECONDS;
  const nonce = randomBytes(18).toString('base64url');
  const signature = signAdminSession(expires, nonce);
  setAdminCookie(res, `${expires}.${nonce}.${signature}`, ADMIN_SESSION_SECONDS);
  res.json({ authenticated: true });
});

app.post('/api/admin/logout', requireSameOrigin, (req, res) => {
  setAdminCookie(res, '', 0);
  res.json({ authenticated: false });
});

app.use('/api/admin', requireAdmin, requireSameOrigin);

app.get('/api/admin/data', async (req, res) => {
  try {
    const { data: stations, warning } = await readJSON(join(__dirname, 'config', 'stations.json'));
    if (warning || !Array.isArray(stations)) throw new Error(warning || 'İstasyon dosyası bir dizi olmalı.');
    res.json({ stations, tapes: await readAdminTapes() });
  } catch (error) {
    console.error('[admin] Yapılandırma okunamadı:', error.message);
    res.status(500).json({ error: `Yapılandırma okunamadı: ${error.message}` });
  }
});

app.put('/api/admin/stations', async (req, res) => {
  let stations;
  try {
    stations = validateStations(req.body?.stations);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    await writeJSONAtomic(join(__dirname, 'config', 'stations.json'), stations);
    res.json({ stations });
  } catch (error) {
    console.error('[admin] İstasyonlar kaydedilemedi:', error.message);
    res.status(500).json({ error: `İstasyonlar kaydedilemedi: ${error.message}` });
  }
});

app.post('/api/admin/tapes', async (req, res) => {
  let tape;
  try {
    tape = validateTape(req.body?.tape);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const id = tapeSlug(tape.label);
    const filePath = join(__dirname, 'config', 'tapes', `${id}.json`);
    try {
      await readFile(filePath);
      return res.status(409).json({ error: 'Bu kaset adı zaten kullanılıyor.' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await writeJSONAtomic(filePath, tape);
    res.status(201).json({ tape: { id, ...tape } });
  } catch (error) {
    console.error('[admin] Kaset eklenemedi:', error.message);
    const status = error.code === 'EEXIST' ? 409 : 500;
    res.status(status).json({ error: `Kaset eklenemedi: ${error.message}` });
  }
});

app.put('/api/admin/tapes/:id', async (req, res) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Kaset kimliği geçersiz.' });
  }
  let tape;
  try {
    tape = validateTape(req.body?.tape);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const filePath = join(__dirname, 'config', 'tapes', `${req.params.id}.json`);
    await readFile(filePath);
    await writeJSONAtomic(filePath, tape);
    res.json({ tape: { id: req.params.id, ...tape } });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    console.error('[admin] Kaset kaydedilemedi:', error.message);
    res.status(status).json({ error: `Kaset kaydedilemedi: ${error.message}` });
  }
});

app.delete('/api/admin/tapes/:id', async (req, res) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Kaset kimliği geçersiz.' });
  }
  try {
    await unlink(join(__dirname, 'config', 'tapes', `${req.params.id}.json`));
    res.json({ deleted: true });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    console.error('[admin] Kaset silinemedi:', error.message);
    res.status(status).json({ error: `Kaset silinemedi: ${error.message}` });
  }
});

app.post('/api/admin/check-link', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url || url.length > 2048) return res.status(400).json({ error: 'Kontrol edilecek bağlantı geçersiz.' });
  try {
    const { data: stations, warning } = await readJSON(join(__dirname, 'config', 'stations.json'));
    if (warning || !Array.isArray(stations)) {
      return res.status(500).json({ error: warning || 'İstasyon listesi geçersiz.' });
    }
    let result;
    try {
      result = await probeExternalLink(url);
    } catch (error) {
      result = { healthy: false, message: error.message || 'Bağlantı test edilemedi.' };
    }
    const station = stations.find(item => item.streamUrl === url);
    if (station) {
      stationHealth.set(url, {
        healthy: result.healthy,
        message: result.message,
        statusCode: result.statusCode || null,
        contentType: result.contentType || null,
        checkedAt: new Date().toISOString(),
      });
      await persistStationHealth();
    }
    res.json({ ...result, testedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[station-health] Bağlantı durumu kaydedilemedi:', error.message);
    res.status(500).json({ error: `Bağlantı durumu kaydedilemedi: ${error.message}` });
  }
});

app.post('/api/admin/check-stations', async (req, res) => {
  try {
    if (stationCheckRun) {
      return res.status(409).json({
        error: 'Toplu kontrol zaten çalışıyor.',
        running: true,
        completed: stationCheckRun.completed,
        total: stationCheckRun.total,
      });
    }
    const run = await runStationHealthSweep();
    res.status(202).json({ running: true, completed: run.completed, total: run.total });
  } catch (error) {
    console.error('[station-health] Toplu kontrol başlatılamadı:', error.message);
    res.status(500).json({ error: `Toplu kontrol başlatılamadı: ${error.message}` });
  }
});

app.get('/api/admin/station-health', async (req, res) => {
  const { data: stations, warning } = await readJSON(join(__dirname, 'config', 'stations.json'));
  if (warning || !Array.isArray(stations)) {
    return res.status(500).json({ error: warning || 'İstasyon listesi geçersiz.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    stations: stationHealthPayload(stations),
    running: Boolean(stationCheckRun),
    completed: stationCheckRun?.completed || 0,
    total: stationCheckRun?.total || stations.length,
    startedAt: stationCheckRun?.startedAt || null,
  });
});

app.get('/api/admin/requests', async (req, res) => {
  const filePath = join(__dirname, 'data', 'song-requests.jsonl');
  try {
    const fileInfo = await stat(filePath);
    if (fileInfo.size > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'İstek dosyası 10 MB sınırını aştı; sunucu tarafından incelenmesi gerekiyor.' });
    }
    const raw = await readFile(filePath, 'utf8');
    const requests = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).slice(-500).reverse();
    res.json({ requests });
  } catch (error) {
    if (error.code === 'ENOENT') return res.json({ requests: [] });
    console.error('[admin] Şarkı istekleri okunamadı:', error.message);
    res.status(500).json({ error: `Şarkı istekleri okunamadı: ${error.message}` });
  }
});

// ─────────────────────────────────────────────
// POST /api/song-requests
// İstekleri data/song-requests.jsonl dosyasına ekler.
// ─────────────────────────────────────────────
app.post('/api/song-requests', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Form verileri geçersiz.' });
  }

  const limits = { song: 120, artist: 120, name: 80, note: 500 };
  const request = {};
  for (const [field, maxLength] of Object.entries(limits)) {
    const value = body[field] ?? '';
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'Form alanları metin olmalıdır.' });
    }
    const normalized = value.replace(/\0/g, '').trim();
    if (normalized.length > maxLength) {
      return res.status(400).json({ error: `${field} alanı en fazla ${maxLength} karakter olabilir.` });
    }
    request[field] = normalized;
  }
  if (!request.song) {
    return res.status(400).json({ error: 'Şarkı adı zorunludur.' });
  }

  const record = { ...request, submittedAt: new Date().toISOString() };
  const dataDir = join(__dirname, 'data');
  try {
    await mkdir(dataDir, { recursive: true });
    await appendFile(join(dataDir, 'song-requests.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    return res.status(201).json({ message: 'Şarkı isteğiniz kaydedildi. Teşekkürler!' });
  } catch (err) {
    console.error('[song-requests] İstek kaydedilemedi:', err.message);
    return res.status(500).json({ error: 'İstek şu anda kaydedilemedi. Lütfen daha sonra tekrar deneyin.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/stations
// Frekansı 88–108 MHz dışındaki kayıtları atlar.
// ─────────────────────────────────────────────
app.get('/api/stations', async (req, res) => {
  const filePath = join(__dirname, 'config', 'stations.json');
  const { data, warning } = await readJSON(filePath);
  const arr = Array.isArray(data) ? data : [];
  const valid = [];
  for (const s of arr) {
    if (
      typeof s.frequency !== 'number' ||
      s.frequency < 88 ||
      s.frequency > 108
    ) {
      console.warn(`[stations] Geçersiz kayıt atlandı:`, s);
      continue;
    }
    valid.push(s);
  }

  res.json({ stations: valid, warning: warning || null });
});

app.get('/api/station-status', async (req, res) => {
  const { data: stations, warning } = await readJSON(join(__dirname, 'config', 'stations.json'));
  if (warning || !Array.isArray(stations)) {
    return res.status(500).json({ error: warning || 'İstasyon listesi geçersiz.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ stations: stationHealthPayload(stations), running: Boolean(stationCheckRun) });
});

// ─────────────────────────────────────────────
// GET /api/tracks  (geriye dönük uyumluluk — config/tracks.json)
// ─────────────────────────────────────────────
app.get('/api/tracks', async (req, res) => {
  const filePath = join(__dirname, 'config', 'tracks.json');
  const { data, warning } = await readJSON(filePath);
  const arr = Array.isArray(data) ? data : [];
  res.json({ tracks: arr, warning: warning || null });
});

// ─────────────────────────────────────────────
// GET /api/tapes
// config/tapes/ klasöründeki tüm *.json dosyalarını okur.
// Her dosya bir kaset (playlist) temsil eder.
// Yeni kaset eklemek için klasöre yeni bir JSON dosyası bırakmak yeterlidir.
// Beklenen format: { "label": "...", "category": "...", "color": "#hex", "tracks": [...] }
// ─────────────────────────────────────────────
app.get('/api/tapes', async (req, res) => {
  const tapesDir = join(__dirname, 'config', 'tapes');
  let files = [];
  try {
    const all = await readdir(tapesDir);
    files = all.filter(f => f.endsWith('.json')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[tapes] Klasör okunamadı:', err.message);
    return res.json({ tapes: [], warning: 'config/tapes/ klasörü bulunamadı.' });
  }

  const tapes = [];
  for (const file of files) {
    const { data, warning } = await readJSON(join(tapesDir, file));
    if (warning) {
      console.warn(`[tapes] ${file}: ${warning}`);
      continue;
    }
    // Dizi formatını da destekle (eski tracks.json formatı)
    if (Array.isArray(data)) {
      tapes.push({ id: file.replace('.json',''), label: file.replace('.json',''), category: 'Diğer', color: null, tracks: data });
    } else if (data && Array.isArray(data.tracks)) {
      tapes.push({
        id: file.replace('.json',''),
        label: data.label || file.replace('.json',''),
        category: typeof data.category === 'string' && data.category.trim() ? data.category.trim() : 'Diğer',
        color: data.color || null,
        tracks: data.tracks
      });
    } else {
      console.warn(`[tapes] ${file}: Geçersiz format (tracks dizisi yok).`);
    }
  }

  res.json({ tapes });
});

// ─────────────────────────────────────────────
// GET /api/resolve?url=<encodedUrl>
// PLS/M3U içindeki ilk gerçek stream URL'ini döner.
// Beyaz liste kontrolü: yalnızca stations.json'daki URL'ler.
// Frontend bunu /api/stream çağrısından önce kullanır.
// ─────────────────────────────────────────────
app.get('/api/resolve', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url parametresi gerekli.' });

  // Beyaz liste kontrolü
  const { data: stations } = await readJSON(join(__dirname, 'config', 'stations.json'));
  const allowedUrls = stations.map((s) => s.streamUrl).filter(Boolean);
  if (!allowedUrls.includes(targetUrl)) {
    return res.status(403).json({ error: 'Bu URL beyaz listede değil.' });
  }

  try {
    const resolved = await resolveStreamUrl(targetUrl);
    res.json({ streamUrl: resolved[0], all: resolved });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/now-playing?url=<station stream URL>
// ICY StreamTitle metadata, desteklenmiyorsa null döner.
// ─────────────────────────────────────────────
app.get('/api/now-playing', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url parametresi gerekli.' });

  const { data: stations } = await readJSON(join(__dirname, 'config', 'stations.json'));
  const allowedUrls = Array.isArray(stations) ? stations.map((station) => station.streamUrl).filter(Boolean) : [];
  if (!allowedUrls.includes(targetUrl)) {
    return res.status(403).json({ error: 'Bu URL için radyo bilgisi alınamaz.' });
  }

  try {
    const [streamUrl] = await resolveStreamUrl(targetUrl);
    const metadata = await readIcyMetadata(streamUrl);
    res.json({ metadata });
  } catch (err) {
    console.warn(`[metadata] ${targetUrl} başarısız: ${err.message}`);
    res.status(502).json({ error: 'Radyo bilgisi alınamadı.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/stream?url=<encodedUrl>
// Radyo stream proxy — beyaz liste korumalı.
// PLS/M3U ise önce playlist çözümlenir, ardından gerçek stream proxylenir.
// Redirect'leri takip eder.
// ─────────────────────────────────────────────
app.get('/api/stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url parametresi gerekli.' });

  // Beyaz liste kontrolü
  const { data: stations } = await readJSON(join(__dirname, 'config', 'stations.json'));
  const allowedUrls = stations.map((s) => s.streamUrl).filter(Boolean);
  if (!allowedUrls.includes(targetUrl)) {
    console.warn(`[proxy] İzin verilmeyen URL engellendi: ${targetUrl}`);
    return res.status(403).json({ error: 'Bu URL proxy üzerinden erişime kapalı.' });
  }

  // Playlist çözümleme (PLS/M3U)
  let streamUrls;
  try {
    streamUrls = await resolveStreamUrl(targetUrl);
  } catch (err) {
    return res.status(502).json({ error: 'Playlist çözümlenemedi: ' + err.message });
  }

  // Çözümlenen URL'leri sırayla dene (birincisi başarısız olursa yedek)
  let lastError = null;
  for (const streamUrl of streamUrls) {
    try {
      await proxyStream(streamUrl, res);
      return; // Başarılı
    } catch (err) {
      lastError = err;
      console.warn(`[proxy] ${streamUrl} başarısız: ${err.message}`);
    }
  }

  if (!res.headersSent) {
    res.status(502).json({ error: 'Tüm stream URL\'leri başarısız: ' + (lastError?.message || '') });
  }
});

/**
 * Belirtilen URL'yi proxy olarak istemciye bağlar.
 * 3xx redirect'leri takip eder (en fazla 5 adım).
 */
async function proxyStream(url, res, redirectsLeft = 5) {
  if (redirectsLeft <= 0) throw new Error('Çok fazla yönlendirme.');
  const { url: safeUrl, addresses } = await assertPublicHttpUrl(url);
  console.log(`[proxy] Bağlanıyor: ${safeUrl}`);

  const upstream = await makeStreamRequest(safeUrl.toString(), {}, addresses);

  // 3xx yönlendirme
  if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
    const nextUrl = new URL(upstream.headers.location, safeUrl).toString();
    upstream.resume();
    console.log(`[proxy] Redirect → ${nextUrl}`);
    return proxyStream(nextUrl, res, redirectsLeft - 1);
  }

  if (upstream.statusCode < 200 || upstream.statusCode >= 400) {
    upstream.resume();
    throw new Error(`HTTP ${upstream.statusCode}`);
  }

  // Başarılı bağlantı: başlıkları ayarla ve veriyi aktar
  res.setHeader('Content-Type', upstream.headers['content-type'] || 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  // ICY metadata başlıklarını ilet (bazı player'lar kullanır)
  for (const [key, val] of Object.entries(upstream.headers)) {
    if (key.toLowerCase().startsWith('icy-')) {
      res.setHeader(key, val);
    }
  }

  upstream.pipe(res, { end: true });

  upstream.on('error', (err) => {
    if (res.destroyed && !res.writableFinished) return;
    console.error('[proxy] Upstream akış hatası:', err.message);
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });

  // GET request gövdesi tamamlandığında `req.close` tetiklenebilir;
  // upstream yalnızca istemci yanıtı gerçekten yarıda keserse kapatılmalı.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
}

// ─────────────────────────────────────────────
// Sunucuyu başlat
// ─────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`\n🎙  Karışık Kaset çalışıyor → http://localhost:${PORT}\n`);
  if (!adminIsConfigured()) {
    console.warn('[admin] Admin paneli kapalı: ADMIN_USERNAME, en az 16 karakterli ADMIN_PASSWORD ve en az 32 bayt ADMIN_SESSION_SECRET yapılandırılmalı.');
  }
  console.log('  Yeni istasyon eklemek: config/stations.json dosyasına satır ekle');
  console.log('  Yeni parça eklemek   : config/tracks.json  dosyasına satır ekle\n');
  loadStationHealth()
    .catch(error => console.error('[station-health] Önceki durumlar yüklenemedi:', error.message))
    .finally(() => runStationHealthSweep().catch(error => {
      console.error('[station-health] Otomatik kontrol başlatılamadı:', error.message);
    }));
  const stationCheckTimer = setInterval(() => {
    if (!stationCheckRun) {
      runStationHealthSweep().catch(error => {
        console.error('[station-health] Zamanlanmış kontrol başarısız:', error.message);
      });
    }
  }, STATION_CHECK_INTERVAL_MS);
  stationCheckTimer.unref();
});
