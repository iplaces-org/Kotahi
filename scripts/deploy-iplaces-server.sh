#!/usr/bin/env bash
#
# Guarded deploy for the iPlaces test server (Fly app: iplaces-test-server).
#
# Builds the prebuilt Coko image + the single DataCite overlay patch and
# deploys it with the CANONICAL committed config (server-fix/fly.toml), then
# verifies the stack stayed up. See PATCHES.md.
#
# Usage:
#   scripts/deploy-iplaces-server.sh             # confirm, deploy, verify
#   scripts/deploy-iplaces-server.sh --dry-run   # show the exact command only
#   scripts/deploy-iplaces-server.sh --confirm   # skip the interactive prompt
#   scripts/deploy-iplaces-server.sh --verify-only  # run guards, no deploy
#
# SAFETY: this script NEVER passes --yes to `fly deploy`, so any Fly prompt
# about detaching a volume / replacing a machine will ABORT the deploy rather
# than be auto-answered. If you see such a prompt, STOP and investigate.

set -euo pipefail

# ----- config (edit here if these ever change) -------------------------------
APP="iplaces-test-server"
CONFIG="server-fix/fly.toml"
DOCKERFILE="server-fix/Dockerfile"
IGNOREFILE="server-fix/.dockerignore.deploy"
CONTAINER_PATCH_PATH="/home/node/app/services/publishing/datacite/fieldsTransformers.js"
CONTAINER_CMS_ENDPOINT_PATH="/home/node/app/api/rest/cmsUpload/endpoint.js"
CONTAINER_MS_CTRL_PATH="/home/node/app/controllers/manuscript/manuscript.controllers.js"
# Marker from the LATEST serializer patch. UPDATE THIS every time a patch
# adds a function -- it's what catches a half-deployed patch stack (index.js
# calling what fieldsTransformers doesn't export => "X is not a function"
# at first publish). History: Patch 7 = getSubjects; Patch 8 = getAllTitles;
# Patch 9 = getAlternateIdentifiers; Patch 10 = getSpdxRights;
# Patch 11 = refreshLocalContext; Patch 13 = getRelatedItems (re-enabled).
LATEST_PATCH_MARKER="getRelatedItems"
PUBLIC_URL="https://iplaces-test-server.fly.dev/"
EXPECTED_CLIENT_URL="https://iplaces-test-client.fly.dev"
EXPECTED_INSTANCE_GROUPS="gumpstation:journal,testclone3:journal"
# -----------------------------------------------------------------------------

# Resolve repo root from this script's location, and cd there (build context).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0; CONFIRM=0; VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=1 ;;
    --confirm)     CONFIRM=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

