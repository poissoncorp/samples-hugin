#!/usr/bin/env bash
# captive-test.sh — Phase 6 captive-portal smoke from a Linux/WSL/macOS client
# connected to the Hugin AP. Pipes a structured PASS/FAIL/SKIP checklist.
#
# Usage:
#   ./captive-test.sh              # run all 12 items
#   ./captive-test.sh | tee /tmp/hugin-captive-$(date +%s).log
#
set -uo pipefail

PASS=0
FAIL=0
SKIP=0
LOG="/tmp/hugin-captive-test-$(date +%Y-%m-%dT%H%M%S).log"
COOKIES="/tmp/hugin-captive.cookies"
: > "$LOG"

color() {
  local code=$1; shift
  if [[ -t 1 ]]; then printf '\e[%sm%s\e[0m' "$code" "$*"; else printf '%s' "$*"; fi
}
ok()   { echo "[ $(color 32 PASS) ]  $*"; PASS=$((PASS+1)); }
nope() { echo "[ $(color 31 FAIL) ]  $*"; FAIL=$((FAIL+1)); }
skip() { echo "[ $(color 33 SKIP) ]  $*"; SKIP=$((SKIP+1)); }
need() { command -v "$1" >/dev/null 2>&1; }

# Discover interface + IP.
GW_INFO="$(ip route get 10.1.1.1 2>/dev/null | head -1 || true)"
IFACE="$(echo "$GW_INFO" | awk '/dev/ { for (i=1;i<=NF;i++) if ($i=="dev") print $(i+1) }')"
IP="$(echo "$GW_INFO" | awk '/src/ { for (i=1;i<=NF;i++) if ($i=="src") print $(i+1) }')"
GW="$(ip route 2>/dev/null | awk '/^default/ { print $3; exit }')"

echo "=== Hugin captive-portal smoke ==="
echo "Client: $(hostname)  iface=${IFACE:-?}  ip=${IP:-?}  gw=${GW:-?}"
echo "Date:   $(date -Iseconds)"
echo

# 1. DHCP lease in 10.1.1.0/24
if [[ "$IP" =~ ^10\.1\.1\. ]]; then ok "1.  DHCP lease in 10.1.1.0/24 (got $IP)"
else                                nope "1.  DHCP lease — got '$IP', expected 10.1.1.x"; fi

# 2. Default gateway
if [[ "$GW" == "10.1.1.1" ]]; then ok  "2.  Default gateway = 10.1.1.1"
else                              nope "2.  Default gateway — got '$GW', expected 10.1.1.1"; fi

# 3. DNS catch-all
if need dig; then
  ans="$(dig +short +time=2 +tries=1 some-random-host.example | head -1 || true)"
  if [[ "$ans" == "10.1.1.1" ]]; then ok  "3.  DNS catch-all → 10.1.1.1"
  else                                nope "3.  DNS catch-all — got '$ans'"; fi
else
  skip "3.  DNS catch-all (dig missing)"
fi

