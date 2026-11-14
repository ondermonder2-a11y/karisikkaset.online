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
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── .env dosyasını yükle (harici paket gerekmez) ──────────────────────────────
{
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const raw   = await readFile(join(__dir, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* .env yoksa sessizce geç */ }
}
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { lookup } from 'dns/promises';
import https from 'https';
import http from 'http';
import { isIP } from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

const rateLimitBuckets = new Map();
const MAX_RATE_LIMIT_BUCKETS = 20_000;
let lastRateLimitCleanupAt = 0;

function pruneRateLimitBuckets(now) {
  if (now - lastRateLimitCleanupAt < 60_000) return;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
  lastRateLimitCleanupAt = now;
}

function createRateLimiter(name, windowMs, max) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    let bucket = rateLimitBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (bucket) rateLimitBuckets.delete(key);
      pruneRateLimitBuckets(now);
      if (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        rateLimitBuckets.delete(rateLimitBuckets.keys().next().value);
      }
      bucket = { count: 0, resetAt: now + windowMs };
    }

    bucket.count++;
    rateLimitBuckets.delete(key);
    rateLimitBuckets.set(key, bucket);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Çok fazla istek. Lütfen daha sonra tekrar deneyin.' });
    }
    next();
  };
}

const apiRateLimit = createRateLimiter('api', 15 * 60 * 1000, 15_000);
const heartbeatRateLimit = createRateLimiter('heartbeat', 60 * 1000, 600);
const streamRateLimit = createRateLimiter('stream', 10 * 60 * 1000, 300);
const resolveRateLimit = createRateLimiter('resolve', 10 * 60 * 1000, 300);
const nowPlayingRateLimit = createRateLimiter('now-playing', 10 * 60 * 1000, 900);
const listenersRateLimit = createRateLimiter('listeners', 60 * 1000, 120);
const radioSearchRateLimit = createRateLimiter('radio-search', 15 * 60 * 1000, 60);
const scraperStatusRateLimit = createRateLimiter('scraper-status', 60 * 1000, 10);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use('/api', apiRateLimit);
// Gövde ayrıştırıcı tüm rotalardan önce kayıtlı olmalı (heartbeat dahil).
app.use(express.json({ limit: '512kb' }));
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
const STATION_CHECK_CONCURRENCY = 4;
const DNS_LOOKUP_TIMEOUT_CODE = 'DNS_LOOKUP_TIMEOUT';
const PLAYLIST_TOO_LARGE_CODE = 'PLAYLIST_TOO_LARGE';
const customCassetteRateLimits = new Map();
const CUSTOM_CASSETTE_DATA_PATH = join(__dirname, 'data', 'custom-cassettes.json');
const CUSTOM_CASSETTE_SECRET_PATH = join(__dirname, 'data', 'custom-cassette-secret');
const TAPE_ORDER_DATA_PATH = join(__dirname, 'data', 'tape-order.json');
const TAPE_BACKUP_DIR = join(__dirname, 'data', 'backups', 'tapes');
const TAPE_BACKUP_LIMIT = 30;
const SITE_CODE_DATA_PATH = join(__dirname, 'data', 'site-code.json');
const MAX_SITE_CODE_LENGTH = 32 * 1024;
const CUSTOM_CASSETTE_MAX_TRACKS = 20;
const CUSTOM_CASSETTE_MAX_PER_EMAIL = 12;
const SONG_REQUESTS_PATH = join(__dirname, 'data', 'song-requests.jsonl');
let songRequestWriteChain = Promise.resolve();
let customCassetteSecretPromise = null;
let customCassetteWriteChain = Promise.resolve();

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
  const content = `${JSON.stringify(data, null, 2)}\n`;
  // Docker Windows volume mount'ta rename() EBUSY/EPERM verebilir.
  // Güvenli yol: doğrudan writeFile (overwrite).
  await writeFile(filePath, content, { encoding: 'utf8' });
}

async function readSiteCode() {
  let raw;
  try {
    raw = await readFile(SITE_CODE_DATA_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { adsense: '', tracker: '' };
    throw error;
  }
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Site kodu yapılandırma dosyası geçersiz.');
  }
  return {
    adsense: typeof data.adsense === 'string' ? data.adsense : '',
    tracker: typeof data.tracker === 'string' ? data.tracker : '',
  };
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
  let addresses;
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    addresses = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error('Alan adı çözümleme zaman aşımına uğradı.');
        error.code = DNS_LOOKUP_TIMEOUT_CODE;
        reject(error);
      }, 5000);
      lookup(hostname, { all: true, verbatim: true }).then(
        result => { clearTimeout(timeout); resolve(result); },
        error => { clearTimeout(timeout); reject(error); }
      );
    });
  }
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
  if (!Array.isArray(value.tracks)) throw new Error('Parça listesi geçersiz.');
  // 300'den fazla parça varsa sessizce kes — hata verme
  const rawTracks = value.tracks.slice(0, 300);
  const tracks = rawTracks.map((track, index) => {
    const title = typeof track?.title === 'string' ? track.title.trim() : '';
    const subtitle = typeof track?.subtitle === 'string' ? track.subtitle.trim() : '';
    const soundcloudUrl = typeof track?.soundcloudUrl === 'string' ? track.soundcloudUrl.trim() : '';
    // artworkUrl: opsiyonel, boş olabilir, sadece https:// ile başlamalı
    const artworkUrl = typeof track?.artworkUrl === 'string' ? track.artworkUrl.trim() : '';
    if (!title || title.length > 160 || subtitle.length > 120 || !soundcloudUrl || soundcloudUrl.length > 2048) {
      throw new Error(`${index + 1}. parçanın bilgileri geçersiz.`);
    }
    let url;
    try { url = new URL(soundcloudUrl); } catch { throw new Error(`${index + 1}. parçanın bağlantısı geçersiz.`); }
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (hostname !== 'soundcloud.com' && !hostname.endsWith('.soundcloud.com'))) {
      throw new Error(`${index + 1}. parça HTTPS SoundCloud bağlantısı olmalı.`);
    }
    // artworkUrl doğrulama: boşsa atla, varsa https kontrolü
    const safeArtwork = artworkUrl && artworkUrl.startsWith('https://') ? artworkUrl : '';
    return { title, subtitle, soundcloudUrl, ...(safeArtwork ? { artworkUrl: safeArtwork } : {}) };
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
  return applyTapeOrder(tapes, await readTapeOrder());
}

