#!/usr/bin/env bash
#
# Aeolus installer.
#
#   curl -fsSL https://raw.githubusercontent.com/o6ez9na/Aeolus/main/scripts/install.sh | sudo bash
#
# Asks for a language, then whether to install the PANEL (the hub clients dial)
# or a NODE (an exit the panel forwards them to). Non-interactive:
#
#   ... | sudo bash -s -- panel
#   ... | sudo bash -s -- node
#   AEOLUS_LANG=ru INSTALL_MODE=node AEOLUS_PANEL_DOMAIN=vpn.example.com ... | sudo bash
#
# Running it again on a machine that already has Aeolus updates it in place: the
# tree is refreshed and the containers rebuilt, while .env — which holds the
# secrets every stored key is derived from — is left alone.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/o6ez9na/Aeolus.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/aeolus}"

# --- output ----------------------------------------------------------------
c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info() { echo "$(c '1;34' '::') $*"; }
ok()   { echo "$(c '1;32' 'ok') $*"; }
warn() { echo "$(c '1;33' '!!') $*" >&2; }
die()  { echo "$(c '1;31' 'error') $*" >&2; exit 1; }

# Testing the permissions is not enough: /dev/tty exists and is readable even
# for a process with no controlling terminal, where opening it fails outright.
if { : >/dev/tty; } 2>/dev/null; then HAVE_TTY=1; else HAVE_TTY=""; fi
say() { if [ -n "$HAVE_TTY" ]; then echo "$*" >/dev/tty; else echo "$*" >&2; fi; }

# --- language --------------------------------------------------------------
# One case per language rather than gettext: the installer has to run on a box
# where nothing is installed yet, and it arrives as a single piped file.
LANGUAGE="${AEOLUS_LANG:-}"

t_en() {
  case "$1" in
    need_root)        echo "run as root (sudo).";;
    no_distro)        echo "unsupported distro (need apt or dnf).";;
    lang_question)    echo "Language / Язык";;
    lang_en)          echo "  1) English";;
    lang_ru)          echo "  2) Русский";;
    lang_choice)      echo "choice";;
    mode_question)    echo "What should this machine be?";;
    mode_panel)       echo "  1) panel — the hub: web UI, database, the endpoint clients and nodes dial";;
    mode_node)        echo "  2) node  — an exit the panel forwards clients to";;
    mode_no_tty)      echo "no terminal to ask on: pass 'panel' or 'node' as an argument, or set INSTALL_MODE.";;
    mode_unknown)     echo "unknown mode: %s (expected panel or node)";;
    installing)       echo "installing Aeolus %s into %s";;
    docker_here)      echo "docker with the compose plugin is already here";;
    docker_install)   echo "installing docker";;
    docker_ready)     echo "docker ready";;
    docker_no_plugin) echo "docker installed but 'docker compose' is missing";;
    net_check)        echo "checking that containers can reach the package mirrors";;
    net_ok)           echo "containers have working DNS and outbound HTTPS";;
    net_broken)       echo "a container cannot reach the Alpine mirrors — this is what makes the build fail with 'no such package'";;
    net_dns_try)      echo "pointing docker at public DNS servers and retrying";;
    net_dns_written)  echo "wrote %s and restarted docker";;
    net_daemon_exists) echo "%s already exists; leaving it alone";;
    net_manual)       echo "still no way out from a container. Fix DNS for docker, then run this script again. Usual causes: the provider's resolver, or a host with IPv6 that containers cannot use. Try: echo '{\"dns\":[\"1.1.1.1\",\"8.8.8.8\"]}' > /etc/docker/daemon.json && systemctl restart docker";;
    tun_create)       echo "creating /dev/net/tun";;
    tun_fail)         echo "cannot create /dev/net/tun — in an LXC container, bind-mount it from the host";;
    tree_refresh)     echo "refreshing %s";;
    tree_not_git)     echo "%s exists but is not a git checkout — using it as is";;
    tree_clone)       echo "cloning %s into %s";;
    tree_clone_fail)  echo "clone failed. If the repository is private, deploy a key or set REPO_URL to an authenticated URL.";;
    ask_domain)       echo "domain the panel answers on (A record must already point here)";;
    domain_required)  echo "a domain is required: the panel serves HTTPS and every node dials it by name";;
    ask_admin_pass)   echo "password for the first admin (empty = generate one)";;
    ask_panel_domain) echo "domain of the panel this node reports to";;
    panel_required)   echo "a node is useless without a panel to report to";;
    ask_node_name)    echo "name for this node";;
    subnets_hint1)    echo "Networks behind this node that clients should be able to reach,";;
    subnets_hint2)    echo "comma separated CIDRs. Leave empty for an internet-exit-only node.";;
    ask_subnets)      echo "local networks";;
    build_panel)      echo "building and starting the panel — the first build takes a few minutes";;
    build_node)       echo "building and starting the node";;
    build_retry)      echo "build failed (attempt %s of %s), retrying — package mirrors fail intermittently";;
    build_failed)     echo "build failed. The output above says why; a mirror or DNS problem is the usual one.";;
    panel_up)         echo "panel is up at https://%s";;
    admin_user)       echo "  admin user:  %s";;
    admin_pass_gen)   echo "  password:    %s";;
    admin_pass_note)  echo "  (generated — it is also in %s, which is root-only)";;
    admin_pass_kept)  echo "  password:    the one you set (stored in %s)";;
    ports_note)       echo "Open on this machine: 80, 443 (panel), 1194/udp and 8443/tcp (clients), 1195/udp (nodes), 50051/tcp (agents). Certificates are issued on first request, so give Let's Encrypt a moment.";;
    add_node_hint)    echo "Add a node from any other server:";;
    node_up)          echo "node is up and has announced itself to %s";;
    fp_wait)          echo "waiting for the agent to print its key fingerprint";;
    fp_line)          echo "  fingerprint: %s";;
    fp_fail)          echo "could not read the fingerprint from the logs yet; run:";;
    accept_hint1)     echo "Accept it in the panel: nodes -> requests. Compare the fingerprint above with";;
    accept_hint2)     echo "the one shown next to the request — that comparison is the only thing standing";;
    accept_hint3)     echo "between your mesh and anyone else who knows the domain.";;
    logs_hint)        echo "Logs:";;
    *)                echo "$1";;
  esac
}

