#!/usr/bin/env bash
#
# Set up the weekly automatic database backup on the Mac (launchd).
#
#   ~/Kotahi/scripts/install-backup-schedule.sh              install or update
#   ~/Kotahi/scripts/install-backup-schedule.sh --run-now    install, then run one backup now
#   ~/Kotahi/scripts/install-backup-schedule.sh --uninstall  remove the schedule
#
# The job runs backup-iplaces-db.sh --unattended --restore-test every Monday at
# 09:00. If the Mac is asleep or off then, it runs at the next wake. Output goes
# to ~/iplaces-backups/backup.log, and a failure shows a macOS notification.
# The one database holds every station, so this backs up all of them.
#
# Encryption key: the first time, this makes an age key pair. Only the PUBLIC
# half stays on the Mac (~/.config/iplaces-backup/recipients.txt), which can
# lock backups but not open them. The PRIVATE half is copied to the clipboard
# for you to save in the password manager, then deleted from the Mac. That key
# is the only way to open backups made from now on. (Older backups still open
# with the old passphrase.)
#
# The job runs a copy of the backup script kept in ~/iplaces-backups/bin, so a
# git checkout of another branch can't break it. Re-run this installer after
# the backup script changes.

set -euo pipefail

LABEL="org.iplaces.db-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONF_DIR="$HOME/.config/iplaces-backup"
RECIPIENTS="$CONF_DIR/recipients.txt"
BACKUP_DIR="$HOME/iplaces-backups"
BIN_DIR="$BACKUP_DIR/bin"
LOG="$BACKUP_DIR/backup.log"
WEEKDAY=1
HOUR=9

red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
hdr(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
die(){ red "STOP: $*"; exit 1; }

RUN_NOW=0
case "${1:-}" in
  "") ;;
  --run-now) RUN_NOW=1 ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    grn "Weekly backup schedule removed. Backups and the key file were left alone."
    exit 0 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-iplaces-db.sh"
[[ -f "$SRC" ]] || die "backup-iplaces-db.sh not found next to this script."

hdr "1. Tools"
FLY="$(command -v fly || command -v flyctl || true)"
AGE="$(command -v age || true)"
AGEKEYGEN="$(command -v age-keygen || true)"
[[ -n "$FLY" ]] || die "fly is not installed."
[[ -n "$AGE" && -n "$AGEKEYGEN" ]] || die "age is not installed. Run: brew install age"
"$FLY" auth whoami >/dev/null 2>&1 || die "not logged in to Fly. Run: fly auth login"
grn "  ok: fly at $FLY, age at $AGE"

hdr "2. Backup key"
mkdir -p "$CONF_DIR" "$BIN_DIR"
chmod 700 "$CONF_DIR"
if [[ -s "$RECIPIENTS" ]]; then
  grn "  ok: using the existing public key in $RECIPIENTS"
else
  KEYFILE="$CONF_DIR/PRIVATE-KEY-save-then-delete.txt"
  rm -f "$KEYFILE"
  "$AGEKEYGEN" -o "$KEYFILE" 2>/dev/null
  "$AGEKEYGEN" -y "$KEYFILE" > "$RECIPIENTS"
  pbcopy < "$KEYFILE"
  echo
  echo "The PRIVATE backup key is now on your clipboard."
  echo "Paste it into a new password manager entry called \"iPlaces backup age key\"."
  echo "It is three lines; the important one starts with AGE-SECRET-KEY-."
  echo
  printf 'Press Enter once it is saved in the password manager: '
  read -r _
  rm -f "$KEYFILE"
  printf 'cleared' | pbcopy
  grn "  ok: private key deleted from the Mac and clipboard cleared; public key kept in $RECIPIENTS"
fi

hdr "3. Install the job"
cp "$SRC" "$BIN_DIR/backup-iplaces-db.sh"
chmod 755 "$BIN_DIR/backup-iplaces-db.sh"
TOOLPATH="$(dirname "$FLY"):$(dirname "$AGE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$BIN_DIR/backup-iplaces-db.sh</string>
    <string>--unattended</string>
    <string>--restore-test</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$TOOLPATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>$WEEKDAY</integer>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF
plutil -lint "$PLIST" >/dev/null || die "the job file did not validate: $PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
grn "  ok: runs every Monday at 09:00 (or at the next wake). Log: $LOG"

if [[ "$RUN_NOW" == 1 ]]; then
  hdr "4. Running one backup now"
  launchctl kickstart "gui/$(id -u)/$LABEL"
  echo "  started in the background. Follow it with: tail -f $LOG"
fi