async function createTapeBackup(reason = 'manual') {
  const tapesDir = join(__dirname, 'config', 'tapes');
  await mkdir(TAPE_BACKUP_DIR, { recursive: true });
  const files = [];
  for (const file of (await readdir(tapesDir)).filter(name => name.endsWith('.json')).sort()) {
    const raw = await readFile(join(tapesDir, file), 'utf8');
    files.push({ file, data: JSON.parse(raw) });
  }
  const createdAt = new Date().toISOString();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backup = { version: 1, id, createdAt, reason, order: await readTapeOrder(), files };
  await writeJSONAtomic(join(TAPE_BACKUP_DIR, `${id}.json`), backup);

  const old = (await readdir(TAPE_BACKUP_DIR)).filter(file => file.endsWith('.json')).sort().reverse();
  await Promise.all(old.slice(TAPE_BACKUP_LIMIT).map(file => unlink(join(TAPE_BACKUP_DIR, file))));
  return { id, createdAt, reason, tapeCount: files.length };
}

async function readTapeBackup(id) {
  if (!/^[0-9]{13}-[a-z0-9]{6}$/.test(id)) throw new Error('Yedek kimliği geçersiz.');
  const { data, warning } = await readJSON(join(TAPE_BACKUP_DIR, `${id}.json`));
  if (warning || !data || data.version !== 1 || !Array.isArray(data.files)) {
    throw new Error(warning || 'Kaset yedeği geçersiz.');
  }
  if (data.files.some(item => !/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(item.file))) {
    throw new Error('Kaset yedeğinde geçersiz dosya adı var.');
  }
  return data;
}

async function readTapeOrder() {
  const { data, warning } = await readJSON(TAPE_ORDER_DATA_PATH);
  if (warning === 'Dosya bulunamadı.') return [];
  if (warning) throw new Error(`Kaset sırası okunamadı: ${warning}`);
  if (
    !Array.isArray(data) ||
    data.some(id => typeof id !== 'string' || !id || id.length > 128) ||
    new Set(data).size !== data.length
  ) {
    throw new Error('Kaset sırası dosyası geçersiz.');
  }
  return data;
}

function applyTapeOrder(tapes, order) {
  const remaining = new Map(tapes.map(tape => [tape.id, tape]));
  const ordered = [];
  for (const id of order) {
    const tape = remaining.get(id);
    if (!tape) continue;
    ordered.push(tape);
    remaining.delete(id);
  }
  return [...ordered, ...tapes.filter(tape => remaining.has(tape.id))];
}