t_ru() {
  case "$1" in
    need_root)        echo "запускай от root (sudo).";;
    no_distro)        echo "дистрибутив не поддерживается (нужен apt или dnf).";;
    lang_question)    echo "Language / Язык";;
    lang_en)          echo "  1) English";;
    lang_ru)          echo "  2) Русский";;
    lang_choice)      echo "выбор";;
    mode_question)    echo "Что ставим на эту машину?";;
    mode_panel)       echo "  1) панель — хаб: веб-интерфейс, база, точка, куда звонят клиенты и узлы";;
    mode_node)        echo "  2) узел   — выход, в который панель заворачивает клиентов";;
    mode_no_tty)      echo "спросить негде: передай 'panel' или 'node' аргументом либо задай INSTALL_MODE.";;
    mode_unknown)     echo "неизвестный режим: %s (ожидается panel или node)";;
    installing)       echo "ставлю Aeolus (%s) в %s";;
    docker_here)      echo "docker с плагином compose уже есть";;
    docker_install)   echo "ставлю docker";;
    docker_ready)     echo "docker готов";;
    docker_no_plugin) echo "docker поставился, но 'docker compose' отсутствует";;
    net_check)        echo "проверяю, что контейнеры дотягиваются до зеркал пакетов";;
    net_ok)           echo "у контейнеров работает DNS и исходящий HTTPS";;
    net_broken)       echo "контейнер не достаёт до зеркал Alpine — именно из-за этого сборка падает с 'no such package'";;
    net_dns_try)      echo "прописываю docker публичные DNS и пробую снова";;
    net_dns_written)  echo "записал %s и перезапустил docker";;
    net_daemon_exists) echo "%s уже существует, не трогаю его";;
    net_manual)       echo "из контейнера всё равно нет выхода. Почини DNS для docker и запусти скрипт снова. Обычные причины: резолвер провайдера или IPv6 на хосте, недоступный контейнерам. Попробуй: echo '{\"dns\":[\"1.1.1.1\",\"8.8.8.8\"]}' > /etc/docker/daemon.json && systemctl restart docker";;
    tun_create)       echo "создаю /dev/net/tun";;
    tun_fail)         echo "не могу создать /dev/net/tun — в LXC-контейнере пробрось его с хоста";;
    tree_refresh)     echo "обновляю %s";;
    tree_not_git)     echo "%s существует, но это не git-копия — беру как есть";;
    tree_clone)       echo "клонирую %s в %s";;
    tree_clone_fail)  echo "клонирование не удалось. Если репозиторий приватный — добавь deploy-ключ или задай REPO_URL с авторизацией.";;
    ask_domain)       echo "домен, на котором отвечает панель (A-запись уже должна вести сюда)";;
    domain_required)  echo "домен обязателен: панель отдаёт HTTPS, и каждый узел звонит к ней по имени";;
    ask_admin_pass)   echo "пароль первого админа (пусто — сгенерирую)";;
    ask_panel_domain) echo "домен панели, которой подчиняется этот узел";;
    panel_required)   echo "узел без панели бесполезен";;
    ask_node_name)    echo "имя этого узла";;
    subnets_hint1)    echo "Сети за этим узлом, до которых клиенты должны доставать,";;
    subnets_hint2)    echo "через запятую в формате CIDR. Пусто — узел только как выход в интернет.";;
    ask_subnets)      echo "локальные сети";;
    build_panel)      echo "собираю и поднимаю панель — первая сборка занимает несколько минут";;
    build_node)       echo "собираю и поднимаю узел";;
    build_retry)      echo "сборка упала (попытка %s из %s), повторяю — зеркала пакетов отваливаются наскоками";;
    build_failed)     echo "сборка не удалась. Причина в выводе выше; чаще всего это зеркало или DNS.";;
    panel_up)         echo "панель поднята: https://%s";;
    admin_user)       echo "  админ:   %s";;
    admin_pass_gen)   echo "  пароль:  %s";;
    admin_pass_note)  echo "  (сгенерирован, лежит в %s — файл только для root)";;
    admin_pass_kept)  echo "  пароль:  тот, что ты задал (хранится в %s)";;
    ports_note)       echo "Открой на этой машине: 80, 443 (панель), 1194/udp и 8443/tcp (клиенты), 1195/udp (узлы), 50051/tcp (агенты). Сертификат выпускается по первому запросу, дай Let's Encrypt минуту.";;
    add_node_hint)    echo "Добавить узел с любого другого сервера:";;
    node_up)          echo "узел поднят и отправил заявку на %s";;
    fp_wait)          echo "жду, пока агент напечатает отпечаток своего ключа";;
    fp_line)          echo "  отпечаток: %s";;
    fp_fail)          echo "отпечаток из логов пока не вычитался, посмотри сам:";;
    accept_hint1)     echo "Прими узел в панели: узлы → заявки. Сверь отпечаток выше с тем,";;
    accept_hint2)     echo "который показан рядом с заявкой — это единственное, что отделяет твою";;
    accept_hint3)     echo "сеть от любого, кто знает домен.";;
    logs_hint)        echo "Логи:";;
    *)                echo "$1";;
  esac
}

