#!/usr/bin/env bash
# Raise nginx proxy timeouts so DocuSign envelope create is not cut at 60s (504).
# Also raise upload body size (default 1m rejects a 1.2MB witness JPG).
# Run on the droplet as root:
#   bash scripts/apply-nginx-docusign-timeouts.sh
set -euo pipefail

mkdir -p /etc/nginx/conf.d /etc/nginx/snippets
cat > /etc/nginx/conf.d/fipo-uploads.conf <<'EOF'
# Witness / PMI evidence uploads. Nginx default is 1m and Firefox shows NetworkError.
client_max_body_size 20m;
EOF
echo "Wrote /etc/nginx/conf.d/fipo-uploads.conf"

SNIPPET=/etc/nginx/snippets/fipo-long-timeouts.conf
cat > "$SNIPPET" <<'EOF'
    proxy_connect_timeout 30s;
proxy_send_timeout 180s;
proxy_read_timeout 180s;
send_timeout 180s;
fastcgi_read_timeout 180s;
client_max_body_size 20m;
EOF
echo "Wrote $SNIPPET"

INCLUDE_LINE='include snippets/fipo-long-timeouts.conf;'

shopt -s nullglob
for conf in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf /etc/nginx/nginx.conf; do
  [[ -f "$conf" ]] || continue
  [[ "$(basename "$conf")" == "fipo-uploads.conf" ]] && continue
  python3 - "$conf" "$INCLUDE_LINE" <<'PY'
import re
import sys
from pathlib import Path
path = Path(sys.argv[1])
include = sys.argv[2]
text = path.read_text()
original = text
if "proxy_pass" in text and include not in text:
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
        text = "".join(out)
        print(f"Patched timeouts in {path}")

# Location/server blocks often override the http-level 20m with nginx's 1m default.
if re.search(r"\bserver\s*\{", text) and "client_max_body_size" not in text:
    text, n = re.subn(
        r"(server\s*\{)",
        r"\1\n    client_max_body_size 20m;",
        text,
        count=1,
    )
    if n:
        print(f"Set client_max_body_size in {path}")
elif "client_max_body_size 1m" in text:
    text = text.replace("client_max_body_size 1m", "client_max_body_size 20m")
    print(f"Raised 1m upload limit in {path}")

if text != original:
    path.write_text(text)
PY
done

nginx -t
systemctl reload nginx
echo "nginx reloaded with 180s proxy timeouts and 20m upload limit."
echo "Retry the witness Photo ID / proof of address upload."
echo "If it still fails, check: grep -i 'client intended to send too large body' /var/log/nginx/error.log | tail"
