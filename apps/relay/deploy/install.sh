#!/usr/bin/env bash
# One-command setup of the ACAN AI relay on an Ubuntu or Debian server.
#
#   curl -fsSL https://raw.githubusercontent.com/phoenix-2203/acan/master/apps/relay/deploy/install.sh -o install.sh
#   sudo bash install.sh acan-ai.duckdns.org
#
# It installs Node.js 22 (if needed), the ACAN code in /opt/acan, the relay as a
# service, and Caddy for HTTPS. It asks for the Groq API key once (typing is
# hidden) and stores it in /etc/acan/relay.env, readable only by root.
# Safe to run again: it updates the code and keeps the saved key unless you
# choose to replace it.
set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/phoenix-2203/acan.git"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo bash install.sh $DOMAIN"
[[ "$DOMAIN" =~ ^[a-z0-9-]+\.duckdns\.org$ ]] || die "give your DuckDNS name, e.g.: sudo bash install.sh acan-ai.duckdns.org"
# Read the OS in a subshell: /etc/os-release defines its own NAME, VERSION, etc.
os="$( (. /etc/os-release 2>/dev/null; echo "${ID:-} ${ID_LIKE:-}|${PRETTY_NAME:-unknown}") )"
case "${os%%|*}" in
  *debian*|*ubuntu*) ;;
  *) die "this installer supports Ubuntu and Debian only (found: ${os#*|})" ;;
esac
command -v systemctl >/dev/null || die "systemd is required"

say "1/6  Basic tools"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

say "2/6  Node.js"
node_ok() { [ -x /usr/bin/node ] && [ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi
node_ok || die "Node.js 20+ is not at /usr/bin/node"
echo "Node $(/usr/bin/node -v)"

say "3/6  ACAN code in /opt/acan"
if [ -d /opt/acan/.git ]; then
  git -C /opt/acan pull --ff-only
else
  git clone --depth 1 "$REPO" /opt/acan
fi

say "4/6  Groq API key"
mkdir -p /etc/acan
replace=y
if [ -s /etc/acan/relay.env ]; then
  read -r -p "A Groq key is already saved. Replace it? [y/N] " replace </dev/tty || replace=n
fi
if [[ "$replace" =~ ^[Yy]$ ]]; then
  key=""
  while [ -z "$key" ]; do
    read -r -s -p "Paste your Groq API key (it will not show) and press Enter: " key </dev/tty
    echo
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [[ "$key" =~ ^gsk_ ]] || { echo "That does not look like a Groq key (they start with gsk_). Try again."; key=""; }
  done
  (umask 077; printf 'GROQ_API_KEY=%s\n' "$key" >/etc/acan/relay.env)
  unset key
fi
chmod 600 /etc/acan/relay.env

say "5/6  Relay service"
cp /opt/acan/apps/relay/deploy/acan-relay.service /etc/systemd/system/acan-relay.service
systemctl daemon-reload
systemctl enable acan-relay >/dev/null
systemctl restart acan-relay
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8787/health || { journalctl -u acan-relay -n 30 --no-pager; die "the relay did not start (log above)"; }
echo

say "6/6  HTTPS with Caddy for $DOMAIN"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
# One file per ACAN site, all imported by the main Caddyfile (install-site.sh adds the demo site).
sed "s/acan-ai\.duckdns\.org/$DOMAIN/" /opt/acan/apps/relay/deploy/Caddyfile >/etc/caddy/acan-relay.caddy
echo "import /etc/caddy/acan-*.caddy" >/etc/caddy/Caddyfile
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80,443/tcp
fi
systemctl enable caddy >/dev/null
systemctl restart caddy

echo "Waiting for the HTTPS certificate (up to a minute)…"
for _ in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
    printf '\n\033[32mDONE. Open https://%s/health in your browser: it should say "ok":true.\033[0m\n' "$DOMAIN"
    exit 0
  fi
  sleep 2
done
myip="$(curl -fsS -4 https://api.ipify.org 2>/dev/null || echo unknown)"
dnsip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
echo
echo "The relay runs, but https://$DOMAIN is not answering yet."
echo "  This server's IP:       $myip"
echo "  $DOMAIN points to:  ${dnsip:-nothing}"
[ "$myip" = "${dnsip:-}" ] || echo "  -> These differ: on duckdns.org, set the IP of $DOMAIN to $myip."
echo "  Also check that ports 80 and 443 are open in your VPS provider's firewall."
echo "  Caddy's log: journalctl -u caddy -n 30 --no-pager"
exit 1
