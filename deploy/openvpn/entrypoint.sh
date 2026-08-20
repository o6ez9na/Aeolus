#!/bin/sh
set -e

CONFIG_DIR=${AEOLUS_OPENVPN_CONFIG_DIR:-/etc/openvpn/aeolus}
VPN_SUBNET=${AEOLUS_VPN_SUBNET:-10.8.0.0}
VPN_TCP_SUBNET=${AEOLUS_VPN_TCP_SUBNET:-10.9.0.0}
VPN_MASK=${AEOLUS_VPN_MASK_BITS:-24}
RESTART_FLAG="$CONFIG_DIR/.restart"

# On the panel host the backend writes the bundle at startup, so this is a short
# race. On a node the config only arrives once an operator has accepted the join
# request, which can take as long as it takes — so wait rather than give up.
attempt=0
while [ ! -f "$CONFIG_DIR/server.conf" ]; do
    attempt=$((attempt + 1))
    if [ $((attempt % 15)) -eq 1 ]; then
        echo "waiting for $CONFIG_DIR/server.conf — the panel writes it once this node is accepted"
    fi
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
for subnet in "$VPN_SUBNET/$VPN_MASK" "$VPN_TCP_SUBNET/$VPN_MASK"; do
    if ! iptables -t nat -C POSTROUTING -s "$subnet" -o "$UPLINK" -j MASQUERADE 2>/dev/null; then
        iptables -t nat -A POSTROUTING -s "$subnet" -o "$UPLINK" -j MASQUERADE
    fi
    iptables -A FORWARD -s "$subnet" -j ACCEPT
    iptables -A FORWARD -d "$subnet" -m state --state ESTABLISHED,RELATED -j ACCEPT
done

mkdir -p /run/openvpn

openvpn_pid=""
openvpn_tcp_pid=""
openvpn_transit_pid=""

start_openvpn() {
    echo "starting openvpn on $UPLINK, NAT for $VPN_SUBNET/$VPN_MASK"
    openvpn --config "$CONFIG_DIR/server.conf" --cd "$CONFIG_DIR" &
    openvpn_pid=$!

    # A second listener on TCP, for networks that pass the handshake and then
    # drop the UDP flow.
    openvpn_tcp_pid=""
    if [ -f "$CONFIG_DIR/server-tcp.conf" ]; then
        echo "starting openvpn tcp listener"
        openvpn --config "$CONFIG_DIR/server-tcp.conf" --cd "$CONFIG_DIR" &
        openvpn_tcp_pid=$!
    fi

    # Transit: the hub listens for nodes here, a node dials the hub. Same file
    # name either way — the panel decides which of the two it wrote.
    openvpn_transit_pid=""
    if [ -f "$CONFIG_DIR/transit.conf" ]; then
        echo "starting openvpn transit tunnel"
        openvpn --config "$CONFIG_DIR/transit.conf" --cd "$CONFIG_DIR" &
        openvpn_transit_pid=$!
    fi
}

stop_openvpn() {
    [ -n "$openvpn_pid" ] && kill "$openvpn_pid" 2>/dev/null || true
    [ -n "$openvpn_tcp_pid" ] && kill "$openvpn_tcp_pid" 2>/dev/null || true
    [ -n "$openvpn_transit_pid" ] && kill "$openvpn_transit_pid" 2>/dev/null || true
    wait "$openvpn_pid" 2>/dev/null || true
    wait "$openvpn_tcp_pid" 2>/dev/null || true
    wait "$openvpn_transit_pid" 2>/dev/null || true
}

shutdown() {
    stop_openvpn
    exit 0
}
trap shutdown TERM INT

start_openvpn
seen_flag=$(cat "$RESTART_FLAG" 2>/dev/null || echo "")

# The agent rewrites server.conf when the panel changes it and touches the flag.
# The CRL and ccd are re-read by OpenVPN itself, so only server.conf needs this.
while true; do
    sleep 5

    # OpenVPN writes status.log mode 0600; the agent runs as another user and
    # only ever reads it. Re-apply on every pass because the file is recreated.
    chmod 0644 /run/openvpn/status.log /run/openvpn/status-tcp.log \
        /run/openvpn/status-transit.log 2>/dev/null || true

    if ! kill -0 "$openvpn_pid" 2>/dev/null; then
        echo "openvpn exited, restarting" >&2
        stop_openvpn
        start_openvpn
        continue
    fi

    if [ -n "$openvpn_tcp_pid" ] && ! kill -0 "$openvpn_tcp_pid" 2>/dev/null; then
        echo "openvpn tcp listener exited, restarting" >&2
        stop_openvpn
        start_openvpn
        continue
    fi

    if [ -n "$openvpn_transit_pid" ] && ! kill -0 "$openvpn_transit_pid" 2>/dev/null; then
        echo "openvpn transit tunnel exited, restarting" >&2
        stop_openvpn
        start_openvpn
        continue
    fi

    current_flag=$(cat "$RESTART_FLAG" 2>/dev/null || echo "")
    if [ "$current_flag" != "$seen_flag" ]; then
        seen_flag="$current_flag"
        echo "configuration changed, restarting openvpn"
        stop_openvpn
        start_openvpn
    fi
done
