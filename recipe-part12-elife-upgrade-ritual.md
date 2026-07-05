# PART 12 — The eLife upgrade ritual (folding upstream releases into the iPlaces stack)

*Derived from the live 2026.04.27-0 → 2026.07.03-0 upgrade of the test stack, July 5 2026. Every step below was actually run; every gotcha was actually hit. Repeat this ritual for each upstream release you want to fold in. Elapsed time for a well-behaved upgrade: one focused session.*

## The shape of the thing

Upstream = `eLifePathways/Kotahi` on GitHub (attached locally as the fetch-only `upstream` remote). Releases are tagged `YYYY.MM.DD-N` and CI pushes matching Docker images to `cokoapps/kotahi-server:<tag>` and `cokoapps/kotahi-client:<tag>`. Our stack = prebuilt images + the `server-fix/` overlay Dockerfile (five overlays as of this writing). An upgrade is: verify overlays still apply → re-pin what drifted → bump the tag → deploy → smoke test.

**Golden rules (each earned the hard way):**
1. Base copies of overlay files come FROM THE IMAGE, never from the repo or memory. (`docker run --rm <image> cat <path> > file`)
2. Back up the DB before first boot of a new server version — migrations run automatically and are not guaranteed reversible.
3. Verify, then trust: every re-pinned file gets a final diff against the image copy that must show YOUR patch lines only.
4. Since 2026.07.03-0: every overlay COPYs to BOTH the plain path and its `dist/` twin.
5. Since 2026.07.03-0: `NODE_ENV=production` is REQUIRED on the server app.

---

## Phase 0 — Recon (no changes, ~15 min)

**What's new upstream:**
```
git fetch upstream --tags
git tag | tail -8                      # newest tags
git log --oneline <current>..<new> | wc -l    # how far behind
```
Read release notes: `git show <new-tag>:CHANGES.md | head -80`. Watch especially for **"Deployment changes"** sections — that's where breaking changes live (the TypeScript build switch and JOB_QUEUE_POSTGRES_* vars were announced there).

**Did upstream touch any overlay file?** For each overlay:
```
git diff --stat <current>..<new> -- packages/server/services/publishing/datacite/
git diff --stat <current>..<new> -- packages/server/controllers/pdfExport.controllers.js
git diff --stat <current>..<new> -- packages/server/api/rest/cmsUpload/
```
- Empty diff → that overlay ports as-is.
- Small diff → read it (`git diff` without `--stat`); decide whether it collides with our patch.
- Big diff → plan a full re-pin (Phase 3).

Note: repo paths carry the `packages/server/` prefix; in-image paths do NOT (image roots at `/home/node/app/`).

## Phase 1 — Baseline + backup (~10 min)

1. Prove current stack works: login → dashboard → open manuscript → one Flax page.
2. Record current tags: `fly image show -a iplaces-test-server` / `-a iplaces-test-client`.
3. Commit the working tree: `git add -A && git commit -m "pre-upgrade snapshot: <current-tag>"`.
4. **Backup the DB:**
```
fly proxy 15432:5432 -a iplaces-test-db2          # window 1, leave running
pg_dump -h localhost -p 15432 -U <POSTGRES_USER> -d <POSTGRES_DB> -Fc \
  -f ~/Desktop/iplaces-test-backup-$(date +%Y%m%d).dump    # window 2
```
Real user/db/password: `fly ssh console -a iplaces-test-server -C "printenv" | grep -i postgres`. If `pg_dump` missing: `brew install libpq && brew link --force libpq`. Checkpoint: dump file is MB-scale, not 0 bytes. (July 2026 test DB: 1.6 MB.) The "circular foreign-key constraints on nodes" warning is routine (pg-boss table); `-Fc` full dumps restore fine.

## Phase 2 — Inspect the new image (~10 min)

```
docker pull cokoapps/kotahi-server:<new-tag>
docker run --rm -it --entrypoint sh cokoapps/kotahi-server:<new-tag>
```
(The linux/amd64-vs-arm64 platform WARNING is harmless emulation noise — and it goes to stderr, so it never contaminates `>` redirected file pulls.)

