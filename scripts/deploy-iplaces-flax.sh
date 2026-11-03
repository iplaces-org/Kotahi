#!/usr/bin/env bash
#
# Guarded deploy for iPlaces Flax (Fly app: iplaces-test-flax).
#
# Run it from ~/Kotahi on iplaces-prod-config. It deploys with
# flax-fix/fly.toml (building flax-fix/Dockerfile), and only after checking
# that the file still mounts the flax_public volume at /app/public.
#
# Why: Flax writes every built station site to /app/public. Without the
# volume, a deploy, restart or `fly secrets set` rebuilds the disk from the
# image and the station sites vanish (2026-10-19: Gump 403, WAMS 404). The
# only copy of the toml with the [mounts] block used to live in ~/flax-fix
# on Erin's Mac; it now lives in flax-fix/fly.toml. The old root
# fly-flax.toml (no [mounts]) was deleted so it can't be deployed by mistake.
#
# Usage:
#   scripts/deploy-iplaces-flax.sh                    # checks, then build flax-fix/Dockerfile and deploy
#   scripts/deploy-iplaces-flax.sh --image <ref>      # checks, then deploy that image (no rebuild)
#   scripts/deploy-iplaces-flax.sh --verify-only      # checks only, no deploy
#
# SAFETY: never passes --yes to `fly deploy`.

set -euo pipefail

# ----- config ----------------------------------------------------------------
APP="iplaces-test-flax"
VOLUME="flax_public"
MOUNT_AT="/app/public"
TOML="flax-fix/fly.toml"
# -----------------------------------------------------------------------------

VERIFY_ONLY=0
IMAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1; shift ;;
    --image) IMAGE="${2:-}"; [[ -n "$IMAGE" ]] || { echo "--image needs a value" >&2; exit 2; }; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
hdr(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
die(){ red "STOP: $*"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

hdr "Check $TOML"
[[ -f "$TOML" ]] || die "$TOML not found in $REPO_ROOT."
grep -qE "^app *= *['\"]$APP['\"]" "$TOML" \
  || die "$TOML does not target $APP."
# The [mounts] (or [[mounts]]) table must name the volume and the mount point.
MOUNTS="$(awk '
  /^\[\[?mounts\]\]?/ {inm=1; next}
  /^\[/ {inm=0}
  inm {print}
' "$TOML")"
[[ -n "$MOUNTS" ]] || die "$TOML has no [mounts] block. Deploying it would wipe every station site."
echo "$MOUNTS" | grep -qE "^ *source *= *['\"]$VOLUME['\"]" \
  || die "[mounts] in $TOML does not use source = \"$VOLUME\"."
echo "$MOUNTS" | grep -qE "^ *destination *= *['\"]$MOUNT_AT/?['\"]" \
  || die "[mounts] in $TOML does not mount at $MOUNT_AT."
grn "  ok: $TOML targets $APP and mounts $VOLUME at $MOUNT_AT"

hdr "Check the volume exists on Fly"
fly volumes list --app "$APP" | grep -q "$VOLUME" \
  || die "no volume named $VOLUME on $APP (fly volumes list --app $APP)."
grn "  ok: $VOLUME exists on $APP"

if [[ "$VERIFY_ONLY" == 1 ]]; then
  grn "All checks passed (--verify-only, nothing deployed)."
  exit 0
fi

hdr "Deploy $APP"
if [[ -n "$IMAGE" ]]; then
  (cd flax-fix && fly deploy -c fly.toml --app "$APP" --image "$IMAGE")
else
  (cd flax-fix && fly deploy -c fly.toml --app "$APP")
fi
grn "Deployed. nginx takes 30-60 s to come up; then check https://iplacesalliance.org/gumpstation/ and /wams/."
