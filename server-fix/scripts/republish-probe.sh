#!/bin/sh
# Runs ON the server (uploaded by republish-bg.sh). Prints the job's state:
# PROBE_OK always; NOLOG if the log is gone; the pass/REPUBLISH lines; ALIVE if
# a republish job is running.
echo PROBE_OK
test -f /tmp/republish.log || echo NOLOG
grep -a -e '^pass' -e REPUBLISH /tmp/republish.log 2>/dev/null
for f in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$f" 2>/dev/null; echo; done | grep -q 'node republis[h]' && echo ALIVE
exit 0
