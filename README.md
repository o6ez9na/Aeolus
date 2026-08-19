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

## Run it

```sh
cp .env.example .env
# fill AEOLUS_SECRET_KEY (openssl rand -hex 32), POSTGRES_PASSWORD,
# and AEOLUS_FIRST_ADMIN_PASSWORD
docker compose up -d --build
```

Panel: <http://localhost:8080>. The API is same-origin under `/api/v1`, proxied by
nginx to the backend, so no CORS setup is needed.

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
