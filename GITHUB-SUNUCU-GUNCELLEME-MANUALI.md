# Karışık Kaset — GitHub ve Canlı Sunucu Güncelleme Kılavuzu

Bu kılavuz, yerel Windows bilgisayardaki projeyi GitHub'a göndermek ve Docker ile çalışan canlı sunucuyu güncellemek için kullanılır.

> Proje: `https://github.com/ondermonder2-a11y/karisikkaset.online.git`
>
> Canlı klasör: `/home/onder/apps/karisikkaset-deploy`
>
> Canlı servis: `karisik-kaset`
>
> Dış port: `3005` — container iç portu: `3000`

## 1. Yerel bilgisayarda hazırlık

PowerShell'i açın ve proje klasörüne girin:

```powershell
cd "D:\Projeler\Node\karisikkaset"
```

Git'in Windows sahiplik güvenlik kontrolü için bu değişkeni tanımlayın. Bu işlem global Git ayarını değiştirmez:

```powershell
$git = @("-c", "safe.directory=D:/Projeler/Node/karisikkaset")
```

Önce durumu kontrol edin:

```powershell
git @git status --short
git @git remote -v
git @git branch --show-current
```

`.gitignore` içinde en az şu satırlar bulunmalıdır:

```text
node_modules/
.env
.env.*
data/
*.log
tmp/
.manus/
```

Eksikse `.gitignore` dosyasını düzenleyin. `tmp/`, `.manus/`, `.env` ve `data/` GitHub'a gönderilmemelidir.

## 2. Commit öncesi kontrol

Önce JavaScript dosyalarının sözdizimini kontrol edin:

```powershell
node --check public\app.js
node --check public\admin.js
node --check server.js
```

Dosyaları stage edin:

```powershell
git @git add -A
```

Stage edilen dosyaları kontrol edin:

```powershell
git @git status --short
```

Aşağıdaki dosyalar stage listesinde görünmemelidir:

```text
.env
data/
tmp/
.manus/
```

Kontrol için:

```powershell
$staged = git @git diff --cached --name-only
$staged | Select-String -Pattern '(^|/)(\.env|data/|tmp/|\.manus/)'
```

Bu komut hiçbir çıktı vermemelidir.

> Daha önce taşınan ve artık kullanılmayan bir dosyanın silinmesini istemiyorsanız, commit'ten önce geri alın. Örnek:
>
> ```powershell
> git @git restore --source=HEAD -- arkaplan/cerceve.png
> git @git add -A
> ```

## 3. GitHub'a commit ve push

Anlamlı bir commit oluşturun:

```powershell
git @git commit -m "Describe the change briefly"
```

Örnek:

```powershell
git @git commit -m "Add live listener counter and prepare Docker deployment"
```

GitHub'a gönderin:

```powershell
git @git push origin main
```

Kimlik doğrulama hatası alırsanız Git Credential Manager'ı etkinleştirin:

```powershell
git config --global credential.helper manager
```

Sonra push komutunu tekrar çalıştırın:

```powershell
git @git push origin main
```

GitHub parola yerine Personal Access Token isterse GitHub parolanızı değil, `repo` yetkili token'ı kullanın. Token'ı terminal çıktısına, sohbet ekranına veya dosyaya yazmayın.

Push doğrulaması:

```powershell
git @git status
git @git log -1 --oneline --decorate
```

Beklenen durum:

```text
Your branch is up to date with 'origin/main'.
nothing to commit, working tree clean
```

## 4. Canlı sunucuya bağlanma

Yerel PowerShell'den SSH ile bağlanın:

```powershell
ssh KULLANICI_ADI@SUNUCU_IP
```

Sunucuda gerekli araçları kontrol edin:

```bash
docker --version
docker compose version
git --version
```

Canlı proje klasörüne girin:

```bash
cd /home/onder/apps/karisikkaset-deploy
```

## 5. Güncelleme öncesi güvenli yedek

Canlı klasörde yerel değişiklik olup olmadığını kontrol edin:

```bash
git status --short
```

Özellikle sunucuda elle eklenmiş kaset dosyaları varsa önce yedekleyin:

```bash
BACKUP="$HOME/karisikkaset-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP/config/tapes"

cp -a config/tapes/90lar-karisik.json "$BACKUP/config/tapes/" 2>/dev/null || true
cp -a config/tapes/80-lar-karisik.json "$BACKUP/config/tapes/" 2>/dev/null || true
cp -a config/tapes/80-ler-90-lar-turkce-pop.json "$BACKUP/config/tapes/" 2>/dev/null || true

git diff -- config/tapes/90lar-karisik.json > "$BACKUP/90lar-karisik.diff" 2>/dev/null || true

echo "Yedek: $BACKUP"
```

Sunucudaki `.env` dosyasının varlığını değerleri göstermeden kontrol edin:

```bash
if [ -f .env ]; then
  echo ".env mevcut"
  stat -c 'izin=%A sahip=%U:%G boyut=%s' .env
  sed -n 's/=.*//p' .env
else
  echo "UYARI: .env bulunamadı"
fi
```

Gerekli değişkenler:

```text
ADMIN_USERNAME
ADMIN_PASSWORD
ADMIN_SESSION_SECRET
```

## 6. GitHub sürümünü canlı sunucuya alma

Önce GitHub'daki güncel branch'i çekin:

```bash
git fetch origin main
git rev-parse --short FETCH_HEAD
```

