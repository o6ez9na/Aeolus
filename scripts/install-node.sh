#!/bin/sh
#
# Aeolus node installer for routers and small boxes (OpenWrt, Keenetic with
# Entware, plain Linux). Fetches the anemoi binary for this machine, checks it
# against the release's checksums, and hands over to `anemoi install`, which
# does the rest with the platform's own tools.
#
#   wget -qO- https://raw.githubusercontent.com/o6ez9na/Aeolus/main/scripts/install-node.sh | sh -s -- --panel vpn.example.com
#   curl -fsSL .../install-node.sh | sh -s -- --panel vpn.example.com --name home
#
# On Keenetic, Entware's wget is a busybox applet without HTTPS, so put
# wget-ssl in first (the panel's command does it):
#   opkg update && opkg install wget-ssl ca-bundle
#
# Everything after `--` goes to `anemoi install` (see `anemoi help`).
#
#   ANEMOI_VERSION=anemoi-v0.2.1   a specific release instead of the latest
#   ANEMOI_RELEASE_URL=...         where the binaries and SHA256SUMS live
#
# Plain POSIX sh: it has to run in busybox ash on a router with nothing else.
set -eu

REPO="o6ez9na/Aeolus"
VERSION="${ANEMOI_VERSION:-latest}"
if [ -n "${ANEMOI_RELEASE_URL:-}" ]; then
    BASE="$ANEMOI_RELEASE_URL"
elif [ "$VERSION" = latest ]; then
    BASE="https://github.com/$REPO/releases/latest/download"
else
    BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

say() { printf ':: %s\n' "$*"; }
die() { printf 'error %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "нужен root / must run as root"

# --- what this machine is -----------------------------------------------------

# Byte 5 of an ELF header is the byte order (1 little, 2 big), byte 4 the class
# (1 for 32-bit). uname says "mips" for both byte orders, so ask a binary.
# Compared with printf rather than read with od: OpenWrt's busybox has no od.
# shellcheck disable=SC2059 # the format is the escape being built
elf_is() { # elf_is <offset> <octal value>
    [ "$(dd if=/bin/sh bs=1 skip="$1" count=1 2>/dev/null)" = "$(printf "\\$2")" ]
}

case "$(uname -m)" in
    x86_64|amd64) TARGET=x86_64-unknown-linux-musl ;;
    aarch64|arm64) TARGET=aarch64-unknown-linux-musl ;;
    mips|mips64)
        elf_is 4 001 || die "64-битный MIPS userland пока не поддерживается / 64-bit MIPS userland is not supported yet"
        if elf_is 5 001; then TARGET=mipsel-unknown-linux-musl
        elif elf_is 5 002; then TARGET=mips-unknown-linux-musl
        else die "не понял порядок байт MIPS / cannot tell MIPS byte order"; fi
        ;;
    *) die "архитектура $(uname -m) пока не поддерживается / architecture $(uname -m) is not supported yet" ;;
esac

if [ -f /etc/openwrt_release ]; then
    PLATFORM=openwrt
elif [ -x /opt/bin/opkg ]; then
    PLATFORM=entware
else
    PLATFORM=linux
fi
say "$(uname -m) → $TARGET ($PLATFORM)"

# --- tools ----------------------------------------------------------------------

# Install a package with whatever this machine uses, for the few tools this
# script itself needs.
pkg_add() {
    case "$PLATFORM" in
        openwrt)
            if command -v apk >/dev/null 2>&1; then apk update >/dev/null 2>&1 || true; apk add "$@"
            else opkg update >/dev/null 2>&1 || true; opkg install "$@"; fi ;;
        entware) /opt/bin/opkg update >/dev/null 2>&1 || true; /opt/bin/opkg install "$@" ;;
        linux)
            if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
            elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "$@"
            elif command -v apk >/dev/null 2>&1; then apk add "$@"
            else return 1; fi ;;
    esac
}

# The busybox wget on a lot of firmware speaks no HTTPS; OpenWrt's
# uclient-fetch does. Prefer curl when it is there.
fetch() { # fetch <url> <file>
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 -o "$2" "$1"
    else
        wget -q -O "$2" "$1"
    fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# The checksums double as the probe: if this machine's downloader cannot fetch
# them, it cannot fetch the binary either. Probing a page of its own would
# test the wrong host (uclient-fetch times out on github.com's front page
# while release downloads work).
if ! fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" 2>/dev/null; then
    command -v curl >/dev/null 2>&1 && die "не скачались контрольные суммы / download failed: $BASE/SHA256SUMS"
    say "загрузчик не справился, ставлю curl / the downloader failed, installing curl"
    pkg_add curl || die "не смог поставить curl; поставь его и запусти снова / could not install curl; install it and run again"
    fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "не скачались контрольные суммы / download failed: $BASE/SHA256SUMS"
fi

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
    else return 1; fi
}
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then
    say "нет sha256sum, ставлю / no sha256sum, installing it"
    case "$PLATFORM" in
        entware) pkg_add coreutils-sha256sum ;;
        *) pkg_add coreutils || pkg_add coreutils-sha256sum ;;
    esac || die "нечем проверить контрольную сумму / nothing to verify the checksum with"
fi

# --- fetch and verify ------------------------------------------------------------

say "загружаю / downloading $BASE/anemoi-$TARGET"
fetch "$BASE/anemoi-$TARGET" "$TMP/anemoi" || die "не скачался бинарь / download failed: $BASE/anemoi-$TARGET"

want=$(awk -v f="anemoi-$TARGET" '$2 == f || $2 == "*" f {print $1}' "$TMP/SHA256SUMS")
got=$(sha256 "$TMP/anemoi")
[ -n "$want" ] || die "в SHA256SUMS нет anemoi-$TARGET / SHA256SUMS has no entry for anemoi-$TARGET"
[ "$want" = "$got" ] || die "контрольная сумма не сходится / checksum mismatch ($got != $want)"
say "контрольная сумма сходится / checksum ok"

chmod +x "$TMP/anemoi"
"$TMP/anemoi" version >/dev/null || die "бинарь не запускается на этой машине / the binary does not run on this machine"

# `anemoi install` copies itself into place; the temporary copy goes with TMP.
"$TMP/anemoi" install "$@"
