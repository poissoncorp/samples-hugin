#!/usr/bin/env bash
# strip-image.sh — Phase 4 disk-strip helper, runs ON the Pi.
#
# Strips DATA-only items (empty stub DBs, old Ollama models, journals,
# apt cache, log files, temp dirs). Does NOT remove admin/dev tooling
# — that's deferred to Phase 7.2's final-second strip so dev capabilities
# stay intact through working sessions.
#
# Idempotent and dry-run by default. Re-run with --apply once you've
# reviewed what it would do.
#
# Usage:
#   sudo ./strip-image.sh             # dry-run, prints actions
#   sudo ./strip-image.sh --apply     # actually strip
#
set -euo pipefail

DRY_RUN=1
[[ "${1:-}" == "--apply" ]] && DRY_RUN=0

PREFIX="[dry-run]"
[[ $DRY_RUN -eq 0 ]] && PREFIX="[apply]"

run() {
  echo "$PREFIX $*"
  if [[ $DRY_RUN -eq 0 ]]; then
    eval "$@"
  fi
}

note() { echo "[note] $*"; }

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (sudo)" >&2
  exit 1
fi

echo "=== pre-strip baseline ==="
df -h / 2>/dev/null || true
du -h --max-depth=1 /var/lib/ravendb/data 2>/dev/null | tail -10 || true
ollama list 2>/dev/null || true
journalctl --disk-usage 2>/dev/null || true
echo "=========================="

# 1. Empty stub DBs from prior migration.
RAVEN_DB_DIR="/var/lib/ravendb/data/Databases"
STUB_DBS=(Hugin Hugin-Backup Hugin-int1 Hugin-int8b XferProbe)
note "1/7 — empty stub DBs"
RESTART_RAVEN=0
for db in "${STUB_DBS[@]}"; do
  if [[ -d "$RAVEN_DB_DIR/$db" ]]; then
    if [[ $RESTART_RAVEN -eq 0 ]]; then
      run "systemctl stop ravendb hugin"
      RESTART_RAVEN=1
    fi
    run "rm -rf '$RAVEN_DB_DIR/$db'"
  fi
done

# 1b. Forensic *.corrupted-* dirs.
note "2/7 — forensic backups"
for d in "$RAVEN_DB_DIR" /var/lib/ravendb/data; do
  for c in "$d"/*.corrupted-* "$d"/System.corrupted-*; do
    [[ -e "$c" ]] || continue
    if [[ $RESTART_RAVEN -eq 0 ]]; then
      run "systemctl stop ravendb hugin"
      RESTART_RAVEN=1
    fi
    run "rm -rf '$c'"
  done
done

if [[ $RESTART_RAVEN -eq 1 ]]; then
  run "systemctl start ravendb"
  echo "(allow ~30 s for raven to come back up before next steps depend on it)"
fi

# 2. Old Ollama models. Keep only snowflake-arctic-embed:s.
note "3/7 — old Ollama models"
KEEP="snowflake-arctic-embed:s"
if command -v ollama >/dev/null 2>&1; then
  while IFS= read -r line; do
    name="$(echo "$line" | awk '{print $1}')"
    [[ -z "$name" || "$name" == "NAME" ]] && continue
    if [[ "$name" != "$KEEP" ]]; then
      run "ollama rm '$name'"
    fi
  done < <(ollama list 2>/dev/null || true)
else
  note "ollama CLI not on PATH — skipping model strip"
fi

# 3. APT cache.
note "4/7 — apt cache"
run "apt-get clean"

# 4. Journals — cap at 50 MB.
note "5/7 — journals"
run "journalctl --vacuum-size=50M"

# 5. Old rotated log files.
note "6/7 — rotated logs"
for p in /var/log/dnsmasq.log /var/log/syslog.* /var/log/nginx/*.log.*.gz; do
  [[ -e "$p" ]] || continue
  run "rm -f '$p'"
done

# 6. /tmp transient migration staging.
note "7/7 — /tmp staging"
for d in /tmp/hugin-staging-* /tmp/staging-*; do
  [[ -e "$d" ]] || continue
  run "rm -rf '$d'"
done

# Restart hugin if we stopped it.
if [[ $RESTART_RAVEN -eq 1 ]]; then
  run "systemctl start hugin"
fi

echo
echo "=== post-strip ==="
df -h / 2>/dev/null || true
echo "=================="

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Dry-run complete. Re-run with --apply to actually perform the strip."
fi