# 4. Apple captive probe (pre-release)
http_get_status() {
  curl -sI -o /dev/null --max-time 5 -w '%{http_code}|%{redirect_url}' "$@" 2>>"$LOG" || true
}
out="$(http_get_status http://captive.apple.com/hotspot-detect.html)"
code="${out%%|*}"; loc="${out#*|}"
if [[ "$code" == "302" && "$loc" == http://start.ravendb* ]]; then ok "4.  Apple probe → 302 to start.ravendb"
else                                                              nope "4.  Apple probe — code=$code loc=$loc"; fi

# 5. Android probe
out="$(http_get_status http://connectivitycheck.gstatic.com/generate_204)"
code="${out%%|*}"; loc="${out#*|}"
if [[ "$code" == "302" && "$loc" == http://start.ravendb* ]]; then ok "5.  Android probe → 302 to start.ravendb"
else                                                              nope "5.  Android probe — code=$code loc=$loc"; fi

# 6. Microsoft connecttest
out="$(curl -sI --max-time 5 http://msftconnecttest.com/connecttest.txt | tr -d '\r' | head -1)"
if echo "$out" | grep -q "^HTTP/1.1 302"; then ok "6.  Microsoft connecttest → 302"
else                                          nope "6.  Microsoft connecttest — got: $out"; fi

# 7. Microsoft NCSI
out="$(curl -sI --max-time 5 http://www.msftncsi.com/ncsi.txt | tr -d '\r' | head -1)"
if echo "$out" | grep -q "^HTTP/1.1 302"; then ok "7.  Microsoft NCSI → 302"
else                                          nope "7.  Microsoft NCSI — got: $out"; fi

# 8. start.ravendb HTML
out="$(curl -sI --max-time 5 http://start.ravendb/ | tr -d '\r' | head -1)"
if echo "$out" | grep -q "^HTTP/1.1 200"; then ok "8.  start.ravendb HTML → 200"
else                                          nope "8.  start.ravendb HTML — got: $out"; fi

# 9. /api/communities
if need jq; then
  count="$(curl -sS --max-time 8 http://start.ravendb/api/communities 2>>"$LOG" | jq '.data | length' 2>>"$LOG" || echo 0)"
  if [[ "$count" =~ ^[0-9]+$ && "$count" -ge 4 ]]; then ok "9.  /api/communities returns ${count} ≥ 4"
  else                                                  nope "9.  /api/communities — got count='$count'"; fi
else
  skip "9.  /api/communities (jq missing)"
fi

# 10. AI search
if need jq; then
  count="$(curl -sS --max-time 30 'http://start.ravendb/api/search?mode=ai&q=raspberry+pi+gpio&pageSize=3' 2>>"$LOG" | jq '.data.results | length' 2>>"$LOG" || echo 0)"
  if [[ "$count" =~ ^[0-9]+$ && "$count" -ge 1 ]]; then ok "10. AI search returns ${count} result(s)"
  else                                                  nope "10. AI search — got count='$count'"; fi
else
  skip "10. AI search (jq missing)"
fi

# 11. Captive release flow
release_code="$(curl -sI -c "$COOKIES" --max-time 5 -o /dev/null -w '%{http_code}' http://start.ravendb/captive/complete)"
if [[ "$release_code" == "204" ]] && grep -q "captive_released" "$COOKIES" 2>/dev/null; then
  # Re-run probe 4 with cookie; expect success codes (200 OR 204).
  out="$(curl -sI -b "$COOKIES" --max-time 5 -o /dev/null -w '%{http_code}' http://captive.apple.com/hotspot-detect.html)"
  if [[ "$out" == "200" ]]; then ok "11. Captive release — Apple probe returns 200 with cookie"
  else                          nope "11. Captive release — Apple probe with cookie returned $out"; fi
else
  nope "11. Captive release — /captive/complete code=$release_code or cookie missing"
fi
rm -f "$COOKIES"

# 12. HTTPS catch-all
out="$(curl -skI --max-time 5 -o /dev/null -w '%{http_code}' https://start.ravendb/)"
if [[ "$out" == "200" ]]; then
  out2="$(curl -skI --max-time 5 --resolve example.com:443:10.1.1.1 -o /dev/null -w '%{http_code}|%{redirect_url}' https://example.com/)"
  code2="${out2%%|*}"; loc2="${out2#*|}"
  if [[ "$code2" == "302" && "$loc2" == http://start.ravendb* ]]; then ok "12. HTTPS catch-all redirects to http://start.ravendb"
  else                                                                 nope "12. HTTPS catch-all — code=$code2 loc=$loc2"; fi
else
  nope "12. HTTPS start.ravendb — got $out, expected 200"
fi

echo
echo "Summary: ${PASS}/$((PASS+FAIL+SKIP)) PASS  ${FAIL} FAIL  ${SKIP} SKIP"
echo "Failure log: $LOG"
[[ $FAIL -eq 0 ]] || exit 2
