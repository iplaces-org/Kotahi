#!/bin/bash
# Usage: bash server-fix/scripts/republish-bg.sh gumpstation 130 16 55
# Like republish.sh, but runs on the server in the background (survives a dropped
# fly ssh connection). Progress: bash server-fix/scripts/republish-bg.sh --status
set -e
if [ "$1" = "--status" ]; then
  fly ssh console -a iplaces-test-server -C "grep -a -E pass|REPUBLISH /tmp/republish.log" | tail -15
  exit 0
fi
B64=$(base64 < "$(dirname "$0")/republish.js" | tr -d '\n')
fly ssh console -a iplaces-test-server -C "sh -c 'echo $B64 | base64 -d > /home/node/app/republish.js && cd /home/node/app && setsid nohup node republish.js $* >> /tmp/republish.log 2>&1 < /dev/null & echo started; sleep 2; tail -2 /tmp/republish.log'"