t() { # t <key> [printf args]
  local key="$1"; shift
  local fmt
  case "$LANGUAGE" in
    ru) fmt="$(t_ru "$key")" ;;
    *)  fmt="$(t_en "$key")" ;;
  esac
  # shellcheck disable=SC2059 - the format string is ours, from the table above.
  printf "$fmt\n" "$@"
}

[ "$(id -u)" -eq 0 ] || { LANGUAGE="${LANGUAGE:-en}"; die "$(t need_root)"; }

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

choose_language() {
  if [ -n "$LANGUAGE" ]; then
    case "$LANGUAGE" in ru|en) return 0 ;; *) LANGUAGE=en; return 0 ;; esac
  fi
  # A guess from the environment is only a default; the question still gets asked.
  case "${LANG:-}${LC_ALL:-}" in *ru_RU*|*ru_*) LANGUAGE=ru ;; *) LANGUAGE=en ;; esac
  [ -n "$HAVE_TTY" ] || return 0

  local reply
  say "$(t lang_question)"
  say "$(t lang_en)"
  say "$(t lang_ru)"
  ask "$(t lang_choice)" reply "$([ "$LANGUAGE" = ru ] && echo 2 || echo 1)"
  case "$reply" in
    2|ru|RU|рус*) LANGUAGE=ru ;;
    *) LANGUAGE=en ;;
  esac
}

