#!/bin/bash
# Usage: bash server-fix/scripts/republish-bg.sh gumpstation 130 16 55
#
# Starts republish.js on the server in the background, then watches it from the
# Mac until it finishes. While it watches it:
#   - keeps the server awake (iplaces-test-server auto-stops when no web traffic
#     arrives, and a stop kills the job and wipes /tmp),
#   - keeps the Mac awake (caffeinate),
#   - prints each record as it finishes,
#   - FAILS LOUDLY (alert sound, macOS notification, exit 1) if the job is lost,
#     the server can't be reached, or any record fails.
# Ctrl-C stops watching only; the job keeps running on the server.
set -u
APP=iplaces-test-server
URL=https://iplaces-test-server.fly.dev/
[ $# -ge 2 ] || { echo "usage: bash $0 <group> <shortId>..."; exit 2; }

alert() {
  printf '\a'
  osascript -e "display notification \"$1\" with title \"$2\" sound name \"$3\"" 2>/dev/null
}
fail() { echo; echo "*** REPUBLISH FAILED: $1 ***"; alert "$1" "Republish FAILED" Basso; exit 1; }

probe() {
  fly ssh console -a $APP -C "sh -c 'test -f /tmp/republish.log || echo NOLOG; grep -a -e ^pass -e REPUBLISH /tmp/republish.log 2>/dev/null; grep -l republish[.]js /proc/[0-9]*/cmdline 2>/dev/null | head -1 | sed s/^/ALIVE/'" 2>&1
}

caffeinate -i -w $$ &

curl -s -o /dev/null --max-time 30 $URL
if probe | grep -q '^ALIVE'; then
  fail "a republish job is already running on the server; wait for it to finish"
fi

B64=$(base64 < "$(dirname "$0")/republish.js" | tr -d '\n')
fly ssh console -a $APP -C "sh -c 'echo $B64 | base64 -d > /home/node/app/republish.js && : > /tmp/republish.log && cd /home/node/app && setsid nohup node republish.js $* >> /tmp/republish.log 2>&1 < /dev/null & echo started'" \
  | grep -q started || fail "could not start the job on the server"
echo "Started $1 ($(($# - 1)) records). Watching; this window must stay open."

seen=0
while true; do
  for i in 1 2 3; do curl -s -o /dev/null --max-time 10 $URL; sleep 20; done
  out=$(probe)
  echo "$out" | grep -q 'complete' || fail "could not reach the server: $(echo "$out" | tail -1)"
  echo "$out" | grep -q '^NOLOG' && fail "the server restarted and the job was lost; rerun the records not yet listed above"
  passes=$(echo "$out" | grep '^pass')
  total=$(echo "$passes" | grep -c '^pass')
  [ "$total" -gt "$seen" ] && echo "$passes" | tail -n $((total - seen)) && seen=$total
  bad=$(echo "$out" | grep -e 'FAILED' | head -3)
  [ -n "$bad" ] && fail "$bad"
  if echo "$out" | grep -q 'REPUBLISH DONE'; then
    echo; echo "=== REPUBLISH DONE: $1 ==="; alert "All $1 records republished" "Republish done" Glass; exit 0
  fi
  echo "$out" | grep -q '^ALIVE' || fail "the job stopped without finishing; rerun the records not yet listed above"
done
