FROM ubuntu:24.04

# Ubuntu rather than Alpine for one package: libengine-gost-openssl, the GOST
# provider for OpenSSL 3 (Kuznyechik, Streebog). Alpine does not ship it, and
# the panel can run the whole network on Kuznyechik. The scripts are plain POSIX
# sh and run the same under dash; netcat-openbsd stands in for busybox nc.
#
# The package index comes over the network, and on a fresh VPS that is the first
# thing to break: a provider resolver that mangles the mirror, a host with IPv6
# routes the container cannot use, or the mirror simply having a bad minute. The
# failure reads as "unable to locate package", which looks like a missing
# package rather than a missing index — so retry, then fall back to a different
# mirror.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    for mirror in \
        "http://archive.ubuntu.com/ubuntu" \
        "http://mirror.yandex.ru/ubuntu" \
        "http://mirrors.edge.kernel.org/ubuntu" \
    ; do \
        for attempt in 1 2 3; do \
            sed -i "s#^URIs: .*#URIs: $mirror#" /etc/apt/sources.list.d/ubuntu.sources; \
            if apt-get update -o Acquire::Retries=2 \
                && apt-get install -y --no-install-recommends \
                    openvpn libengine-gost-openssl openssl iptables iproute2 jq netcat-openbsd; then \
                rm -rf /var/lib/apt/lists/*; \
                openssl list -cipher-algorithms -provider default -provider gostprov \
                    | grep -q kuznyechik-cbc; \
                exit 0; \
            fi; \
            echo "apt failed on $mirror (attempt $attempt), retrying"; \
            sleep 3; \
        done; \
    done; \
    echo "could not install packages from any mirror — check DNS and outbound HTTPS from docker" >&2; \
    exit 1

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY apply-routing.sh /usr/local/bin/apply-routing.sh
COPY host-routes.sh /usr/local/bin/host-routes.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/apply-routing.sh /usr/local/bin/host-routes.sh

# Config and certificates arrive through a volume the panel writes to.
VOLUME /etc/openvpn/aeolus

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
