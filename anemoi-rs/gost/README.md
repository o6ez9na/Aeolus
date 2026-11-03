# gostprov for Keenetic's Entware

`entware-<arch>/gostprov.so` is gost-engine's provider for OpenSSL 3
(Kuznyechik, Magma, Streebog). Entware packages no GOST module, so the agent
built for a router's architecture carries the matching file inside its binary
and `anemoi install` writes it to `/opt/lib/ossl-modules/gostprov.so`, where
Entware's OpenSSL looks for providers (`src/gost.rs`).

Built by `scripts/build-gostprov-entware.sh`:

- gost-engine master at `af2b7e69` (2026-10-22). Release v3.0.3 links its
  provider against the ENGINE API, which Entware's OpenSSL is built without;
  master builds the provider alone (`GOST_BUILD_ENGINE=OFF`).
- Our patch `scripts/gostprov-cbc-alignment.patch`: Kuznyechik CBC worked on
  the caller's buffers with word loads, and OpenVPN decrypts at an unaligned
  offset, so MIPS died with SIGBUS. The patch copies blocks into aligned
  locals.
- OpenSSL `3.5.5` headers (`no-engine`), linked against Entware's own
  `libcrypto.so.3` from `libopenssl_3.5.5-1`; the build fails if the module
  needs a symbol that library does not export.
- zig `0.13.0` as the cross compiler, glibc `2.27` (Entware's), soft-float on
  MIPS like Entware's `mipselsf` and `mipssf`.

Checked under qemu-user with Entware's own `openssl` and `openvpn` 2.6.14:
the module loads on all three, Kuznyechik and Streebog agree with the hub's
Ubuntu provider in both directions, and a transit tunnel on Kuznyechik passes
traffic on mipsel and aarch64. On big-endian mips qemu cannot set the tunnel's
MTU (with AES just as well), so there only the cipher itself was checked.

`SHA256SUMS` lists the files as built. Rebuild when Entware moves to another
OpenSSL major version or glibc, then rebuild anemoi.
