# anemoi (Rust)

The node agent as a single static binary, for machines that cannot or should
not run Docker: routers first of all. It replaces, on such a machine, the three
containers a node runs elsewhere: the Python agent, the OpenVPN supervisor and
wstunnel.

| Target | Machines |
| --- | --- |
| `mipsel-unknown-linux-musl` | Keenetic on MT7621/MT7628 (Giant, Ultra, …), most MIPS OpenWrt routers |
| `mips-unknown-linux-musl` | big-endian MIPS: Keenetic on EcoNet/Airoha, older Atheros OpenWrt |
| `aarch64-unknown-linux-musl` | ARM64 Keenetic and OpenWrt routers, ARM boards |
| `x86_64-unknown-linux-musl` | servers, VMs, x86 OpenWrt |

All static, 2.3–3.0 MB, soft-float on MIPS (routers there have no FPU).

## Installing a node

```sh
wget -qO- https://raw.githubusercontent.com/o6ez9na/Aeolus/main/scripts/install-node.sh \
  | sh -s -- --panel vpn.example.com
```

The script picks the binary for the machine, checks it against the release's
`SHA256SUMS` and runs `anemoi install`, which:

- detects OpenWrt (apk or opkg), Keenetic/Entware or plain Linux;
- installs what is missing with the platform's own package manager
  (`openvpn-openssl`, `kmod-tun` on OpenWrt; `openvpn-openssl`, `iptables`
  from Entware on Keenetic; `openvpn`, `iptables` elsewhere);
- writes the settings (`/etc/anemoi/anemoi.env`, `/opt/etc/anemoi/` on
  Entware) and keeps them on re-runs;
- registers a service with the platform's init: procd, Entware's init.d,
  systemd; on Keenetic also a netfilter.d hook, because NDMS rebuilds its
  firewall from scratch;
- prints the key fingerprint to compare in the panel before accepting the node.

Running it again repairs and updates and restarts the service only if
something changed. `anemoi doctor` checks every piece; `anemoi uninstall`
removes exactly what install added (`--purge` also the node's key and
settings, otherwise a reinstall comes back as the same node).

Options of `anemoi install`: `--panel DOMAIN`, `--name NAME`,
`--subnets CIDR,...` (LANs behind the node offered to clients), `--panel-ca FILE`
(a panel without a public certificate), `--grpc-port N` and `--sni NAME` (gRPC
through the panel's 443: `--grpc-port 443 --sni anemoi-grpc`), `--token TOKEN`,
`--no-start`.

## What it does at runtime

- Enrols over the panel's HTTPS API (announce, or a one-time token), then talks
  gRPC with mTLS; the key and certificate are the Python agent's files, in the
  same format.
- Writes the configuration bundle atomically and only when it changed.
- With `ANEMOI_SUPERVISE=1` (what install sets) runs the transit OpenVPN
  itself, on a copy of `transit.conf` adjusted for the machine (tun `aeolus0`,
  status file, WebSocket remote on localhost), restarts it on changes and
  crashes, and falls back to `--disable-dco` where the kernel refuses DCO.
- Carries the transit inside a WebSocket on the panel's 443, speaking
  wstunnel's protocol, so the panel side is the stock wstunnel server.
- Lets the hub's client pools out: fw4 via uci on OpenWrt, its own iptables
  chains elsewhere.

Settings are `ANEMOI_*` variables, read from the environment or the env file;
the same names as the Python agent, so the binary can replace it in a
container as well.

## Building

```sh
pip install --user ziglang==0.17.0 cargo-zigbuild==0.24.0
cargo zigbuild --release --target aarch64-unknown-linux-musl
# MIPS is a tier-3 target: no prebuilt std
rustup toolchain install nightly-2026-10-29 --component rust-src
cargo +nightly-2026-10-29 zigbuild --release --target mipsel-unknown-linux-musl -Zbuild-std=std,panic_abort
```

`.cargo/config.toml` explains the MIPS link flags. CI
(`.github/workflows/anemoi.yml`) builds all four targets, smoke-tests each under
qemu-user and publishes a release on an `anemoi-v*` tag.
