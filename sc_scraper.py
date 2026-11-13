#!/usr/bin/env python3
"""
sc_scraper.py — SoundCloud Playlist Scraper Microservice
=========================================================
Dışarıdan paket gerektirmez (sadece requests, standart kütüphane http.server).

Çalıştırma:
    python sc_scraper.py            # varsayılan port 5001
    python sc_scraper.py --port 5001

API:
    POST /scrape
    Content-Type: application/json
    Body: {"url": "https://soundcloud.com/.../sets/..."}

    Yanıt (200):
    {
      "title": "Playlist adı",
      "tracks": [
        {"title": "...", "subtitle": "...", "soundcloudUrl": "..."},
        ...
      ]
    }

    Hata (4xx/5xx):
    {"error": "açıklama"}

Nasıl çalışır:
  1. window.__sc_hydration JSON'dan playlist ve parça verisini çeker.
  2. Sadece id içeren (tam verisi olmayan) parçaları SoundCloud API v2 ile
     50'lik batch'ler halinde tamamlar. Bu adım için client_id gerekir;
     client_id SoundCloud JS bundle'larından dinamik olarak alınır.
"""

import argparse
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

# ─── HTTP oturumu ───────────────────────────────────────────────────────────
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
})

# client_id önbelleği — her servis başlangıcında bir kez alınır
_CLIENT_ID: str | None = None


# ─── SoundCloud client_id ────────────────────────────────────────────────────
def get_client_id() -> str | None:
    """SoundCloud JS bundle'larından client_id'yi dinamik olarak çeker."""
    global _CLIENT_ID
    if _CLIENT_ID:
        return _CLIENT_ID

    print("[scraper] client_id alınıyor…", flush=True)
    try:
        r = SESSION.get("https://soundcloud.com", timeout=20)
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"[scraper] Ana sayfa indirilemedi: {e}", flush=True)
        return None

    # JS bundle URL'lerini bul
    script_urls = re.findall(
        r'<script[^>]+src="(https://a-v2\.sndcdn\.com/assets/[^"]+\.js)"', r.text
    )
    if not script_urls:
        script_urls = re.findall(
            r'"(https://a-v2\.sndcdn\.com/assets/[0-9a-f-]+\.js)"', r.text
        )

    for url in reversed(script_urls):
        try:
            js = SESSION.get(url, timeout=15).text
            m = re.search(r'client_id\s*:\s*"([A-Za-z0-9]{32,})"', js)
            if m:
                _CLIENT_ID = m.group(1)
                print(f"[scraper] client_id: {_CLIENT_ID[:8]}…", flush=True)
                return _CLIENT_ID
        except requests.RequestException:
            continue

    # HTML içinde doğrudan geçiyor olabilir
    m = re.search(r'"client_id":"([A-Za-z0-9]{32,})"', r.text)
    if m:
        _CLIENT_ID = m.group(1)
        return _CLIENT_ID

    print("[scraper] client_id bulunamadı.", flush=True)
    return None


# ─── Hydration ───────────────────────────────────────────────────────────────
def fetch_hydration(url: str) -> list:
    """SoundCloud sayfasından window.__sc_hydration dizisini döner."""
    r = SESSION.get(url, timeout=25)
    r.encoding = "utf-8"
    if r.status_code == 404:
        raise ValueError("Sayfa bulunamadı (404). URL herkese açık mı?")
    r.raise_for_status()

    scripts = re.findall(r"<script[^>]*>(.*?)</script>", r.text, re.DOTALL)
    for sc in scripts:
        if "__sc_hydration" not in sc:
            continue
        m = re.search(r"window\.__sc_hydration\s*=\s*(\[.+)", sc, re.DOTALL)
        if not m:
            continue
        raw = m.group(1).strip()
        raw = re.sub(r";\s*window\..+$", "", raw, flags=re.DOTALL).rstrip(";").strip()
        return json.loads(raw)

    raise ValueError("window.__sc_hydration bulunamadı. Sayfa yapısı değişmiş olabilir.")


