#!/usr/bin/env bash
#
# Aeolus installer.
#
#   curl -fsSL https://raw.githubusercontent.com/o6ez9na/Aeolus/main/scripts/install.sh | sudo bash
#
# Asks whether to install the PANEL (the hub clients dial) or a NODE (an exit
# the panel forwards them to). Non-interactive:
#
#   ... | sudo bash -s -- panel
#   ... | sudo bash -s -- node
#   INSTALL_MODE=node AEOLUS_PANEL_DOMAIN=vpn.example.com ... | sudo bash
#
# Running it again on a machine that already has Aeolus updates it in place:
# the tree is refreshed and the containers rebuilt, while .env — which holds the
# secrets every stored key is derived from — is left alone. FORCE_REINSTALL=1
# takes the full path anyway.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/o6ez9na/Aeolus.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/aeolus}"

# --- output ----------------------------------------------------------------
c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info() { echo "$(c '1;34' '::') $*"; }
ok()   { echo "$(c '1;32' 'ok') $*"; }
warn() { echo "$(c '1;33' 'warn') $*" >&2; }
die()  { echo "$(c '1;31' 'error') $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)."

# The script itself arrives on stdin, so prompts have to read the terminal
# directly. There may not be one — a CI run or a piped install with stdin closed
# — in which case every question falls back to its default and anything without
# one has to come from the environment.
# Testing the permissions is not enough: /dev/tty exists and is readable even
# for a process with no controlling terminal, where opening it fails outright.
if { : >/dev/tty; } 2>/dev/null; then HAVE_TTY=1; else HAVE_TTY=""; fi
say() { if [ -n "$HAVE_TTY" ]; then echo "$*" >/dev/tty; else echo "$*" >&2; fi; }

ask() { # ask <prompt> <var> [default]
  local prompt="$1" __var="$2" def="${3:-}" reply=""
  if [ -z "$HAVE_TTY" ]; then
    printf -v "$__var" '%s' "$def"
    return 0
  fi
  [ -n "$def" ] && prompt="$prompt [$def]"
  printf '%s: ' "$prompt" >/dev/tty
  read -r reply </dev/tty || true
  printf -v "$__var" '%s' "${reply:-$def}"
}
ask_secret() {
  local prompt="$1" __var="$2" reply=""
  if [ -n "$HAVE_TTY" ]; then
    printf '%s: ' "$prompt" >/dev/tty
    read -rs reply </dev/tty || true
    echo >/dev/tty
  fi
  printf -v "$__var" '%s' "$reply"
}

# --- distro ----------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
else die "unsupported distro (need apt or dnf)."; fi

pkg_install() {
  case "$PKG" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
    dnf) dnf install -y "$@" ;;
  esac
}

APT_UPDATED=""
pkg_refresh() {
  [ "$PKG" = apt ] || return 0
  [ -n "$APT_UPDATED" ] && return 0
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  APT_UPDATED=1
}

rand_hex() { openssl rand -hex 32; }
rand_pass() { openssl rand -base64 18 | tr -d '/+=' | cut -c1-20; }

# --- prerequisites ---------------------------------------------------------
install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "docker with the compose plugin is already here"
    return
  fi
  info "installing docker"
  pkg_refresh
  pkg_install ca-certificates curl
  # The distro packages lag and often ship docker-compose v1; the convenience
  # script gets the plugin that `docker compose` needs.
  curl -fsSL https://get.docker.com | sh
  docker compose version >/dev/null 2>&1 || die "docker installed but 'docker compose' is missing"
  systemctl enable --now docker
  ok "docker ready"
}

ensure_tools() {
  pkg_refresh
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  [ "${#missing[@]}" -gt 0 ] && pkg_install "${missing[@]}"
  :
}

ensure_tun() {
  [ -c /dev/net/tun ] && return 0
  info "creating /dev/net/tun"
  mkdir -p /dev/net
  mknod /dev/net/tun c 10 200 || die "cannot create /dev/net/tun — in an LXC container, bind-mount it from the host"
  chmod 600 /dev/net/tun
}

ensure_forwarding() {
  sysctl -qw net.ipv4.ip_forward=1
  echo 'net.ipv4.ip_forward=1' >/etc/sysctl.d/99-aeolus.conf
}

