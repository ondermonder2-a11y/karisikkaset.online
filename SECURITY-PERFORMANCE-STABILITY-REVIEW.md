# Karışık Kaset — Güvenlik, Performans ve Stabilite Denetimi

**İncelenen bileşenler:** `server.js`, `sc_scraper.py`, `Dockerfile`, `Dockerfile.scraper`, `docker-compose.yml`, `package.json`, `.dockerignore`, `public/app.js`, `public/admin.js`

**Denetim türü:** Statik kod incelemesi ve güvenli yapılandırma incelemesi. Canlı sunucuya veya production verisine dokunulmadı.

**Özet sonuç (denetim anındaki durum):** SSRF savunmasının temelinde iyi kontroller var; admin oturumu için HMAC imzalı cookie kullanılmış; Node container'ı non-root çalışıyor. Denetim anında iki admin route'u auth middleware'inden önce tanımlıydı, genel güvenlik başlıkları/rate limiting eksikti ve listener Map'i sınırsız büyüyebiliyordu. Öncelik sırası aşağıdadır.

**Uygulama durumu:** SEC-01 düzeltildi; korumalı admin middleware'i search-radio ve scraper-status rotalarından önce çalışıyor. SEC-02 kısmen düzeltildi: temel güvenlik başlıkları, API ve maliyetli uçlar için sınırlı bellek kullanan rate limit'ler eklendi, stream proxy'deki wildcard CORS kaldırıldı. Inline site-code/ad/tracker desteği nedeniyle CSP eklenmedi; Helmet ve CSP ayrıca değerlendirilmelidir. SEC-04/05 için heartbeat kimlik ve mod doğrulaması, listener kapasite sınırı ve public listener özetinden yayın adları/sürelerinin çıkarılması uygulandı; ayrıntılı liste yalnızca `/api/admin/listeners` üzerinden sunulur. Diğer bulgular bu değişiklik kapsamında ele alınmadı.

---

## 1. Öncelikli bulgular

| ID | Seviye | Bulgu | Etkilenen yer | Önerilen öncelik |
|---|---|---|---|---|
| SEC-01 | **Kritik** | İki `/api/admin/*` endpoint'i `requireAdmin` middleware'inden önce tanımlı | `server.js` yaklaşık 958–1066 | Hemen |
| SEC-02 | **Yüksek** | Global rate limiting, Helmet ve güvenlik başlıkları yok | `server.js` | Hemen |
| SEC-03 | **Yüksek** | Scraper tek thread, `Content-Length`/body limiti ve sağlam URL/redirect politikası yok | `sc_scraper.py` | Hemen |
| SEC-04 | **Yüksek** | Listener heartbeat Map'i sınırsız; sahte session ID ile bellek tüketimi mümkün | `server.js` yaklaşık 823–874 | Hemen |
| SEC-05 | **Yüksek** | `/api/listeners` herkese yayın adı ve dinleme süresi döndürüyor | `server.js` yaklaşık 858–874 | Kısa vadede |
| SEC-06 | **Orta** | `site-code` admin girdisi HTML olarak ana sayfaya ham ekleniyor; stored XSS etkisi yüksek | `server.js` yaklaşık 883–894, 1079–1095 | Tasarım kararıyla |
| SEC-07 | **Orta** | Oturum logout sonrası server-side revoke edilmiyor; çalınan token expiry'ye kadar geçerli | `server.js` yaklaşık 66–95, 940–950 | Kısa vadede |
| PERF-01 | **Orta** | Config/tape dosyaları her istekte diskten okunuyor | `server.js` yaklaşık 133–153, 1383–1423 | Orta vadede |
| STAB-01 | **Orta** | Healthcheck yok; Compose sadece `restart: unless-stopped` içeriyor | `docker-compose.yml` | Hemen |
| STAB-02 | **Orta** | Global uncaught/unhandled olayları ve merkezi Express error handler yok | `server.js` başlangıç/son | Hemen |
| DOCKER-01 | **Orta** | Scraper root çalışıyor; read-only root filesystem/capability hardening yok | `Dockerfile.scraper`, Compose | Hemen |
| DOCKER-02 | **Düşük/Orta** | `requests==2.31.0` eski bir pin; image supply-chain doğrulaması yok | `Dockerfile.scraper` | Planlı |