# ─── Playlist extract ────────────────────────────────────────────────────────
def extract_playlist(hydration: list) -> dict:
    for item in hydration:
        if item.get("hydratable") == "playlist":
            return item.get("data", {})
    return {}


# ─── Batch API ───────────────────────────────────────────────────────────────
def resolve_batch(ids: list[int], client_id: str) -> dict[int, dict]:
    """50 id'ye kadar SoundCloud API v2 ile parça bilgilerini getirir."""
    ids_str = ",".join(str(i) for i in ids)
    url = f"https://api-v2.soundcloud.com/tracks?ids={ids_str}&client_id={client_id}"
    try:
        r = SESSION.get(url, timeout=20)
        r.encoding = "utf-8"
        if r.status_code == 200:
            return {t["id"]: t for t in r.json() if "id" in t}
        if r.status_code == 429:
            print("[scraper] API hız sınırı, 10 sn bekleniyor…", flush=True)
            time.sleep(10)
        else:
            print(f"[scraper] API {r.status_code}", flush=True)
    except requests.RequestException as e:
        print(f"[scraper] Batch API hatası: {e}", flush=True)
    return {}


def parse_artist_from_title(title: str) -> tuple[str, str]:
    """
    "Müslüm Gürses - Sende Ki Yalnızlık" gibi parça adlarından
    sanatçı ve şarkı adını ayırır.
    Ayraç: ' - ' veya ' – ' (uzun tire)
    Eğer ayraç yoksa (title, "") döner.
    """
    for sep in (" - ", " – ", " — "):
        if sep in title:
            parts = title.split(sep, 1)
            artist_part = parts[0].strip()
            song_part   = parts[1].strip()
            # Makul sanatçı adı: 2-50 karakter, sayıyla başlamıyor
            if 2 <= len(artist_part) <= 50 and not artist_part[0].isdigit():
                return song_part, artist_part
    return title, ""


def extract_artist(track_data: dict, title: str) -> tuple[str, str]:
    """
    Sanatçıyı şu öncelik sırasıyla belirler:
      1. publisher_metadata.artist  (gerçek sanatçı bilgisi, en güvenilir)
      2. publisher_metadata.album_title içinde sanatçı ipucu
      3. Parça adından parse et  (örn: "Sanatçı - Şarkı Adı")
      4. user.username  (yükleyen — son çare)
    Döner: (temiz_baslik, sanatci)
    """
    pm = track_data.get("publisher_metadata") or {}

    # 1. publisher_metadata.artist
    pm_artist = (pm.get("artist") or "").strip()
    if pm_artist:
        return title, pm_artist

    # 2. Parça adından parse
    parsed_title, parsed_artist = parse_artist_from_title(title)
    if parsed_artist:
        return parsed_title, parsed_artist

    # 3. user.username (yükleyen — son çare)
    uploader = (track_data.get("user", {}).get("username") or "").strip()
    return title, uploader


def extract_artwork(track_data: dict) -> str:
    """
    Parçanın albüm kapağı URL'sini döner.
    SoundCloud artwork_url varsayılan olarak küçük (100x100) gelir;
    '-large' → '-t500x500' ile en yüksek çözünürlüğe yükseltiyoruz.
    Yoksa boş string döner.
    """
    raw = (track_data.get("artwork_url") or "").strip()
    if not raw:
        # Kullanıcı avatarı fallback (bazı parçalarda artwork olmayabilir)
        raw = (track_data.get("user", {}).get("avatar_url") or "").strip()
    if not raw:
        return ""
    # Kalite yükselt: -large (100px) → -t500x500 (500px)
    return raw.replace("-large", "-t500x500").replace("-small", "-t500x500")