Beklenen commit, GitHub'daki son commit'tir. Sunucuda yerel değişiklik varsa stash'e alın:

```bash
git stash push -u -m "production-local-before-github-update"
```

GitHub'daki sürümü fast-forward olarak alın:

```bash
git pull --ff-only origin main
```

`--ff-only` merge çatışması oluşturmaz. Çatışma veya beklenmeyen durum olursa işlemi durdurun; `git reset --hard` çalıştırmayın.

## 7. Sunucudaki yerel kasetleri geri koyma

Daha önce yedek aldığınız yerel kasetleri kullanmaya devam edecekseniz:

```bash
# BACKUP değişkeni hâlâ mevcutsa bunu kullanın.
# Yeni SSH oturumunda gerekiyorsa gerçek yedek klasörünü yazın:
BACKUP="/home/onder/karisikkaset-backup-YYYYMMDD-HHMMSS"

cp -a "$BACKUP/config/tapes/90lar-karisik.json" config/tapes/ 2>/dev/null || true
cp -a "$BACKUP/config/tapes/80-lar-karisik.json" config/tapes/ 2>/dev/null || true
cp -a "$BACKUP/config/tapes/80-ler-90-lar-turkce-pop.json" config/tapes/ 2>/dev/null || true
```

Kontrol:

```bash
find config/tapes -maxdepth 1 -type f -printf '%f\n' | sort
git status --short
```

Bu yerel kasetler GitHub'a gönderilmeyecekse `git status` içinde `?? config/tapes/...` olarak görünmeleri normaldir. Bunları commit etmeyin.

## 8. Compose doğrulama ve Docker image yedek etiketi

Önce Compose dosyasını doğrulayın:

```bash
docker compose config --quiet
echo "compose_exit=$?"
```

Beklenen:

```text
compose_exit=0
```

Çalışan image'ı geri dönüş için etiketleyin:

```bash
ROLLBACK_TAG="rollback-$(date +%Y%m%d-%H%M%S)"
docker image tag karisikkaset-deploy-app "karisikkaset-deploy-app:$ROLLBACK_TAG"
echo "$ROLLBACK_TAG"
```

## 9. Build ve canlı güncelleme

Önce image'ları oluşturun:

```bash
docker compose build app scraper
```

Build başarılıysa servisleri yeni image ile başlatın:

```bash
docker compose up -d
```

Durumu kontrol edin:

```bash
docker compose ps
docker ps --filter "name=karisik" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Beklenen servisler:

```text
karisik-kaset
karisik-scraper
```

## 10. Canlılık testleri

Ana sayfa testi:

```bash
curl -I http://127.0.0.1:3005/
```

Dinleyici API testi:

```bash
curl -sS http://127.0.0.1:3005/api/listeners
echo
```

Beklenen başlangıç yanıtı yaklaşık olarak:

```json
{"count":0,"radio":0,"tape":0,"listeners":[]}
```

Log kontrolü:

```bash
docker compose logs --tail=100 app

docker compose logs --tail=100 scraper
```

Tarayıcıda şu adresleri kontrol edin:

```text
https://karisikkaset.online/
https://karisikkaset.online/admin
```

Ana sayfadaki mantar panoda canlı dinleyici notu görünmelidir. Bir tarayıcı sekmesinde radyo veya kaset oynatınca sayı yaklaşık 5 saniye içinde artmalı, duraklatınca düşmelidir.

## 11. Güncelleme başarısız olursa rollback

Önce servis loglarını kontrol edin:

```bash
docker compose logs --tail=200 app
```

Önceki image etiketi hâlâ mevcutsa Compose servisini eski image'a döndürmek için mevcut Docker ayarlarına göre ilerleyin. Image etiketini doğrulayın:

```bash
docker image ls --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}' | grep karisikkaset
```

Eğer Compose dosyası image'ı `build:` ile oluşturuyorsa, en güvenli rollback yöntemi Git kodunu önceki commit'e döndürmek değil, yedeği saklayarak önceki commit'i ayrı bir çalışma kopyasında build etmektir. Önce şunları kaydedin:

```bash
docker compose ps
git rev-parse --short HEAD
git stash list
echo "$ROLLBACK_TAG"
```

Acil durumda container'ı durdurmadan önce mutlaka logları ve bu bilgileri kaydedin. `docker system prune`, `docker compose down -v` ve `git reset --hard` komutlarını düşünmeden çalıştırmayın; bunlar veri veya volume kaybına yol açabilir.

## 12. Günlük hızlı güncelleme özeti

Yerel bilgisayar:

```powershell
cd "D:\Projeler\Node\karisikkaset"
$git = @("-c", "safe.directory=D:/Projeler/Node/karisikkaset")
git @git add -A
git @git diff --cached --name-only
git @git commit -m "Describe the change"
git @git push origin main
```

Sunucu:

```bash
cd /home/onder/apps/karisikkaset-deploy
git fetch origin main
git stash push -u -m "production-local-before-update"
git pull --ff-only origin main
docker compose config --quiet
docker compose build app scraper
docker compose up -d
docker compose ps
curl -I http://127.0.0.1:3005/
```

> Sunucuda `git stash` ile korunan yerel içerikler gerekiyorsa, güncellemeden sonra bunları yedekten geri koyun. Sunucudaki `.env`, `data/` ve Compose volume'larını silmeyin.
