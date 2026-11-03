#!/usr/bin/env bash
#
# One-command backup of the Kotahi database (Fly app: iplaces-test-db2).
#
# Run it from Terminal on the Mac, from anywhere:
#   ~/Kotahi/scripts/backup-iplaces-db.sh                  dump, download, encrypt, prune
#   ~/Kotahi/scripts/backup-iplaces-db.sh --restore-test   same, plus a restore test first
#
# What it does (the steps in planning/db-backup/BACKUP-STEPS.md, in order):
#   1. checks fly and age are installed and the database machine has room
#   2. runs pg_dump -Fc ON the database machine (same Postgres version, no tunnel)
#   3. downloads the dump to ~/iplaces-backups and checks the size matches
#   4. (--restore-test) restores it into a scratch database and compares row counts
#   5. deletes the dump from the database machine
#   6. encrypts the laptop copy with `age -p` and deletes the unencrypted file
#   7. keeps the newest 8 encrypted dumps and deletes older ones
#   8. copies the encrypted file to Google Drive iPlaces/db-backups if Google
#      Drive for desktop is installed (or IPLACES_DRIVE_DIR is set), and keeps
#      the newest 8 there too
#
# `age -p` asks for a passphrase twice. Use the one in the password manager.
# Without it the backup can never be opened.
#
# The script never handles the database password. It uses the database
# machine's own OPERATOR_PASSWORD environment variable, so it keeps working
# after a password rotation with no change.

set -euo pipefail

# ----- config ----------------------------------------------------------------
DB_APP="iplaces-test-db2"
DB_NAME="postgres"
PGCONN="-h localhost -p 5433 -U postgres"
LOCAL_DIR="$HOME/iplaces-backups"
KEEP=8
REMOTE_DIR="/data/backups"
# -----------------------------------------------------------------------------

