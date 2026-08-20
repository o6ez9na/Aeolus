#!/bin/sh
#
# Apply the hub's routing plan: which client may reach what, and where the rest
# of a client's traffic goes.
#
# Run inside the namespace that owns the tunnels — the panel writes the plan,
# this applies it, the same split as every other config file here.
#
# Everything is rebuilt from scratch on each run rather than patched: a rule set
# that drifts from the plan is worse than one that is briefly rewritten, and
# "flush then fill" is the only way to be sure the two agree.
set -eu

PLAN=${1:-/etc/openvpn/aeolus/routing.json}
[ -f "$PLAN" ] || exit 0

# The chains are ours alone, so flushing them cannot disturb anything else on
# the host — which matters when this container shares the host's namespace.
CHAIN=AEOLUS-FWD
NAT_CHAIN=AEOLUS-NAT
TABLE_BASE=100

jqr() { jq -r "$1" "$PLAN"; }

UPLINK=$(ip -4 route show default | awk '{print $5; exit}')
POOL=$(jqr '.pool')
POOL_TCP=$(jqr '.pool_tcp')
TRANSIT=$(jqr '.transit')

# --- filter -----------------------------------------------------------------
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
# Hook it in once; -C keeps a restart from stacking duplicates.
iptables -C FORWARD -j "$CHAIN" 2>/dev/null || iptables -I FORWARD 1 -j "$CHAIN"

# Return traffic first: every rule below only has to describe who may start a
# conversation.
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Two encapsulations back to back (client -> hub -> node) leave far less room
# than the tunnel's own MTU suggests. Small packets get through, full-size ones
# are dropped with DF set, and TCP stalls with no error anywhere. Clamp the
# handshake so both ends agree on something that fits.
iptables -t mangle -N "$CHAIN" 2>/dev/null || true
iptables -t mangle -F "$CHAIN"
iptables -t mangle -C FORWARD -j "$CHAIN" 2>/dev/null || iptables -t mangle -I FORWARD 1 -j "$CHAIN"
iptables -t mangle -A "$CHAIN" -p tcp --tcp-flags SYN,RST SYN \
    -j TCPMSS --clamp-mss-to-pmtu

# --- nat --------------------------------------------------------------------
iptables -t nat -N "$NAT_CHAIN" 2>/dev/null || true
iptables -t nat -F "$NAT_CHAIN"
iptables -t nat -C POSTROUTING -j "$NAT_CHAIN" 2>/dev/null || \
    iptables -t nat -I POSTROUTING 1 -j "$NAT_CHAIN"

# Clients that exit through the hub itself leave by its uplink.
for pool in "$POOL" "$POOL_TCP"; do
    iptables -t nat -A "$NAT_CHAIN" -s "$pool" -o "$UPLINK" -j MASQUERADE
done

# --- per client -------------------------------------------------------------
count=$(jqr '.clients | length')
i=0
while [ "$i" -lt "$count" ]; do
    name=$(jqr ".clients[$i].name")
    exit_via=$(jqr ".clients[$i].exit_via")

    for addr in $(jqr ".clients[$i].address") $(jqr ".clients[$i].address_tcp"); do
        # Networks this client was granted, whichever node they sit behind.
        for dest in $(jqr ".clients[$i].allow[]?"); do
            iptables -A "$CHAIN" -s "$addr" -d "$dest" -j ACCEPT
        done

        case "$exit_via" in
            null|"")
                # No exit: this client only reaches what it was granted, and the
                # policy below drops the rest.
                ;;
            hub)
                # Out through the hub's own uplink, and nowhere else: leaving
                # this unqualified would open every other site's LAN too.
                iptables -A "$CHAIN" -s "$addr" -o "$UPLINK" -j ACCEPT
                ;;
            *)
                # Out through a node. Everything except the mesh itself, for the
                # same reason.
                mesh=$(jqr '.mesh | join(",")')
                if [ -n "$mesh" ]; then
                    for dest in $(jqr '.mesh[]?'); do
                        iptables -A "$CHAIN" -s "$addr" -d "$dest" -j RETURN
                    done
                fi
                iptables -A "$CHAIN" -s "$addr" -j ACCEPT
                ;;
        esac
    done
    i=$((i + 1))
done

# Anything in our pools that nothing above accepted stops here. Scoped to the
# pools so a shared host's own forwarding is left alone.
for pool in "$POOL" "$POOL_TCP"; do
    iptables -A "$CHAIN" -s "$pool" -j DROP
done

# --- policy routing ---------------------------------------------------------
# One table per exit node; a client's address is what picks the table. Several
# nodes can be exits at once this way, which a single default route could not do.
ip rule show | awk '$0 ~ /lookup (1[0-9][0-9]|[2-9][0-9][0-9])/ {print $0}' | while read -r rule; do
    prio=${rule%%:*}
    case "$prio" in
        [0-9]*) ip rule del prio "$prio" 2>/dev/null || true ;;
    esac
done

i=0
while [ "$i" -lt "$count" ]; do
    exit_via=$(jqr ".clients[$i].exit_via")
    case "$exit_via" in
        null|""|hub) i=$((i + 1)); continue ;;
    esac

    # A table per node address: 10.10.0.2 -> 102, 10.10.0.3 -> 103.
    host=${exit_via##*.}
    table=$((TABLE_BASE + host))
    ip route replace default via "$exit_via" table "$table" 2>/dev/null || true

    for addr in $(jqr ".clients[$i].address") $(jqr ".clients[$i].address_tcp"); do
        ip rule add from "$addr" table "$table" prio "$table" 2>/dev/null || true
    done
    i=$((i + 1))
done

echo "routing plan applied: $(jqr '.revision') ($count clients)"
