#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  KSE NMT — Deploy to Hetzner
#  Usage: ./deploy.sh
#
#  БЕЗПЕЧНО для серверів з іншими проєктами:
#  - Торкається ЛИШЕ /opt/kse-nmt і /var/lib/kse-nmt
#  - Не видаляє чужі nginx сайти
#  - nginx/systemd оновлює тільки якщо файл змінився
#  - БД ніколи не перезаписується
#
#  Перший раз на новому сервері?
#    ./deploy/setup_server.sh root@YOUR_SERVER_IP
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓  $*${NC}"; }
warn() { echo -e "  ${YELLOW}⚠  $*${NC}"; }
err()  { echo -e "\n  ${RED}✗  $*${NC}\n"; }
step() { echo -e "\n${YELLOW}${BOLD}$*${NC}"; }
hr()   { echo -e "${CYAN}${BOLD}  ─────────────────────────────────────────${NC}"; }

REMOTE_APP_DIR="/opt/kse-nmt"
REMOTE_DATA_DIR="/var/lib/kse-nmt"
CONFIG_FILE=".deploy_config"

# ─── Banner ───────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}${BOLD}  ╔═══════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}${BOLD}  ║     🚀  KSE NMT — Deploy to Hetzner      ║${NC}"
echo -e "${YELLOW}${BOLD}  ╚═══════════════════════════════════════════╝${NC}"
echo ""

# ─── Конфігурація ─────────────────────────────────────────────
hr
echo -e "  ${BOLD}Конфігурація сервера${NC}"
hr