function consumeCustomCassetteRateLimit(req, action) {
  const key = `${action}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  const now = Date.now();
  const windowMs = action === 'create' ? 60 * 60 * 1000 : 15 * 60 * 1000;
  const limit = action === 'create' ? 8 : 30;
  const previous = customCassetteRateLimits.get(key);
  if (customCassetteRateLimits.size > 1000) {
    for (const [entryKey, entry] of customCassetteRateLimits) {
      if (entry.resetAt <= now) customCassetteRateLimits.delete(entryKey);
    }
  }
  if (previous && previous.resetAt > now && previous.count >= limit) return false;
  const current = previous && previous.resetAt > now
    ? previous
    : { count: 0, resetAt: now + windowMs };
  current.count++;
  customCassetteRateLimits.set(key, current);
  return true;
}

function normalizeCustomCassetteEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().normalize('NFKC').toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email)) return '';
  return email;
}

async function getCustomCassetteSecret() {
  if (!customCassetteSecretPromise) {
    customCassetteSecretPromise = (async () => {
      await mkdir(dirname(CUSTOM_CASSETTE_SECRET_PATH), { recursive: true });
      try {
        const secret = await readFile(CUSTOM_CASSETTE_SECRET_PATH);
        if (secret.length !== 32) throw new Error('Kişisel kaset anahtarı geçersiz.');
        return secret;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const secret = randomBytes(32);
        try {
          await writeFile(CUSTOM_CASSETTE_SECRET_PATH, secret, { flag: 'wx', mode: 0o600 });
          return secret;
        } catch (writeError) {
          if (writeError.code !== 'EEXIST') throw writeError;
          const existing = await readFile(CUSTOM_CASSETTE_SECRET_PATH);
          if (existing.length !== 32) throw new Error('Kişisel kaset anahtarı geçersiz.');
          return existing;
        }
      }
    })();
  }
  return customCassetteSecretPromise;
}

async function hashCustomCassetteEmail(email) {
  const secret = await getCustomCassetteSecret();
  return createHmac('sha256', secret).update(email).digest('hex');
}

async function readCustomCassetteRecords() {
  const { data, warning } = await readJSON(CUSTOM_CASSETTE_DATA_PATH);
  if (warning && warning !== 'Dosya bulunamadı.') {
    throw new Error('Kişisel kaset verisi okunamadı.');
  }
  if (!data) return [];
  if (!Array.isArray(data.cassettes)) throw new Error('Kişisel kaset verisi geçersiz.');
  return data.cassettes;
}

function updateCustomCassetteRecords(update) {
  const operation = customCassetteWriteChain.then(async () => {
    const records = await readCustomCassetteRecords();
    const result = await update(records);
    await writeJSONAtomic(CUSTOM_CASSETTE_DATA_PATH, { version: 1, cassettes: records });
    return result;
  });
  customCassetteWriteChain = operation.catch(() => {});
  return operation;
}

function publicCustomCassette(record) {
  return {
    id: record.id,
    label: record.label,
    category: 'Kişisel kaset',
    color: record.color,
    tracks: record.tracks,
    isCustom: true,
    createdAt: record.createdAt,
  };
}

async function normalizeCustomRadioTracks(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('Radyo istasyonu listesi geçersiz.');
  const seen = new Set();
  const usedFrequencies = new Set();
  const tracks = [];
  for (const station of value) {
    const streamUrl = typeof station?.streamUrl === 'string' ? station.streamUrl.trim() : '';
    if (!streamUrl || seen.has(streamUrl)) throw new Error('Radyo istasyonlarında boş veya yinelenen kayıt var.');
    await assertPublicHttpUrl(streamUrl);
    seen.add(streamUrl);
    let frequencyKey = Math.round(Number(station?.frequency) * 10);
    if (!Number.isInteger(frequencyKey) || frequencyKey < 880 || frequencyKey > 1080 || usedFrequencies.has(frequencyKey)) {
      frequencyKey = 880;
      while (usedFrequencies.has(frequencyKey) && frequencyKey <= 1080) frequencyKey++;
    }
    if (frequencyKey > 1080) throw new Error('Kişisel kasette kullanılabilecek frekans aralığı dolu.');
    usedFrequencies.add(frequencyKey);
    tracks.push({
      type: 'radio',
      title: typeof station?.name === 'string' && station.name.trim() ? station.name.trim().slice(0, 120) : 'İsimsiz radyo',
      subtitle: typeof station?.genre === 'string' ? station.genre.trim().slice(0, 80) : '',
      streamUrl,
      frequency: frequencyKey / 10,
    });
  }
  return tracks;
}

async function probeStation(station) {
  const streamUrls = await resolveStreamUrl(station.streamUrl, { allowOversizedFallback: false });
  let lastResult = null;
  let inconclusiveResult = null;
  for (const streamUrl of streamUrls.slice(0, 5)) {
    try {
      lastResult = await probeExternalLink(streamUrl);
      if (lastResult.healthy) return lastResult;
    } catch (error) {
      const failure = connectionFailure(error);
      if (failure.healthy === null) inconclusiveResult = failure;
      else lastResult = failure;
    }
  }
  return inconclusiveResult || lastResult || { healthy: false, message: 'Çalışan bir yayın adresi bulunamadı.' };
}

function connectionFailure(error) {
  if (error?.code === DNS_LOOKUP_TIMEOUT_CODE) {
    return { healthy: null, message: 'Sunucuda DNS yanıtı zamanında alınamadı; bu sonuç yayının kapalı olduğunu doğrulamaz.' };
  }
  if (error?.code === PLAYLIST_TOO_LARGE_CODE) {
    return { healthy: null, message: 'Playlist 1 MB sınırını aştı; yayın durumu doğrulanamadı.' };
  }
  return { healthy: false, message: error.message || 'Bağlantı test edilemedi.' };
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
    if (typeof url === 'string' && result && (typeof result.healthy === 'boolean' || result.healthy === null)) {
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
        result = connectionFailure(error);
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
        const error = new Error('Playlist dosyası 1 MB sınırını aştı.');
        error.code = PLAYLIST_TOO_LARGE_CODE;
        response.destroy();
        reject(error);
      }
    });
    response.on('end', () => resolve({ text: body, url: url.toString() }));
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
function parseM3U(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(entry => new URL(entry, baseUrl).toString());
}

// ─────────────────────────────────────────────
// Verilen URL bir playlist mi? → Gerçek stream URL'lerini döner.
// Playlist değilse URL'nin kendisini dizi içinde döner.
// ─────────────────────────────────────────────
async function resolveStreamUrl(url, { allowOversizedFallback = true } = {}) {
  const lower = url.toLowerCase().split('?')[0];

  // Uzantıya göre karar ver
  const isPls  = lower.endsWith('.pls');
  const isM3u  = lower.endsWith('.m3u') || lower.endsWith('.m3u8');

  if (!isPls && !isM3u) return [url]; // Zaten doğrudan stream URL'si

  try {
    const playlist = await fetchText(url);
    const entries = isPls ? parsePLS(playlist.text) : parseM3U(playlist.text, playlist.url);
    const urls = isPls
      ? entries.map(entry => new URL(entry, playlist.url).toString())
      : entries;
    if (urls.length === 0) throw new Error('Playlist boş veya ayrıştırılamadı.');
    console.log(`[resolve] ${url} → ${urls.length} giriş bulundu`);
    return urls;
  } catch (err) {
    if (err?.code === PLAYLIST_TOO_LARGE_CODE && !allowOversizedFallback) throw err;
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
// Dinleyici heartbeat sistemi
// Her oynatıcı 15 sn'de bir POST /api/heartbeat gönderir.
// 20 sn içinde heartbeat gelmezse dinleyici düşer.
// sessionId: istemci tarafında rastgele üretilen UUID.
// ─────────────────────────────────────────────
const listeners = new Map(); // sessionId → { lastSeen, firstSeen, mode, label }
const LISTENER_TTL_MS = 75_000;
const LISTENER_HEARTBEAT_MS = 20_000;
const MAX_LISTENERS = 5_000;
const LISTENER_SESSION_ID_PATTERN = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|kk-[a-z0-9]{1,16}-[a-z0-9]{1,8})$/i;

function pruneListeners() {
  const now = Date.now();
  for (const [id, info] of listeners) {
    if (now - info.lastSeen > LISTENER_TTL_MS) listeners.delete(id);
  }
}

app.post('/api/heartbeat', heartbeatRateLimit, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  const mode = req.body?.mode;
  const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 120) : '';
  if (!LISTENER_SESSION_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: 'sessionId biçimi geçersiz.' });
  }
  if (mode !== 'radio' && mode !== 'tape') {
    return res.status(400).json({ error: 'Dinleme modu geçersiz.' });
  }
  const now = Date.now();
  pruneListeners();
  const previous = listeners.get(id);
  if (!previous && listeners.size >= MAX_LISTENERS) {
    return res.status(503).json({ error: 'Dinleyici kapasitesi dolu. Daha sonra tekrar deneyin.' });
  }
  listeners.set(id, {
    lastSeen: now,
    firstSeen: previous?.firstSeen || now,
    mode,
    label,
  });
  res.json({ ok: true, intervalMs: LISTENER_HEARTBEAT_MS });
});

app.delete('/api/heartbeat', heartbeatRateLimit, (req, res) => {
  const id = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  if (id && !LISTENER_SESSION_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: 'sessionId biçimi geçersiz.' });
  }
  if (id) listeners.delete(id);
  pruneListeners();
  res.json({ ok: true });
});

app.get('/api/listeners', listenersRateLimit, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  pruneListeners();
  let radio = 0;
  let tape = 0;
  for (const listener of listeners.values()) {
    if (listener.mode === 'radio') radio++;
    else tape++;
  }
  res.json({ count: radio + tape, radio, tape, updatedAt: new Date().toISOString() });
});

app.get('/api/admin/listeners', requireAdmin, requireSameOrigin, listenersRateLimit, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  pruneListeners();
  const now = Date.now();
  const list = [...listeners.values()].map(({ mode, label, firstSeen }) => ({
    mode,
    label,
    seconds: Math.max(0, Math.round((now - firstSeen) / 1000)),
  }));
  res.json({
    count: list.length,
    radio: list.filter(item => item.mode === 'radio').length,
    tape: list.filter(item => item.mode === 'tape').length,
    listeners: list,
    updatedAt: new Date(now).toISOString(),
  });
});

// ─────────────────────────────────────────────
// Statik dosyalar
// ─────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});
app.get(['/', '/index.html'], async (req, res) => {
  try {
    const [html, siteCode] = await Promise.all([
      readFile(join(__dirname, 'public', 'index.html'), 'utf8'),
      readSiteCode(),
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      html
        .replace('<!-- ADSENSE_HEAD_CODE -->', siteCode.adsense)
        .replace('<!-- TRACKER_BODY_CODE -->', siteCode.tracker)
    );
  } catch (error) {
    console.error('[site-code] Ana sayfa oluşturulamadı:', error.message);
    res.status(500).send('Ana sayfa yüklenemedi.');
  }
});
app.use(express.static(join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(?:png|jpe?g|webp|avif|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    }
  },
}));
app.use('/arkaplan', express.static(join(__dirname, 'arkaplan'), {
  maxAge: '30d',
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(?:png|jpe?g|webp|avif)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    }
  },
}));

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

// ─────────────────────────────────────────────
// GET /api/admin/search-radio?q=<name>&country=TR&limit=20
// radio-browser.info API'sinden istasyon arar.
// Admin oturumu gerektirir. Sonuçları stations.json formatına normalize eder.
// ─────────────────────────────────────────────
app.get('/api/admin/search-radio', radioSearchRateLimit, async (req, res) => {
  const q       = typeof req.query.q       === 'string' ? req.query.q.trim()       : '';
  const country = typeof req.query.country === 'string' ? req.query.country.trim() : '';
  const tag     = typeof req.query.tag     === 'string' ? req.query.tag.trim()     : '';
  const limit   = Math.min(parseInt(req.query.limit || '30', 10), 100);

  // En az bir arama kriteri zorunlu
  if (!q && !country && !tag) {
    return res.status(400).json({ error: 'Arama için en az bir kriter (q, country veya tag) gerekli.' });
  }

  const params = new URLSearchParams({
    hidebroken: 'true',
    order:      'votes',
    reverse:    'true',
    limit:      String(limit),
  });
  if (q)       params.set('name', q);
  if (country) params.set('countrycode', country.toUpperCase());
  if (tag)     params.set('tag', tag);

  // radio-browser.info — birden fazla sunucu var, ilkini dene
  const RADIO_API = 'https://de1.api.radio-browser.info/json/stations/search';

  try {
    const response = await new Promise((resolve, reject) => {
      const url  = new URL(`${RADIO_API}?${params}`);
      const req2 = https.request(
        { hostname: url.hostname, port: 443,
          path: url.pathname + url.search, method: 'GET',
          headers: { 'User-Agent': 'KarisikKaset/1.0 (admin-search)' },
          timeout: 10000 },
        resolve
      );
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('API zaman aşımı.')); });
      req2.end();
    });

    if (response.statusCode !== 200) {
      response.resume();
      return res.status(502).json({ error: `radio-browser.info HTTP ${response.statusCode}` });
    }

    const body = await new Promise((resolve, reject) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) { response.destroy(); reject(new Error('Yanıt çok büyük.')); } });
      response.on('end', () => resolve(data));
      response.on('error', reject);
    });

    const raw = JSON.parse(body);

    // stations.json formatına normalize et + HTTPS tercih
    const stations = raw
      .filter(s => s.url_resolved)
      .map(s => ({
        name:      s.name?.trim() || 'İsimsiz',
        genre:     s.tags?.split(',')[0]?.trim() || s.country || 'Diğer',
        streamUrl: s.url_resolved,
        // Frekans bilgisi yok — 0 ile işaretle (kullanıcı doldurur)
        frequency: null,
        // Ek meta (sadece arama sonuçlarında, kaydedilmez)
        _meta: {
          codec:     s.codec || '',
          bitrate:   s.bitrate || 0,
          country:   s.country || '',
          votes:     s.votes || 0,
          isHttps:   s.url_resolved.startsWith('https'),
          favicon:   s.favicon || '',
          homepage:  s.homepage || '',
        }
      }));

    res.json({ stations, total: stations.length });
  } catch (err) {
    console.error('[search-radio] Hata:', err.message);
    res.status(502).json({ error: `Radyo arama başarısız: ${err.message}` });
  }
});

// ─────────────────────────────────────────────
// GET /api/admin/scraper-status (admin oturumu gerektirir)
// Python sc_scraper.py'nin 5001 portunda çalışıp çalışmadığını kontrol eder.
// Hassas veri dönmez, sadece {ok: true/false}.
// ─────────────────────────────────────────────
app.get('/api/admin/scraper-status', scraperStatusRateLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const host = process.env.SCRAPER_HOST || '127.0.0.1';
  const port = parseInt(process.env.SCRAPER_PORT || '5001', 10);
  try {
    await new Promise((resolve, reject) => {
      const req2 = http.request(
        { hostname: host, port, path: '/scrape', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
          timeout: 2000 },
        (r) => { r.resume(); resolve(); }
      );
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
      req2.write('{}');
      req2.end();
    });
    res.json({ ok: true, host, port });
  } catch {
    res.json({ ok: false, host, port });
  }
});

app.get('/api/admin/site-code', async (req, res) => {
  try {
    res.json(await readSiteCode());
  } catch (error) {
    console.error('[admin] Site kodları okunamadı:', error.message);
    res.status(500).json({ error: `Site kodları okunamadı: ${error.message}` });
  }
});

app.put('/api/admin/site-code', async (req, res) => {
  const { adsense, tracker } = req.body || {};
  if (
    typeof adsense !== 'string' || typeof tracker !== 'string' ||
    adsense.length > MAX_SITE_CODE_LENGTH || tracker.length > MAX_SITE_CODE_LENGTH
  ) {
    return res.status(400).json({ error: 'Kod alanları geçersiz veya 32 KB sınırını aşıyor.' });
  }
  const siteCode = { adsense, tracker };
  try {
    await writeJSONAtomic(SITE_CODE_DATA_PATH, siteCode);
    res.json(siteCode);
  } catch (error) {
    console.error('[admin] Site kodları kaydedilemedi:', error.message);
    res.status(500).json({ error: `Site kodları kaydedilemedi: ${error.message}` });
  }
});

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

app.get('/api/admin/tapes/backups', async (req, res) => {
  try {
    await mkdir(TAPE_BACKUP_DIR, { recursive: true });
    const backups = [];
    for (const file of (await readdir(TAPE_BACKUP_DIR)).filter(name => name.endsWith('.json')).sort().reverse()) {
      try {
        const info = await stat(join(TAPE_BACKUP_DIR, file));
        const id = file.replace(/\.json$/i, '');
        const { data } = await readJSON(join(TAPE_BACKUP_DIR, file));
        backups.push({ id, createdAt: data?.createdAt || info.mtime.toISOString(), reason: data?.reason || 'backup', tapeCount: data?.files?.length || 0 });
      } catch { /* Bozuk tek bir yedek listeyi durdurmasın. */ }
    }
    res.json({ backups });
  } catch (error) {
    res.status(500).json({ error: `Kaset yedekleri okunamadı: ${error.message}` });
  }
});

app.post('/api/admin/tapes/backups', async (req, res) => {
  try {
    const backup = await createTapeBackup('manual');
    const data = await readTapeBackup(backup.id);
    res.status(201).json({ backup, data });
  } catch (error) {
    console.error('[admin] Kaset yedeği oluşturulamadı:', error.message);
    res.status(500).json({ error: `Kaset yedeği oluşturulamadı: ${error.message}` });
  }
});

app.get('/api/admin/tapes/backups/:id/download', async (req, res) => {
  try {
    const data = await readTapeBackup(req.params.id);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="karisik-kaset-yedek-${data.id}.json"`);
    res.json(data);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/api/admin/tapes/backups/:id/restore', async (req, res) => {
  try {
    const backup = await readTapeBackup(req.params.id);
    await createTapeBackup('before-restore');
    const tapesDir = join(__dirname, 'config', 'tapes');
    const wanted = new Set(backup.files.map(item => item.file));
    for (const file of (await readdir(tapesDir)).filter(name => name.endsWith('.json'))) {
      if (!wanted.has(file)) await unlink(join(tapesDir, file));
    }
    for (const item of backup.files) {
      const parsed = Array.isArray(item.data)
        ? { label: item.file.replace(/\.json$/i, ''), category: 'Diğer', color: '#1a237e', tracks: item.data }
        : item.data;
      const valid = validateTape({ ...parsed, category: parsed.category || 'Diğer' });
      await writeJSONAtomic(join(tapesDir, item.file), valid);
    }
    if (Array.isArray(backup.order)) {
      await writeJSONAtomic(TAPE_ORDER_DATA_PATH, backup.order);
    }
    res.json({ restored: true, tapeCount: backup.files.length, createdAt: backup.createdAt });
  } catch (error) {
    console.error('[admin] Kaset yedeği geri yüklenemedi:', error.message);
    res.status(400).json({ error: `Kaset yedeği geri yüklenemedi: ${error.message}` });
  }
});

