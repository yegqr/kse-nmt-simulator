#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  KSE NMT — Перший запуск на новому Hetzner сервері
#
#  Запускати ОДИН РАЗ перед першим deploy.sh
#  Якщо на сервері вже є інші проєкти — безпечно,
#  скрипт питає перед кожною потенційно небезпечною дією.
#
#  Запуск з локальної машини:
#    ./deploy/setup_server.sh root@YOUR_SERVER_IP
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

ok()     { echo -e "  ${GREEN}✓  $*${NC}"; }
warn()   { echo -e "  ${YELLOW}⚠  $*${NC}"; }
danger() { echo -e "  ${RED}⚠  $*${NC}"; }
step()   { echo -e "\n${YELLOW}${BOLD}$*${NC}"; }
hr()     { echo -e "${CYAN}${BOLD}  ─────────────────────────────────────────${NC}"; }

ask() {
  # ask "Питання?" → повертає 0 якщо y/Y/Enter, 1 якщо n/N
  local prompt="$1"
  echo -en "  ${YELLOW}$prompt [Y/n]: ${NC}"
  read -r reply
  reply=${reply:-Y}
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ─── Якщо запущено локально з аргументом — передаємо на сервер ─
if [ "${1:-}" != "" ]; then
  echo -e "${YELLOW}${BOLD}Запускаю setup на $1...${NC}"
  ssh -t "$1" 'bash -s' < "$0"
  echo ""
  echo -e "${GREEN}${BOLD}  ✅ Setup завершено! Тепер запускай ./deploy.sh${NC}"
  exit 0
fi

# ════════════════════════════════════════════════════════════════
#  Далі виконується НА СЕРВЕРІ
# ════════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}${BOLD}  ╔══════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}${BOLD}  ║   🛠️   KSE NMT — Server Setup (Hetzner)    ║${NC}"
echo -e "${YELLOW}${BOLD}  ╚══════════════════════════════════════════════╝${NC}"
echo ""

if [ "$(id -u)" != "0" ]; then
  echo -e "${RED}  Потрібен root.${NC}"
  exit 1
fi

# ─── Крок 0: Перевірка поточного стану ───────────────────────
step "Крок 0/5 — Аналіз поточного сервера"
hr

# Перевіряємо Node.js
NODE_VER=$(node --version 2>/dev/null || echo "none")
echo -e "  Node.js:    ${CYAN}$NODE_VER${NC}"

# Перевіряємо чи зайнятий порт 3000
PORT_3000=$(ss -tlnp 2>/dev/null | grep ':3000 ' | awk '{print $NF}' || echo "")
if [ -n "$PORT_3000" ]; then
  danger "Порт 3000 вже зайнятий: $PORT_3000"
  warn "kse-nmt теж хоче порт 3000. Можливий конфлікт!"
  ask "Продовжити все одно?" || { echo "Скасовано."; exit 0; }
else
  ok "Порт 3000 вільний."
fi

# Перевіряємо інші nginx сайти
NGINX_SITES=$(ls /etc/nginx/sites-enabled/ 2>/dev/null | grep -v '^kse-nmt$' | grep -v '^default$' || echo "")
if [ -n "$NGINX_SITES" ]; then
  warn "На сервері є інші nginx сайти:"
  for s in $NGINX_SITES; do echo -e "    ${CYAN}• $s${NC}"; done
  ok "Вони НЕ будуть зачеплені (ми лише додаємо kse-nmt)."
fi

# ─── Крок 1: Системні пакети ──────────────────────────────────
step "Крок 1/5 — Базові пакети"
hr
apt-get update -qq
apt-get install -y -q curl gnupg ca-certificates nginx
ok "curl, nginx — встановлено/оновлено."

# ─── Крок 2: Node.js ──────────────────────────────────────────
step "Крок 2/5 — Node.js"
hr

if [ "$NODE_VER" != "none" ] && [[ "$NODE_VER" > "v17" ]]; then
  ok "Node.js $NODE_VER вже встановлено і підходить (>=18). Пропускаємо."
else
  if [ "$NODE_VER" != "none" ]; then
    danger "Знайдено Node.js $NODE_VER — потрібна версія >=18."
    danger "Якщо інші проєкти залежать від Node $NODE_VER, вони можуть зламатися!"
    warn "Рекомендую: використай nvm на сервері для керування версіями."
    ask "Все одно встановити Node.js 20 (замінить $NODE_VER)?" || {
      echo -e "  ${YELLOW}Пропущено. Встанови Node.js 20 вручну або через nvm.${NC}"
      echo -e "  ${CYAN}  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash${NC}"
      echo -e "  ${CYAN}  nvm install 20 && nvm use 20${NC}"
      # Продовжуємо setup без Node.js (деплой може зламатися пізніше)
    }
  fi

  if ask "Встановити Node.js 20 LTS?"; then
    echo "  → Завантажую NodeSource setup..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tail -3
    apt-get install -y nodejs
    ok "Node.js $(node --version), npm $(npm --version) — встановлено."
  fi
fi

# ─── Крок 3: Директорії ───────────────────────────────────────
step "Крок 3/5 — Директорії"
hr

mkdir -p /opt/kse-nmt
mkdir -p /var/lib/kse-nmt/data/uploads
chown -R www-data:www-data /var/lib/kse-nmt
chmod -R 755 /var/lib/kse-nmt
# www-data теж має читати код
chown -R www-data:www-data /opt/kse-nmt

ok "/opt/kse-nmt          ← код (deploy.sh оновлює при кожному деплої)"
ok "/var/lib/kse-nmt      ← БД + uploads (deploy.sh НІКОЛИ не чіпає)"

# ─── Крок 4: nginx ────────────────────────────────────────────
step "Крок 4/5 — nginx"
hr

if [ -f /etc/nginx/sites-enabled/kse-nmt ] || [ -f /etc/nginx/sites-available/kse-nmt ]; then
  ok "nginx config для kse-nmt вже існує — пропускаємо."
  ok "(deploy.sh оновить його якщо файл зміниться)"
else
  # Встановлюємо базовий config зараз
  # Фінальна версія прийде при першому deploy.sh
  cat > /etc/nginx/sites-available/kse-nmt << 'NGINX'
server {
    listen 80;
    server_name _;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-SafeExamBrowser-RequestHash $http_x_safeexambrowser_requesthash;
        proxy_set_header X-SafeExamBrowser-ConfigKeyHash $http_x_safeexambrowser_configkeyhash;
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }

    location /uploads/ {
        alias /var/lib/kse-nmt/data/uploads/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
}
NGINX

  # ТІЛЬКИ якщо default сайт веде на стандартну заглушку nginx — прибираємо
  DEFAULT_CONTENT=$(cat /etc/nginx/sites-enabled/default 2>/dev/null || echo "")
  if echo "$DEFAULT_CONTENT" | grep -q "Welcome to nginx"; then
    if ask "Прибрати стандартну nginx заглушку (Welcome to nginx)?"; then
      rm -f /etc/nginx/sites-enabled/default
      ok "Стандартна заглушка прибрана."
    fi
  else
    warn "default nginx сайт виглядає як справжній проєкт — не чіпаємо його."
  fi

  ln -sf /etc/nginx/sites-available/kse-nmt /etc/nginx/sites-enabled/kse-nmt
  nginx -t && systemctl reload nginx
  ok "nginx налаштовано: порт 80 → Node.js :3000"
fi

# ─── Крок 5: systemd service ──────────────────────────────────
step "Крок 5/5 — systemd сервіс"
hr

if [ -f /etc/systemd/system/kse-nmt.service ]; then
  ok "kse-nmt.service вже існує — пропускаємо."
  ok "(deploy.sh оновить його якщо файл зміниться)"
else
  cat > /etc/systemd/system/kse-nmt.service << 'SERVICE'
[Unit]
Description=KSE NMT Exam Simulator
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/kse-nmt
EnvironmentFile=/opt/kse-nmt/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StartLimitInterval=60s
StartLimitBurst=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=kse-nmt
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SERVICE

  systemctl daemon-reload
  systemctl enable kse-nmt
  ok "kse-nmt.service встановлено та увімкнено."
fi

# ─── Готово ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}  ║       ✅  Сервер готовий!                        ║${NC}"
echo -e "${GREEN}${BOLD}  ╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Що далі (з локальної машини):${NC}"
echo -e "  ${BOLD}  ./deploy.sh${NC}  — перший деплой"
echo ""
echo -e "  ${CYAN}Після деплою БД буде тут (назавжди):${NC}"
echo -e "  ${BOLD}  /var/lib/kse-nmt/exam.db${NC}       ← питання, відповіді"
echo -e "  ${BOLD}  /var/lib/kse-nmt/sessions.db${NC}   ← сесії"
echo -e "  ${BOLD}  /var/lib/kse-nmt/data/uploads/${NC} ← зображення"
echo ""
echo -e "  ${CYAN}Управління (на сервері):${NC}"
echo -e "  ${BOLD}  journalctl -u kse-nmt -f${NC}           ← логи"
echo -e "  ${BOLD}  systemctl status kse-nmt${NC}            ← статус"
echo -e "  ${BOLD}  systemctl restart kse-nmt${NC}           ← рестарт"
echo ""
