#!/bin/bash
# wifi-direct.sh — direct (no-backend) WiFi mode operations.
#
# Extracted from the original hugin-mode.sh so that new tools (hugin-ap,
# hugin-wifi, hugin-reset-radio) can share the same proven config-write and
# teardown logic.
#
# Sourced by tools that need to touch wlan0/wpa_supplicant/dhcpcd directly.
# All functions here assume they run as root — caller must require_root.
#
# Functions (public):
#   wifi_apply_ap              — write AP config + teardown + restart dhcpcd
#   wifi_apply_client <ssid> <psk>
#   wifi_reset_radio           — modprobe -r/add brcmfmac for firmware recovery
#   wifi_current_mode          — echoes "ap" | "client" | "unknown"
#   wifi_status_raw            — prints a plain-text status block
#   wifi_backup_file <path>    — .bak-<timestamp> copy
#
# Constants (may be overridden by caller via env):
#   WPA_CONF, DHCPCD_CONF, WIFI_COUNTRY (env: HUGIN_WIFI_COUNTRY), AP_SSID, AP_CIDR
#
# Why the teardown sequence? `systemctl restart dhcpcd` on its own does NOT
# kill the old wpa_supplicant, does NOT flush stale IPs (old DHCP lease +
# new static = half-client / half-AP zombie), and does NOT recycle the
# radio between client and AP mode. Without this sequence the interface
# keeps answering on the old client IP while the AP SSID fails to broadcast.

: "${WPA_CONF:=/etc/wpa_supplicant/wpa_supplicant.conf}"
: "${DHCPCD_CONF:=/etc/dhcpcd.conf}"
: "${WIFI_COUNTRY:=${HUGIN_WIFI_COUNTRY:-IL}}"
: "${AP_SSID:=Hugin (ravendb)}"
: "${AP_CIDR:=10.1.1.1/24}"

WIFI_MARKER_BEGIN="# >>> hugin-mode wlan0 (managed) >>>"
WIFI_MARKER_END="# <<< hugin-mode wlan0 (managed) <<<"

_wifi_ts() { date +%Y%m%d-%H%M%S; }

wifi_backup_file() {
  local f=$1
  [[ -f "$f" ]] && cp -a "$f" "${f}.bak-$(_wifi_ts)"
}

# --- wpa_supplicant.conf writers ---

wifi_write_wpa_ap() {
  cat > "$WPA_CONF" <<EOF
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=${WIFI_COUNTRY}

network={
    ssid="${AP_SSID}"
    mode=2
    key_mgmt=NONE
    frequency=2412
}
EOF
  chmod 600 "$WPA_CONF"
}

wifi_write_wpa_client() {
  local ssid=$1 psk=$2
  cat > "$WPA_CONF" <<EOF
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=${WIFI_COUNTRY}

network={
    ssid="${ssid}"
    psk="${psk}"
    key_mgmt=WPA-PSK
}
EOF
  chmod 600 "$WPA_CONF"
}

# --- dhcpcd.conf managed block ---
# We keep a single block between markers so we can rewrite cleanly.

wifi_strip_managed_block() {
  # Remove the marker-delimited block if present.
  if grep -qF "$WIFI_MARKER_BEGIN" "$DHCPCD_CONF" 2>/dev/null; then
    sed -i "/^${WIFI_MARKER_BEGIN}\$/,/^${WIFI_MARKER_END}\$/d" "$DHCPCD_CONF"
  fi
  # Best-effort strip of legacy unmarked wlan0/static block (pre-hugin-mode era).
  if grep -qE '^interface wlan0' "$DHCPCD_CONF" 2>/dev/null \
     && grep -qE "static ip_address=${AP_CIDR//./\\.}" "$DHCPCD_CONF" 2>/dev/null; then
    sed -i "/^interface wlan0\$/,/^\(interface \|\$\)/{/^interface wlan0\$/d; /^static ip_address=/d; /^env wpa_supplicant_conf=/d;}" "$DHCPCD_CONF"
  fi
}

