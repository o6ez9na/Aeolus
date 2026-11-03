#!/bin/sh
# Build gost-engine's OpenSSL 3 provider (gostprov.so) for Keenetic's Entware.
#
# Entware packages no GOST module, so anemoi carries one inside its binary for
# the router's architecture (see anemoi-rs/src/gost.rs). This is how those
# files are made: in a throwaway Debian container, zig as the cross compiler
# for glibc 2.27, gost-engine at a fixed tag, OpenSSL headers of the version
# Entware ships, and Entware's own libcrypto.so.3 to link against: the very
# library the module meets on the router.
#
#   scripts/build-gostprov-entware.sh                       # writes anemoi-rs/gost/
#   GOST_WORK=/tmp/gost scripts/build-gostprov-entware.sh   # keeps the downloads
#
# Needs docker and network access. Run it again when Entware moves to another
# OpenSSL major or glibc, then rebuild anemoi.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/anemoi-rs/gost"
work=${GOST_WORK:-$(mktemp -d)}
mkdir -p "$out" "$work"
docker run --rm -i -v "$out:/out" -v "$work:/work" -v "$here/scripts:/scripts:ro" \
  debian:bookworm sh -s <<'INNER'
set -eu
# gost-engine master: v3.0.3 links the provider against the ENGINE API, and
# Entware's OpenSSL is built without it. master builds the provider alone.
GOST_REF=af2b7e69e855572202420ffc36bae06ccd70796b
OPENSSL_VER=3.5.5
ENTWARE_OPENSSL=3.5.5-1
ZIG_VER=0.13.0
W=/work; OUT=/out
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ca-certificates curl git cmake make perl xz-utils binutils file >/dev/null
mkdir -p $W && cd $W
if [ ! -x zig/zig ]; then
  # The ziglang PyPI wheel carries the same release, served from a CDN that
  # does not crawl from here the way ziglang.org does.
  apt-get install -y -qq --no-install-recommends python3-pip unzip >/dev/null
  pip3 download --no-deps --only-binary=:all: --platform manylinux_2_12_x86_64 -q -d /tmp/zw "ziglang==$ZIG_VER"
  mkdir -p /tmp/zx && unzip -q /tmp/zw/ziglang-*.whl -d /tmp/zx && mv /tmp/zx/ziglang zig && chmod +x zig/zig
fi
if [ "$(git -C gost rev-parse HEAD 2>/dev/null)" != "$GOST_REF" ]; then
  rm -rf gost && git init -q gost
  git -C gost fetch -q --depth 1 https://github.com/gost-engine/engine "$GOST_REF"
  git -C gost checkout -q FETCH_HEAD
  git -C gost submodule -q update --init --depth 1
fi
# Our fix on top: Kuznyechik CBC on unaligned buffers (see the patch).
git -C gost checkout -q -- .
git -C gost apply --recount /scripts/gostprov-cbc-alignment.patch
[ -d openssl-$OPENSSL_VER ] || curl -fsSL https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VER/openssl-$OPENSSL_VER.tar.gz | tar xz
echo "gost-engine $(git -C gost rev-parse --short HEAD) ($(git -C gost log -1 --format=%cs)), openssl headers $OPENSSL_VER, zig $($W/zig/zig version)"

