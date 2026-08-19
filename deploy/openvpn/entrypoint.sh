#!/bin/sh
set -e

CONFIG_DIR=${AEOLUS_OPENVPN_CONFIG_DIR:-/etc/openvpn/aeolus}
VPN_SUBNET=${AEOLUS_VPN_SUBNET:-10.8.0.0}
VPN_MASK=${AEOLUS_VPN_MASK_BITS:-24}

# The panel writes the bundle on startup, so the first boot can race it.
attempt=0
while [ ! -f "$CONFIG_DIR/server.conf" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 60 ]; then
        echo "no $CONFIG_DIR/server.conf after 60 tries; is the panel running?" >&2
        exit 1
    fi
    echo "waiting for the panel to write $CONFIG_DIR/server.conf ($attempt/60)"
    sleep 2
done

if [ ! -c /dev/net/tun ]; then
    mkdir -p /dev/net
    mknod /dev/net/tun c 10 200
    chmod 600 /dev/net/tun
fi

# Clients leave through this container's own interface, which Docker then NATs
# to the host. Keeping NAT in here means the host firewall is left alone.
UPLINK=$(ip -4 route show default | awk '{print $5; exit}')
if ! iptables -t nat -C POSTROUTING -s "$VPN_SUBNET/$VPN_MASK" -o "$UPLINK" -j MASQUERADE 2>/dev/null; then
    iptables -t nat -A POSTROUTING -s "$VPN_SUBNET/$VPN_MASK" -o "$UPLINK" -j MASQUERADE
fi
iptables -A FORWARD -s "$VPN_SUBNET/$VPN_MASK" -j ACCEPT
iptables -A FORWARD -d "$VPN_SUBNET/$VPN_MASK" -m state --state ESTABLISHED,RELATED -j ACCEPT

mkdir -p /run/openvpn

echo "starting openvpn on $UPLINK, NAT for $VPN_SUBNET/$VPN_MASK"
exec openvpn --config "$CONFIG_DIR/server.conf" --cd "$CONFIG_DIR"
