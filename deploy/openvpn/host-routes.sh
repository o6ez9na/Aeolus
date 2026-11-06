#!/bin/sh
#
# The host's half of a site link to the hub.
#
# A device on the hub's LAN reaches a node's LAN through the panel's host, once
# its router sends those networks here. Everything past the host happens in the
# openvpn container (apply-routing.sh). The host, though, does not know that
# container is the way there: it hands the packet back to the router, which sends
# it here again until the TTL runs out. A container on a bridge cannot change
# that, so this one runs in the host's namespace.
#
# That makes it able to do anything to the host's network, so it gets as little
# as possible: NET_ADMIN and the one file apply-routing.sh leaves for it, which
# holds the openvpn container's address, then one "source destination" pair per
# line.
set -u

INPUT=/run/openvpn/host-routes
# Marks a route as ours in the kernel, so it can be taken away again later, and so
# nothing else on this host is ever touched.
PROTO=222
CHAIN=AEOLUS-HOST

problems=""
reported=""
routes=""
forwarding=""

problem() {
    problems="$problems$1
"
}

sync_routes() {
    via=$1
    wanted=$2

    for net in $wanted; do
        ours=$(ip -4 route show exact "$net" proto "$PROTO")
        if [ -n "$ours" ]; then
            case "$ours" in *"via $via "*) continue ;; esac
            op=replace
        elif [ -n "$(ip -4 route show exact "$net")" ]; then
            problem "$net is already routed on this host by something else, leaving it alone"
            continue
        else
            op=add
        fi
        if ! out=$(ip -4 route "$op" "$net" via "$via" proto "$PROTO" 2>&1); then
            problem "cannot route $net via $via: $out"
        fi
    done

    for net in $(ip -4 route show proto "$PROTO" | awk '{print $1}'); do
        case " $wanted " in
            *" $net "*) ;;
            *) ip -4 route del "$net" proto "$PROTO" ;;
        esac
    done
}

# Docker usually sets the FORWARD policy to DROP and lets in only what is
# published. DOCKER-USER is the chain it leaves to everyone else.
sync_forwarding() {
    pairs=$1

    if ! iptables -S DOCKER-USER >/dev/null 2>&1; then
        [ -z "$pairs" ] || problem "no DOCKER-USER chain here: if the host drops forwarded packets, allow these flows by hand"
        return 0
    fi

    iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null && [ "$pairs" = "$forwarding" ] && return 0

    iptables -N "$CHAIN" 2>/dev/null || true
    iptables -F "$CHAIN"
    iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER 1 -j "$CHAIN"
    printf '%s\n' "$pairs" | while read -r src dst; do
        [ -n "$dst" ] || continue
        iptables -A "$CHAIN" -s "$src" -d "$dst" -j ACCEPT
    done
    forwarding=$pairs
}

sync_all() {
    problems=""
    via=$(head -n 1 "$INPUT")
    pairs=$(tail -n +2 "$INPUT")
    if [ -z "$via" ]; then
        problem "$INPUT does not name the openvpn container's address"
    else
        sync_routes "$via" "$(printf '%s\n' "$pairs" | awk 'NF {print $2}' | sort -u | tr '\n' ' ')"
        sync_forwarding "$pairs"
    fi

    # Only what changed, or this would fill the log every few seconds.
    now=$(ip -4 route show proto "$PROTO")
    if [ "$now" != "$routes" ]; then
        routes=$now
        echo "routes on this host: ${now:-none}"
    fi
    if [ "$problems" != "$reported" ]; then
        reported=$problems
        printf '%s' "$problems" >&2
    fi
}

trap 'exit 0' TERM INT

while true; do
    [ -s "$INPUT" ] && sync_all
    sleep 5 &
    wait $!
done