Inside, answer three questions:
```
ls /home/node/app                                  # packages/ prefix present? (no, since ≥2026.07.03-0)
find /home/node/app -name <overlayfile> ...        # one copy or two (dist/)?
diff <src-path> dist/<src-path>                    # if two: identical logic?
```
As of 2026.07.03-0: source tree AND a compiled `dist/` mirror coexist; the dist copies are logic-identical (TS compiler reformatting only: "use strict", semicolons, indentation). `dist/config` mirrors the whole config tree including `storage/` and `cmsTemplateFiles/` — hence golden rule 4.

**Pull pristine base copies** (from the Mac terminal, one-shot):
```
mkdir -p ~/Desktop/new-base
docker run --rm cokoapps/kotahi-server:<new-tag> cat /home/node/app/<path> > ~/Desktop/new-base/<file>
```
Sanity check each with `head -3` (should show real code, no warning text).

## Phase 3 — Port the overlays (~20 min, the real work)

For each overlay, diff pristine-new-base vs our patched file:
```
diff ~/Desktop/new-base/<file> <our-patched-file-path>
```
Three outcomes:
- **Diff shows ONLY our patch lines** → file ports as-is, zero edits. (2026-07: both DataCite files, cmsUpload endpoint.)
- **Diff shows our patch + trivial upstream noise** (lint/cosmetic) → usually keep ours as-is; note it.
- **Diff is noisy / upstream restructured** → **full re-pin**: take the new base copy, re-insert our patch at the same anchor, replace our overlay file with the result. (2026-07: pdfExport.controllers.js — upstream moved to `config.get('pagedjs')` + new `createFile(stream, name, {tags, objectId})` signature, making our old-vintage pin actively dangerous.)

**Re-pin verification (mandatory):** `diff ~/Desktop/new-base/<file> <re-pinned-file>` must output EXACTLY our patch lines and nothing else. This simultaneously proves the git tag matches the image byte-for-byte.

**Current overlay inventory + patch summary** (update this list when overlays change):
| Overlay file (repo path) | Our patch |
|---|---|
| `packages/server/services/publishing/datacite/fieldsTransformers.js` | funderIdentifier ← `funderid` (ROR), not the funder name |
| `packages/server/services/publishing/datacite/index.js` | schemaVersion kernel-4; resourceTypeGeneral ← `resourcetype`; resourceType ← `ifother` (omitted when blank); checkPayload reads `resourcetype` not `objectType` |
| `packages/server/api/rest/cmsUpload/endpoint.js` | `await` + try/catch around `uploadCms` → errors surface as HTTP 500 |
| `server-fix/overlays/controllers/pdfExport.controllers.js` | 5-line meta.source guard, inserted immediately BEFORE `articleData.files = await getFilesWithUrl(...)` (i.e. before `replaceImageSrc` consumes `meta.source`). PINNED to the image copy — re-pin every bump. |
| `packages/server/config/storage/forms-journal/submit.json` + `station-master/cmsTemplateFiles/` | seed data, version-independent, ports as-is |

The pdfExport guard, verbatim:
```js
  // Metadata-only records have no body, so meta.source is null. cheerio.load()
  // (inside replaceImageSrc) throws on non-strings, so coerce to an empty string.
  if (!articleData.meta) articleData.meta = {}
  if (typeof articleData.meta.source !== 'string') articleData.meta.source = ''
```

## Phase 4 — Dockerfile (~5 min)

In `server-fix/Dockerfile`:
1. `FROM cokoapps/kotahi-server:<new-tag>`
2. Every overlay gets TWO COPY lines: destination `/home/node/app/<path>` AND `/home/node/app/dist/<path>`. Ten COPYs total for five overlays. Verify: `grep -c "^COPY" server-fix/Dockerfile` → 10.
3. Update the Patch-4 comment with the new pin tag + "verified: diff vs image copy shows guard lines only".

Commit: `git add -A && git commit -m "upgrade server overlay to <new-tag>: ..."`.

## Phase 5 — Deploy + boot watch