RESTORE_TEST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore-test) RESTORE_TEST=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
hdr(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
die(){ red "STOP: $*"; exit 1; }

# Run a shell snippet on the database machine. The snippet must end by
# echoing a marker; callers grep for it because `fly ssh console -C` does
# not reliably pass the remote exit code back.
on_db(){ fly ssh console -a "$DB_APP" -C "sh -c '$1'"; }

file_size(){ wc -c < "$1" | tr -d " "; }

STAMP="$(date +%Y%m%d-%H%M)"
NAME="kotahi-$STAMP.dump"
LOCAL_DUMP="$LOCAL_DIR/$NAME"
LOCAL_AGE="$LOCAL_DUMP.age"
REMOTE_DUMP="$REMOTE_DIR/$NAME"
REMOTE_LEFT=0

cleanup(){
  if [[ "$REMOTE_LEFT" == 1 ]]; then
    red "Cleaning up: removing $REMOTE_DUMP from the database machine."
    on_db "rm -f $REMOTE_DUMP; echo RM_OK" >/dev/null 2>&1 || red "Could not remove it. Run: fly ssh console -a $DB_APP -C \"rm -f $REMOTE_DUMP\""
  fi
  if [[ -f "$LOCAL_DUMP" ]]; then
    red "Cleaning up: deleting the unencrypted $LOCAL_DUMP (Exhibit C: no plain copies on the laptop)."
    rm -f "$LOCAL_DUMP"
  fi
}
trap cleanup EXIT

# ----- 1. checks ---------------------------------------------------------------
hdr "1. Checks"
command -v fly >/dev/null || die "fly is not installed."
command -v age >/dev/null || die "age is not installed. Run: brew install age"
fly auth whoami >/dev/null 2>&1 || die "not logged in to Fly. Run: fly auth login"
mkdir -p "$LOCAL_DIR"

OUT="$(on_db "echo DBSIZE=\$(PGPASSWORD=\$OPERATOR_PASSWORD psql $PGCONN -Atc \"select pg_database_size(current_database())\" $DB_NAME); echo DF=\$(df -Pk /data | tail -1); echo CHECK_OK" 2>&1 | tr -d '\r')" || true
echo "$OUT" | grep -q CHECK_OK || { echo "$OUT"; die "could not reach the database machine (it may be starting; try again in a minute)."; }
DB_BYTES="$(echo "$OUT" | sed -n 's/^DBSIZE=\([0-9][0-9]*\)$/\1/p' | head -1)"
FREE_KB="$(echo "$OUT" | sed -n 's/^DF=//p' | awk '{print $4}' | head -1)"
[[ -n "$DB_BYTES" && -n "$FREE_KB" ]] || { echo "$OUT"; die "could not read the database size or free space."; }
NEED_KB=$(( DB_BYTES * 2 / 1024 ))
echo "  database: $(( DB_BYTES / 1024 / 1024 )) MB, free on /data: $(( FREE_KB / 1024 )) MB"
(( FREE_KB > NEED_KB )) || die "not enough free space on /data (need about twice the database size)."
grn "  ok"

# ----- 2. dump on the database machine ------------------------------------------
hdr "2. Dump on $DB_APP"
REMOTE_LEFT=1
OUT="$(on_db "mkdir -p $REMOTE_DIR && PGPASSWORD=\$OPERATOR_PASSWORD pg_dump $PGCONN -Fc -f $REMOTE_DUMP $DB_NAME && echo SIZE=\$(stat -c %s $REMOTE_DUMP) && echo DUMP_OK" 2>&1 | tr -d '\r')" || true
echo "$OUT" | grep -q DUMP_OK || { echo "$OUT"; die "pg_dump failed on the database machine."; }
REMOTE_SIZE="$(echo "$OUT" | sed -n 's/^SIZE=\([0-9]*\).*/\1/p' | head -1)"
[[ -n "$REMOTE_SIZE" && "$REMOTE_SIZE" -gt 0 ]] || die "the dump on the database machine is empty."
grn "  ok: $REMOTE_DUMP, $REMOTE_SIZE bytes"

# ----- 3. download ---------------------------------------------------------------
hdr "3. Download to $LOCAL_DIR"
fly ssh sftp get "$REMOTE_DUMP" "$LOCAL_DUMP" -a "$DB_APP"
[[ -f "$LOCAL_DUMP" ]] || die "download failed: $LOCAL_DUMP is missing."
LOCAL_SIZE="$(file_size "$LOCAL_DUMP")"
[[ "$LOCAL_SIZE" == "$REMOTE_SIZE" ]] || die "size mismatch: machine $REMOTE_SIZE, laptop $LOCAL_SIZE bytes."
grn "  ok: sizes match ($LOCAL_SIZE bytes)"

# ----- 4. restore test (optional) ------------------------------------------------
if [[ "$RESTORE_TEST" == 1 ]]; then
  hdr "4. Restore test into kotahi_restore_test"
  COUNTS="select (select count(*) from manuscripts), (select count(*) from users), (select count(*) from groups), (select count(*) from files)"
  OUT="$(on_db "export PGPASSWORD=\$OPERATOR_PASSWORD; dropdb --if-exists --force $PGCONN kotahi_restore_test; createdb $PGCONN kotahi_restore_test && pg_restore $PGCONN --no-owner -d kotahi_restore_test $REMOTE_DUMP && echo RESTORE_OK; echo PROD=\$(psql $PGCONN -d $DB_NAME -Atc \"$COUNTS\"); echo COPY=\$(psql $PGCONN -d kotahi_restore_test -Atc \"$COUNTS\"); dropdb --force $PGCONN kotahi_restore_test; echo DONE" 2>&1 | tr -d '\r')" || true
  echo "$OUT" | grep -E '^(PROD|COPY)='
  echo "$OUT" | grep -q RESTORE_OK || { echo "$OUT"; die "restore test failed. The laptop copy will be deleted; do not rely on this dump."; }
  PROD="$(echo "$OUT" | sed -n 's/^PROD=//p')"
  COPY="$(echo "$OUT" | sed -n 's/^COPY=//p')"
  if [[ "$PROD" == "$COPY" ]]; then
    grn "  ok: restore clean, row counts match (manuscripts|users|groups|files)"
  else
    red "  restore clean but counts differ. That is fine if someone was working during the backup; otherwise ask in the project."
  fi
fi

# ----- 5. remove the dump from the database machine ------------------------------
hdr "5. Remove the dump from $DB_APP"
OUT="$(on_db "rm -f $REMOTE_DUMP && echo RM_OK" 2>&1 | tr -d '\r')" || true
echo "$OUT" | grep -q RM_OK || { echo "$OUT"; die "could not delete $REMOTE_DUMP on the database machine."; }
REMOTE_LEFT=0
grn "  ok"

# ----- 6. encrypt -----------------------------------------------------------------
hdr "6. Encrypt with age"
echo "age will now ask for the backup passphrase twice (from the password manager)."
echo "Nothing shows on screen while you type or paste. That is normal."
age -p -o "$LOCAL_AGE" "$LOCAL_DUMP" || { rm -f "$LOCAL_AGE"; die "encryption failed."; }
[[ -s "$LOCAL_AGE" ]] || die "encrypted file is empty."
rm -f "$LOCAL_DUMP"
grn "  ok: $LOCAL_AGE ($(file_size "$LOCAL_AGE") bytes); unencrypted copy deleted"

# ----- 7. keep the newest $KEEP locally ------------------------------------------
prune(){
  local dir="$1" n=0 f
  while IFS= read -r f; do
    n=$((n + 1))
    if (( n > KEEP )); then rm -f "$dir/$f"; echo "  deleted old $f"; fi
  done < <(ls -1t "$dir" | grep -E '^kotahi-[0-9]{8}-[0-9]{4}\.dump\.age$')
}
hdr "7. Keep the newest $KEEP in $LOCAL_DIR"
prune "$LOCAL_DIR"
grn "  ok: $(ls -1 "$LOCAL_DIR" | grep -cE '^kotahi-[0-9]{8}-[0-9]{4}\.dump\.age$') encrypted dumps on the laptop"

# ----- 8. copy to Google Drive ------------------------------------------------------
hdr "8. Copy to Google Drive"
DRIVE_DIR="${IPLACES_DRIVE_DIR:-}"
if [[ -z "$DRIVE_DIR" ]]; then
  for d in "$HOME"/Library/CloudStorage/GoogleDrive-*/"My Drive"/iPlaces/db-backups; do
    [[ -d "$d" ]] && { DRIVE_DIR="$d"; break; }
  done
fi
if [[ -n "$DRIVE_DIR" && -d "$DRIVE_DIR" ]]; then
  cp "$LOCAL_AGE" "$DRIVE_DIR/"
  prune "$DRIVE_DIR"
  grn "  ok: copied to $DRIVE_DIR"
else
  red "  Google Drive folder not found on this Mac. Upload $LOCAL_AGE to Drive iPlaces/db-backups by hand,"
  red "  and delete the oldest there so 8 remain."
fi

hdr "Done"
grn "Backup $NAME.age is encrypted on the laptop${DRIVE_DIR:+ and in Drive}."
