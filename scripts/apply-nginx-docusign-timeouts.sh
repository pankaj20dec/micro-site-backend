#!/usr/bin/env bash
# Raise nginx proxy timeouts so DocuSign envelope create is not cut at 60s (504).
# Run on the droplet as root:
#   bash scripts/apply-nginx-docusign-timeouts.sh
set -euo pipefail

SNIPPET=/etc/nginx/snippets/fipo-long-timeouts.conf
mkdir -p /etc/nginx/snippets
cat > "$SNIPPET" <<'EOF'
proxy_connect_timeout 30s;
proxy_send_timeout 180s;
proxy_read_timeout 180s;
send_timeout 180s;
fastcgi_read_timeout 180s;
EOF
echo "Wrote $SNIPPET"

INCLUDE_LINE='include snippets/fipo-long-timeouts.conf;'
patched=0

shopt -s nullglob
for conf in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [[ -f "$conf" ]] || continue
  if grep -q 'fipo-long-timeouts.conf' "$conf"; then
    echo "Already included in $conf"
    continue
  fi
  if ! grep -q 'proxy_pass' "$conf"; then
    continue
  fi
  python3 - "$conf" "$INCLUDE_LINE" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
include = sys.argv[2]
text = path.read_text()
if include in text:
    raise SystemExit(0)
out = []
inserted = False
for line in text.splitlines(True):
    out.append(line)
    stripped = line.strip()
    if stripped.startswith("proxy_pass") and not inserted:
        indent = line[: len(line) - len(line.lstrip())]
        out.append(f"{indent}{include}\n")
        inserted = True
if inserted:
    path.write_text("".join(out))
    print(f"Patched {path}")
PY
  patched=$((patched + 1))
done

nginx -t
systemctl reload nginx
echo "nginx reloaded with 180s proxy timeouts."
echo "Retry Review Engagement Documents. If it still 504s, check: tail -n 50 /var/log/nginx/error.log"