# --- distro ----------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
else PKG=""; fi

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
    ok "$(t docker_here)"
    return
  fi
  info "$(t docker_install)"
  pkg_refresh
  pkg_install ca-certificates curl
  # The distro packages lag and often ship docker-compose v1; the convenience
  # script gets the plugin that `docker compose` needs.
  curl -fsSL https://get.docker.com | sh
  docker compose version >/dev/null 2>&1 || die "$(t docker_no_plugin)"
  systemctl enable --now docker
  ok "$(t docker_ready)"
}

container_can_fetch() {
  # Exactly what the image build does, and the step that fails on a box where
  # docker has no usable DNS: pull the Alpine index.
  docker run --rm --pull always alpine:3.22 \
    sh -c 'apk update >/dev/null 2>&1' >/dev/null 2>&1
}

ensure_docker_network() {
  info "$(t net_check)"
  if container_can_fetch; then
    ok "$(t net_ok)"
    return 0
  fi

  warn "$(t net_broken)"
  local daemon=/etc/docker/daemon.json
  if [ -s "$daemon" ]; then
    # Merging someone else's daemon.json blind is how a working docker gets
    # broken; say what to do instead.
    warn "$(t net_daemon_exists "$daemon")"
  else
    info "$(t net_dns_try)"
    mkdir -p /etc/docker
    printf '{ "dns": ["1.1.1.1", "8.8.8.8"] }\n' >"$daemon"
    systemctl restart docker || true
    sleep 3
    ok "$(t net_dns_written "$daemon")"
    if container_can_fetch; then
      ok "$(t net_ok)"
      return 0
    fi
  fi

  die "$(t net_manual)"
}

ensure_tools() {
  pkg_refresh
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v ip >/dev/null 2>&1 || missing+=(iproute2)
  [ "${#missing[@]}" -gt 0 ] && pkg_install "${missing[@]}"
  :
}

ensure_tun() {
  [ -c /dev/net/tun ] && return 0
  info "$(t tun_create)"
  mkdir -p /dev/net
  mknod /dev/net/tun c 10 200 || die "$(t tun_fail)"
  chmod 600 /dev/net/tun
}

ensure_forwarding() {
  sysctl -qw net.ipv4.ip_forward=1
  echo 'net.ipv4.ip_forward=1' >/etc/sysctl.d/99-aeolus.conf
}

fetch_tree() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "$(t tree_refresh "$INSTALL_DIR")"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  elif [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    # Deployed by rsync rather than git; leave the tree as the operator put it.
    warn "$(t tree_not_git "$INSTALL_DIR")"
  else
    info "$(t tree_clone "$REPO_URL" "$INSTALL_DIR")"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" \
      || die "$(t tree_clone_fail)"
  fi
}

compose_up() { # compose_up <compose args...>
  # Package mirrors fail intermittently, and a half-built stack is worse than a
  # slow one, so give the build a couple of tries before giving up.
  local tries=3 attempt=1
  while [ "$attempt" -le "$tries" ]; do
    if ( cd "$INSTALL_DIR" && docker compose "$@" up -d --build ); then
      return 0
    fi
    [ "$attempt" -eq "$tries" ] && break
    warn "$(t build_retry "$attempt" "$tries")"
    sleep 5
    attempt=$((attempt + 1))
  done
  die "$(t build_failed)"
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
    ask "$(t ask_domain)" domain
    [ -n "$domain" ] || die "$(t domain_required)"
  fi

  existing_pass="$(env_get "$env_file" AEOLUS_FIRST_ADMIN_PASSWORD)"
  admin_pass="${AEOLUS_FIRST_ADMIN_PASSWORD:-}"
  if [ -z "$admin_pass" ] && [ -z "$existing_pass" ]; then
    ask_secret "$(t ask_admin_pass)" admin_pass
    # No answer, or nowhere to ask: a generated password beats refusing to
    # install, and it is printed at the end either way.
    [ -n "$admin_pass" ] || { admin_pass="$(rand_pass)"; GENERATED_PASS=1; }
  fi

  ensure_tun
  ensure_forwarding

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

  info "$(t build_panel)"
  compose_up -f docker-compose.yml -f docker-compose.prod.yml

  ok "$(t panel_up "$domain")"
  echo
  t admin_user "$(env_get "$env_file" AEOLUS_FIRST_ADMIN_USERNAME)"
  if [ -n "${GENERATED_PASS:-}" ]; then
    t admin_pass_gen "$admin_pass"
    t admin_pass_note "$env_file"
  else
    t admin_pass_kept "$env_file"
  fi
  echo
  t ports_note
  echo
  t add_node_hint
  echo "  curl -fsSL https://raw.githubusercontent.com/o6ez9na/Aeolus/main/scripts/install.sh | sudo bash -s -- node"
}