---

# 2. Güvenlik kontrolleri

## SEC-01 — Admin route'larında auth bypass

`server.js` içinde şu middleware yaklaşık 1068. satırda devreye giriyor:

```js
app.use('/api/admin', requireAdmin, requireSameOrigin);
```

Ancak `/api/admin/search-radio` ve `/api/admin/scraper-status` bu satırdan önce tanımlanmış. Express ilk eşleşen route'u çalıştırdığı için bu iki endpoint admin oturumu olmadan çağrılabilir.

Etkiler:

- `search-radio`: dış API'ye yetkisiz arama istekleri yaptırılarak kaynak tüketimi oluşturulabilir.
- `scraper-status`: aslında status endpoint'i olmasına rağmen scraper'a POST `/scrape` başlatıyor; bu pahalı SoundCloud ağ işlemlerini auth olmadan tetikliyor.

### Önerilen düzeltme

`/api/admin/session`, login ve logout route'larından sonra; korumalı admin route'larından önce middleware'i taşıyın:

```js
app.get('/api/admin/session', (req, res) => {
  res.json({ enabled: adminIsConfigured(), authenticated: adminSessionIsValid(req) });
});

app.post('/api/admin/login', requireSameOrigin, loginHandler);
app.post('/api/admin/logout', requireSameOrigin, logoutHandler);

// Bu satır search-radio, scraper-status ve aşağıdaki tüm admin route'larından
// ÖNCE gelmelidir.
app.use('/api/admin', requireAdmin, requireSameOrigin);

app.get('/api/admin/search-radio', searchRadioHandler);
app.get('/api/admin/scraper-status', scraperStatusHandler);
```

Mevcut dosyada fonksiyonlar inline tanımlı olduğu için pratik değişiklik: mevcut `app.use('/api/admin', requireAdmin, requireSameOrigin);` satırını 1068. satırdan alıp logout route'undan hemen sonraya koyun. Daha aşağıdaki duplicate middleware satırını silin.

## SEC-02 — Security headers, CORS ve rate limit

### Mevcut durum

- `helmet` yok.
- Genel API rate limit yok.
- Login için basit process-local Map var; çoklu replica'da ortak değil.
- `/api/stream`, `/api/resolve`, `/api/now-playing`, `/api/heartbeat` ve public JSON endpoint'leri sınırsız.
- Stream proxy'de `Access-Control-Allow-Origin: *` var. Bu player için işlevsel olabilir, ancak tüm proxy yanıtlarını tüm origin'lere açıyor.

### Önerilen Node paketleri

```bash
npm install helmet express-rate-limit
```

### Middleware örneği

```js
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false, // Inline SVG/script mimarisi temizlenince açın.
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Çok fazla istek. Lütfen kısa süre sonra tekrar deneyin.' },
});

const expensiveApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Bu işlem için istek sınırına ulaşıldı.' },
});

app.use('/api/', publicApiLimiter);
app.use(['/api/stream', '/api/resolve', '/api/now-playing'], expensiveApiLimiter);
```

Reverse proxy kullanıldığı için `trust proxy` ayarı gerçek Nginx Proxy Manager subnet'iyle sınırlandırılmalıdır. `loopback, linklocal, uniquelocal` Docker ortamında beklenen client IP'sini vermeyebilir:

```js
// .env: TRUST_PROXY=172.18.0.0/16 gibi gerçek proxy subnet'i
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
```

CORS için genel `*` yerine player'ın gerçek origin'ini allowlist edin. Eğer browser stream proxy'si gerçekten cross-origin kullanılmıyorsa `Access-Control-Allow-Origin` header'ını tamamen kaldırın.

## SEC-03 — SSRF incelemesi

### İyi taraflar

`assertPublicHttpUrl()`:

- Sadece HTTP/HTTPS kabul ediyor.
- URL kullanıcı adı/parolasını reddediyor.
- localhost, `.local`, `.internal` gibi host adlarını reddediyor.
- DNS çözümleyip özel/reserved IP aralıklarını engelliyor.
- Redirect'lerde `proxyStream()` tekrar `assertPublicHttpUrl()` çağırıyor.
- Stream/resolve endpoint'leri başlangıçta `stations.json` allowlist'i kullanıyor.

