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

## Kurallar

- **Frekans**: 88–108 MHz aralığı dışındakiler otomatik atlanır.
- **Stream proxy**: Yalnızca `stations.json`'da tanımlı URL'ler proxylenir (açık proxy koruması).
- **SoundCloud**: Widget API üzerinden çalışır. Atıf gizlenemez ("Powered by SoundCloud").
