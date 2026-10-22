#!/bin/bash
# Usage: bash server-fix/scripts/republish.sh gumpstation 130 16 55
# Copies republish.js into the running server and runs it there.
set -e
B64=$(base64 < "$(dirname "$0")/republish.js" | tr -d '\n')
fly ssh console -a iplaces-test-server -C "sh -c 'echo $B64 | base64 -d > /home/node/app/republish.js && cd /home/node/app && node republish.js $*'"
