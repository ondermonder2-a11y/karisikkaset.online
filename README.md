# 🎙 Karışık Kaset

Retro boombox tasarımı tabanlı Node.js radyo + kaset çalar.

## Çalıştırma

```bash
# 1) Bağımlılıkları kur (ilk seferinde)
npm install

# 2) Sunucuyu başlat
node server.js
# → http://localhost:3000

# Geliştirme modunda (dosya değişikliğinde otomatik yeniden başlatır):
node --watch server.js
```

## Proje yapısı

```
karisikkaset/
├── server.js          ← Express sunucu (API + proxy)
├── package.json
├── config/
│   ├── stations.json  ← Radyo istasyonları (sen eklersin)
│   └── tracks.json    ← Kaset parçaları    (sen eklersin)
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## Yeni istasyon eklemek

`config/stations.json` dosyasını aç ve yeni bir satır ekle:

```json
{ "frequency": 95.0, "name": "İstasyon Adı", "genre": "Tür", "streamUrl": "https://..." }
```

Sunucuyu yeniden başlatmana gerek yok — her istekte diskten okunur.

## Yeni parça eklemek

`config/tracks.json` dosyasını aç ve yeni bir satır ekle:

```json
{ "title": "Parça Adı", "subtitle": "Sanatçı", "soundcloudUrl": "https://soundcloud.com/..." }
```

## Yeni kaset ve kategori eklemek

`config/tapes/` klasörüne bir JSON dosyası ekle. `category` alanı kaset rafındaki kategori filtresinde kullanılır; aynı kategori adını kullanan kasetler birlikte listelenir.

```json
{
  "label": "Yaz Hitleri",
  "category": "Pop",
  "color": "#880e4f",
  "tracks": [
    { "title": "Parça Adı", "subtitle": "Sanatçı", "soundcloudUrl": "https://soundcloud.com/..." }
  ]
}
```

Kategori belirtilmezse kaset `Diğer` altında görünür. JSON dosyaları her istekte okunduğundan sunucuyu yeniden başlatmak gerekmez; sayfayı yenilemek yeterlidir.

## Admin paneli

`/admin` sayfasından radyo istasyonlarını, kasetleri/parçaları yönetebilir; kaynak URL'lerini sunucudan test edebilir ve son 500 şarkı isteğini görüntüleyebilirsin. Yönetim API'si kullanıcı adı/parola girişi olmadan kullanılamaz. Giriş oturumu `HttpOnly`, `Secure` ve `SameSite=Strict` çereziyle korunur; admin sayfasını HTTPS alan adından aç.

Kasetler sekmesinde kasetleri sürükleyerek veya klavyede `Alt` + `↑`/`↓` ile sıralayabilir, **Sıralamayı Kaydet** düğmesiyle ana sayfaya uygulayabilirsin. Sıra `data/tape-order.json` dosyasında saklanır.

Radyo bağlantıları sunucu açılışında ve her 15 dakikada bir otomatik kontrol edilir. Player’daki istasyon listesi durumu gösterir; yönetim panelindeki **Tümünü kontrol et** düğmesi kayıtlı istasyonlar için toplu kontrolü başlatır ve ilerlemeyi gösterir. Son kontrol sonuçları `data/station-health.json` içinde tutulur. Bir istasyon çevrimdışı görünse bile yeniden denemek için player’dan seçilebilir; durum yalnızca kontrol anındaki sunucu erişilebilirliğini gösterir.

Docker kurulumunda sunucudaki proje klasöründe `.env` dosyasını oluştur ve aşağıdaki değerleri kendin belirle:

```dotenv
ADMIN_USERNAME=sececegin-kullanici-adi
ADMIN_PASSWORD=en-az-16-karakter-uzun-benzersiz-parola
ADMIN_SESSION_SECRET=openssl-rand-hex-32-ile-uretilen-64-hex-karakter
```

Parola en az 16 karakter olmalı; benzersiz ve güçlü bir parola seç. `ADMIN_SESSION_SECRET` en az 32 bayt olmalı. Örneğin terminalde `openssl rand -hex 32` çalıştır; çıktıyı yalnızca sunucudaki `.env` dosyasına yaz, sohbete veya GitHub'a gönderme. Dosyanın izinlerini `chmod 600 .env` ile kısıtla. Ardından `docker compose up -d --build` çalıştır. `.env` Git tarafından yok sayılır ve Compose bu kimlik bilgilerini yalnızca app konteynerine aktarır.

## Arama motorları

Ana sayfa Türkçe başlık/açıklama, canonical URL ve yapılandırılmış uygulama verisi içerir. `public/robots.txt` tarama yönergelerini, `public/sitemap.xml` ise indekslenecek ana sayfayı bildirir. Yayına aldıktan sonra `https://karisikkaset.online/sitemap.xml` adresini Google Search Console ve Bing Webmaster Tools'a gönder; sahiplik doğrulamasını da ilgili araçlardan tamamla. Bu ayarlar taranmayı kolaylaştırır, ancak arama sıralaması veya indekslenme garantisi vermez.

Compose, `config/stations.json`, `config/tracks.json`, `config/tapes/` ve `data/` konumlarını host üzerinde kalıcı tutar; admin panelinde yaptığın değişiklikler imaj yeniden oluşturulduğunda silinmez. Kaynak testleri kısa bir HTTP isteği yapar; çevrimiçi durumu o anda sunucudan yanıt ve veri alındığını gösterir, üçüncü taraf yayının daha sonra kesilmeyeceğini garanti etmez. Test, yerel/özel ağ adreslerine erişime izin vermez.

## Kurallar

- **Frekans**: 88–108 MHz aralığı dışındakiler otomatik atlanır.
- **Stream proxy**: Yalnızca `stations.json`'da tanımlı URL'ler proxylenir (açık proxy koruması).
- **SoundCloud**: Widget API üzerinden çalışır. Atıf gizlenemez ("Powered by SoundCloud").


Docker imajını son değişikliklerle build edip konteyneri güncelliyorum; ardından web uygulamasının yanıtını doğrulayacağım.

PowerShell’i açıp şu komutları sırayla çalıştır:

```powershell
cd "D:\Projeler\Node\karisikkaset"
docker compose build
docker compose up -d
docker compose ps

```

İkisini tek komutla yapmak istersen:

```powershell
cd "D:\Projeler\Node\karisikkaset"
docker compose up --build -d
```

Docker Desktop önce açık ve **Engine çalışır durumda** olmalı. Uygulama açılınca [http://localhost:3005](http://localhost:3005) adresine git. Uygulama ve scraper, dış alan adlarını çözebilmek için `web_proxy` ağına bağlıdır; servisler birbirine Compose servis adlarıyla ulaşır. Hata kayıtlarını görmek için:

```powershell
docker compose logs -f app
```

Scraper bağlantı veya DNS hataları için:

```powershell
docker compose logs -f scraper
```

`web_proxy` ağı bulunamadı hatası çıkarsa çıktıyı gönder; compose ayarına göre çözelim.