wifi_write_dhcpcd_ap() {
  wifi_strip_managed_block
  cat >> "$DHCPCD_CONF" <<EOF

${WIFI_MARKER_BEGIN}
env wpa_supplicant_conf=${WPA_CONF}
interface wlan0
static ip_address=${AP_CIDR}
nohook lookup-hostname
${WIFI_MARKER_END}
EOF
}

wifi_write_dhcpcd_client() {
  wifi_strip_managed_block
  cat >> "$DHCPCD_CONF" <<EOF

${WIFI_MARKER_BEGIN}
env wpa_supplicant_conf=${WPA_CONF}
${WIFI_MARKER_END}
EOF
}

# --- Teardown + bring-up ---

wifi_teardown_wlan0() {
  # `systemctl stop dhcpcd` has its own internal timeout (~90s default for
  # TimeoutStopSec). On a flapping radio dhcpcd can sit in `waiting for
  # carrier` and ignore SIGTERM until systemd finally SIGKILLs it 90s later.
  # That blew past hugin-boot.service's 60s TimeoutStartSec, killing the
  # whole unit before the AP fallback ran (observed 2026-05-03 evening: a
  # 5s per-network probe stretched to 73s, AP fallback never ran, Pi ended
  # up on APIPA 169.254.x.x). Cap the stop at 5s and SIGKILL behind it.
  timeout --kill-after=2s 5s systemctl stop dhcpcd >/dev/null 2>&1 || true
  pkill -9 dhcpcd 2>/dev/null || true
  pkill -9 -f '^wpa_supplicant' 2>/dev/null || true
  ip link set wlan0 down 2>/dev/null || true
  ip addr flush dev wlan0 2>/dev/null || true
  ip link set wlan0 up 2>/dev/null || true
}

# Spawn wpa_supplicant explicitly against $WPA_CONF. We do NOT rely on dhcpcd's
# `env wpa_supplicant_conf=` hook anymore — on Bookworm that hook silently
# fails to fire when the radio was in a flapping state, leaving wlan0 with
# no AP carrier and dhcpcd stuck on `waiting for carrier`. Starting
# wpa_supplicant ourselves is deterministic: either it daemonizes (-B) and
# the caller sees `type AP` on wlan0, or the command errors out loudly.
wifi_spawn_wpa_supplicant() {
  # Clear any stale control socket that would make -B fail with "already in use".
  rm -f /var/run/wpa_supplicant/wlan0 2>/dev/null || true
  wpa_supplicant -B -i wlan0 -c "$WPA_CONF" >/dev/null 2>&1
}

wifi_start_dhcpcd_and_wait() {
  # Cap `systemctl start dhcpcd` at 5s for the same reason wifi_teardown_wlan0
  # caps stop: a stuck dhcpcd unit can hold systemctl far longer than the
  # caller's per-network budget. Worst case dhcpcd doesn't actually start
  # within 5s — that's fine, the wifi_wait_for_client poll will time out
  # cleanly and the caller moves on.
  timeout --kill-after=2s 5s systemctl start dhcpcd >/dev/null 2>&1 || true
  # dhcpcd's association timing is independent of wpa_supplicant now that we
  # spawn the latter ourselves. The real readiness check lives in
  # wifi_wait_for_ap / wifi_wait_for_client; we just yield briefly so dhcpcd
  # has scheduled its first IP-assignment pass before the polling loop starts.
  sleep 0.5
}

# Verify AP came up: iw reports type AP, interface has 10.1.1.1/24, and
# wpa_supplicant is running. Polls up to ${1:-5} seconds at 2 Hz so healthy
# boots (AP ready in ~1-2s) finish fast without wasting cycles spinning.
# Echoes a one-line diagnostic on stderr, returns 0 on success, 1 on timeout.
wifi_wait_for_ap() {
  local iters=$(( ${1:-5} * 2 ))
  local iwtype="" ip="" running=0
  while (( iters-- > 0 )); do
    iwtype=$(iw dev wlan0 info 2>/dev/null | awk '/type/{print $2; exit}')
    ip=$(ip -4 -br addr show wlan0 2>/dev/null | awk '{print $3}')
    running=0
    pgrep -f '^wpa_supplicant' >/dev/null 2>&1 && running=1
    if [[ "$iwtype" == "AP" && "$ip" == "$AP_CIDR" && $running -eq 1 ]]; then
      echo "wifi_wait_for_ap: OK (type=AP ip=$ip wpa_supplicant=running)" >&2
      return 0
    fi
    sleep 0.5
  done
  echo "wifi_wait_for_ap: TIMEOUT (type=${iwtype:-?} ip=${ip:-none} wpa_supplicant=${running})" >&2
  return 1
}