fetch_tree() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "refreshing $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  elif [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    # Deployed by rsync rather than git; leave the tree as the operator put it.
    warn "$INSTALL_DIR exists but is not a git checkout — using it as is"
  else
    info "cloning $REPO_URL into $INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" \
      || die "clone failed. If the repository is private, deploy a key or set REPO_URL to an authenticated URL."
  fi
}

# --- .env handling ---------------------------------------------------------
# Values already present are never rewritten: AEOLUS_PKI_SECRET is the key every
# stored private key is encrypted with, and changing it silently would make the
# whole PKI unreadable.
env_get() { # env_get <file> <key>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -1
}
env_set() { # env_set <file> <key> <value>
  local file="$1" key="$2" value="$3"
  touch "$file"
  if grep -q "^$key=" "$file"; then
    # The value can contain slashes and &, so do the substitution in awk.
    awk -v k="$key" -v v="$value" -F= '
      $1 == k { print k "=" v; next } { print }' "$file" >"$file.tmp"
    mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}
env_default() { # env_default <file> <key> <value> — only when unset or empty
  [ -n "$(env_get "$1" "$2")" ] || env_set "$1" "$2" "$3"
}

detect_wan_iface() {
  ip -4 route show default 2>/dev/null | awk '{print $5; exit}'
}

detect_lan_subnet() {
  # The kernel's own connected route, so the answer is right for masks that are
  # not /24 — deriving it from the address by hand gets those wrong.
  local iface="$1"
  [ -n "$iface" ] || return 0
  ip -4 route show dev "$iface" scope link 2>/dev/null | awk '{print $1; exit}'
}

# --- panel -----------------------------------------------------------------
install_panel() {
  local env_file="$INSTALL_DIR/.env"
  local domain admin_pass existing_pass

  domain="${AEOLUS_DOMAIN:-$(env_get "$env_file" AEOLUS_DOMAIN)}"
  if [ -z "$domain" ]; then
    ask "domain the panel answers on (A record must already point here)" domain
    [ -n "$domain" ] || die "a domain is required: the panel serves HTTPS and every node dials it by name"
  fi

  existing_pass="$(env_get "$env_file" AEOLUS_FIRST_ADMIN_PASSWORD)"
  admin_pass="${AEOLUS_FIRST_ADMIN_PASSWORD:-}"
  if [ -z "$admin_pass" ] && [ -z "$existing_pass" ]; then
    ask_secret "password for the first admin (empty = generate one)" admin_pass
    # No answer, or nowhere to ask: a generated password beats refusing to
    # install, and it is printed at the end either way.
    [ -n "$admin_pass" ] || { admin_pass="$(rand_pass)"; GENERATED_PASS=1; }
  fi

  ensure_tun
  ensure_forwarding

  # Secrets first, and only if absent.
  env_default "$env_file" AEOLUS_SECRET_KEY "$(rand_hex)"
  env_default "$env_file" AEOLUS_PKI_SECRET "$(rand_hex)"
  env_default "$env_file" POSTGRES_PASSWORD "$(rand_hex)"
  env_default "$env_file" POSTGRES_USER aeolus
  env_default "$env_file" POSTGRES_DB aeolus
  env_default "$env_file" AEOLUS_FIRST_ADMIN_USERNAME admin
  [ -n "$admin_pass" ] && env_default "$env_file" AEOLUS_FIRST_ADMIN_PASSWORD "$admin_pass"
  env_default "$env_file" AEOLUS_DEBUG false
  env_set "$env_file" AEOLUS_DOMAIN "$domain"
  chmod 600 "$env_file"

  info "building and starting the panel — first build takes a few minutes"
  ( cd "$INSTALL_DIR" && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build )

  ok "panel is up at https://$domain"
  echo
  echo "  admin user:  $(env_get "$env_file" AEOLUS_FIRST_ADMIN_USERNAME)"
  if [ -n "${GENERATED_PASS:-}" ]; then
    echo "  password:    $admin_pass"
    echo "  (generated — it is also in $env_file, which is root-only)"
  else
    echo "  password:    the one you set (stored in $env_file)"
  fi
  echo
  echo "Open ports on this machine: 80, 443 (panel), 1194/udp and 8443/tcp (clients),"
  echo "1195/udp (nodes), 50051/tcp (agents). Certificates are issued on first request,"
  echo "so give Let's Encrypt a moment before the first visit."
  echo
  echo "Add a node from any other server:"
  echo "  curl -fsSL https://raw.githubusercontent.com/o6ez9na/Aeolus/main/scripts/install.sh | sudo bash -s -- node"
}

