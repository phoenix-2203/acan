#!/usr/bin/env bash
# Adds the hosted provenance co-signer to the demo-site server (after the relay
# and the site are installed: apps/relay/deploy/install.sh and install-site.sh).
#
#   sudo bash /opt/acan/apps/cosigner/deploy/install.sh acan-demo.duckdns.org
#
# It updates /opt/acan, makes the co-signer key once (kept in
# /etc/acan/cosigner.env, readable only by root), runs the service on
# 127.0.0.1:8788, and serves it at https://<site>/cosigner. Safe to run again.
set -euo pipefail

DOMAIN="${1:-}"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo bash $0 $DOMAIN"
[[ "$DOMAIN" =~ ^[a-z0-9-]+\.duckdns\.org$ ]] || die "give the site's DuckDNS name, e.g.: sudo bash $0 acan-demo.duckdns.org"
[ -d /opt/acan/.git ] || die "/opt/acan is missing: install the relay first"
[ -s /etc/caddy/acan-site.caddy ] || die "/etc/caddy/acan-site.caddy is missing: run apps/relay/deploy/install-site.sh first"

say "1/4  Update the ACAN code"
git -C /opt/acan pull --ff-only
[ -s /opt/acan/apps/cosigner/deploy/hosted-cosigner.mjs ] || die "the co-signer bundle is missing from the code"

say "2/4  Co-signer key"
if [ ! -s /etc/acan/cosigner.env ]; then
  secret="$(/usr/bin/node /opt/acan/apps/cosigner/deploy/hosted-cosigner.mjs --new-secret)"
  [[ "$secret" =~ ^S[A-Z2-7]{55}$ ]] || die "could not make a co-signer key"
  (umask 077; printf 'COSIGNER_SECRET=%s\n' "$secret" >/etc/acan/cosigner.env)
  unset secret
  echo "New co-signer key saved in /etc/acan/cosigner.env"
else
  echo "Keeping the existing co-signer key"
fi
origins="$(grep -m1 '^ALLOWED_ORIGINS=' /etc/acan/relay.env 2>/dev/null | cut -d= -f2- || true)"
[ -n "$origins" ] || origins="https://phoenix-2203.github.io,https://$DOMAIN"
sed -i '/^ALLOWED_ORIGINS=/d' /etc/acan/cosigner.env
echo "ALLOWED_ORIGINS=$origins" >>/etc/acan/cosigner.env
chmod 600 /etc/acan/cosigner.env

say "3/4  Co-signer service"
cp /opt/acan/apps/cosigner/deploy/acan-cosigner.service /etc/systemd/system/acan-cosigner.service
systemctl daemon-reload
systemctl enable acan-cosigner >/dev/null
systemctl restart acan-cosigner
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS http://127.0.0.1:8788/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8788/health || { journalctl -u acan-cosigner -n 30 --no-pager; die "the co-signer did not start (log above)"; }
echo

say "4/4  Serve it at https://$DOMAIN/cosigner"
if ! grep -q 'handle_path /cosigner/\*' /etc/caddy/acan-site.caddy; then
  # Insert the route right after the site's opening line.
  sed -i "0,/{\$/s//{\n\thandle_path \/cosigner\/* {\n\t\treverse_proxy 127.0.0.1:8788\n\t}/" /etc/caddy/acan-site.caddy
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; die "Caddy rejected the configuration (above)"; }
systemctl reload caddy || systemctl restart caddy
sleep 2
if curl -fsS "https://$DOMAIN/cosigner/health"; then
  printf '\n\033[32mDONE. The co-signer answers at https://%s/cosigner/health\033[0m\n' "$DOMAIN"
else
  die "https://$DOMAIN/cosigner/health does not answer yet; Caddy's log: journalctl -u caddy -n 30 --no-pager"
fi