app.put('/api/admin/tape-order', async (req, res) => {
  const { order } = req.body || {};
  if (
    !Array.isArray(order) ||
    order.length > 500 ||
    order.some(id => typeof id !== 'string' || !id || id.length > 128) ||
    new Set(order).size !== order.length
  ) {
    return res.status(400).json({ error: 'Kaset sırası geçersiz.' });
  }

  try {
    const tapes = await readAdminTapes();
    const currentIds = new Set(tapes.map(tape => tape.id));
    if (order.length !== currentIds.size || order.some(id => !currentIds.has(id))) {
      return res.status(409).json({ error: 'Kaset listesi değişti. Listeyi yenileyip tekrar deneyin.' });
    }

    await createTapeBackup('before-order-change');
    await mkdir(dirname(TAPE_ORDER_DATA_PATH), { recursive: true });
    await writeJSONAtomic(TAPE_ORDER_DATA_PATH, order);
    res.json({ tapes: await readAdminTapes() });
  } catch (error) {
    console.error('[admin] Kaset sırası kaydedilemedi:', error.message);
    res.status(500).json({ error: `Kaset sırası kaydedilemedi: ${error.message}` });
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
    await createTapeBackup('before-create');
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
    await createTapeBackup('before-update');
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
    await createTapeBackup('before-delete');
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
      result = connectionFailure(error);
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

function getSongRequestId(line, index, record) {
  if (typeof record.id === 'string' && /^[a-f0-9]{24}$/.test(record.id)) return record.id;
  return createHash('sha256').update(`${index}\u0000${line}`).digest('hex').slice(0, 24);
}

async function readSongRequestEntries() {
  let raw;
  try {
    const fileInfo = await stat(SONG_REQUESTS_PATH);
    if (fileInfo.size > 10 * 1024 * 1024) {
      const error = new Error('İstek dosyası 10 MB sınırını aştı.');
      error.statusCode = 413;
      throw error;
    }
    raw = await readFile(SONG_REQUESTS_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    const record = JSON.parse(line);
    return { line, record, id: getSongRequestId(line, index, record) };
  });
}

function enqueueSongRequestWrite(operation) {
  const next = songRequestWriteChain.then(operation);
  songRequestWriteChain = next.catch(() => {});
  return next;
}

app.get('/api/admin/requests', async (req, res) => {
  try {
    const entries = await readSongRequestEntries();
    const requests = entries.slice(-500).reverse().map(({ record, id }) => ({ ...record, id }));
    res.json({ requests });
  } catch (error) {
    console.error('[admin] Şarkı istekleri okunamadı:', error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode === 413
      ? error.message
      : 'Şarkı istekleri okunamadı.' });
  }
});

app.delete('/api/admin/requests/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{24}$/.test(id)) {
    return res.status(400).json({ error: 'İstek kimliği geçersiz.' });
  }

  try {
    const deleted = await enqueueSongRequestWrite(async () => {
      const entries = await readSongRequestEntries();
      const remaining = entries.filter(entry => entry.id !== id);
      if (remaining.length === entries.length) return false;
      await mkdir(dirname(SONG_REQUESTS_PATH), { recursive: true });
      const content = remaining.length ? `${remaining.map(entry => entry.line).join('\n')}\n` : '';
      await writeFile(SONG_REQUESTS_PATH, content, 'utf8');
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Şarkı isteği bulunamadı.' });
    res.json({ deleted: true, id });
  } catch (error) {
    console.error('[admin] Şarkı isteği silinemedi:', error.message);
    res.status(error.statusCode || 500).json({ error: 'Şarkı isteği silinemedi.' });
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

  const record = { id: randomBytes(12).toString('hex'), ...request, submittedAt: new Date().toISOString() };
  try {
    await enqueueSongRequestWrite(async () => {
      await mkdir(dirname(SONG_REQUESTS_PATH), { recursive: true });
      await appendFile(SONG_REQUESTS_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    });
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

  try {
    res.json({ tapes: applyTapeOrder(tapes, await readTapeOrder()) });
  } catch (error) {
    console.error('[tapes] Kaset sırası okunamadı:', error.message);
    res.status(500).json({ error: 'Kaset sırası okunamadı.' });
  }
});

app.post('/api/custom-cassettes/lookup', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!consumeCustomCassetteRateLimit(req, 'lookup')) {
    return res.status(429).json({ error: 'Çok fazla arama yapıldı. Bir süre sonra tekrar deneyin.' });
  }
  const email = normalizeCustomCassetteEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });

  try {
    const emailHash = await hashCustomCassetteEmail(email);
    const records = await readCustomCassetteRecords();
    const cassettes = records
      .filter(record => typeof record.emailHash === 'string' && safeEqual(record.emailHash, emailHash))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(publicCustomCassette);
    res.json({ cassettes });
  } catch (error) {
    console.error('[custom-cassettes] Lookup failed:', error.message);
    res.status(500).json({ error: 'Kasetler şu anda getirilemedi. Lütfen daha sonra tekrar deneyin.' });
  }
});

app.post('/api/custom-cassettes', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!consumeCustomCassetteRateLimit(req, 'create')) {
    return res.status(429).json({ error: 'Çok sık kaset oluşturuldu. Bir süre sonra tekrar deneyin.' });
  }

  const email = normalizeCustomCassetteEmail(req.body?.email);
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const color = typeof req.body?.color === 'string' ? req.body.color.trim() : '';
  const requestedUrls = Array.isArray(req.body?.trackUrls) ? req.body.trackUrls : [];
  const requestedStations = req.body?.radioStations;
  if (!email) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
  if (!label || label.length > 48) return res.status(400).json({ error: 'Kaset adı 1–48 karakter olmalı.' });
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'Kaset rengi geçersiz.' });
  const requestedCount = requestedUrls.length + (Array.isArray(requestedStations) ? requestedStations.length : 0);
  if (requestedCount < 1 || requestedCount > CUSTOM_CASSETTE_MAX_TRACKS) {
    return res.status(400).json({ error: `1–${CUSTOM_CASSETTE_MAX_TRACKS} arası parça seçin.` });
  }

  const trackUrls = requestedUrls.map(url => typeof url === 'string' ? url.trim() : '');
  if (trackUrls.some(url => !url) || new Set(trackUrls).size !== trackUrls.length) {
    return res.status(400).json({ error: 'Parça listesinde boş veya yinelenen kayıt var.' });
  }

  try {
    const catalog = await readAdminTapes();
    const allowedTracks = new Map(catalog.flatMap(tape => tape.tracks.map(track => [track.soundcloudUrl, track])));
    const tracks = trackUrls.map(url => allowedTracks.get(url));
    if (tracks.some(track => !track)) {
      return res.status(400).json({ error: 'Seçilen parçalardan biri artık katalogda bulunmuyor. Listeyi yenileyip tekrar deneyin.' });
    }
    const radioTracks = await normalizeCustomRadioTracks(requestedStations);

    const emailHash = await hashCustomCassetteEmail(email);
    const record = {
      id: `visitor-${randomBytes(12).toString('hex')}`,
      emailHash,
      label,
      color,
      tracks: [...tracks, ...radioTracks],
      createdAt: new Date().toISOString(),
    };
    const tape = await updateCustomCassetteRecords(records => {
      if (records.length >= 5000) {
        const error = new Error('Kişisel kaset alanı şu anda dolu.');
        error.statusCode = 503;
        throw error;
      }
      const ownedCount = records.filter(item => typeof item.emailHash === 'string' && safeEqual(item.emailHash, emailHash)).length;
      if (ownedCount >= CUSTOM_CASSETTE_MAX_PER_EMAIL) {
        const error = new Error(`Bir e-posta adresi en fazla ${CUSTOM_CASSETTE_MAX_PER_EMAIL} kaset saklayabilir.`);
        error.statusCode = 409;
        throw error;
      }
      records.push(record);
      return publicCustomCassette(record);
    });
    res.status(201).json({ tape, message: 'Kaset oluşturuldu ve rafa eklendi.' });
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) {
      console.error('[custom-cassettes] Save failed:', error.message);
    }
    res.status(error.statusCode || 500).json({
      error: error.statusCode && error.statusCode < 500
        ? error.message
        : 'Kaset kaydedilemedi. Lütfen daha sonra tekrar deneyin.',
    });
  }
});

