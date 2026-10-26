# Self-hosted Signal and TURN

This bundle runs the OpenBot remote stack on one Linux server. It has no Docker and no
Cloudflare DNS API token. Caddy gets the certificates with ACME HTTP-01, so the ACME server
answers the challenge on port 80 of your host.

The bundle has these parts:

| Part | Path | Use |
| --- | --- | --- |
| Caddy configuration | `Caddyfile` | The TLS front. It proxies to the Signal service and to the account service. |
| TURN configuration | `coturn/turnserver.conf` | The TURN service. It relays the media of a connection. |
| TURN runtime script | `coturn/openbot-turn-config.sh` | It writes the secret and the certificate into the memory disk. |
| Systemd units | `systemd/` | One unit for each service. |
| Environment examples | `env/` | The secrets. The real files live in `/etc/openbot`. |

The other deployment of the same services is the Docker deployment in `remote/`. It uses a
Cloudflare DNS API token for the certificates. The guide [Self-hosted remote access](../../docs/self-hosting.md)
describes that deployment and the keys of the account service. Read it before you start. This
bundle changes the way the certificates arrive, and it adds the account service to the same
server.

## What you need

- Ubuntu 24.04 or Debian 12 with systemd.
- A static public IPv4 address.
- Three names that point at the server: `signal.example.com`, `api.example.com` and
  `turn.example.com`. Use your own names.
- An SMTP account that accepts TLS on port 465. The sign-in code comes from it.
- Bun and Git.
- The packages `coturn` and `caddy`.

The examples in this file use `example.com` and the address `203.0.113.10`. Change every value.

## The ports and the firewall

| Port | Protocol | Use |
| --- | --- | --- |
| 80 | TCP | The challenge of ACME. Caddy sends the other requests to HTTPS. |
| 443 | TCP | The TLS of Caddy. It serves the Signal service and the account service. |
| 3478 | TCP and UDP | The TURN service, without TLS. |
| 5349 | TCP | The TURN service, with TLS. |
| 49152-65535 | UDP | The relay ports of the TURN service. |

The services keep their own ports on the loopback address. Only Caddy and coturn open ports.

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
```

A relay needs the ports 49152 to 65535 for UDP. A closed port breaks the media of a connection
that has no direct path.

## Install

### 1. The packages and the tools

```sh
sudo apt-get update
sudo apt-get install -y coturn curl git
```

Install Bun, and put it in `/usr/local/bin`, because the units call it there:

```sh
curl -fsSL https://bun.sh/install | bash
sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
```

Install Caddy. The Debian package puts the binary in `/usr/bin/caddy` and starts it with the
unit `caddy.service`. The official repository puts the binary in `/usr/local/bin/caddy`. The unit
of this bundle uses `/usr/local/bin/caddy`. Change the path in the unit when you use the Debian
package, or use the unit `caddy.service` of the package and keep its file at
`/etc/caddy/Caddyfile`.

```sh
sudo apt-get install -y caddy
```

### 2. The server user and the repository

```sh
sudo useradd --system --home-dir /var/lib/openbot --create-home --shell /usr/sbin/nologin openbot
sudo install -d -m 0755 /opt/openbot
sudo git clone https://github.com/nightly-labs/openbot.git /opt/openbot/openbot
cd /opt/openbot/openbot
bun install --frozen-lockfile
```

The coturn package makes the user `turnserver`. The unit of the TURN service uses it.

### 3. The keys and the secrets

Make the ticket key pair and the secrets as step 1 of [the guide](../../docs/self-hosting.md)
describes. The command in that guide prints `REMOTE_TICKET_KEY_ID`, `REMOTE_TICKET_PRIVATE_JWK`
and `REMOTE_TICKET_PUBLIC_JWKS`.

Make each other secret with `openssl rand -base64 48`. You need four values:

| Secret | Where |
| --- | --- |
| `REMOTE_AUTH_WEBHOOK_SECRET` | The account service and the Signal service. |
| `REMOTE_SESSION_SECRET` | The Signal service. |
| `TURN_SHARED_SECRET` | The Signal service and the TURN service. |
| `REMOTE_METRICS_TOKEN` | The Signal service. |

Each value must have at least 32 bytes.

### 4. The account service

The account service is the Worker of `apps/auth-api`. The repository runs it on Cloudflare
Workers. This bundle runs the same Worker on this server, so the account data stays here.

Change the `vars` section at the top level of `apps/auth-api/wrangler.jsonc`. Do not change the
`env` section.

- `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USERNAME`, `EMAIL_FROM`: your SMTP account.
- `REMOTE_TICKET_KEY_ID`: the key ID from step 3.
- `REMOTE_SIGNAL_URL`: `wss://signal.example.com/v1/signal`.
- `REMOTE_AUTH_WEBHOOK_URL`: `https://signal.example.com/internal/auth-events`.
- `HOSTED_SERVERS_ENABLED`: `"false"`.

Build the Worker and apply the migrations to the local database:

```sh
cd /opt/openbot/openbot
bun run --cwd apps/auth-api build
bun run --cwd apps/auth-api db:migrate:local
```

The local database and the local objects stay in `apps/auth-api/.wrangler/state`. The local
runtime has no cron trigger, so the retry of the outbox never runs. Each request does its first
attempt itself.

### 5. The environment files

The files hold the secrets. They live in `/etc/openbot`, and they never go into the repository.
The Git rule `deploy/self-host/env/*.env` ignores a copy that stays in the repository.