red(){   printf '\033[31m%s\033[0m\n' "$*"; }
grn(){   printf '\033[32m%s\033[0m\n' "$*"; }
ylw(){   printf '\033[33m%s\033[0m\n' "$*"; }
hdr(){   printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
flycli(){ command -v flyctl >/dev/null 2>&1 && flyctl "$@" || fly "$@"; }

FAILURES=0
fail(){ red "  FAIL: $*"; FAILURES=$((FAILURES+1)); }
ok(){   grn "  ok:   $*"; }

# ===== PRE-FLIGHT GUARDS (config sanity, before any deploy) ===================
preflight() {
  hdr "Pre-flight guards"

  [[ -f "$CONFIG" ]]     || { fail "$CONFIG missing"; return; }
  [[ -f "$DOCKERFILE" ]] || { fail "$DOCKERFILE missing"; return; }
  [[ -f "$IGNOREFILE" ]] || { fail "$IGNOREFILE missing"; return; }

  # The canonical toml must target the right app, port 3000, and must NOT
  # contain an [env] block or a [processes] line (both break this stack).
  grep -qE "^app *= *\"$APP\"" "$CONFIG"            && ok "config targets $APP" || fail "config app != $APP"
  grep -qE "internal_port *= *3000" "$CONFIG"       && ok "config has internal_port 3000" || fail "config missing port 3000"
  if grep -qE "^\[env\]" "$CONFIG"; then fail "config has an [env] block (forbidden)"; else ok "no [env] block"; fi
  if grep -qE "^\[processes\]" "$CONFIG"; then fail "config has a [processes] line (forbidden)"; else ok "no [processes] block"; fi
  grep -q "kotahi_test_plugins" "$CONFIG"           && ok "mount kotahi_test_plugins present" || fail "mount missing"

  # The patched source file must carry the complete patch and parse.
  local f="packages/server/services/publishing/datacite/fieldsTransformers.js"
  if grep -q "funderIdentifier: funderid" "$f" && grep -qE "Funding, funderid," "$f"; then
    ok "source patch present (funderid destructured + used)"
  else
    fail "source patch incomplete in $f"
  fi
  node --check "$f" >/dev/null 2>&1 && ok "patched file syntax valid" || fail "patched file has a syntax error"

  # Patch 2: the DataCite index.js overlay must parse and carry the schemaVersion
  # (kernel-4) that makes DataCite 4.6 accept resourceTypeGeneral values like "Project".
  local idx="packages/server/services/publishing/datacite/index.js"
  node --check "$idx" >/dev/null 2>&1 && ok "index.js syntax valid" || fail "index.js has a syntax error"
  grep -q "schemaVersion" "$idx" && ok "index.js carries schemaVersion (DataCite 4.6)" || fail "index.js missing schemaVersion overlay"

  # Patches 3-7: both DataCite files must be from the SAME patch generation.
  # The latest marker must be defined+exported in fieldsTransformers (>=2 hits)
  # AND referenced in index.js -- a mismatch means one file is stale (the
  # classic download-suffix / missed-download failure).
  local ftn idxn
  ftn="$(grep -c "$LATEST_PATCH_MARKER" "$f" || true)"
  idxn="$(grep -c "$LATEST_PATCH_MARKER" "$idx" || true)"
  if [[ "$ftn" -ge 2 && "$idxn" -ge 1 ]]; then
    ok "patch generations match (marker $LATEST_PATCH_MARKER: ft=$ftn idx=$idxn)"
  else
    fail "PATCH GENERATION MISMATCH: $LATEST_PATCH_MARKER ft=$ftn (need >=2) idx=$idxn (need >=1) -- one file is stale"
  fi

  local ctrl="packages/server/controllers/manuscript/manuscript.controllers.js"
  if [[ -f "$ctrl" ]] && grep -q "refreshLocalContextWriteback" "$ctrl"; then
    ok "Patch 12 marker present in local controller source"
  else
    fail "Patch 12 marker (refreshLocalContextWriteback) missing from local controller source -- stale copy?"
  fi

  # A stray root ./fly.toml is the classic foot-gun (wrong port / [env] /
  # [processes]). We always deploy with -c "$CONFIG", but warn loudly.
  if [[ -f "fly.toml" ]]; then
    ylw "  WARN: a root ./fly.toml exists. This script ignores it (uses $CONFIG),"
    ylw "        but a bare 'fly deploy' would pick it up and break the stack."
    ylw "        Consider: mv fly.toml fly.toml.UNSAFE"
  fi
}

# ===== THE DEPLOY COMMAND =====================================================
# Note: the Dockerfile is selected via [build].dockerfile in $CONFIG (resolved
# relative to the config dir). We do NOT pass --dockerfile here -- Fly prefers
# the toml value and the CLI flag's relative resolution is ambiguous.
DEPLOY_CMD=(flyctl deploy . \
  --config "$CONFIG" \
  --ignorefile "$IGNOREFILE" \
  --app "$APP")

show_cmd() {
  hdr "Exact deploy command"
  printf '  (from %s)\n  ' "$REPO_ROOT"
  printf '%q ' "${DEPLOY_CMD[@]}"; echo
  echo
  echo "  Current base image tag:"
  grep -E "^FROM " "$DOCKERFILE" | sed 's/^/    /'
}

capture_rollback_point() {
  hdr "Rollback point"
  echo "  Current releases (newest first):"
  flycli releases --app "$APP" 2>/dev/null | head -4 | sed 's/^/    /' || ylw "  (could not read releases)"
  echo "  Rollback if needed:  flyctl releases --app $APP   then   flyctl deploy --image <prev-image> -c $CONFIG --app $APP"
  echo "  Or:                  flyctl releases rollback --app $APP"
}

# ===== POST-DEPLOY GUARDS ====================================================
wake_machine() {
  # min_machines_running=0 + auto_stop means the machine may be stopped.
  # Hit the public URL to auto-start it so ssh/printenv work.
  curl -s -o /dev/null --max-time 45 "$PUBLIC_URL" || true
  sleep 3
}

guard_patch_landed() {
  hdr "Guard: patch landed in container"
  # Drop stderr (ssh connection chatter) and parse ONLY a bare-integer line --
  # grep -c prints exactly the count, so noise can't cause a false pass.
  local out n
  out="$(flycli ssh console --app "$APP" -C "grep -c funderid $CONTAINER_PATCH_PATH" 2>/dev/null || true)"
  n="$(printf '%s\n' "$out" | grep -oE '^[0-9]+$' | tail -1)"
  if [[ -n "$n" && "$n" -ge 1 ]]; then ok "funderid present in-container ($n line(s)) at flattened path"
  else fail "funderid NOT found at $CONTAINER_PATCH_PATH (raw: $(printf '%s' "$out" | tr '\n' ' '))"; fi
}

guard_cms_endpoint_landed() {
  hdr "Guard: cmsUpload endpoint overlay landed in container"
  # Same parsing discipline as guard_patch_landed: grep -c prints exactly the
  # count on its own line, so ssh chatter on stderr can't cause a false pass.
  local out n
  out="$(flycli ssh console --app "$APP" -C "grep -c 'await uploadCms' $CONTAINER_CMS_ENDPOINT_PATH" 2>/dev/null || true)"
  n="$(printf '%s\n' "$out" | grep -oE '^[0-9]+$' | tail -1)"
  if [[ -n "$n" && "$n" -ge 1 ]]; then ok "await uploadCms present in-container ($n line(s)) at flattened path"
  else fail "await uploadCms NOT found at $CONTAINER_CMS_ENDPOINT_PATH (raw: $(printf '%s' "$out" | tr '\n' ' '))"; fi
}

guard_lc_writeback_landed() {
  hdr "Guard: Patch 12 LC write-back landed in container"
  # Fixed-path + fixed-string check (same discipline as funderid / uploadCms).
  # Patch 12 lives in the manuscript controller, not the serializer, so it is
  # NOT covered by the LATEST_PATCH_MARKER generation check.
  local out n
  out="$(flycli ssh console --app "$APP" -C "grep -c refreshLocalContextWriteback $CONTAINER_MS_CTRL_PATH" 2>/dev/null || true)"
  n="$(printf '%s\n' "$out" | grep -oE '^[0-9]+$' | tail -1)"
  if [[ -n "$n" && "$n" -ge 1 ]]; then ok "refreshLocalContextWriteback present in-container ($n) at controller"
  else fail "refreshLocalContextWriteback NOT found at $CONTAINER_MS_CTRL_PATH (raw: $(printf '%s' "$out" | tr '\n' ' '))"; fi
}

guard_latest_patch_landed() {
  hdr "Guard: latest serializer patch landed in container (both paths)"
  # Same parsing discipline as guard_patch_landed. Checks BOTH the plain and
  # dist/ copies (the 2026.07.03-0 image may run either).
  local p out n
  for p in "$CONTAINER_PATCH_PATH" "/home/node/app/dist/services/publishing/datacite/fieldsTransformers.js"; do
    out="$(flycli ssh console --app "$APP" -C "grep -c $LATEST_PATCH_MARKER $p" 2>/dev/null || true)"
    n="$(printf '%s\n' "$out" | grep -oE '^[0-9]+$' | tail -1)"
    if [[ -n "$n" && "$n" -ge 2 ]]; then ok "$LATEST_PATCH_MARKER present ($n) at $p"
    else fail "$LATEST_PATCH_MARKER NOT sufficiently present at $p (raw: $(printf '%s' "$out" | tr '\n' ' '))"; fi
  done
}

guard_env_preserved() {
  hdr "Guard: env preserved (secrets not clobbered)"
  local ig cu
  ig="$(flycli ssh console --app "$APP" -C "printenv INSTANCE_GROUPS" 2>/dev/null | tr -d '\r\n ' || true)"
  cu="$(flycli ssh console --app "$APP" -C "printenv CLIENT_URL" 2>/dev/null | tr -d '\r\n ' || true)"
  [[ "$ig" == "$EXPECTED_INSTANCE_GROUPS" ]] && ok "INSTANCE_GROUPS=$ig" || fail "INSTANCE_GROUPS='$ig' (expected '$EXPECTED_INSTANCE_GROUPS')"
  [[ "$cu" == "$EXPECTED_CLIENT_URL" ]]      && ok "CLIENT_URL=$cu"      || fail "CLIENT_URL='$cu' (expected '$EXPECTED_CLIENT_URL')"
}

guard_machine_healthy() {
  hdr "Guard: machine started & not crash-looping"
  local json
  json="$(flycli machine list --app "$APP" --json 2>/dev/null || true)"
  if command -v jq >/dev/null 2>&1 && [[ -n "$json" ]]; then
    local states; states="$(printf '%s' "$json" | jq -r '.[].state' 2>/dev/null | tr '\n' ' ')"
    echo "  machine state(s): $states"
    if printf '%s' "$states" | grep -qE "failed|replacing|destroying"; then
      fail "a machine is in a bad state: $states"
    else ok "no machine in failed/replacing state"; fi
  else
    flycli status --app "$APP" 2>&1 | sed 's/^/    /' || true
    ylw "  (jq not available — inspect the status output above manually)"
  fi
  # Crash-loop / connection-refused signal in recent logs.
  local logs; logs="$(flycli logs --app "$APP" --no-tail 2>/dev/null | tail -80 || true)"
  if printf '%s' "$logs" | grep -qE "\[PC01\]|connection refused|Reaping|exited with"; then
    fail "recent logs show crash/refused-connection markers (see below)"
    printf '%s\n' "$logs" | grep -E "\[PC01\]|connection refused|Reaping|exited with" | tail -8 | sed 's/^/      /'
  else ok "no crash-loop / refused-connection markers in recent logs"; fi
}

guard_listening_3000() {
  hdr "Guard: app listening (no [PC01] refused connection)"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 45 "$PUBLIC_URL" || echo 000)"
  echo "  GET $PUBLIC_URL -> HTTP $code"
  # 502/503/000 from Fly's edge == app not accepting connections on 3000.
  case "$code" in
    502|503|000) fail "edge could not reach the app on 3000 (HTTP $code)";;
    *)           ok  "app answered on 3000 (HTTP $code)";;
  esac
}