Bu savunma, doğrudan SSRF riskini önemli ölçüde düşürüyor.

### Eksikler ve öneriler

- `validateStations()` yalnızca protocol/userinfo kontrolü yapıyor; `assertPublicHttpUrl()` ile aynı DNS/IP politikasını kullanmıyor. Admin zaten yetkili olsa da tek doğrulama fonksiyonu kullanmak daha güvenli.
- `probeExternalLink()` ve `readIcyMetadata()` her redirect'te güvenli URL kontrolü yapıyor; bu korunmalı.
- `/api/admin/validate-tape/:id` içinde SoundCloud URL'si için protocol/hostname tekrar doğrulanmıyor. Dosya admin tarafından yazılsa bile savunma katmanı eklenmeli.

Ortak URL doğrulama helper'ı:

```js
function assertSoundCloudUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (host !== 'soundcloud.com' && !host.endsWith('.soundcloud.com'))
  ) {
    throw new Error('Yalnızca HTTPS SoundCloud URL kabul edilir.');
  }
  return url;
}
```

## SEC-04 — Listener Map bellek tüketimi

Şu anda herhangi bir istemci 64 karaktere kadar sınırsız sayıda farklı `sessionId` göndererek `listeners` Map'ini büyütebilir. TTL yalnızca eski kayıtları siler; yoğun sahte heartbeat akışında Map büyümesi mümkün.

### Güvenli örnek

```js
const MAX_LISTENERS = 10_000;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const LISTENER_MODES = new Set(['radio', 'tape']);

function pruneListeners() {
  const now = Date.now();
  for (const [id, info] of listeners) {
    if (now - info.lastSeen > LISTENER_TTL_MS) listeners.delete(id);
  }
}

app.post('/api/heartbeat', (req, res) => {
  pruneListeners();
  const id = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  const mode = typeof req.body?.mode === 'string' ? req.body.mode : '';
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 120) : '';

  if (!SESSION_ID_RE.test(id) || !LISTENER_MODES.has(mode)) {
    return res.status(400).json({ error: 'Heartbeat verisi geçersiz.' });
  }
  if (!listeners.has(id) && listeners.size >= MAX_LISTENERS) {
    return res.status(503).json({ error: 'Canlı dinleyici kapasitesi dolu.' });
  }

  const now = Date.now();
  const previous = listeners.get(id);
  listeners.set(id, { lastSeen: now, firstSeen: previous?.firstSeen || now, mode, label });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});
```

Ek olarak heartbeat endpoint'ine IP/session rate limit uygulayın. Public endpoint'te ayrıntılı yayın etiketi ve süre döndürmek yerine ziyaretçilere yalnızca özet verin:

```js
app.get('/api/listeners', (req, res) => {
  pruneListeners();
  let radio = 0;
  let tape = 0;
  for (const item of listeners.values()) item.mode === 'radio' ? radio++ : tape++;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ count: radio + tape, radio, tape });
});
```

Ayrıntılı `listeners` listesini yalnızca `requireAdmin` arkasındaki ayrı endpoint'ten döndürün. Böylece dinlenen parça adları ve süreleri public metadata olmaktan çıkar.

## SEC-05 — Stored XSS / site-code tasarımı

`/api/admin/site-code` `adsense` ve `tracker` alanlarını ham HTML olarak kaydediyor; ana sayfa bunları `.replace()` ile doğrudan HTML'ye koyuyor. Bu özellik reklam/analytics script'i eklemek için kasıtlı olabilir, ancak admin hesabı ele geçirilirse kalıcı XSS etkisi doğurur.

Öneriler:

1. En güvenlisi: raw HTML yerine yalnızca provider ID/config saklayın ve server template'ı kendisi oluştursun.
2. Raw snippet zorunluysa sadece trusted admin kullanımını dokümante edin, içerik boyutunu daha da düşürün ve CSP'yi nonce/hash tabanlı tasarlayın.
3. Kullanıcı girdilerini `site-code` alanına asla koymayın.
4. Admin hesabı için MFA destekleyen reverse proxy veya SSO katmanı ekleyin.