```sh
sudo install -d -m 0750 -o root -g openbot /etc/openbot
sudo install -m 0640 -o root -g openbot deploy/self-host/env/signal.env.example \
  /etc/openbot/signal.env
sudo install -m 0640 -o root -g openbot deploy/self-host/env/auth-api.env.example \
  /etc/openbot/auth-api.env
sudo install -d -m 0750 -o root -g turnserver /etc/openbot
sudo install -m 0640 -o root -g turnserver deploy/self-host/env/coturn.env.example \
  /etc/openbot/coturn.env
sudoedit /etc/openbot/signal.env
sudoedit /etc/openbot/auth-api.env
sudoedit /etc/openbot/coturn.env
```

Fill in every value that says `replace-with`. The account service and the Signal service use the
same `REMOTE_AUTH_WEBHOOK_SECRET`. The Signal service and the TURN service use the same
`TURN_SHARED_SECRET`.

The local runtime of the account service writes the secrets into the build output, under
`apps/auth-api/dist`. Keep that directory private.

### 6. The configurations and the units

Change the three names and the address of the ACME account in the Caddy file before you copy it.

```sh
cd /opt/openbot/openbot
sudo install -m 0644 deploy/self-host/Caddyfile /etc/caddy/Caddyfile
sudo install -d -m 0750 -o root -g turnserver /etc/openbot
sudo install -m 0644 deploy/self-host/coturn/turnserver.conf /etc/openbot/turnserver.conf
sudo install -m 0755 deploy/self-host/coturn/openbot-turn-config.sh /usr/local/sbin/openbot-turn-config
sudo install -m 0644 deploy/self-host/systemd/*.service deploy/self-host/systemd/*.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
```

The Caddy user must own the storage of the certificates:

```sh
sudo install -d -m 0750 -o caddy -g caddy /var/lib/caddy
```

### 7. Start the services

```sh
sudo systemctl enable --now openbot-signal.service
sudo systemctl enable --now openbot-auth-api.service
sudo systemctl enable --now openbot-caddy.service
sudo systemctl enable --now openbot-turn-config.service openbot-coturn.service
sudo systemctl enable --now openbot-turn-config.timer
```

Caddy needs some time for the first certificate. The TURN service waits five minutes for that
certificate. If it does not start, run this command again after Caddy has the certificate:

```sh
sudo systemctl start openbot-turn-config.service openbot-coturn.service
```

### 8. Check the services

Each command must answer `200`:

```sh
curl -fsS https://signal.example.com/health/ready
curl -fsS https://api.example.com/health/live
curl -fsS https://api.example.com/.well-known/jwks.json
```

The TURN service answers on the loopback address:

```sh
sudo turnutils_stunclient 127.0.0.1 -p 3478
```

## Use the app

Do these steps on each computer that hosts a server or that connects to one.

1. Sign out in the app if you signed in to `openbot.run` before. The app sends the old session
   token to your service otherwise.
2. Start the app with the two variables. The value of `OPENBOT_REMOTE_SIGNAL_URL` must be equal to
   the `REMOTE_SIGNAL_URL` of the account service.

   macOS:

   ```sh
   OPENBOT_AUTH_API_URL=https://api.example.com \
   OPENBOT_REMOTE_SIGNAL_URL=wss://signal.example.com/v1/signal \
   /Applications/OpenBot.app/Contents/MacOS/OpenBot
   ```

   Linux:

   ```sh
   OPENBOT_AUTH_API_URL=https://api.example.com \
   OPENBOT_REMOTE_SIGNAL_URL=wss://signal.example.com/v1/signal \
   ./OpenBot-<version>-x86_64.AppImage
   ```

3. Sign in with an email address. The code comes from your SMTP account.
4. Connect a provider, as on a hosted server.

## The certificates

Caddy gets the certificate of each name with ACME HTTP-01. The ACME server sends a request to
port 80 of your host, and Caddy answers it. Caddy keeps the certificate and the ACME account in
`/var/lib/caddy`. Caddy replaces a certificate before it ends, and it needs no action from you.

The TURN service cannot read the storage of Caddy, because the user of Caddy owns the files with
the mode 0600. The script `openbot-turn-config` copies the certificate of the TURN domain into
`/run/openbot`. The timer `openbot-turn-config.timer` runs the script each day, and the script
tells coturn to read the new certificate.

## The secrets

Every secret is a value in an environment file. No secret is in the repository, and no secret is
in a command that the other users can read.

| File | Holds | Group |
| --- | --- | --- |
| `/etc/openbot/signal.env` | The secrets of the Signal service. | `openbot` |
| `/etc/openbot/auth-api.env` | The secrets of the account service. | `openbot` |
| `/etc/openbot/coturn.env` | The secret of the TURN service. | `turnserver` |

The script of the TURN service writes the secret into `/run/openbot/turnserver.conf`. That file
is in a memory disk, and it has the mode 0600.

## Updates

```sh
cd /opt/openbot/openbot
sudo git pull
bun install --frozen-lockfile
bun run --cwd apps/auth-api build
sudo systemctl restart openbot-signal.service openbot-auth-api.service
```

A restart of the Signal service closes the WebSocket connections. The clients connect again, and
an active call stays up.

## Not confirmed

- The bundle was not run on a Linux server. The Caddy file was checked with the Caddy binary, and
  the TURN configuration was checked with the coturn binary. The units were not started.
- The account service on this server is new. The repository runs it on Cloudflare Workers, and
  [the guide](../../docs/self-hosting.md) describes that way. The local runtime has no cron
  trigger, and the rate limits of the Worker behave in another way there.
- The firewall rules above use `ufw`. Another firewall needs the same ports.
- The certificate of the TURN domain is a copy. A renewal of the certificate in Caddy does not
  reach coturn before the timer runs.
