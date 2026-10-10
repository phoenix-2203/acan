#!/usr/bin/env bash
# Serve the ACAN demo site from this server too, at a second DuckDNS name.
# Run install.sh (the AI relay) first. Then:
#
#   sudo bash /opt/acan/apps/relay/deploy/install-site.sh acan-demo.duckdns.org
#
# The site's files come from the repo's site-dist branch, which GitHub Actions
# rebuilds on every push; this server checks for a new build every 5 minutes.
# It also lets the new address use the AI relay.
set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/phoenix-2203/acan.git"
WWW=/var/www/acan-site
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo"
[[ "$DOMAIN" =~ ^[a-z0-9-]+\.duckdns\.org$ ]] || die "give the site's DuckDNS name, e.g.: sudo bash install-site.sh acan-demo.duckdns.org"
command -v caddy >/dev/null && [ -s /etc/acan/relay.env ] || die "run install.sh (the AI relay) first"

say "1/4  Site files from the site-dist branch"
if [ -d "$WWW/.git" ]; then
  git -C "$WWW" fetch -q --depth 1 origin site-dist
  git -C "$WWW" reset -q --hard FETCH_HEAD
else
  rm -rf "$WWW"
  git clone -q --depth 1 --branch site-dist "$REPO" "$WWW"
fi
[ -f "$WWW/index.html" ] || die "no index.html in the site-dist branch"
git -C "$WWW" log --oneline -1

say "2/4  Update every 5 minutes"
cat >/etc/systemd/system/acan-site-update.service <<UNIT
[Unit]
Description=Update the ACAN demo site from the site-dist branch
After=network-online.target
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'git -C $WWW fetch -q --depth 1 origin site-dist && git -C $WWW reset -q --hard FETCH_HEAD'
UNIT
cat >/etc/systemd/system/acan-site-update.timer <<UNIT
[Unit]
Description=Update the ACAN demo site every 5 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now acan-site-update.timer >/dev/null

say "3/4  Let https://$DOMAIN use the AI relay"
origins="https://phoenix-2203.github.io,https://$DOMAIN"
if grep -q '^ALLOWED_ORIGINS=' /etc/acan/relay.env; then
  sed -i "s#^ALLOWED_ORIGINS=.*#ALLOWED_ORIGINS=$origins#" /etc/acan/relay.env
else
  echo "ALLOWED_ORIGINS=$origins" >>/etc/acan/relay.env
fi
systemctl restart acan-relay

say "4/4  HTTPS with Caddy for $DOMAIN"
cat >/etc/caddy/acan-site.caddy <<CADDY
$DOMAIN {
	handle_path /cosigner/* {
		reverse_proxy 127.0.0.1:8788
	}
	root * $WWW
	encode zstd gzip
	@git path /.git /.git/*
	respond @git 404
	header /assets/* Cache-Control "public, max-age=31536000, immutable"
	header / Cache-Control "no-cache"
	header /index.html Cache-Control "no-cache"
	file_server
}
CADDY
echo "import /etc/caddy/acan-*.caddy" >/etc/caddy/Caddyfile
[ -s /etc/caddy/acan-relay.caddy ] || die "/etc/caddy/acan-relay.caddy is missing: run install.sh again first"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; die "Caddy rejected the configuration (above)"; }
systemctl reload caddy || systemctl restart caddy

echo "Waiting for the HTTPS certificate (up to a minute)…"
for _ in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/" 2>/dev/null | grep -q "ACAN"; then
    printf '\n\033[32mDONE. Open https://%s/ in your browser.\033[0m\n' "$DOMAIN"
    exit 0
  fi
  sleep 2
done
myip="$(curl -fsS -4 https://api.ipify.org 2>/dev/null || echo unknown)"
dnsip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
echo
echo "The site is set up, but https://$DOMAIN is not answering yet."
echo "  This server's IP:  $myip"
echo "  $DOMAIN points to:  ${dnsip:-nothing}"
[ "$myip" = "${dnsip:-}" ] || echo "  -> These differ: on duckdns.org, set the IP of $DOMAIN to $myip."
echo "  Caddy's log: journalctl -u caddy -n 30 --no-pager"
exit 1
