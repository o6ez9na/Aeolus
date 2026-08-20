FROM alpine:3.22

# apk pulls its index over the network, and on a fresh VPS that is the first
# thing to break: a provider resolver that mangles dl-cdn, a host with IPv6
# routes the container cannot use, or the CDN simply having a bad minute. The
# failure reads as "no such package", which looks like a missing package rather
# than a missing index — so retry, then fall back to a different mirror.
RUN set -eux; \
    for mirror in \
        "https://dl-cdn.alpinelinux.org/alpine" \
        "https://mirror.yandex.ru/mirrors/alpine" \
        "https://mirrors.edge.kernel.org/alpine" \
    ; do \
        for attempt in 1 2 3; do \
            printf '%s/v3.22/main\n%s/v3.22/community\n' "$mirror" "$mirror" >/etc/apk/repositories; \
            if apk add --no-cache openvpn iptables ip6tables; then exit 0; fi; \
            echo "apk failed on $mirror (attempt $attempt), retrying"; \
            sleep 3; \
        done; \
    done; \
    echo "could not install packages from any mirror — check DNS and outbound HTTPS from docker" >&2; \
    exit 1

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Config and certificates arrive through a volume the panel writes to.
VOLUME /etc/openvpn/aeolus

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
