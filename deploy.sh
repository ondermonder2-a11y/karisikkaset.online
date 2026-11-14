#!/usr/bin/env bash
# Karışık Kaset — GitHub -> Docker production deployment
# Çalıştırma: bash deploy.sh
# Varsayılan konum: /home/onder/apps/karisikkaset-deploy

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/home/onder/apps/karisikkaset-deploy}"
BRANCH="${BRANCH:-main}"
COMPOSE_SERVICES="${COMPOSE_SERVICES:-app scraper}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3005/}"
LISTENER_URL="${LISTENER_URL:-http://127.0.0.1:3005/api/listeners}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/karisikkaset-backup-$TIMESTAMP}"
STASH_NAME="production-local-before-deploy-$TIMESTAMP"

log() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '\nHATA: %s\n' "$*" >&2; exit 1; }

on_error() {
  local line="$1"
  printf '\nHATA: deploy.sh %s. satırda durdu.\n' "$line" >&2
  printf 'Çalışan container korunmuştur; aşağıdaki komutlarla durumu inceleyin:\n' >&2
  printf '  cd %q\n' "$APP_DIR" >&2
  printf '  docker compose ps\n' >&2
  printf '  docker compose logs --tail=100 app\n' >&2
}
trap 'on_error "$LINENO"' ERR

command -v git >/dev/null 2>&1 || die "git bulunamadı."
command -v docker >/dev/null 2>&1 || die "docker bulunamadı."
docker compose version >/dev/null 2>&1 || die "docker compose kullanılamıyor."

[ -d "$APP_DIR/.git" ] || die "Git proje klasörü bulunamadı: $APP_DIR"
cd "$APP_DIR"

log "Deployment başladı: $APP_DIR"
log "Branch: $BRANCH"

if [ ! -f .env ]; then
  die ".env bulunamadı. ADMIN_USERNAME, ADMIN_PASSWORD ve ADMIN_SESSION_SECRET ayarlanmalı."
fi

for key in ADMIN_USERNAME ADMIN_PASSWORD ADMIN_SESSION_SECRET; do
  grep -qE "^${key}=.+" .env || die ".env içinde $key eksik veya boş."
done

log "Mevcut çalışma durumu"
git status --short

# Sunucuda elle eklenmiş/takip edilmeyen tüm kasetleri ve yerel radyo
# yapılandırmasını yedekle. Stash tek başına yeterli değildir: pull sonrasında
# bu dosyalar tekrar çalışma ağacına alınmazsa Compose eski listeyi görür.
mkdir -p "$BACKUP_DIR/config/tapes"
LOCAL_TAPE_BACKUP_COUNT=0
if [ -d config/tapes ]; then
  cp -a config/tapes/. "$BACKUP_DIR/config/tapes/"
  LOCAL_TAPE_BACKUP_COUNT="$(find "$BACKUP_DIR/config/tapes" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
fi

for live_config in config/stations.json config/tracks.json; do
  if [ -f "$live_config" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$live_config")"
    cp -a "$live_config" "$BACKUP_DIR/$live_config"
  fi
done

log "Yedek klasörü: $BACKUP_DIR ($LOCAL_TAPE_BACKUP_COUNT kaset; stations/tracks korunuyor)"

# Uzak branch'i al; yerel dosyaları kaybetmemek için stash oluştur.
log "GitHub branch'i alınıyor"
git fetch origin "$BRANCH"
REMOTE_COMMIT="$(git rev-parse --short "FETCH_HEAD")"
log "GitHub commit: $REMOTE_COMMIT"

git stash push -u -m "$STASH_NAME" >/dev/null || true

log "GitHub sürümü uygulanıyor"
git pull --ff-only origin "$BRANCH"

# Önceki sunucuda bulunan yerel kasetleri ve radyo yapılandırmasını geri koy.
# GitHub'da yeni eklenen dosyalar korunur; aynı isimli canlı dosyada sunucu
# sürümü önceliklidir. .env ve data volume'larına dokunulmaz.
if [ "$LOCAL_TAPE_BACKUP_COUNT" -gt 0 ]; then
  log "Yerel kasetler geri yükleniyor"
  mkdir -p config/tapes
  cp -a "$BACKUP_DIR/config/tapes/." config/tapes/
fi

for live_config in config/stations.json config/tracks.json; do
  if [ -f "$BACKUP_DIR/$live_config" ]; then
    mkdir -p "$(dirname "$live_config")"
    cp -a "$BACKUP_DIR/$live_config" "$live_config"
  fi
done

log "Compose doğrulanıyor"
docker compose config --quiet

# Çalışan image varsa geri dönüş etiketi oluştur.
CURRENT_IMAGE="$(docker inspect karisik-kaset --format '{{.Config.Image}}' 2>/dev/null || true)"
ROLLBACK_TAG=""
if [ -n "$CURRENT_IMAGE" ] && docker image inspect "$CURRENT_IMAGE" >/dev/null 2>&1; then
  ROLLBACK_TAG="rollback-$TIMESTAMP"
  docker image tag "$CURRENT_IMAGE" "karisikkaset-deploy-app:$ROLLBACK_TAG"
  log "Rollback image etiketi: karisikkaset-deploy-app:$ROLLBACK_TAG"
fi

log "Docker image'ları build ediliyor"
docker compose build $COMPOSE_SERVICES

log "Servisler başlatılıyor"
docker compose up -d

log "Container durumu"
docker compose ps

log "Ana sayfa sağlık testi"
HTTP_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$HEALTH_URL")"
case "$HTTP_STATUS" in
  2*|3*) log "Ana sayfa başarılı: HTTP $HTTP_STATUS" ;;
  *) die "Ana sayfa başarısız: HTTP $HTTP_STATUS" ;;
esac

log "Dinleyici API testi"
curl -fsS --max-time 15 "$LISTENER_URL"
printf '\n'

log "Son uygulama logları"
docker compose logs --tail=40 app

log "Deployment tamamlandı"
printf '\nGitHub commit: %s\n' "$REMOTE_COMMIT"
printf 'Yedek klasörü: %s\n' "$BACKUP_DIR"
if [ -n "$ROLLBACK_TAG" ]; then
  printf 'Rollback etiketi: karisikkaset-deploy-app:%s\n' "$ROLLBACK_TAG"
fi
printf "\nNot: Yerel kaset dosyaları sunucuda tutuldu; GitHub'a geri gönderilmedi.\n"
