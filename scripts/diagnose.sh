#!/bin/bash
# diagnose.sh — one-shot picture of the iPlaces stack.
# Run this BEFORE forming any hypothesis about a silent failure.
# Paste the whole output into the chat.
#
# Usage:  scripts/diagnose.sh            full dump
#         scripts/diagnose.sh --quick    errors + operations only (the two-second version)

SERVER=iplaces-test-server
CLIENT=iplaces-test-client
FLAX=iplaces-test-flax
DB=iplaces-test-db2
PDF=iplaces-pdf
PAGEDJS=iplaces-pagedjs
ZENODO=iplaces-zenodo
PROXY=iplaces-proxy
GROUP=gumpstation

hr() { printf '\n== %s ==\n' "$1"; }

# ---------- 1. server errors + operations (always) ----------
hr "SERVER ERRORS (last 10)"
fly logs -a $SERVER --no-tail 2>/dev/null \
  | grep -o '"level":"ERROR"[^}]*' | tail -10 || true
echo "(end errors)"

hr "SERVER GRAPHQL OPERATIONS (last 20, oldest first)"
fly logs -a $SERVER --no-tail 2>/dev/null \
  | grep -o '"operation":"[A-Za-z]*"' | tail -20 | sed 's/"operation"://' | tr '\n' ' '
echo

if [ "$1" = "--quick" ]; then
  echo; echo "(quick mode — rerun without --quick for the full dump)"; exit 0
fi

# ---------- 2. machine states ----------
hr "MACHINE STATES"
for app in $SERVER $CLIENT $FLAX $PDF $PAGEDJS $ZENODO $PROXY; do
  state=$(fly status -a $app 2>/dev/null | awk '/^ *app/ {print $9; exit}')
  printf '%-22s %s\n' "$app" "${state:-unknown}"
done

# ---------- 3. server version fingerprint ----------
hr "SERVER VERSION FINGERPRINT"
echo "(package.json is NOT reliable — code fingerprints only)"
fly ssh console -a $SERVER -C "sh -c '
  printf \"07.03+ (coar No payload provided): \"; grep -c \"No payload provided\" /home/node/app/dist/api/rest/coar/inbox.js;
  printf \"08.20+ (typeof archivePeriodDays): \"; grep -c \"typeof archivePeriodDays\" /home/node/app/dist/controllers/manuscript/manuscriptCommsUtils.js;
  printf \"pdfExport meta.source guard:     \"; grep -c \"typeof articleData.meta.source\" /home/node/app/dist/controllers/pdfExport.controllers.js;
  printf \"menuPinned in user schema:       \"; grep -c menuPinned /home/node/app/api/graphql/user/user.graphql;
  true
'" 2>/dev/null || echo "(ssh failed — machine may be stopped; rerun)"

# ---------- 4. database shape ----------
hr "DATABASE"
SQL=$(mktemp)
cat > "$SQL" << 'EOF'
\pset pager off
\echo --- users.menu_pinned (must be ABSENT on >=08.20, PRESENT on <=07.03) ---
SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'menu_pinned';
\echo --- last 5 manuscripts by updated ---
SELECT short_id, status, doi IS NOT NULL AS has_doi, to_char(updated, 'MM-DD HH24:MI:SS') AS updated FROM manuscripts ORDER BY updated DESC LIMIT 5;
\echo --- version rows per short_id (any >1 = versioned record) ---
SELECT short_id, count(*) AS versions FROM manuscripts GROUP BY short_id HAVING count(*) > 1 ORDER BY short_id;
\q
EOF
fly postgres connect -a $DB < "$SQL" 2>/dev/null | grep -E '^( |-|\()'
rm -f "$SQL"
echo "(db done)"

# ---------- 5. flax build health ----------
hr "FLAX BUILD ($GROUP) — counts must match"
fly ssh console -a $FLAX -C "sh -c '
  printf \"built article dirs: \"; ls /app/public/$GROUP/articles | wc -l;
  printf \"records in data:    \"; grep -o shortId /app/src/$GROUP/data/articleQuery.json | wc -l;
  printf \"newest built:       \"; ls /app/public/$GROUP/articles | sort -n | tail -3 | tr \"\\n\" \" \"; echo;
  true
'" 2>/dev/null || echo "(ssh failed — machine may be stopped; rerun)"

# ---------- 6. pagedjs ----------
hr "PAGEDJS"
curl -s --max-time 8 https://iplaces-pagedjs.fly.dev/healthcheck || echo "(no response)"
echo
fly logs -a $PAGEDJS --no-tail 2>/dev/null | grep -E "htmlToPDF|Connection terminated" | tail -4

hr "DONE"