app.put('/api/custom-cassettes/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!consumeCustomCassetteRateLimit(req, 'update')) {
    return res.status(429).json({ error: 'Çok sık düzenleme yapıldı. Bir süre sonra tekrar deneyin.' });
  }
  const id = req.params.id;
  const email = normalizeCustomCassetteEmail(req.body?.email);
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const color = typeof req.body?.color === 'string' ? req.body.color.trim() : '';
  const requestedUrls = Array.isArray(req.body?.trackUrls) ? req.body.trackUrls : [];
  const requestedStations = req.body?.radioStations;
  if (!/^visitor-[a-f0-9]{24}$/.test(id)) return res.status(400).json({ error: 'Kaset kimliği geçersiz.' });
  if (!email) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
  if (!label || label.length > 48) return res.status(400).json({ error: 'Kaset adı 1–48 karakter olmalı.' });
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'Kaset rengi geçersiz.' });
  const requestedCount = requestedUrls.length + (Array.isArray(requestedStations) ? requestedStations.length : 0);
  if (requestedCount < 1 || requestedCount > CUSTOM_CASSETTE_MAX_TRACKS) {
    return res.status(400).json({ error: `1–${CUSTOM_CASSETTE_MAX_TRACKS} arası parça seçin.` });
  }
  const trackUrls = requestedUrls.map(url => typeof url === 'string' ? url.trim() : '');
  if (trackUrls.some(url => !url) || new Set(trackUrls).size !== trackUrls.length) {
    return res.status(400).json({ error: 'Parça listesinde boş veya yinelenen kayıt var.' });
  }

  try {
    const emailHash = await hashCustomCassetteEmail(email);
    const catalog = await readAdminTapes();
    const catalogTracks = new Map(catalog.flatMap(tape => tape.tracks.map(track => [track.soundcloudUrl, track])));
    const updatedTape = await updateCustomCassetteRecords(async records => {
      const record = records.find(item => item.id === id && typeof item.emailHash === 'string' && safeEqual(item.emailHash, emailHash));
      if (!record) {
        const error = new Error('Kaset bulunamadı. E-posta adresini kontrol edin.');
        error.statusCode = 404;
        throw error;
      }
      const allowedTracks = new Map(catalogTracks);
      (record.tracks || []).forEach(track => {
        if (track?.soundcloudUrl && !allowedTracks.has(track.soundcloudUrl)) allowedTracks.set(track.soundcloudUrl, track);
      });
      const tracks = trackUrls.map(url => allowedTracks.get(url));
      if (tracks.some(track => !track)) {
        const error = new Error('Seçilen parçalardan biri artık kullanılabilir değil. Listeyi yenileyip tekrar deneyin.');
        error.statusCode = 400;
        throw error;
      }
      const radioTracks = await normalizeCustomRadioTracks(requestedStations);
      record.label = label;
      record.color = color;
      record.tracks = [...tracks, ...radioTracks];
      record.updatedAt = new Date().toISOString();
      return publicCustomCassette(record);
    });
    res.json({ tape: updatedTape, message: 'Kaset güncellendi.' });
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) {
      console.error('[custom-cassettes] Update failed:', error.message);
    }
    res.status(error.statusCode || 500).json({
      error: error.statusCode && error.statusCode < 500
        ? error.message
        : 'Kaset güncellenemedi. Lütfen daha sonra tekrar deneyin.',
    });
  }
});

