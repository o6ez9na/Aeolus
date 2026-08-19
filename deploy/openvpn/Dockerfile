FROM alpine:3.22

RUN apk add --no-cache openvpn iptables ip6tables

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Config and certificates arrive through a volume the panel writes to.
VOLUME /etc/openvpn/aeolus

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