# --- node ------------------------------------------------------------------
install_node() {
  local env_file="$INSTALL_DIR/.env"
  local domain name subnets wan guess_subnet

  domain="${AEOLUS_PANEL_DOMAIN:-$(env_get "$env_file" AEOLUS_PANEL_DOMAIN)}"
  if [ -z "$domain" ]; then
    ask "$(t ask_panel_domain)" domain
    [ -n "$domain" ] || die "$(t panel_required)"
  fi

  name="${AEOLUS_NODE_NAME:-$(env_get "$env_file" AEOLUS_NODE_NAME)}"
  [ -n "$name" ] || ask "$(t ask_node_name)" name "$(hostname -s)"

  wan="${AEOLUS_NODE_WAN_IFACE:-$(env_get "$env_file" AEOLUS_NODE_WAN_IFACE)}"
  [ -n "$wan" ] || wan="$(detect_wan_iface)"

  subnets="${AEOLUS_NODE_SUBNETS:-$(env_get "$env_file" AEOLUS_NODE_SUBNETS)}"
  if [ -z "$subnets" ]; then
    guess_subnet="$(detect_lan_subnet "$wan")"
    say "$(t subnets_hint1)"
    say "$(t subnets_hint2)"
    ask "$(t ask_subnets)" subnets "$guess_subnet"
  fi

  ensure_tun
  ensure_forwarding

  env_set "$env_file" AEOLUS_PANEL_DOMAIN "$domain"
  env_set "$env_file" AEOLUS_NODE_NAME "$name"
  env_set "$env_file" AEOLUS_NODE_SUBNETS "$subnets"
  env_set "$env_file" AEOLUS_NODE_WAN_IFACE "$wan"
  chmod 600 "$env_file"

  info "$(t build_node)"
  compose_up -f docker-compose.node.yml

  ok "$(t node_up "$domain")"
  echo
  print_fingerprint
  echo
  t accept_hint1
  t accept_hint2
  t accept_hint3
  echo
  t logs_hint
  echo "  cd $INSTALL_DIR && docker compose -f docker-compose.node.yml logs -f anemoi"
}

print_fingerprint() {
  local line="" tries=0
  info "$(t fp_wait)"
  while [ "$tries" -lt 30 ]; do
    line="$(cd "$INSTALL_DIR" && docker compose -f docker-compose.node.yml logs anemoi 2>/dev/null \
      | grep -A1 'fingerprint must read' | tail -1 | tr -d '\r' | awk '{print $NF}')"
    case "$line" in
      *:*:*) t fp_line "$(c '1;32' "$line")"; return 0 ;;
    esac
    tries=$((tries + 1))
    sleep 2
  done
  warn "$(t fp_fail)"
  echo "  cd $INSTALL_DIR && docker compose -f docker-compose.node.yml logs anemoi | grep -A1 fingerprint"
}

# --- run -------------------------------------------------------------------
choose_language
[ -n "$PKG" ] || die "$(t no_distro)"

MODE="${1:-${INSTALL_MODE:-}}"
if [ -z "$MODE" ]; then
  [ -n "$HAVE_TTY" ] || die "$(t mode_no_tty)"
  say "$(t mode_question)"
  say "$(t mode_panel)"
  say "$(t mode_node)"
  ask "$(t lang_choice)" MODE "1"
  case "$MODE" in
    1|panel|панель) MODE=panel ;;
    2|node|узел)    MODE=node ;;
    *) die "$(t mode_unknown "$MODE")" ;;
  esac
fi
[ "$MODE" = panel ] || [ "$MODE" = node ] || die "$(t mode_unknown "$MODE")"

info "$(t installing "$MODE" "$INSTALL_DIR")"
ensure_tools
install_docker
ensure_docker_network
fetch_tree

case "$MODE" in
  panel) install_panel ;;
  node)  install_node ;;
esac