## SEC-06 — CSRF ve session

`SameSite=Strict` iyi bir temel. `requireSameOrigin()` Origin header'ı yoksa isteği reddediyor; fakat allowlist doğrudan gelen `Host` header'ına göre oluşturuluyor. Host header'ı güvenilir bir deployment allowlist'iyle sınırlandırılmalıdır:

```js
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://karisikkaset.online')
    .split(',').map(value => value.trim()).filter(Boolean)
);

function requireSameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'İstek kaynağı doğrulanamadı.' });
  }
  next();
}
```

Oturum token'ı stateless olduğu için logout server-side revoke yapmıyor. Saldırgan cookie'yi ele geçirirse 8 saat kullanabilir. Daha güçlü model:

- Redis/database session store,
- session ID + server-side record,
- logout'ta record silme,
- kısa access session (ör. 30 dakika) + kontrollü refresh.

---

# 3. Scraper güvenlik ve performans incelemesi

## Mevcut riskler

### Tek thread

`HTTPServer` tek iş parçacıklıdır. Bir SoundCloud isteği 20–90 saniye beklerken ikinci istekler bekleyebilir. Bu hem admin deneyimini hem de health/status çağrılarını etkileyebilir.

### Request body limiti yok

`Content-Length` doğrudan `int()` ile parse ediliyor. Eksik, negatif veya çok büyük değerler güvenli şekilde yönetilmiyor. Body için örneğin 16 KB sınırı uygulanmalı.

### Redirect politikası gevşek

`requests.Session.get()` varsayılan olarak redirect takip ediyor. İlk URL host kontrolünden geçse bile redirect hedefi ayrıca SoundCloud allowlist'iyle doğrulanmıyor. SSRF savunması için redirect'leri kapatıp yalnızca beklenen host'a izin verin.

### CORS

Scraper'ın `Access-Control-Allow-Origin: http://localhost:3000` header'ı production domain'iyle uyumlu değil ve bu servis browser'dan çağrılmamalı. Node → scraper iç ağ çağrısı için CORS gerekmez; kaldırılabilir.

## Güvenli scraper handler örneği

```python
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MAX_BODY = 16 * 1024
ALLOWED_HOSTS = {"soundcloud.com", "www.soundcloud.com"}


def validate_soundcloud_url(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in ALLOWED_HOSTS:
        raise ValueError("Yalnızca HTTPS soundcloud.com URL kabul edilir.")
    if parsed.username or parsed.password:
        raise ValueError("URL kullanıcı bilgisi içeremez.")
    return value


class Handler(BaseHTTPRequestHandler):
    server_version = "KarisikKasetScraper/1.0"

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "Bulunamadı."})

    def do_POST(self):
        if self.path != "/scrape":
            self._send_json(404, {"error": "Sadece POST /scrape desteklenir."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Content-Length geçersiz."})
            return
        if length <= 0 or length > MAX_BODY:
            self._send_json(413, {"error": "İstek gövdesi çok büyük veya boş."})
            return

        try:
            body = json.loads(self.rfile.read(length))
            url = validate_soundcloud_url(str(body.get("url", "")).strip())
        except (json.JSONDecodeError, ValueError) as error:
            self._send_json(400, {"error": str(error)})
            return

        try:
            result = scrape_playlist(url)
            self._send_json(200, result)
        except requests.HTTPError:
            self._send_json(502, {"error": "SoundCloud HTTP hatası."})
        except requests.RequestException:
            self._send_json(502, {"error": "SoundCloud bağlantı hatası."})
        except ValueError as error:
            self._send_json(422, {"error": str(error)})
        except Exception:
            print("[scraper] Beklenmedik hata", flush=True)
            self._send_json(500, {"error": "Scraper dahili hatası."})


# Main içinde:
server = ThreadingHTTPServer((args.host, args.port), Handler)
server.daemon_threads = True
```

