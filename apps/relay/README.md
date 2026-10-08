# ACAN AI relay

The demo site's sandbox has an AI chat. Each visitor's AI agent spends from **the
visitor's own** sandbox smart account, signs with the visitor's own agent key, and
asks for the visitor's own passkey when a payment needs approval. All of that runs in
the browser.

The only thing that cannot run in a browser is the AI provider's API key. This relay
holds it: it forwards a visitor's conversation to Groq with a **fixed** system prompt
and **fixed** tools, and returns the model's next message. It never holds wallet keys
and never moves money.

Limits, per UTC day: 50 messages per visitor (by IP address) and 1,000 for all visitors
together. The model's extra steps per answer are capped too. Change them with
`PER_VISITOR_DAILY` and `GLOBAL_DAILY`.

No dependencies: one file, `server.mjs`, Node 20 or newer.

## Run it on a VPS (Ubuntu or Debian)

**Quick way: one command.** Log in to the server, then:

```sh
curl -fsSL https://raw.githubusercontent.com/phoenix-2203/acan/master/apps/relay/deploy/install.sh -o install.sh
sudo bash install.sh YOUR-NAME.duckdns.org
```

It does steps 1 to 6 below, asks for the Groq key once (hidden while you paste),
and checks HTTPS at the end. The steps below are the same thing done by hand.


You need a DuckDNS name pointing at the server's public IP (e.g. `acan-ai.duckdns.org`)
and ports 80 and 443 open. Run these on the server.

**1. Node.js 22** (skip if `node -v` already prints v20 or newer and `which node`
prints `/usr/bin/node`):

```sh
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
sudo -E bash nodesource_setup.sh
sudo apt install -y nodejs
node -v
```

**2. The code:**

```sh
sudo apt install -y git
sudo git clone https://github.com/phoenix-2203/acan.git /opt/acan
```

**3. The Groq key** (only on the server, readable only by root):

```sh
sudo mkdir -p /etc/acan
sudo sh -c 'umask 077; printf "GROQ_API_KEY=%s\n" "PASTE_YOUR_KEY_HERE" > /etc/acan/relay.env'
```

**4. Start the relay as a service:**

```sh
sudo cp /opt/acan/apps/relay/deploy/acan-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now acan-relay
curl -s http://127.0.0.1:8787/health
```

The last line should print `{"ok":true,...}`.

**5. HTTPS with Caddy** (it gets and renews the certificate on its own). Install it
([caddyserver.com/docs/install](https://caddyserver.com/docs/install)):

```sh
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Then point it at the relay. Replace `acan-ai.duckdns.org` with your name:

```sh
sed 's/acan-ai.duckdns.org/YOUR-NAME.duckdns.org/' /opt/acan/apps/relay/deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If the server runs a firewall (`sudo ufw status` says active):

```sh
sudo ufw allow 80,443/tcp
```

**6. Check from anywhere:** open `https://YOUR-NAME.duckdns.org/health` in a browser.
It should show `{"ok":true,...}` with a padlock.

Then put the address in `deployments/testnet.json` as `"aiRelay"` and push. The
demo site's sandbox shows the AI chat from then on.

## Day to day

- Logs: `sudo journalctl -u acan-relay -f`
- Update after a `git push`: `sudo git -C /opt/acan pull && sudo systemctl restart acan-relay`
- Usage today: `curl -s http://127.0.0.1:8787/health`
- Stop the AI chat: `sudo systemctl stop acan-relay` (the rest of the site keeps working)

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GROQ_API_KEY` | (required) | Groq key, in `/etc/acan/relay.env` |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Model |
| `PER_VISITOR_DAILY` | 50 | Messages per visitor per UTC day |
| `GLOBAL_DAILY` | 1000 | Messages for everyone per UTC day |
| `ALLOWED_ORIGINS` | `https://phoenix-2203.github.io` + localhost | Sites allowed to call the relay |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Where it listens (behind Caddy) |
| `TRUST_PROXY` | `1` in the service | Read the visitor's IP from Caddy's `X-Forwarded-For` |

## Also serve the demo site from this server

After the relay is installed, a second DuckDNS name (pointing at the same IP) can
serve the demo site:

```sh
sudo bash /opt/acan/apps/relay/deploy/install-site.sh acan-demo.duckdns.org
```

The site's files come from the `site-dist` branch, which the "Demo site" workflow
rebuilds on every push; the server checks for a new build every 5 minutes. The script
also adds the new address to the relay's `ALLOWED_ORIGINS`. GitHub Pages keeps working.