```
./scripts/deploy-iplaces-server.sh      # sets the repo-root build context the COPYs need
fly logs -a iplaces-test-server         # second window
```
Healthy boot sequence: `Load config` → `✓ Configuration valid` → DB/storage checks → **migrations** (one-way; the backup's moment) → `Seed groups` all "already exists… Skipping" → `✓ Registered component` parade (confirm `./api/rest/cmsUpload` appears — proves the overlay landed) → job queues → "App is listening on port 3000". 2026-07 boot: 6.4 s.

**Known failure signatures:**
- `ERR_MODULE_NOT_FOUND: Cannot find module '/home/node/app/models/modelComponents' imported from /home/node/app/config.ts`, crash-looping at "Load config" → **NODE_ENV is not `production`**. Root cause (read from @coko/server 5.1.1 source): `findConfigurationFile` roots at `dist/` only when `NODE_ENV === 'production'`; otherwise it loads raw `config.ts`, whose extensionless imports die under Node's runtime. Fix: `fly secrets set NODE_ENV=production -a iplaces-test-server` (restarts in place; no toml redeploy, so the service-config-drop trap doesn't apply). NOTE: crash happens BEFORE migrations, so the DB is untouched in this failure mode and plain rollback is safe.
- `config.get` undefined at require time, crash-loop → an overlay pinned to the wrong vintage (the original pdfExport lesson). Re-pin per Phase 3.
- Consequence of production mode: interactive GraphQL sandbox/introspection may be off. Shield-allowed public queries (`manuscriptsPublishedSinceDate` etc.) keep working — verified 2026-07. Open item, not a blocker.

## Phase 6 — Client + smoke tests

```
fly deploy -a iplaces-test-client --image cokoapps/kotahi-client:<new-tag>
```
Then, in order: (1) ORCID login + dashboard; (2) open manuscript, form renders, authors display; (3) CMS file browser shows the .njk tree; (4) Wax editor + toolbars; (5) Flax article page (theme + JSON-LD in source); (6) **iplaces-pdf on one article** — first real exercise of the re-pinned pdfExport + the JWT path; (7) Zenodo button; (8) DataCite dry-run — confirm `funderIdentifier` = ROR and `schemaVersion` kernel-4 in the payload; (9) one direct GraphQL consumer (`build-iplaces-home.js` or a curl of `manuscriptsPublishedSinceDate`).

All green → push: `git push` (origin = iplaces-org/Kotahi; upstream = eLifePathways, push DISABLED).

## Rollback (in case, not in expectation)

- Server: revert the Dockerfile FROM (one `git revert`), redeploy.
- Client: `fly deploy -a iplaces-test-client --image cokoapps/kotahi-client:<old-tag>`.
- DB: only if new migrations left the old server unbootable — `pg_restore` the Phase 1 dump (add `--disable-triggers` if the circular `nodes` constraint complains). Crash-at-Load-config failures never need this (pre-migration).

## Git remote hygiene (one-time, done 2026-07-05)

```
origin    https://github.com/iplaces-org/Kotahi.git   (fetch + push)
upstream  https://github.com/eLifePathways/Kotahi.git (fetch)
upstream  DISABLED                                     (push)
```
Set up via `git remote rename origin upstream` + `git remote add origin …` + `git remote set-url --push upstream DISABLED`. A push aimed at eLife now fails structurally, not just on permissions (the 403 that revealed the misconfiguration).

## Handy one-liners discovered along the way

- Peek inside any image without going interactive: `docker run --rm <image> ls <path>` / `… cat <path>`
- Compare upstream tags for any file: `git diff <tagA>..<tagB> -- <repo-path>` (needs `git fetch upstream --tags`)
- Release-notes skim: `git show <tag>:CHANGES.md | head -80`
- COPY count check: `grep -c "^COPY" server-fix/Dockerfile`

## Open items carried forward

- `JOB_QUEUE_POSTGRES_*` vars: not set (db2 has no transaction pooler; new version separates job-queue connections with fallbacks on its own). Watch whether knex pool exhaustion improves passively post-upgrade.
- GraphQL introspection under production mode: revisit only if tooling misses it.
- Prod-stack upgrade: same Phases 0–6 once the test stack has soaked for a few days.