build() { # build <entware-arch> <ipk-arch> <zig-target> <openssl-target> <name>
  ew=$1; ia=$2; zt=$3; ot=$4; an=$5
  mkdir -p $OUT/entware-$an
  S=$W/sysroot-$ew; B=$W/build-$ew
  rm -rf $S $B; mkdir -p $S/lib $S/include $B
  # Entware's libcrypto/libssl, the exact files the router has.
  curl -fsSL http://bin.entware.net/$ew/libopenssl_${ENTWARE_OPENSSL}_$ia.ipk -o $S/libopenssl.ipk
  (cd $S && mkdir x && cd x && tar xzf ../libopenssl.ipk 2>/dev/null || ar x ../libopenssl.ipk; tar xzf data.tar.gz)
  cp -a $S/x/opt/lib/libcrypto.so* $S/x/opt/lib/libssl.so* $S/lib/
  ln -sf libcrypto.so.3 $S/lib/libcrypto.so; ln -sf libssl.so.3 $S/lib/libssl.so
  # Headers configured for this target (configuration.h differs per arch).
  rm -rf $W/ossl-$ew; cp -a $W/openssl-$OPENSSL_VER $W/ossl-$ew
  (cd $W/ossl-$ew && perl Configure $ot no-asm no-engine shared >/dev/null && make -s build_generated >/dev/null 2>&1 || make -s include/openssl/configuration.h include/openssl/opensslv.h >/dev/null)
  cp -a $W/ossl-$ew/include/openssl $S/include/
  # Entware's MIPS builds are soft-float (mipselsf, mipssf); glibc's loader
  # refuses a hard-float object in a soft-float process.
  case $an in mips*) xf=-msoft-float ;; *) xf= ;; esac
  printf '#!/bin/sh\nexec %s/zig/zig cc -target %s %s "$@"\n' $W $zt "$xf" > $W/cc-$ew; chmod +x $W/cc-$ew
  # The alignment probe runs a test program, which cannot run on the build
  # host; strict alignment is the safe answer for every target here (MIPS
  # traps on unaligned access).
  cmake -S $W/gost -B $B -DCMAKE_BUILD_TYPE=Release -DCMAKE_SYSTEM_NAME=Linux \
    -DCMAKE_C_COMPILER=$W/cc-$ew -DCMAKE_AR=$W/zig/zig-ar-wrapper -DCMAKE_RANLIB=$W/zig/zig-ranlib-wrapper -DOPENSSL_ROOT_DIR=$S \
    -DOPENSSL_INCLUDE_DIR=$S/include -DOPENSSL_CRYPTO_LIBRARY=$S/lib/libcrypto.so \
    -DOPENSSL_SSL_LIBRARY=$S/lib/libssl.so -DOPENSSL_USE_STATIC_LIBS=OFF \
    -DRELAXED_ALIGNMENT=OFF -DOPENSSL_ENGINES_DIR=/opt/lib/engines-3 \
    -DGOST_BUILD_ENGINE=OFF -DGOST_BUILD_STATIC_ENGINE=OFF -DGOST_BUILD_PROVIDER=ON \
    -DOPENSSL_MODULES_DIR=/opt/lib/ossl-modules \
    -DCMAKE_SKIP_RPATH=ON -DCMAKE_MODULE_LINKER_FLAGS="-Wl,-rpath,/opt/lib -Wl,--strip-all" \
    >$B/cmake.log 2>&1 || { tail -30 $B/cmake.log; return 1; }
  make -C $B -j"$(nproc)" gost_prov >$B/make.log 2>&1 || { grep -E "error|Error" $B/make.log | head -20; tail -15 $B/make.log; return 1; }
  so=$(find $B -name 'gostprov.so' | head -1)
  cp "$so" $OUT/entware-$an/gostprov.so
  # Every OpenSSL symbol the module needs must be exported by Entware's
  # libcrypto, or the router's dlopen fails ("undefined symbol").
  readelf --dyn-syms -W "$so" | awk '$7=="UND" && $8!="" {sub(/@.*/,"",$8); print $8}' \
    | grep -E '^(OSSL|EVP|ENGINE|BN|EC|CRYPTO|ERR|OPENSSL|ASN1|X509|RAND|OBJ|BIO|PEM|d2i|i2d|PKCS|CMS|DH|RSA|DSA|HMAC|CMAC|ECDSA|ECDH)_?' | sort -u > $B/needs
  readelf --dyn-syms -W $S/lib/libcrypto.so.3 | awk '$7!="UND" {sub(/@.*/,"",$8); print $8}' | sort -u > $B/has
  missing=$(comm -23 $B/needs $B/has)
  if [ -n "$missing" ]; then echo "!! $ew: not in Entware's libcrypto: $missing"; return 1; fi
  echo "  libcrypto symbols: $(wc -l < $B/needs) needed, all exported"
  echo "== $ew"; file $OUT/entware-$an/gostprov.so
  readelf -d $OUT/entware-$an/gostprov.so | grep -E "NEEDED|RPATH|RUNPATH"
  readelf -A $OUT/entware-$an/gostprov.so 2>/dev/null | grep -E "FP ABI" || true
  echo "  max GLIBC: $(readelf -V $OUT/entware-$an/gostprov.so | grep -oE 'GLIBC_[0-9.]+' | sort -t. -k2,2n -k3,3n -u | tail -1)"
}
printf '#!/bin/sh\nexec %s/zig/zig ar "$@"\n' $W > $W/zig/zig-ar-wrapper; chmod +x $W/zig/zig-ar-wrapper
printf '#!/bin/sh\nexec %s/zig/zig ranlib "$@"\n' $W > $W/zig/zig-ranlib-wrapper; chmod +x $W/zig/zig-ranlib-wrapper
for spec in "mipselsf-k3.4 mipsel-3.4 mipsel-linux-gnueabi.2.27 linux-mips32 mipsel" \
            "mipssf-k3.4 mips-3.4 mips-linux-gnueabi.2.27 linux-mips32 mips" \
            "aarch64-k3.10 aarch64-3.10 aarch64-linux-gnu.2.27 linux-aarch64 aarch64"; do
  build $spec || echo "!! $spec failed"
done
(cd $OUT && sha256sum entware-*/gostprov.so | tee SHA256SUMS)
# Hand the results to whoever owns the checkout, not root.
chown -R "$(stat -c %u:%g $OUT)" $OUT
INNER