`fetch_hydration()` ve `get_client_id()` içindeki `SESSION.get()` çağrıları için de `allow_redirects=False` ile kontrollü redirect helper kullanılması önerilir. Redirect response'undaki `Location` hedefi `validate_soundcloud_url()` veya `a-v2.sndcdn.com` allowlist'iyle kontrol edilmeden takip edilmemelidir.

Ağ yanıtları için boyut sınırı da ekleyin:

```python
MAX_HTML_BYTES = 8 * 1024 * 1024

r = SESSION.get(url, timeout=25, allow_redirects=False, stream=True)
r.raise_for_status()
chunks = []
total = 0
for chunk in r.iter_content(64 * 1024):
    total += len(chunk)
    if total > MAX_HTML_BYTES:
        raise ValueError("SoundCloud yanıtı çok büyük.")
    chunks.append(chunk)
html = b"".join(chunks).decode(r.encoding or "utf-8", errors="replace")
```

---

# 4. Performans denetimi

## PERF-01 — Diskten tekrar tekrar JSON okuma

`/api/stations`, `/api/tapes`, `/api/admin/data` ve ana sayfa route'u her istekte disk okuyor. Küçük projede kabul edilebilir; ancak trafik arttığında gereksiz I/O ve JSON parse maliyeti yaratır.

Önerilen model:

- `stations.json` ve tape katalogları için kısa TTL cache (ör. 5–15 saniye),
- admin write sonrası cache invalidation,
- health verisi için ayrı cache,
- dosya değişikliklerini watcher yerine kontrollü invalidate ile yönetme.

Basit TTL cache:

```js
const jsonCache = new Map();
const JSON_CACHE_TTL_MS = 10_000;

async function readCachedJSON(filePath) {
  const now = Date.now();
  const cached = jsonCache.get(filePath);
  if (cached && cached.expiresAt > now) return cached.data;
  const result = await readJSON(filePath);
  jsonCache.set(filePath, { data: result, expiresAt: now + JSON_CACHE_TTL_MS });
  return result;
}

function invalidateJSONCache(filePath) {
  jsonCache.delete(filePath);
}
```

`writeJSONAtomic()` sonrası ilgili path için `invalidateJSONCache(filePath)` çağırın.

## PERF-02 — Stream proxy kaynak sınırı

`proxyStream()` her istemci için uzun ömürlü upstream bağlantısı açıyor. Global concurrent stream limiti ve IP başına limit yok.

Öneriler:

- IP başına eşzamanlı stream sayısı (ör. 3),
- toplam upstream bağlantı limiti,
- limit doluyken 429/503 dönme,
- disconnect olduğunda upstream destroy (mevcut kod bunu büyük ölçüde yapıyor),
- access log'da URL'nin tamamını değil host + station ID'yi loglama.

## PERF-03 — Admin tape validation

`validate-tape` 5 eşzamanlı HEAD isteği gönderiyor. Bu kontrollü; ancak tape dosyasındaki track sayısı 300 ile sınırlanmalı ve SoundCloud host doğrulaması yapılmalı. HTTP status ve response body okunmuyor, bu iyi.

## PERF-04 — Public static caching

HTML ve API response'ları no-store; hashed olmayan `app.js`/CSS dosyaları için uzun cache yok. Reverse proxy üzerinde aşağıdaki ayrım önerilir:

- HTML: `no-cache` veya kısa TTL,
- JS/CSS/SVG: içerik hash'lenene kadar 1–5 dakika,
- `/api/*`: no-store,
- ses stream: no-cache.

Dosya adlarına versiyon query eklenmiş olması iyi bir başlangıç; daha güvenlisi build-time content hash'tir.

---

# 5. Stabilite ve hata yönetimi

## STAB-01 — Merkezi error handler ve process olayları

Şu anda `process.on('uncaughtException')`, `unhandledRejection` ve Express error middleware yok. Express async route'larında try/catch çoğunlukla var; ancak unutulan bir Promise rejection process davranışını belirsiz bırakabilir.

Önerilen temel yapı:

```js
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
  // Uygulama durumuna göre kontrollü kapanış veya alert.
});

process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught exception:', error);
  // Güvenli kapanış: orchestrator restart eder.
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 10_000).unref();
});

app.use((error, req, res, next) => {
  console.error('[http] Unhandled route error:', error);
  if (res.headersSent) return next(error);
  res.status(error.statusCode || 500).json({ error: 'Beklenmeyen sunucu hatası.' });
});
```

