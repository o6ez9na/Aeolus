#!/bin/sh
set -e

CONFIG_DIR=${AEOLUS_OPENVPN_CONFIG_DIR:-/etc/openvpn/aeolus}
VPN_SUBNET=${AEOLUS_VPN_SUBNET:-10.8.0.0}
VPN_TCP_SUBNET=${AEOLUS_VPN_TCP_SUBNET:-10.9.0.0}
VPN_MASK=${AEOLUS_VPN_MASK_BITS:-24}
RESTART_FLAG="$CONFIG_DIR/.restart"

# The agent writes this directory and runs as an unprivileged user, while this
# container is the one that creates it. On the panel the backend gets there
# first with the same uid; on a node nobody else would, so hand it over here.
AGENT_UID=${AEOLUS_AGENT_UID:-10001}
mkdir -p "$CONFIG_DIR"
chown "$AGENT_UID:$AGENT_UID" "$CONFIG_DIR" 2>/dev/null || true

# The hub gets server.conf (the listener clients dial); every other node gets
# only transit.conf (the tunnel it dials to the hub). Wait for whichever this
# machine is meant to run.
#
# On the panel host the backend writes the bundle at startup, so this is a short
# race. On a node the config only arrives once an operator has accepted the join
# request, which can take as long as it takes — so wait rather than give up.
attempt=0
while [ ! -f "$CONFIG_DIR/server.conf" ] && [ ! -f "$CONFIG_DIR/transit.conf" ]; do
    attempt=$((attempt + 1))
    if [ $((attempt % 15)) -eq 1 ]; then
        echo "waiting for a config in $CONFIG_DIR — the panel writes one once this node is accepted"
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
#
# Only where clients actually land: a node has no client pool of its own, and
# these rules may run in the host's tables when it shares the namespace, on a
# machine that could already be routing the very same range.
UPLINK=$(ip -4 route show default | awk '{print $5; exit}')
if [ -f "$CONFIG_DIR/server.conf" ]; then
    for subnet in "$VPN_SUBNET/$VPN_MASK" "$VPN_TCP_SUBNET/$VPN_MASK"; do
        if ! iptables -t nat -C POSTROUTING -s "$subnet" -o "$UPLINK" -j MASQUERADE 2>/dev/null; then
            iptables -t nat -A POSTROUTING -s "$subnet" -o "$UPLINK" -j MASQUERADE
        fi
        iptables -A FORWARD -s "$subnet" -j ACCEPT
        iptables -A FORWARD -d "$subnet" -m state --state ESTABLISHED,RELATED -j ACCEPT
    done
fi

# What a node masquerades: the hub's client pools, which arrive over the transit
# tunnel and leave through this machine's uplink. The panel decides the list; an
# empty file means this machine is the hub, which NATs from its routing plan.
NAT_CHAIN=AEOLUS-NODE-NAT
apply_node_nat() {
    [ -f "$CONFIG_DIR/nat-subnets" ] || return 0
    iptables -t nat -N "$NAT_CHAIN" 2>/dev/null || true
    iptables -t nat -F "$NAT_CHAIN"
    iptables -t nat -C POSTROUTING -j "$NAT_CHAIN" 2>/dev/null || \
        iptables -t nat -I POSTROUTING 1 -j "$NAT_CHAIN"

    iptables -N "$NAT_CHAIN" 2>/dev/null || true
    iptables -F "$NAT_CHAIN"
    iptables -C FORWARD -j "$NAT_CHAIN" 2>/dev/null || iptables -I FORWARD 1 -j "$NAT_CHAIN"

    while read -r subnet; do
        [ -n "$subnet" ] || continue
        iptables -t nat -A "$NAT_CHAIN" -s "$subnet" -o "$UPLINK" -j MASQUERADE
        iptables -A "$NAT_CHAIN" -s "$subnet" -j ACCEPT
        iptables -A "$NAT_CHAIN" -d "$subnet" -m conntrack \
            --ctstate ESTABLISHED,RELATED -j ACCEPT
    done < "$CONFIG_DIR/nat-subnets"
}

mkdir -p /run/openvpn

openvpn_pid=""
openvpn_tcp_pid=""
openvpn_transit_pid=""

start_openvpn() {
    openvpn_pid=""
    if [ -f "$CONFIG_DIR/server.conf" ]; then
        echo "starting openvpn on $UPLINK, NAT for $VPN_SUBNET/$VPN_MASK"
        openvpn --config "$CONFIG_DIR/server.conf" --cd "$CONFIG_DIR" &
        openvpn_pid=$!
    fi

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

# The routing plan says which client may reach what and where the rest of its
# traffic goes. It is applied here rather than by the panel because the tunnels
# live in this namespace.
PLAN="$CONFIG_DIR/routing.json"
seen_plan=""
apply_plan() {
    [ -f "$PLAN" ] || return 0
    current=$(sha256sum "$PLAN" | cut -d" " -f1)
    [ "$current" = "$seen_plan" ] && return 0
    if /usr/local/bin/apply-routing.sh "$PLAN"; then
        seen_plan="$current"
    else
        echo "routing plan rejected, keeping the previous rules" >&2
    fi
}
apply_plan
apply_node_nat

# The agent rewrites server.conf when the panel changes it and touches the flag.
# The CRL and ccd are re-read by OpenVPN itself, so only server.conf needs this.
while true; do
    sleep 5

    # OpenVPN writes status.log mode 0600; the agent runs as another user and
    # only ever reads it. Re-apply on every pass because the file is recreated.
    chmod 0644 /run/openvpn/status.log /run/openvpn/status-tcp.log \
        /run/openvpn/status-transit.log 2>/dev/null || true

    if [ -n "$openvpn_pid" ] && ! kill -0 "$openvpn_pid" 2>/dev/null; then
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

    # Rules follow the tunnels: a client that just got an exit must not wait for
    # a restart to get it.
    apply_plan
    apply_node_nat

    current_flag=$(cat "$RESTART_FLAG" 2>/dev/null || echo "")
    if [ "$current_flag" != "$seen_flag" ]; then
        seen_flag="$current_flag"
        echo "configuration changed, restarting openvpn"
        stop_openvpn
        start_openvpn
    fi
done
