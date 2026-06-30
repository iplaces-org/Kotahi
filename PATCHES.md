# iPlaces overlay patches

This repo runs the **prebuilt** Coko server image
`cokoapps/kotahi-server:2026.04.27-0` for the `iplaces-test-server` Fly app,
with a small set of source patches overlaid at build time. This file is the
canonical record of those patches and how they are deployed.

> Golden rule: each patch is a tracked file under `packages/server/...` that the
> `server-fix/Dockerfile` COPYs onto the prebuilt image. If you change a patch,
> change that file and re-deploy with the guarded script. Never hand-edit a file
> inside a running container.

---

## Patch 1 — DataCite funderIdentifier uses the ROR id

**File:** `packages/server/services/publishing/datacite/fieldsTransformers.js`
**Function:** `getFundingReferences`
**Commit:** `patch(datacite): use funderid for funderIdentifier in funding refs`

### What it does
Upstream emitted the funder **name** (`Funding`) as the DataCite
`funderIdentifier`. DataCite expects the funder **identifier** (the ROR id),
which the submission carries in the `funderid` field. The patch:

1. Destructures `funderid` from the submission, and
2. Sets `funderIdentifier: funderid` (was `funderIdentifier: Funding`).

### The diff (two lines, vs. upstream)
```diff
-  const { funderIdentifierType, Funding, awardnumber, awardtitle, awarduri } =
+  const { funderIdentifierType, Funding, funderid, awardnumber, awardtitle, awarduri } =
@@
-          funderIdentifier: Funding,
+          funderIdentifier: funderid,
```

### Why it is a single isolated commit
Kept as one clean commit touching only this file so that bumping the base
image / rebasing onto upstream surfaces any conflict in this one place.
See "Update ritual" below.

---

## Patch 2 — DataCite index.js: schemaVersion + resource type mapping

**File:** `packages/server/services/publishing/datacite/index.js`
**Functions:** `getPathAndPayload` (publish) and `checkPayload` (payload verifier)

### What it does
1. **`schemaVersion: 'http://datacite.org/schema/kernel-4'`** is added to both
   payloads. Without it, DataCite stamps the DOI with a pre-4.6 default and
   **coerces** newer `resourceTypeGeneral` values (e.g. `Project`, added in
   schema 4.6) to `Other`. Declaring kernel-4 makes DataCite validate against the
   current 4.x list, so `Project` is accepted as-is.
2. **`resourceTypeGeneral` ← `submission.resourcetype`** (controlled list) in
   *both* functions. Previously `checkPayload` read `submission.objectType`,
   which is now never used.
3. **`resourceType` ← `submission.ifother`** (free text), defaulting to `''` and
   **omitted when blank** (`types: { resourceTypeGeneral, ...(resourceType ? { resourceType } : {}) }`).
   This kills a spurious hardcoded `resourceType: "project"` default.

### History
This replaced an abandoned "array-shaped DataCite properties" rewrite (a generic
`RepeatableGroup` form component + `getSubjects`/array serializers) that broke the
client and was rolled back. Only the minimal `index.js` changes above shipped.
Verified live: a record with `resourcetype = "Project"` now publishes
`resourceTypeGeneral: "Project"`.

---

## How the patches reach the container

`server-fix/Dockerfile` overlays the file onto the prebuilt image:

```dockerfile
FROM cokoapps/kotahi-server:2026.04.27-0
COPY packages/server/services/publishing/datacite/fieldsTransformers.js \
     /home/node/app/services/publishing/datacite/fieldsTransformers.js
```

Note the **flattened** destination path inside the container
(`/home/node/app/services/...`, no `packages/server/`).

- **Build context:** the repo root (the deploy script passes `.`).
- **Tiny context:** `server-fix/.dockerignore.deploy` whitelists only the one
  patched file, so the build uploads a single file, not the whole monorepo.
- **Canonical Fly config:** `server-fix/fly.toml` — port **3000**,
  `[build] dockerfile = "server-fix/Dockerfile"`, the 8081 websocket service,
  `[[mounts]] kotahi_test_plugins -> /custom`, and **no `[env]`** and
  **no `[processes]`**. Env (CLIENT_URL, INSTANCE_GROUPS, ORCID, S3, etc.)
  lives in **Fly secrets**, which a no-`[env]` deploy preserves.

---

## Deploying

Always deploy with the guarded script — never a bare `fly deploy`
(a bare deploy picks up a stray `./fly.toml` and breaks the stack):

```bash
scripts/deploy-iplaces-server.sh          # build, deploy, run all guards
scripts/deploy-iplaces-server.sh --dry-run # show the exact command, do nothing
```

The script refuses to run if an unsafe root `fly.toml` is present, and after
deploy verifies: patch landed (grep `funderid` in-container at the flattened
path), env preserved (`INSTANCE_GROUPS`, `CLIENT_URL`), machine started and
not crash-looping, and the app is listening on 3000 (no `[PC01]` refused
connection in logs). Any failed guard exits non-zero with the rollback hint.

---

## Update ritual — bumping the base image tag

When Coko publishes a newer `cokoapps/kotahi-server` image:

1. `git fetch` upstream and rebase this branch so the patch re-applies on top
   of the latest `fieldsTransformers.js`. If the function changed upstream,
   the conflict surfaces here — re-apply the two-line change by hand and
   `node --check` the file.
2. Edit the tag in **two** places so they stay in lockstep:
   - `server-fix/Dockerfile` — the `FROM` line
   - this file's "Patch 1" heading references and the snippet above
   `scripts/bump-image-tag.sh <new-tag>` does both edits for you.
3. Commit (`chore: bump kotahi-server image to <new-tag>`).
4. Deploy with `scripts/deploy-iplaces-server.sh` and confirm all guards pass.
5. Re-verify a funded record reaches DataCite with the ROR (the patch's whole
   purpose) — do not assume a green deploy means the ROR is correct.

---

## Safety rules (do not violate)

- Never `fly deploy` or `fly secrets set` without showing the exact command and
  getting explicit OK first.
- If a Fly prompt mentions **detaching a volume** or **replacing/destroying a
  machine**, STOP and ask — do not answer it.
- Never add an `[env]` block or a `[processes]` line to `server-fix/fly.toml`.
- Do not touch the `iplaces-test-db2` database or switch ORCID to production
  without explicit instruction.
- Commit before any risky change so there is a rollback point.
