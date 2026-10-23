#!/usr/bin/env bash
#
# Guarded deploy for the iPlaces client (Fly app: iplaces-test-client).
#
# Run it from ~/Kotahi on ANY branch (normally iplaces-prod-config). It
# switches to the client branch, pulls, checks the client version, deploys
# from packages/client, then switches back to the branch you started on.
#
# Why: iplaces-prod-config carries an old 2025.09.30 client tree. Building
# that tree broke ORCID login on every station on 2026-10-22. On this branch
# packages/client/fly.toml now points at Dockerfile-wrong-branch, which fails
# the build on purpose, so a bare `fly deploy` here can't ship it again.
#
# Usage:
#   scripts/deploy-iplaces-client.sh             # checks, then fly deploy
#   scripts/deploy-iplaces-client.sh --verify-only  # checks only, no deploy
#
# SAFETY: never passes --yes to `fly deploy` (same rule as the server script).

set -euo pipefail

# ----- config (edit here when the client is upgraded) ------------------------
APP="iplaces-test-client"
CLIENT_BRANCH="repeatable-group-spike"
EXPECTED_VERSION="2026.10.12-0"
# -----------------------------------------------------------------------------

VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --verify-only) VERIFY_ONLY=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

red(){ printf '\033[31m%s\033[0m\n' "$*"; }
grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
hdr(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
die(){ red "STOP: $*"; exit 1; }

# This file does not exist on $CLIENT_BRANCH, so it vanishes at checkout.
# Re-run from a temp copy so bash never reads a missing script mid-run.
if [[ -z "${IPLACES_CLIENT_DEPLOY_COPY:-}" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  TMP_COPY="$(mktemp -t deploy-iplaces-client.XXXXXX)"
  cp "${BASH_SOURCE[0]}" "$TMP_COPY"
  IPLACES_CLIENT_DEPLOY_COPY="$TMP_COPY" REPO_ROOT="$REPO_ROOT" exec bash "$TMP_COPY" "$@"
fi
trap 'rm -f "$IPLACES_CLIENT_DEPLOY_COPY"' EXIT
cd "$REPO_ROOT"

hdr "Switch to $CLIENT_BRANCH"
git diff --quiet && git diff --cached --quiet \
  || die "uncommitted changes in $REPO_ROOT; commit or stash them first."
START_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
trap 'git checkout -q "$START_BRANCH" && echo "Back on $START_BRANCH."; rm -f "$IPLACES_CLIENT_DEPLOY_COPY"' EXIT
git checkout -q "$CLIENT_BRANCH"
git pull -q --ff-only origin "$CLIENT_BRANCH"
grn "  ok: on $CLIENT_BRANCH at $(git rev-parse --short HEAD)"

hdr "Pre-flight guards"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' packages/client/package.json | head -1)"
[[ "$VERSION" == "$EXPECTED_VERSION" ]] \
  || die "packages/client version is '$VERSION', expected '$EXPECTED_VERSION'."
grn "  ok: client version $VERSION"
grep -qE "^app *= *'$APP'" packages/client/fly.toml \
  || die "packages/client/fly.toml does not target $APP."
grep -qE "^ *dockerfile *= *'Dockerfile-production'" packages/client/fly.toml \
  || die "packages/client/fly.toml does not build Dockerfile-production."
grn "  ok: fly.toml targets $APP with Dockerfile-production"

if [[ "$VERIFY_ONLY" == 1 ]]; then
  grn "All checks passed (--verify-only, nothing deployed)."
  exit 0
fi

hdr "Deploy $APP"
(cd packages/client && fly deploy)
grn "Deployed. Check ORCID login on https://iplacesalliance.org/gumpstation/ ."