# --- node ------------------------------------------------------------------
install_node() {
  local env_file="$INSTALL_DIR/.env"
  local domain name subnets wan guess_subnet

  domain="${AEOLUS_PANEL_DOMAIN:-$(env_get "$env_file" AEOLUS_PANEL_DOMAIN)}"
  if [ -z "$domain" ]; then
    ask "domain of the panel this node reports to" domain
    [ -n "$domain" ] || die "a node is useless without a panel to report to"
  fi

  name="${AEOLUS_NODE_NAME:-$(env_get "$env_file" AEOLUS_NODE_NAME)}"
  [ -n "$name" ] || ask "name for this node" name "$(hostname -s)"

  wan="${AEOLUS_NODE_WAN_IFACE:-$(env_get "$env_file" AEOLUS_NODE_WAN_IFACE)}"
  [ -n "$wan" ] || wan="$(detect_wan_iface)"

  subnets="${AEOLUS_NODE_SUBNETS:-$(env_get "$env_file" AEOLUS_NODE_SUBNETS)}"
  if [ -z "$subnets" ]; then
    guess_subnet="$(detect_lan_subnet "$wan")"
    say "Networks behind this node that clients should be able to reach,"
    say "comma separated CIDRs. Leave empty for an internet-exit-only node."
    ask "local networks" subnets "$guess_subnet"
  fi

  ensure_tun
  ensure_forwarding

  env_set "$env_file" AEOLUS_PANEL_DOMAIN "$domain"
  env_set "$env_file" AEOLUS_NODE_NAME "$name"
  env_set "$env_file" AEOLUS_NODE_SUBNETS "$subnets"
  env_set "$env_file" AEOLUS_NODE_WAN_IFACE "$wan"
  chmod 600 "$env_file"

  info "building and starting the node"
  ( cd "$INSTALL_DIR" && docker compose -f docker-compose.node.yml up -d --build )

  ok "node is up and has announced itself to $domain"
  echo
  print_fingerprint
  echo
  echo "Accept it in the panel: узлы → заявки. Compare the fingerprint above with"
  echo "the one shown next to the request — that comparison is the only thing"
  echo "standing between your mesh and anyone else who knows the domain."
  echo
  echo "Logs:   cd $INSTALL_DIR && docker compose -f docker-compose.node.yml logs -f anemoi"
}

print_fingerprint() {
  local line="" tries=0
  info "waiting for the agent to print its key fingerprint"
  while [ "$tries" -lt 30 ]; do
    line="$(cd "$INSTALL_DIR" && docker compose -f docker-compose.node.yml logs anemoi 2>/dev/null \
      | grep -A1 'fingerprint must read' | tail -1 | tr -d '\r' | awk '{print $NF}')"
    case "$line" in
      *:*:*) echo "  fingerprint: $(c '1;32' "$line")"; return 0 ;;
    esac
    tries=$((tries + 1))
    sleep 2
  done
  warn "could not read the fingerprint from the logs yet; run:"
  echo "  cd $INSTALL_DIR && docker compose -f docker-compose.node.yml logs anemoi | grep -A1 fingerprint"
}

# --- mode ------------------------------------------------------------------
MODE="${1:-${INSTALL_MODE:-}}"
if [ -z "$MODE" ]; then
  [ -n "$HAVE_TTY" ] || die "no terminal to ask on: pass 'panel' or 'node' as an argument, or set INSTALL_MODE."
  say "What should this machine be?"
  say "  1) panel — the hub: web UI, database, the endpoint clients and nodes dial"
  say "  2) node  — an exit the panel forwards clients to"
  ask "choice" MODE "1"
  case "$MODE" in
    1|panel) MODE=panel ;;
    2|node)  MODE=node ;;
    *) die "unknown choice: $MODE" ;;
  esac
fi
[ "$MODE" = panel ] || [ "$MODE" = node ] || die "unknown mode: $MODE (expected panel or node)"

info "installing Aeolus $MODE into $INSTALL_DIR"
ensure_tools
install_docker
fetch_tree

case "$MODE" in
  panel) install_panel ;;
  node)  install_node ;;
esac
