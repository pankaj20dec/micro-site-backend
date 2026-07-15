#!/usr/bin/env bash
# Recover nginx → Express → PostgreSQL on the droplet when /api returns 502/500.
# Run on the server:  bash scripts/fix-502-server.sh
set -euo pipefail

echo "==> 1) Proxy / nginx status"
if command -v nginx >/dev/null 2>&1; then
  sudo nginx -t
  sudo systemctl status nginx --no-pager -l | head -n 20 || true
  echo "--- nginx error log (last 40) ---"
  sudo tail -n 40 /var/log/nginx/error.log || true
else
  echo "nginx not found in PATH"
fi

echo
echo "==> 2) Listening ports"
sudo ss -tlnp | head -n 60 || true

echo
echo "==> 3) PostgreSQL"
if systemctl list-unit-files | grep -q postgresql; then
  sudo systemctl status postgresql --no-pager -l | head -n 25 || true
  sudo systemctl start postgresql || true
  sudo systemctl enable postgresql || true
else
  echo "No postgresql systemd unit found — check docker / managed DB"
fi

echo
echo "==> 4) Locate API app directory"
APP_DIR="${APP_DIR:-}"
if [[ -z "$APP_DIR" || ! -f "$APP_DIR/package.json" ]]; then
  APP_DIR=""
  for d in /var/www/micro-site-backend /var/www/fipo-backend /home/*/micro-site-backend /root/micro-site-backend /opt/micro-site-backend; do
    if [[ -f "$d/package.json" ]]; then
      APP_DIR="$d"
      break
    fi
  done
fi

if [[ -z "$APP_DIR" || ! -f "$APP_DIR/package.json" ]]; then
  echo "Could not auto-find backend directory. Re-run with:"
  echo "  APP_DIR=/path/to/micro-site-backend bash scripts/fix-502-server.sh"
  exit 1
fi

echo "Using APP_DIR=$APP_DIR"
cd "$APP_DIR"

echo
echo "==> 5) Apply migrations + restart API"
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
else
  echo "WARNING: no .env in $APP_DIR"
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "pm2 process list:"
  pm2 list || true
  npx prisma migrate deploy
  npx prisma generate
  pm2 restart all --update-env || pm2 start npm --name fipo-api -- start
  pm2 save || true
elif systemctl list-unit-files | grep -qiE 'fipo|micro-site|api'; then
  UNIT=$(systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -iE 'fipo|micro-site|api' | head -n1)
  echo "Restarting systemd unit: $UNIT"
  npx prisma migrate deploy
  npx prisma generate
  sudo systemctl restart "$UNIT"
else
  echo "No pm2/systemd app unit found — starting node directly on PORT=${PORT:-4000}"
  npx prisma migrate deploy
  npx prisma generate
  pkill -f "node src/index.js" || true
  nohup npm start >/var/log/fipo-api.log 2>&1 &
fi

echo
echo "==> 6) Local verification"
sleep 2
API_PORT="${PORT:-4000}"
curl -sS -i "http://127.0.0.1:${API_PORT}/api/health" | head -n 20 || true
curl -sS -i "http://127.0.0.1:${API_PORT}/api/site-settings/layout" | head -n 30 || true
curl -sS -i "http://127.0.0.1/api/site-settings/layout" | head -n 30 || true
curl -sS -i "http://127.0.0.1/api/site-settings/modals/site_disclaimer" | head -n 30 || true

echo
echo "Done. Expect HTTP 200 (or app JSON), not 502/500."