def scrape_playlist(playlist_url: str) -> dict:
    """Playlist URL'sinden parça listesini döner."""
    hydration = fetch_hydration(playlist_url)
    playlist  = extract_playlist(hydration)

    if not playlist:
        raise ValueError("Hydration'da playlist verisi yok.")

    title      = playlist.get("title", "")
    tracks_raw = playlist.get("tracks", [])
    # 300 limitini uygula — fazlasını alma
    if len(tracks_raw) > 300:
        print(f"[scraper] {len(tracks_raw)} parça bulundu, ilk 300 alınıyor.", flush=True)
        tracks_raw = tracks_raw[:300]
    print(f"[scraper] '{title}' — {len(tracks_raw)} parça", flush=True)

    tracks  = []
    missing = []   # sadece id içerenler

    for t in tracks_raw:
        permalink = t.get("permalink_url")
        if permalink:
            raw_title = (t.get("title") or "").strip()
            clean_title, artist = extract_artist(t, raw_title)
            tracks.append({
                "title":         clean_title,
                "subtitle":      artist,
                "soundcloudUrl": permalink,
                "artworkUrl":    extract_artwork(t),
            })
        elif t.get("id"):
            missing.append(t["id"])

    # Eksik parçaları API ile tamamla
    if missing:
        client_id = get_client_id()
        if client_id:
            print(f"[scraper] {len(missing)} eksik parça API ile tamamlanıyor…", flush=True)
            for i in range(0, len(missing), 50):
                batch   = missing[i : i + 50]
                resolved = resolve_batch(batch, client_id)
                for tid in batch:
                    t = resolved.get(tid)
                    if t and t.get("permalink_url"):
                        raw_title = (t.get("title") or "").strip()
                        clean_title, artist = extract_artist(t, raw_title)
                        tracks.append({
                            "title":         clean_title,
                            "subtitle":      artist,
                            "soundcloudUrl": t["permalink_url"],
                            "artworkUrl":    extract_artwork(t),
                        })
                    else:
                        print(f"[scraper]   id={tid} çözülemedi", flush=True)
                print(f"[scraper]   {min(i+50, len(missing))}/{len(missing)} işlendi", flush=True)
                time.sleep(0.3)
        else:
            print(f"[scraper] client_id yok, {len(missing)} parça atlandı.", flush=True)

    print(f"[scraper] Toplam {len(tracks)} parça toplandı.", flush=True)
    return {"title": title, "tracks": tracks}


# ─── HTTP sunucu ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[http] {self.address_string()} {fmt % args}", flush=True)

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type",   "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "http://localhost:3000")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin",  "http://localhost:3000")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path != "/scrape":
            self._send_json(404, {"error": "Sadece POST /scrape desteklenir."})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Geçersiz JSON."})
            return

        url = (body.get("url") or "").strip()
        if not url:
            self._send_json(400, {"error": "'url' alanı gerekli."})
            return

        # Sadece soundcloud.com'a izin ver
        try:
            from urllib.parse import urlparse
            host = urlparse(url).hostname or ""
            if not (host == "soundcloud.com" or host.endswith(".soundcloud.com")):
                self._send_json(400, {"error": "Sadece soundcloud.com desteklenir."})
                return
        except Exception:
            self._send_json(400, {"error": "Geçersiz URL."})
            return

        try:
            result = scrape_playlist(url)
            self._send_json(200, result)
        except ValueError as e:
            self._send_json(422, {"error": str(e)})
        except requests.HTTPError as e:
            self._send_json(502, {"error": f"SoundCloud HTTP hatası: {e}"})
        except requests.RequestException as e:
            self._send_json(502, {"error": f"Ağ hatası: {e}"})
        except Exception as e:
            print(f"[scraper] Beklenmedik hata: {e}", flush=True)
            self._send_json(500, {"error": f"Sunucu hatası: {e}"})


def main():
    ap = argparse.ArgumentParser(description="SoundCloud scraper microservice")
    ap.add_argument("--port", type=int, default=5001)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    # Başlangıçta client_id'yi önbelleğe al
    get_client_id()

    server = HTTPServer((args.host, args.port), Handler)
    print(f"[scraper] Çalışıyor → http://{args.host}:{args.port}/scrape", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[scraper] Durduruluyor…", flush=True)


if __name__ == "__main__":
    main()