[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"

if [ -z "${SERVER_IP:-}" ]; then
  read -rp "  Server IP: " SERVER_IP
fi
if [ -z "${SERVER_USER:-}" ]; then
  read -rp "  SSH user [root]: " SERVER_USER
  SERVER_USER=${SERVER_USER:-root}
fi

printf "SERVER_IP=%s\nSERVER_USER=%s\n" "$SERVER_IP" "$SERVER_USER" > "$CONFIG_FILE"
SERVER="$SERVER_USER@$SERVER_IP"

ok "Сервер:  $SERVER"
ok "Код:     $REMOTE_APP_DIR"
ok "БД:      $REMOTE_DATA_DIR  ← ніколи не чіпаємо"

# ─── Git commit + push ────────────────────────────────────────
step "📦  Крок 1/4 — Git"
hr

git add .

if git diff-index --quiet HEAD --; then
  ok "Нічого комітити."
else
  COMMIT_MSG="deploy: $(date +'%Y-%m-%d %H:%M')"
  git commit -m "$COMMIT_MSG"
  ok "Committed: $COMMIT_MSG"
fi

git push && ok "Запушено на GitHub." || warn "Git push не вдався — деплоїмо без пушу."

# ─── Підтвердження ────────────────────────────────────────────
echo ""
hr
echo -e "  ${YELLOW}Деплоїти на ${BOLD}$SERVER${NC}${YELLOW}?${NC}"
echo -e "  ${CYAN}Enter — продовжити, Ctrl+C — скасувати.${NC}"
hr
read -r

# ─── SSH з'єднання ────────────────────────────────────────────
step "🔌  Крок 2/4 — SSH"
hr

SSH_SOCKET="/tmp/ssh-nmt-$(echo "$SERVER_IP" | tr '.' '-')"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=$SSH_SOCKET -o ControlPersist=10m -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"
trap 'ssh -O exit -o ControlPath="$SSH_SOCKET" "$SERVER" 2>/dev/null || true; rm -f "$SSH_SOCKET"' EXIT

ssh $SSH_OPTS "$SERVER" "echo ''" && ok "З'єднання OK." || { err "SSH недоступний."; exit 1; }

# Директорії (безпечно повторювати — mkdir -p не ламає існуючі)
ssh $SSH_OPTS "$SERVER" "
  mkdir -p $REMOTE_APP_DIR
  mkdir -p $REMOTE_DATA_DIR/data/uploads
  chown -R www-data:www-data $REMOTE_DATA_DIR 2>/dev/null || true
"
ok "Директорії готові."

# ─── rsync (лише код, БД не чіпаємо) ─────────────────────────
step "📡  Крок 3/4 — Синхронізація коду"
hr
echo -e "  ${CYAN}Синхронізую код → $REMOTE_APP_DIR${NC}"
echo -e "  ${GREEN}БД у $REMOTE_DATA_DIR — недоторкана${NC}"
echo ""

rsync -az --progress \
  --exclude 'node_modules/' \
  --exclude '.env' \
  --exclude 'data/' \
  --exclude '*.db' \
  --exclude '*.db-shm' \
  --exclude '*.db-wal' \
  --exclude '.git/' \
  --exclude '.deploy_config' \
  --exclude 'csv_export/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  -e "ssh $SSH_OPTS" \
  ./ "$SERVER:$REMOTE_APP_DIR/"

ok "Синхронізація завершена."

# ─── Задачі на сервері ────────────────────────────────────────
step "⚙️   Крок 4/4 — Запуск на сервері"
hr

ssh $SSH_OPTS "$SERVER" bash << 'REMOTE'
set -e
APP=/opt/kse-nmt
DATA=/var/lib/kse-nmt

# ── 1. npm install ────────────────────────────────────────────
echo "  → npm install..."
cd "$APP"
npm install --omit=dev --silent
echo "  ✓  Залежності встановлені."

# ── 2. Перший запуск: auto-create .env ───────────────────────
# (наступні деплої не чіпають .env — він залишається на сервері)
if [ ! -f "$APP/.env" ]; then
  cp "$APP/.env.example" "$APP/.env"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s/change-me-in-production/$SECRET/" "$APP/.env"

  # Вказуємо на persistent дані в /var/lib/kse-nmt
  cat >> "$APP/.env" << ENV

# Auto-configured by deploy.sh — do not remove these lines
DB_PATH=/var/lib/kse-nmt/exam.db
DATA_DIR=/var/lib/kse-nmt/data
SESSION_DB_DIR=/var/lib/kse-nmt
ENV

  echo "  ✓  .env створено (SESSION_SECRET — випадковий)."
  echo "  ✓  DB_PATH → $DATA/exam.db"
else
  echo "  ✓  .env вже існує — не чіпаємо."
fi

# ── 3. nginx: оновлюємо ЛИШЕ якщо файл змінився ──────────────
# Не видаляємо інші сайти, не чіпаємо чужі проєкти!
NGINX_SRC="$APP/deploy/nginx.conf"
NGINX_DST="/etc/nginx/sites-available/kse-nmt"

if [ -f "$NGINX_SRC" ]; then
  CHANGED=false
  if [ ! -f "$NGINX_DST" ]; then
    CHANGED=true
    echo "  → nginx config: встановлюю вперше."
  else
    SRC_HASH=$(md5sum "$NGINX_SRC" | cut -d' ' -f1)
    DST_HASH=$(md5sum "$NGINX_DST"  | cut -d' ' -f1)
    [ "$SRC_HASH" != "$DST_HASH" ] && CHANGED=true || true
  fi

  if [ "$CHANGED" = "true" ]; then
    cp "$NGINX_SRC" "$NGINX_DST"
    # Симлінк тільки для kse-nmt — інші сайти не чіпаємо
    ln -sf "$NGINX_DST" /etc/nginx/sites-enabled/kse-nmt
    # Тест перед reload — якщо помилка, не ламаємо nginx
    if nginx -t -q 2>/dev/null; then
      systemctl reload nginx
      echo "  ✓  nginx оновлено і перезавантажено."
    else
      echo "  ✗  nginx config має помилку! Залишаю старий."
      cp "$NGINX_DST.bak" "$NGINX_DST" 2>/dev/null || rm -f "$NGINX_DST"
    fi
  else
    echo "  ✓  nginx config не змінився — пропускаємо."
  fi
fi

# ── 4. systemd: оновлюємо ЛИШЕ якщо файл змінився ────────────
SVC_SRC="$APP/deploy/kse-nmt.service"
SVC_DST="/etc/systemd/system/kse-nmt.service"

if [ -f "$SVC_SRC" ]; then
  CHANGED=false
  if [ ! -f "$SVC_DST" ]; then
    CHANGED=true
    echo "  → systemd service: встановлюю вперше."
  else
    SRC_HASH=$(md5sum "$SVC_SRC" | cut -d' ' -f1)
    DST_HASH=$(md5sum "$SVC_DST"  | cut -d' ' -f1)
    [ "$SRC_HASH" != "$DST_HASH" ] && CHANGED=true || true
  fi

  if [ "$CHANGED" = "true" ]; then
    cp "$SVC_SRC" "$SVC_DST"
    systemctl daemon-reload
    systemctl enable kse-nmt 2>/dev/null || true
    echo "  ✓  systemd service оновлено."
  else
    echo "  ✓  systemd service не змінився — пропускаємо."
  fi
fi

# ── 5. Перезапустити лише kse-nmt (інші сервіси не чіпаємо) ──
echo "  → systemctl restart kse-nmt..."
systemctl restart kse-nmt
sleep 2

STATUS=$(systemctl is-active kse-nmt)
if [ "$STATUS" = "active" ]; then
  echo ""
  echo "  ✅ kse-nmt.service — active і працює!"
else
  echo ""
  echo "  ❌ Сервіс не запустився (status: $STATUS)"
  echo "     Логи:"
  journalctl -u kse-nmt -n 40 --no-pager
  exit 1
fi
REMOTE

# ─── Готово ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}  ║      ✨  Деплой успішно завершено!           ║${NC}"
echo -e "${GREEN}${BOLD}  ╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}🌐 Сайт:     ${BOLD}http://$SERVER_IP${NC}"
echo -e "  ${CYAN}🔑 Адмін:    ${BOLD}http://$SERVER_IP/admin.html${NC}"
echo -e "  ${CYAN}📋 Логи:     ssh $SERVER journalctl -u kse-nmt -f${NC}"
echo -e "  ${CYAN}🔧 .env:     ssh $SERVER nano /opt/kse-nmt/.env${NC}"
echo -e "  ${CYAN}🗄️  БД:      ssh $SERVER ls -lh /var/lib/kse-nmt/${NC}"
echo ""