# Verify client got a real DHCP lease (any non-10.1.1.1 IPv4). Default 5s.
# Echoes the acquired CIDR on stdout (success only), nothing on timeout.
# Note: real DHCP on a busy router can take 3-5s; 5s is tight but acceptable.
# Callers who want more slack should pass a bigger timeout.
wifi_wait_for_client() {
  local iters=$(( ${1:-5} * 2 ))
  local cidr
  while (( iters-- > 0 )); do
    cidr=$(ip -4 addr show wlan0 2>/dev/null \
      | grep -oP '\d+\.\d+\.\d+\.\d+/\d+' \
      | grep -v '^10\.1\.1\.1/' \
      | head -1 || true)
    if [[ -n "$cidr" ]]; then
      # Clean the stale AP static if still present.
      ip addr del 10.1.1.1/24 dev wlan0 2>/dev/null || true
      echo "$cidr"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# --- Public API ---

# Apply AP mode and verify. Returns 0 on verified success, 1 otherwise.
# On first-attempt verify failure, automatically runs wifi_reset_radio and
# re-applies once — the single most common root cause is a wedged brcmfmac
# firmware that only a module reload recovers from.
#
# Why we directly `ip addr add` the AP CIDR instead of trusting dhcpcd to
# apply the static block: dhcpcd's "active" notification fires before it
# has actually written the static IP to the interface (observed live
# 2026-05-04 boot sequence — dhcpcd reported active, wifi_wait_for_ap
# polled for 5 s, then 10 s after radio reset, ip stayed `none` both
# times, AP boot failed). dhcpcd's static-IP application has a race
# window we can't bound. Assigning with `ip addr add` is synchronous and
# deterministic — by the time the command returns, the IP is on the
# interface. dhcpcd still runs (its config block is harmless) but we no
# longer depend on its timing.
wifi_apply_ap() {
  wifi_backup_file "$WPA_CONF"
  wifi_backup_file "$DHCPCD_CONF"
  wifi_write_wpa_ap
  wifi_write_dhcpcd_ap
  wifi_teardown_wlan0
  wifi_spawn_wpa_supplicant
  # Apply the AP static IP synchronously, before we hand off to dhcpcd.
  # `2>/dev/null || true` swallows the "File exists" error if a leftover
  # static block already put it there — idempotent.
  ip addr add "$AP_CIDR" dev wlan0 2>/dev/null || true
  wifi_start_dhcpcd_and_wait
  if wifi_wait_for_ap "${WIFI_VERIFY_TIMEOUT:-5}"; then
    return 0
  fi
  echo "wifi_apply_ap: first attempt failed — reloading brcmfmac and retrying once" >&2
  wifi_reset_radio_module_only
  wifi_teardown_wlan0
  wifi_spawn_wpa_supplicant
  ip addr add "$AP_CIDR" dev wlan0 2>/dev/null || true
  wifi_start_dhcpcd_and_wait
  wifi_wait_for_ap "${WIFI_VERIFY_TIMEOUT:-5}"
}

# Apply client mode and verify. Returns 0 on a real DHCP lease, 1 on timeout.
# On success, the acquired CIDR is printed to stdout (single line) so callers
# that want it can capture via `$(...)` — callers that only care about the
# mode flip can just use the exit code. Third arg is verify timeout in
# seconds (default 15).
wifi_apply_client() {
  local ssid=$1 psk=$2 timeout=${3:-${WIFI_VERIFY_TIMEOUT:-5}}
  wifi_backup_file "$WPA_CONF"
  wifi_backup_file "$DHCPCD_CONF"
  wifi_write_wpa_client "$ssid" "$psk"
  wifi_write_dhcpcd_client
  wifi_teardown_wlan0 >/dev/null 2>&1
  wifi_spawn_wpa_supplicant
  wifi_start_dhcpcd_and_wait >/dev/null 2>&1
  wifi_wait_for_client "$timeout"
}

# Module-only reload — no dhcpcd / wpa_supplicant management. Used internally
# by wifi_apply_ap as its first-failure retry step. Callers wanting a full
# radio cycle should use wifi_reset_radio (which also re-applies the current
# wpa_supplicant.conf mode).
wifi_reset_radio_module_only() {
  # Order matters: brcmfmac depends on brcmutil; rmmod fails silently if
  # already unloaded or pinned — that's fine, modprobe re-adds below.
  modprobe -r brcmfmac 2>/dev/null || true
  modprobe -r brcmutil 2>/dev/null || true
  sleep 2
  modprobe brcmfmac
  sleep 3
}

# Full radio recovery: teardown + module reload + re-apply whichever mode
# is currently configured in wpa_supplicant.conf, with verification.
# Returns 0 if the radio came back up in its configured mode, 1 otherwise.
wifi_reset_radio() {
  local mode
  mode=$(wifi_current_mode)
  wifi_teardown_wlan0
  wifi_reset_radio_module_only
  case "$mode" in
    ap)
      wifi_spawn_wpa_supplicant
      wifi_start_dhcpcd_and_wait
      wifi_wait_for_ap "${WIFI_VERIFY_TIMEOUT:-5}"
      ;;
    client)
      wifi_spawn_wpa_supplicant
      wifi_start_dhcpcd_and_wait
      # Client verify is best-effort here — the saved SSID may be out of range.
      wifi_wait_for_client "${WIFI_VERIFY_TIMEOUT:-5}" >/dev/null || return 1
      ;;
    *)
      # Unknown config — just start dhcpcd and let the caller decide.
      wifi_start_dhcpcd_and_wait
      ;;
  esac
}

