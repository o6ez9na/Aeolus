# Aeolus

Primary repository: [Gitea](http://10.31.1.243:3000/Aeolus/Aeolus).
GitHub mirrors this README and [Anemoi release downloads](https://github.com/o6ez9na/Aeolus/releases); source changes and CI live in Gitea.


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

The panel/Docker installer clones the private Gitea repository over SSH: give the
host a Gitea-authorized SSH key, or set `REPO_URL` to an accessible Gitea clone URL.
Native router installations download public release assets and need no Gitea login.

On a fresh Debian or Ubuntu box, as root. It asks for a language, then whether
this machine is the panel or a node, installs Docker if missing, checks that
containers can actually reach the package mirrors, and brings the stack up:

```sh
curl -fsSL https://github.com/o6ez9na/Aeolus/releases/latest/download/install.sh | sudo bash
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

A node carries its tunnel to the panel inside a WebSocket on 443 from the
start. Some networks let an OpenVPN handshake through and then kill the flow
whatever port or protocol it uses; inside a real TLS session there is nothing
left to recognise. It costs a little throughput, so a node on a network that
does not need it can be switched to a direct tunnel with the **ws** button in
the node list.

A node prints the fingerprint of the key it generated and waits. It receives
nothing — no certificate, no address, no configuration — until an operator
accepts that fingerprint in the panel under **узлы → заявки**. Comparing the two
strings is the only thing separating your mesh from anyone else who knows the
domain.

Ports to leave open on the panel: `80`, `443` (panel and the obfuscated
transit), `1194/udp` and `8443/tcp` (clients), `1195/udp` + `1195/tcp` (nodes
on a direct tunnel) and `50051/tcp` (agents). A node needs no inbound port at
all: everything it does is outbound.

Set `AEOLUS_LANG=ru` (or `en`) to skip the language question.

### If the build fails with "Unable to locate package"

That is not a missing package on the host — it is the *build container* failing
to fetch the Ubuntu package index, so apt ends up with no index and reports
every package as missing:

```
W: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Temporary failure resolving 'archive.ubuntu.com'
E: Unable to locate package openvpn
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

If the host reaches the mirrors but containers do not, the problem is the docker
bridge rather than DNS — a firewall dropping forwarded packets, docker started
with `"iptables": false`, or a bridge MTU larger than the uplink. Note that
`docker pull` succeeding proves nothing here: pulls happen in the daemon's own
namespace. The installer detects this and moves the build into the host
namespace; for a node it moves the containers there too, since an agent that
cannot dial the panel is no more use than a build that cannot fetch packages.
Force it with `AEOLUS_HOST_NETWORK=1`, or by hand:

```sh
docker compose -f docker-compose.node.yml -f docker-compose.node.host.yml up -d --build
```

A node in the host namespace binds the host's interfaces directly and installs
its NAT rules in the host's tables — simpler for an exit node, but no longer
confined to a container.

## Install a node on a router

Routers run the `anemoi` agent directly, without Docker. `install-node.sh`
fetches the binary for this machine (x86-64, aarch64, 32-bit mips and mipsel),
checks it against the release's checksums and hands over to `anemoi install`,
which installs OpenVPN and sets up the firewall and the service.

Run it as root, replacing the domain, name and subnet with your own. `--name`
and `--subnets` are optional: without `--subnets` the installer suggests the
LAN it finds on the router. The same command, already filled in, is in the panel
under **узлы**.

### Keenetic with Entware

Entware has to be installed already. Log in to its shell, not to the Keenetic
CLI: it is a separate SSH server, on port `222` by default. Entware's own `wget`
has no HTTPS, so install `wget-ssl` first:

```sh
opkg update && opkg install wget-ssl ca-bundle
wget -qO- https://github.com/o6ez9na/Aeolus/releases/latest/download/install-node.sh \
  | sh -s -- --panel vpn.example.com --name home --subnets 192.168.1.0/24
```

If the installer reports that the firmware lacks the `tun` module, enable the
**OpenVPN** component in the Keenetic web UI, update and run it again.

The agent lands in `/opt/bin/anemoi`, its settings in `/opt/etc/anemoi` and the
service in `/opt/etc/init.d/S99anemoi`. A hook in `/opt/etc/ndm/netfilter.d`
puts the firewall rules back each time Keenetic rebuilds its firewall.

### DNS proxy on a node (Anemoi 0.5.0+)

The native Rust agent includes a DNS forwarder on **127.0.0.1:5354**, UDP and TCP.
Set up to four upstream IP addresses in the hub's **DNS для клиентов** field.
The panel sends the list over the existing authenticated gRPC channel; the
agent reloads it without restarting the DNS listener. The router keeps its
own DNS service and cache on port 53; LAN devices keep using the router as DNS.
The Docker image now runs the same Rust agent; existing enrolment/state volumes
and uid 10001 are preserved. A separately installed legacy Python agent only
receives the list and does not run this proxy.

On Keenetic, some firmware rejects loopback as an upstream DNS address. Bind
Anemoi to the router's **actual LAN IP** instead. For example, if the router is
`192.168.3.2`, put this in `/opt/etc/anemoi/anemoi.env` in the Entware shell:

```text
ANEMOI_DNS_LISTEN=192.168.3.2:5354
```

Restart `/opt/etc/init.d/S99anemoi restart`, then configure in the **Keenetic CLI**:

```text
ip name-server 192.168.3.2:5354
system configuration save
```

Replace that example address with the node's actual LAN IP. The listener binds
only that address, not every interface. Test with
`dig @192.168.3.2 -p 5354 example.org` from a machine with access to the LAN.

Keenetic documents this syntax under
[non-standard DNS ports](https://support.keenetic.com/titan-se/kn-4210/en/19726-setting-a-non-standard-port-for-a-dns-server.html).
Other DNS servers, DoH/DoT and per-device policies may bypass Anemoi. After
checking resolution, choose whether to keep those as fallback or remove them
in the router's DNS settings. For a private zone, an explicit suffix route such
as `ip name-server 192.168.3.2:5354 example.internal` keeps its queries on Anemoi
while retaining ISP DNS for other names. The agent does not change DHCP or router
DNS settings. Clients with explicit DHCP DNS servers continue querying those
servers directly; they do not go through Anemoi automatically.
To undo, run `no ip name-server 192.168.3.2:5354`, restore the previous DNS servers
if removed, then `system configuration save`.

IPv4 upstreams outside the node's own LAN are routed through the VPN. The hub
allows only DNS (UDP/TCP 53) to those destinations, with NAT for the return
path; this does not grant access to the resolver's other services or LAN.
IPv6 upstreams require the node's own IPv6 connectivity: the transit is IPv4.
Loopback, local-interface, unspecified and multicast upstreams are rejected to
avoid forwarding loops. Resolver failures/timeouts try the next configured
server; NXDOMAIN is returned unchanged. If all fail, clients receive SERVFAIL.
There is no hidden fallback to public DNS. Cached LAN answers remain the router's job.

The agent remembers the panel's last resolved IP addresses in its persistent
state directory. If DNS is unavailable during startup, it can reconnect using
those addresses while still checking the original TLS name and certificate.
This covers a private upstream reachable only after the VPN comes up. If the
panel moves while all DNS is unavailable, restore working DNS to refresh the cache.


### DNS proxy in Docker

Rebuild the node stack with the updated Compose files. The agent shares the
OpenVPN container's network namespace, so DNS queries can use the tunnel's
routes. In bridge mode the listener binds inside that namespace; Compose
publishes **127.0.0.1:5354** for both UDP and TCP on the host. The host-network
override binds directly to loopback and removes port publishing.

```sh
docker compose -f docker-compose.node.yml up -d --build
# The host can test with:
dig @127.0.0.1 -p 5354 example.org
```

A resolver on the same host can forward to that address. A Keenetic on a
*different machine* cannot use this host's loopback. Set `ANEMOI_DNS_BIND` in the
node's `.env` to its actual LAN IPv4 address (for example `192.168.1.10`), then
recreate the stack with the same Compose command. This works in both bridge
and host-network modes. Restrict access to the router in the host firewall,
then configure `ip name-server 192.168.1.10:5354` on Keenetic. Keep DHCP handing
out the Keenetic's own LAN address as DNS: DHCP cannot advertise port 5354.
Do not publish DNS on every host interface. No host `/etc/resolv.conf` is overwritten.


### OpenWrt

```sh
wget -qO- https://github.com/o6ez9na/Aeolus/releases/latest/download/install-node.sh \
  | sh -s -- --panel vpn.example.com --name home --subnets 192.168.1.0/24
```

Packages come from `opkg`, or from `apk` on the releases that use it. The agent
lands in `/usr/bin/anemoi`, its settings in `/etc/anemoi` and the service in
`/etc/init.d/anemoi`.

### After installing

The installer prints the node's key fingerprint. Compare it and accept the node
in the panel under **узлы → заявки**. Further commands, with the binary at the
path above:

```sh
anemoi doctor             # check that everything the node needs is in place
anemoi fingerprint        # print the key fingerprint again
anemoi uninstall          # remove what install added, keeping the key and settings
anemoi uninstall --purge  # remove the key and settings too
```

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

## Encryption

The hub's page picks two data-channel ciphers, each AES-256-GCM (the default),
ChaCha20-Poly1305 or GOST Kuznyechik:

- **for clients**: the hub's listeners and every client profile;
- **between nodes**: the transit from the hub to every node.

Two, because the ends differ. Nodes are routers the agent installs GOST on;
phones run OpenVPN Connect, which has no GOST at all. So the transit can run
on Kuznyechik while phones stay on AES. Each listener offers only its own
cipher: profiles issued before a change of the client cipher stop connecting
until they are imported again, while nodes pick up a new transit cipher by
themselves.

Kuznyechik (GOST R 34.12-2015) runs in CBC mode (GOST R 34.13-2015) with HMAC
on Streebog-256 (GOST R 34.11-2012). The algorithms come from the gost-engine
provider for OpenSSL 3, `libengine-gost-openssl`, which is why the OpenVPN
image is Ubuntu. OpenVPN's data channel takes AEAD only as GCM or
ChaCha20-Poly1305, so the GOST MGM mode is not available.

Limits:

- The TLS control channel (ECDSA P-256 certificates) and `tls-crypt` stay
  non-GOST.
- OpenVPN Connect and OpenVPN for Android have no GOST: with Kuznyechik as
  the client cipher, phones cannot connect.
- A node needs the provider too, and `anemoi install` puts it in place where
  it can: on Keenetic's Entware from the module built into the agent (see
  `anemoi-rs/gost/`), on Debian 12 and Ubuntu 24.04 from
  `libengine-gost-openssl`. Debian 13 and Alpine do not package it; OpenWrt
  25.12 ships only the old engine (`libopenssl-gost_engine`), which these
  configs do not use. The panel lists the nodes whose agent reports no GOST.
- This implements the GOST algorithms; it is not a certified cryptographic
  product (СКЗИ).

Measured on x86-64, OpenVPN 2.6.19, iperf3 through the tunnel: AES-256-GCM
about 1300 Mbit/s, ChaCha20-Poly1305 about 1160, Kuznyechik-CBC with Streebog
about 290.

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

### Redeploying by hand

Gitea Actions can validate each change and deploy successful `main` commits to
the existing panel. See [CI/CD setup and recovery](deploy/ci/README.md).

`deploy/Caddyfile` is bind-mounted as a single file, and rsync replaces it with
a new inode — the running container keeps the old one. Recreate rather than
reload it when that file changes:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate caddy
```
