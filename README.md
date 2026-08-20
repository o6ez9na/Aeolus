# Aeolus

Master VPN panel. Operators manage OpenVPN exit nodes from one place; clients get a
config that routes them out through whichever node they are granted.

## Layout

| Path | Role |
| --- | --- |
| `panel/backend` | FastAPI control plane, Postgres, JWT auth, PKI |
| `panel/frontend` | React (JS) web panel served by nginx |
| `anemoi` | node agent: runs on each OpenVPN host, speaks gRPC + mTLS back to the panel |

| `moirai` | client-facing config/subscription distribution |

The panel host is itself a node: it runs OpenVPN alongside the control plane and is
registered with `role = master`, so a client can connect to the panel and exit there.
It gets its own `anemoi` agent rather than a special code path, so the panel talks to
the local node exactly the way it talks to remote ones.

## Install with one command

On a fresh Debian or Ubuntu box, as root. It asks for a language, then whether
this machine is the panel or a node, installs Docker if missing, checks that
containers can actually reach the package mirrors, and brings the stack up:

```sh
curl -fsSL https://raw.githubusercontent.com/o6ez9na/Aeolus/main/scripts/install.sh | sudo bash
```

Non-interactive:

```sh
# the hub: web UI, database, the endpoint clients and nodes dial
curl -fsSL .../install.sh | sudo AEOLUS_DOMAIN=vpn.example.com bash -s -- panel

# an exit node, reporting to that panel
curl -fsSL .../install.sh | sudo AEOLUS_PANEL_DOMAIN=vpn.example.com \
  AEOLUS_NODE_NAME=frankfurt-01 AEOLUS_NODE_SUBNETS=192.168.5.0/24 bash -s -- node
```

The panel generates its own secrets on first run and prints the admin password.
Running the installer again updates the tree and rebuilds the containers without
touching `.env` — `AEOLUS_PKI_SECRET` is what every stored private key is
encrypted with, and regenerating it would make the whole PKI unreadable.

A node prints the fingerprint of the key it generated and waits. It receives
nothing — no certificate, no address, no configuration — until an operator
accepts that fingerprint in the panel under **узлы → заявки**. Comparing the two
strings is the only thing separating your mesh from anyone else who knows the
domain.

Ports to leave open: panel `80`, `443`, `1194/udp`, `8443/tcp` (clients),
`1195/udp` (nodes) and `50051/tcp` (agents); a node needs no inbound port at
all beyond the VPN it serves.

Set `AEOLUS_LANG=ru` (or `en`) to skip the language question.

### If the build fails with "no such package"

That is not a missing package on the host — it is the *build container* failing
to fetch the Alpine index, so apk ends up with no index and reports every
package as missing:

```
WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.22/main: temporary error
ERROR: unable to select packages: openvpn (no such package)
```

Almost always docker has no usable DNS: the provider's resolver mangles the
CDN, or the host has IPv6 that containers cannot use. The installer checks for
this before building and offers to point docker at public resolvers; by hand it
is:

```sh
echo '{ "dns": ["1.1.1.1", "8.8.8.8"] }' > /etc/docker/daemon.json
systemctl restart docker
```

The image build also retries and falls back to other mirrors on its own, since
these failures are often just a bad minute at the CDN.

## Run it by hand

```sh
cp .env.example .env
# fill AEOLUS_SECRET_KEY (openssl rand -hex 32), POSTGRES_PASSWORD,
# and AEOLUS_FIRST_ADMIN_PASSWORD
docker compose up -d --build
```

Panel: <http://localhost:8080>. The API is same-origin under `/api/v1`, proxied by
nginx to the backend, so no CORS setup is needed.

### With a domain and HTTPS

Point an A record at the host, set `AEOLUS_DOMAIN` in `.env`, then bring the stack up
with the production overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Caddy obtains a Let's Encrypt certificate, redirects HTTP to HTTPS and becomes the
only published port; Postgres, the API and nginx stay on the internal network. Serve
the panel over plain HTTP only on a loopback interface — the login sends a password
and the API sends bearer tokens.

The bootstrap admin is created on first startup only, while the users table is
empty. Clear `AEOLUS_FIRST_ADMIN_PASSWORD` once you have logged in.

## Backend, without Docker

```sh
cd panel/backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # fill AEOLUS_SECRET_KEY
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload
```

API docs at <http://localhost:8000/docs>.

## Frontend, without Docker

```sh
cd panel/frontend
npm install
npm run dev   # proxies /api to http://localhost:8000
```

## Auth model

- Access token: JWT, 15 min, kept in memory in the browser only.
- Refresh token: JWT, 30 days, one row per issue in `refresh_tokens` so sessions can
  be revoked server-side. Rotated on every use; replaying a spent token revokes every
  session for that user.
- Roles: `viewer` < `operator` < `admin`, enforced by `require_role` dependencies.
- Passwords: Argon2id, rehashed on login when the parameters change.

## Status

This is a control plane and nothing else so far. **No VPN traffic passes through
anything here yet**: there is no OpenVPN process, no PKI, no agent. Node status and
traffic counters are columns waiting to be filled, so they read `unknown` and zero.

Done: auth and users, node and client CRUD, the web panel, the Docker stack.

Next, in order:

1. PKI service: CA, server and client certificates, CRL.
2. OpenVPN on the panel host as the master node, plus `.ovpn` generation — this is
   the point where a client can first connect and exit.
3. The `anemoi` gRPC agent and its mTLS enrolment, so remote nodes report status and
   receive CRL and CCD updates.
4. `moirai`: client-facing config distribution.
