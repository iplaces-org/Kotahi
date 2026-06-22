#!/usr/bin/env bash
#
# Update ritual: bump the prebuilt Coko base image tag in lockstep.
#
# Usage:  scripts/bump-image-tag.sh cokoapps/kotahi-server:2026.06.01-0
#    or:  scripts/bump-image-tag.sh 2026.06.01-0   (image name kept the same)
#
# This ONLY edits files + prints the ritual. It does NOT commit and does NOT
# deploy. Follow the printed steps.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCKERFILE="server-fix/Dockerfile"
PATCHES="PATCHES.md"

[[ $# -eq 1 ]] || { echo "usage: $0 <new-image-or-tag>" >&2; exit 2; }
NEW="$1"

current_from="$(grep -E '^FROM ' "$DOCKERFILE" | head -1 | awk '{print $2}')"
[[ -n "$current_from" ]] || { echo "could not read FROM in $DOCKERFILE" >&2; exit 1; }
img_name="${current_from%%:*}"

# Accept either a full image:tag or just a tag.
if [[ "$NEW" == *:* ]]; then NEW_REF="$NEW"; else NEW_REF="${img_name}:${NEW}"; fi

if [[ "$NEW_REF" == "$current_from" ]]; then
  echo "Already at $current_from — nothing to do."; exit 0
fi

echo "Bumping base image:"
echo "  from: $current_from"
echo "  to:   $NEW_REF"

# Edit the Dockerfile FROM line, and any matching references in PATCHES.md.
# Use a portable in-place sed (macOS/BSD needs the '' arg).
sedi() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }

sedi "s#^FROM .*#FROM ${NEW_REF}#" "$DOCKERFILE"
[[ -f "$PATCHES" ]] && sedi "s#${current_from}#${NEW_REF}#g" "$PATCHES" || true

echo
echo "Edited: $DOCKERFILE (and $PATCHES references, if any)."
echo
cat <<EOF
Update ritual — finish these steps by hand:
  1. Rebase the DataCite patch onto the new upstream if needed:
       git fetch <upstream> && git rebase <upstream>/<branch>
     If getFundingReferences changed upstream, resolve the 2-line conflict and:
       node --check packages/server/services/publishing/datacite/fieldsTransformers.js
  2. Review the change:
       git diff -- $DOCKERFILE $PATCHES
  3. Commit:
       git add $DOCKERFILE $PATCHES
       git commit -m "chore: bump kotahi-server image to ${NEW_REF##*:}"
  4. Deploy with all guards (requires your explicit OK):
       scripts/deploy-iplaces-server.sh
  5. Re-verify a funded record reaches DataCite with the ROR — a green deploy
     does NOT prove the funderIdentifier is correct.
EOF