`uncaughtException` sonrasında aynı process'i çalışır tutmaya çalışmayın; state bozulmuş olabilir. Docker restart policy yeniden başlatmalıdır.

## STAB-02 — Health endpoint

Node'a liveness/readiness endpoint'i ekleyin:

```js
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});
```

`/healthz` disk, scraper veya dış internet testi yapmamalı; sadece process canlılığını ölçmeli. Daha ağır kontroller için ayrı `/readyz` endpoint'i kullanın.

---

# 6. Docker ve Compose hardening

## Mevcut durum

- Node `Dockerfile` içinde `USER node` kullanıyor: iyi.
- Scraper `Dockerfile.scraper` içinde `USER` yok ve root çalışıyor: düzeltilmeli.
- `restart: unless-stopped` var: iyi.
- Healthcheck yok.
- `read_only`, `cap_drop`, `no-new-privileges`, `tmpfs` yok.
- `depends_on` sadece container start sırasına bakıyor; scraper hazır olmadan app başlayabilir.
- Bind mount'lar admin write işlemleri nedeniyle tamamen read-only yapılamıyor; salt-okunur config/data ayrımı ayrıca tasarlanmalı.

## Güvenli Dockerfile.scraper örneği

```dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system --gid 10001 app \
    && adduser --system --uid 10001 --ingroup app app \
    && pip install --no-cache-dir --disable-pip-version-check requests==2.32.4

COPY --chown=app:app sc_scraper.py ./

USER app
EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/healthz', timeout=3)"

CMD ["python", "sc_scraper.py", "--host", "0.0.0.0", "--port", "5001"]
```

`requests` sürümünü güncellemeden önce `pip-audit` veya şirketinizin dependency scanner'ı ile doğrulayın; sürüm pin'lerini periyodik olarak yenileyin.

## Node Dockerfile iyileştirmesi

```dockerfile
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node config ./config
COPY --chown=node:node arkaplan ./arkaplan

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
```

## Compose hardening örneği

Aşağıdaki örnek, mevcut external `web_proxy` ağını korur:

```yaml
services:
  scraper:
    build:
      context: .
      dockerfile: Dockerfile.scraper
    container_name: karisik-scraper
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs:
      - /tmp:noexec,nosuid,size=32m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    expose:
      - "5001"
    networks:
      - web_proxy

  app:
    build: .
    container_name: karisik-kaset
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    depends_on:
      scraper:
        condition: service_healthy
    ports:
      - "3005:3000"
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: 3000
      SCRAPER_HOST: scraper
      SCRAPER_PORT: 5001
      ALLOWED_ORIGINS: https://karisikkaset.online
    volumes:
      - ./data:/app/data
      - ./config/stations.json:/app/config/stations.json
      - ./config/tracks.json:/app/config/tracks.json
      - ./config/tapes:/app/config/tapes
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3
    networks:
      - web_proxy

networks:
  web_proxy:
    external: true
```

### Read-only volume uyarısı

`/api/admin/stations`, tape create/update/delete, site-code ve data kayıtları yazma yapıyor. Bu nedenle config/data bind mount'larını `:ro` yaparsanız admin yazma özellikleri bozulur. Daha güvenli mimari:

- public katalogları image içine read-only koymak,
- admin yazılabilir verileri tek bir named volume veya ayrı data store'a almak,
- upload/import işini ayrı worker'a taşımak.

Bu mimari değişmeden `read_only: true` root filesystem uygulanabilir; ancak bind mount sahiplik/izinlerini production'da mutlaka test edin.

---

# 7. Loglama ve gözlemlenebilirlik

Mevcut `console.log/error` yaklaşımı başlangıç için yeterli, fakat production için:

- JSON structured log kullanın (`timestamp`, `requestId`, `route`, `status`, `durationMs`),
- kullanıcı e-postası, session token, admin parolası ve tam dış URL query'sini loglamayın,
- stream URL query'si hassas/uzun olabilir; host veya station ID loglayın,
- Docker log rotation ayarlayın,
- 5xx, 429, scraper timeout ve stream failure metriklerini izleyin,
- Uptime Kuma'ya `https://karisikkaset.online/healthz` monitor ekleyin.