run_guards() {
  wake_machine
  guard_patch_landed
  guard_cms_endpoint_landed
  guard_latest_patch_landed
  guard_lc_writeback_landed
  guard_env_preserved
  guard_machine_healthy
  guard_listening_3000
  hdr "Result"
  if [[ "$FAILURES" -eq 0 ]]; then
    grn "ALL GUARDS PASSED — stack is up and patched."
  else
    red "$FAILURES GUARD(S) FAILED. Investigate; roll back if the stack is down:"
    red "  flyctl releases rollback --app $APP   (or deploy a previous --image)"
    exit 1
  fi
}

# ===== MAIN ==================================================================
preflight
if [[ "$FAILURES" -ne 0 ]]; then red "Pre-flight failed ($FAILURES). Not deploying."; exit 1; fi

if [[ "$VERIFY_ONLY" -eq 1 ]]; then run_guards; exit 0; fi

show_cmd
capture_rollback_point

if [[ "$DRY_RUN" -eq 1 ]]; then echo; ylw "--dry-run: nothing was deployed."; exit 0; fi

if [[ "$CONFIRM" -ne 1 ]]; then
  echo
  read -r -p "Type DEPLOY to proceed with the command above: " ans
  [[ "$ans" == "DEPLOY" ]] || { ylw "Aborted."; exit 1; }
fi

hdr "Deploying"
"${DEPLOY_CMD[@]}"

run_guards
