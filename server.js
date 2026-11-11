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
import { appendFile, mkdir, readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

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

// ─────────────────────────────────────────────
// Yardımcı: HTTP/HTTPS GET — Promise tabanlı (metin yanıt)
// Redirect'leri takip eder (en fazla 5 yönlendirme).
// ─────────────────────────────────────────────
function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Çok fazla yönlendirme.'));
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KarisikKaset/1.0)' },
      timeout: 8000,
    }, (res) => {
      // 3xx → redirect takibi
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, redirectsLeft - 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımı.')); });
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
function makeStreamRequest(url, extraHeaders = {}) {
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

    makeStreamRequest(url, { 'Icy-MetaData': '1' }).then((upstream) => {
      response = upstream;
      if (settled) {
        upstream.destroy();
        return;
      }
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        upstream.resume();
        clearTimeout(timeout);
        settled = true;
        readIcyMetadata(upstream.headers.location, redirectsLeft - 1).then(resolve, reject);
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
app.use(express.json({ limit: '8kb' }));
app.use(express.static(join(__dirname, 'public')));
app.use('/arkaplan', express.static(join(__dirname, 'arkaplan')));

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
  console.log(`[proxy] Bağlanıyor: ${url}`);

  const upstream = await makeStreamRequest(url);

  // 3xx yönlendirme
  if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
    upstream.resume();
    console.log(`[proxy] Redirect → ${upstream.headers.location}`);
    return proxyStream(upstream.headers.location, res, redirectsLeft - 1);
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
  console.log('  Yeni istasyon eklemek: config/stations.json dosyasına satır ekle');
  console.log('  Yeni parça eklemek   : config/tracks.json  dosyasına satır ekle\n');
});