wifi_current_mode() {
  if grep -q 'mode=2' "$WPA_CONF" 2>/dev/null; then
    echo "ap"
  elif grep -q 'key_mgmt=WPA-PSK' "$WPA_CONF" 2>/dev/null; then
    echo "client"
  else
    echo "unknown"
  fi
}

wifi_status_raw() {
  echo "=== wpa_supplicant.conf mode ==="
  case "$(wifi_current_mode)" in
    ap)      echo "  APPLIANCE (AP)"; grep -E '^\s*(ssid|frequency|country)' "$WPA_CONF" 2>/dev/null || true ;;
    client)  echo "  CLIENT";          grep -E '^\s*(ssid|country)' "$WPA_CONF" 2>/dev/null || true ;;
    *)       echo "  unknown" ;;
  esac
  echo
  echo "=== wlan0 ==="
  # `ip -4 addr show wlan0` strips the state line — when v4 is missing
  # we'd see empty output and (mis)report "wlan0 not found" even though
  # the interface is up. Use `ip link` for state, then `ip -4 addr` for
  # IP, and report each independently.
  if ip link show wlan0 >/dev/null 2>&1; then
    ip link show wlan0 | awk '/state /{for (i=1;i<=NF;i++) if ($i=="state") print "  link: state " $(i+1) " " $1}'
    local v4
    v4=$(ip -4 addr show wlan0 2>/dev/null | awk '/inet /{print $2}')
    if [[ -n "$v4" ]]; then
      echo "  ipv4: $v4"
    else
      echo "  ipv4: none"
    fi
  else
    echo "  wlan0 interface not present"
  fi
  echo
  echo "=== wpa_supplicant process ==="
  pgrep -a wpa_supplicant 2>/dev/null || echo "  not running"
  echo
  echo "=== iw dev wlan0 info ==="
  iw dev wlan0 info 2>/dev/null | grep -E 'type|ssid|channel' || echo "  iw unavailable"
}