app.delete('/api/custom-cassettes/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!consumeCustomCassetteRateLimit(req, 'delete')) {
    return res.status(429).json({ error: 'Çok fazla silme isteği yapıldı. Bir süre sonra tekrar deneyin.' });
  }
  const id = req.params.id;
  const email = normalizeCustomCassetteEmail(req.body?.email);
  if (!/^visitor-[a-f0-9]{24}$/.test(id)) return res.status(400).json({ error: 'Kaset kimliği geçersiz.' });
  if (!email) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });

  try {
    const emailHash = await hashCustomCassetteEmail(email);
    await updateCustomCassetteRecords(records => {
      const index = records.findIndex(record => record.id === id && typeof record.emailHash === 'string' && safeEqual(record.emailHash, emailHash));
      if (index < 0) {
        const error = new Error('Kaset bulunamadı. E-posta adresini kontrol edin.');
        error.statusCode = 404;
        throw error;
      }
      records.splice(index, 1);
    });
    res.json({ deleted: true, message: 'Kaset silindi.' });
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) {
      console.error('[custom-cassettes] Delete failed:', error.message);
    }
    res.status(error.statusCode || 500).json({
      error: error.statusCode && error.statusCode < 500
        ? error.message
        : 'Kaset silinemedi. Lütfen daha sonra tekrar deneyin.',
    });
  }
});

