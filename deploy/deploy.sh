#!/usr/bin/env bash
# deploy.sh — Deploy KSE NMT Simulator to Hetzner server
# Usage: ./deploy/deploy.sh user@your-server-ip
# Example: ./deploy/deploy.sh root@123.456.789.012
#
# Prerequisites on server:
#   apt install nodejs npm nginx
#   node --version  # should be >= 18

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 user@server-ip"
  exit 1
fi

SERVER="$1"
REMOTE_DIR="/opt/kse-nmt"
DATA_DIR="/var/lib/kse-nmt"

echo "==> Deploying to $SERVER:$REMOTE_DIR"

# 1. Create remote directory
ssh "$SERVER" "mkdir -p $REMOTE_DIR $DATA_DIR/data/uploads"

# 2. Sync files (exclude node_modules, .env, data, db files)
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'data/' \
  --exclude '*.db' \
  --exclude '*.db-shm' \
  --exclude '*.db-wal' \
  --exclude 'deploy/deploy.sh' \
  --exclude '.git' \
  --exclude 'csv_export' \
  ./ "$SERVER:$REMOTE_DIR/"

# 3. Install dependencies on server
ssh "$SERVER" "cd $REMOTE_DIR && npm install --omit=dev"

# 4. Set up .env if not exists
ssh "$SERVER" "
  if [ ! -f $REMOTE_DIR/.env ]; then
    cp $REMOTE_DIR/.env.example $REMOTE_DIR/.env
    echo ''
    echo '!!! IMPORTANT: Edit $REMOTE_DIR/.env and set your values !!!'
    echo ''
  fi
"

# 5. Install nginx config
ssh "$SERVER" "
  cp $REMOTE_DIR/deploy/nginx.conf /etc/nginx/sites-available/kse-nmt
  ln -sf /etc/nginx/sites-available/kse-nmt /etc/nginx/sites-enabled/kse-nmt
  nginx -t && systemctl reload nginx
"

# 6. Install and start systemd service
ssh "$SERVER" "
  cp $REMOTE_DIR/deploy/kse-nmt.service /etc/systemd/system/kse-nmt.service
  systemctl daemon-reload
  systemctl enable kse-nmt
  systemctl restart kse-nmt
  systemctl status kse-nmt --no-pager
"

echo ""
echo "==> Deploy complete!"
echo "==> Edit $REMOTE_DIR/.env on the server to set SESSION_SECRET, DATA_DIR, etc."
echo "==> Update YOUR_DOMAIN in /etc/nginx/sites-available/kse-nmt"
echo "==> Run: sudo systemctl restart kse-nmt after editing .env"