Basit request ID middleware:

```js
import { randomUUID } from 'crypto';

app.use((req, res, next) => {
  const requestId = req.get('x-request-id') || randomUUID();
  res.setHeader('x-request-id', requestId);
  const started = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      event: 'http_request',
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
    }));
  });
  next();
});
```

## Log injection notu

Dış URL, station name veya SoundCloud başlığını doğrudan loglamak satır kırılması/terminal log injection oluşturabilir. Log mesajlarını JSON.stringify ile yazın veya kontrol karakterlerini temizleyin.

---

# 8. Frontend XSS kontrolü

Frontend'in büyük bölümünde `textContent` kullanılması iyi. `admin.js` içinde `esc()` ile HTML template'leri escape ediliyor; bu da iyi.

Kontrol edilmesi gereken noktalar:

- `innerHTML` yalnızca sabit SVG/markup için kullanılsın.
- `site-code` ham HTML olduğu için ayrı trusted-admin özelliği olarak tutulmalı.
- `artworkUrl`, `streamUrl` ve `favicon` için URL allowlist/protocol kontrolü frontend'de değil server'da esas kabul edilmeli.
- Kullanıcıdan gelen `note`, `name`, `artist` gibi alanlar DOM'a yalnızca `textContent` veya `esc()` ile girmeli.

---

# 9. Önerilen uygulama sırası

## Hemen

1. Admin middleware sırasını düzeltin (SEC-01).
2. `helmet`, genel/expensive route rate limit ve güvenlik header'larını ekleyin.
3. Listener Map kapasitesi + session/mode doğrulaması ekleyin.
4. Scraper'a body limiti, `ThreadingHTTPServer`, `/healthz`, generic error response ekleyin.
5. Scraper Dockerfile'ına non-root user ekleyin.
6. Node `/healthz` endpoint'i ve Compose healthcheck ekleyin.

## Kısa vadede

1. Public listener endpoint'inden label/süre ayrıntısını kaldırın.
2. Site-code tasarımını raw HTML yerine allowlisted config'e taşıyın.
3. `callScraper()` yanıtına 2 MB limit ekleyin.
4. Central error handler ve process shutdown davranışını ekleyin.
5. Gerçek reverse proxy subnet'iyle `trust proxy` ayarını düzeltin.

## Orta vadede

1. JSON katalog cache + write invalidation.
2. Session store ve revoke edilebilir admin session.
3. Read-only image + ayrı writable data mimarisi.
4. Structured logging, log rotation ve uptime/alert entegrasyonu.
5. Dependency scan (`npm audit`, `pip-audit`, image scanner) ve CI pipeline.

---

# 10. Doğrulama checklist'i

```bash
# Node syntax
node --check server.js
node --check public/app.js
node --check public/admin.js

# Python syntax
python3 -m py_compile sc_scraper.py

# Compose
 docker compose config --quiet

# Container güvenliği
 docker compose ps
 docker inspect karisik-kaset --format '{{.Config.User}}'
 docker inspect karisik-scraper --format '{{.Config.User}}'

# Health
 curl -fsS http://127.0.0.1:3005/healthz
 curl -fsS http://127.0.0.1:3005/api/listeners
 curl -fsS http://127.0.0.1:3005/ | head

# Auth bypass regression — login olmadan 401/403 beklenir
 curl -i http://127.0.0.1:3005/api/admin/search-radio?q=test
 curl -i http://127.0.0.1:3005/api/admin/scraper-status
```

## Son karar

Mevcut uygulama temel işlevleri için iyi bir güvenlik başlangıcına sahip; özellikle stream proxy'deki public-IP/DNS kontrolü, admin HMAC cookie, input uzunluk limitleri ve frontend escape kullanımı olumlu. Ancak production'a güvenli kabul edilmesi için en kritik adım admin middleware sırasının düzeltilmesi, scraper'ın kaynak sınırlandırılması, public rate limit/headers ve container health/non-root hardening'dir.