// ─────────────────────────────────────────────
// GET /api/resolve?url=<encodedUrl>
// PLS/M3U içindeki ilk gerçek stream URL'ini döner.
// Beyaz liste kontrolü: yalnızca stations.json'daki URL'ler.
// Frontend bunu /api/stream çağrısından önce kullanır.
// ─────────────────────────────────────────────
app.get('/api/resolve', resolveRateLimit, async (req, res) => {
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
app.get('/api/now-playing', nowPlayingRateLimit, async (req, res) => {
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
app.get('/api/stream', streamRateLimit, async (req, res) => {
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
// POST /api/admin/validate-tape/:id
// Kasetteki tüm SoundCloud URL'lerini HEAD isteğiyle kontrol eder.
// Erişilemeyen parçaları (404, private, bölge kısıtlaması) listeler.
// Opsiyonel: { autoClean: true } ile dead link'leri otomatik siler.
// ─────────────────────────────────────────────
app.post('/api/admin/validate-tape/:id', async (req, res) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Kaset kimliği geçersiz.' });
  }
  const autoClean = req.body?.autoClean === true;
  const filePath = join(__dirname, 'config', 'tapes', `${req.params.id}.json`);

  const { data, warning } = await readJSON(filePath);
  if (warning || !data?.tracks?.length) {
    return res.status(404).json({ error: warning || 'Kaset veya parça listesi bulunamadı.' });
  }

  const tracks = data.tracks;
  const results = [];
  const CONCURRENCY = 5; // Aynı anda 5 istek
  const DELAY_MS    = 150; // İstekler arası bekleme

  // Batch'ler halinde kontrol et
  for (let i = 0; i < tracks.length; i += CONCURRENCY) {
    const batch = tracks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (track, batchIdx) => {
      const idx = i + batchIdx;
      try {
        const url  = new URL(track.soundcloudUrl);
        const proto = url.protocol === 'https:' ? https : http;
        const statusCode = await new Promise((resolve, reject) => {
          const req2 = proto.request(
            { hostname: url.hostname, port: url.port || 443,
              path: url.pathname, method: 'HEAD',
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; KarisikKaset/1.0)',
                'Accept': 'text/html',
              },
              timeout: 8000 },
            (r) => { r.resume(); resolve(r.statusCode); }
          );
          req2.on('error', reject);
          req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
          req2.end();
        });

        // 301/302 redirect → SoundCloud'un kendi sitesine yönlendiriyor = parça var
        // 404 = silinmiş, 403 = private/bölge kısıtlaması
        const ok = statusCode < 400 || statusCode === 301 || statusCode === 302;
        return { idx, title: track.title, url: track.soundcloudUrl, statusCode, ok };
      } catch (err) {
        return { idx, title: track.title, url: track.soundcloudUrl, statusCode: null, ok: false, error: err.message };
      }
    }));
    results.push(...batchResults);
    if (i + CONCURRENCY < tracks.length) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const dead    = results.filter(r => !r.ok);
  const alive   = results.filter(r => r.ok);

  // autoClean: ölü linkleri dosyadan kaldır
  if (autoClean && dead.length > 0) {
    await createTapeBackup('before-auto-clean');
    const deadIndices = new Set(dead.map(r => r.idx));
    const cleanedTracks = tracks.filter((_, i) => !deadIndices.has(i));
    const cleanedTape   = { ...data, tracks: cleanedTracks };
    try {
      let validTape;
      try { validTape = validateTape(cleanedTape); } catch { validTape = cleanedTape; }
      await writeJSONAtomic(filePath, validTape);
      console.log(`[validate] "${req.params.id}": ${dead.length} ölü link silindi, ${cleanedTracks.length} parça kaldı.`);
    } catch (err) {
      return res.status(500).json({ error: `Temizlenmiş kaset kaydedilemedi: ${err.message}` });
    }
  }

  res.json({
    total:   tracks.length,
    alive:   alive.length,
    dead:    dead.length,
    cleaned: autoClean && dead.length > 0,
    deadTracks: dead.map(r => ({ idx: r.idx, title: r.title, url: r.url, statusCode: r.statusCode, error: r.error })),
  });
});

// ─────────────────────────────────────────────
// POST /api/admin/import-playlist
// SoundCloud playlist URL'sinden parçaları çeker ve yeni kaset olarak kaydeder.
//
// Body: { url: "https://soundcloud.com/.../sets/...", label: "Kaset Adı", category: "Pop", color: "#1a237e" }
//
// Scraping işini Python microservice (sc_scraper.py, port 5001) üstlenir.
// Önce ona POST /scrape atar; microservice kapalıysa kullanıcıya açık mesaj verir.
// ─────────────────────────────────────────────
app.post('/api/admin/import-playlist', async (req, res) => {
  const rawUrl  = typeof req.body?.url      === 'string' ? req.body.url.trim()      : '';
  const label   = typeof req.body?.label    === 'string' ? req.body.label.trim()    : '';
  const category= typeof req.body?.category === 'string' ? req.body.category.trim() : 'İçe Aktarılan';
  const color   = /^#[0-9a-f]{6}$/i.test(req.body?.color || '') ? req.body.color : '#1a237e';

  if (!rawUrl) return res.status(400).json({ error: 'url gerekli.' });
  if (!label)  return res.status(400).json({ error: 'label gerekli.' });

  // Yalnızca soundcloud.com'a izin ver
  try {
    const scUrl = new URL(rawUrl);
    if (!['soundcloud.com','www.soundcloud.com'].includes(scUrl.hostname.toLowerCase())) {
      return res.status(400).json({ error: 'Yalnızca soundcloud.com adresleri desteklenir.' });
    }
  } catch {
    return res.status(400).json({ error: 'Geçersiz URL.' });
  }

  // Python microservice'e (sc_scraper.py) istek at
  let scraped;
  try {
    scraped = await callScraper(rawUrl);
  } catch (err) {
    console.error('[import] Scraper hatası:', err.message);
    // Kullanıcıya anlaşılır mesaj ver
    if (err.message.includes('ECONNREFUSED')) {
      return res.status(503).json({
        error: 'Scraper servisi çalışmıyor. Lütfen yeni bir terminal açın ve şunu çalıştırın:\n\n  python sc_scraper.py\n\nSonra tekrar deneyin.',
      });
    }
    return res.status(502).json({ error: `Scraper hatası: ${err.message}` });
  }

  if (!scraped.tracks?.length) {
    return res.status(422).json({
      error: 'Sayfada parça bulunamadı. Yalnızca herkese açık (public) playlist\'ler desteklenir.',
    });
  }

  // label verilmediyse playlist başlığını kullan
  const finalLabel = label || scraped.title || 'İçe Aktarılan';

  // Kaset nesnesini doğrula ve kaydet
  const totalFound = scraped.tracks.length;
  // 300 limitini uygula
  if (scraped.tracks.length > 300) scraped.tracks = scraped.tracks.slice(0, 300);

  const tape = { label: finalLabel, category, color, tracks: scraped.tracks };
  let validTape;
  try {
    validTape = validateTape(tape);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = tapeSlug(finalLabel);
  const filePath = join(__dirname, 'config', 'tapes', `${id}.json`);

  try {
    await createTapeBackup('before-import');
    await writeJSONAtomic(filePath, validTape);
  } catch (err) {
    console.error('[import] Kaset kaydedilemedi:', err.message);
    return res.status(500).json({ error: `Kaset kaydedilemedi: ${err.message}` });
  }

  console.log(`[import] "${finalLabel}" kaseti oluşturuldu: ${scraped.tracks.length} parça (toplam bulunan: ${totalFound})`);
  res.status(201).json({
    tape: { id, ...validTape },
    imported: scraped.tracks.length,
    totalFound,
    truncated: totalFound > 300,
  });
});

/**
 * Python sc_scraper.py microservice'ine POST /scrape atar.
 * - Docker ortamında: SCRAPER_HOST=scraper, SCRAPER_PORT=5001 (env'den)
 * - Yerel geliştirmede: 127.0.0.1:5001 (varsayılan)
 */
function callScraper(url) {
  const host = process.env.SCRAPER_HOST || '127.0.0.1';
  const port = parseInt(process.env.SCRAPER_PORT || '5001', 10);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ url });
    const options = {
      hostname: host,
      port,
      path: '/scrape',
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 90000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.error || `Scraper HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error('Scraper geçersiz JSON döndürdü.'));
        }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Scraper zaman aşımı (90 sn).')); });
    req.write(body);
    req.end();
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
    .catch(error => console.error('[station-health] Önceki durumlar yüklenemedi:', error.message));
});
