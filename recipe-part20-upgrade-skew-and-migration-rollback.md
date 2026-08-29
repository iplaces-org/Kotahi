# PART 20 — Upgrade skew, migration rollback, and the corrected upgrade order

*Derived from the live 2026.07.03-0 → 2026.08.20-0 upgrade of the test stack,
29 August 2026 — the whole day, including the two failures it produced and how
each was found. Server-only upgrade locked the client out (§4); rollback
required a manual column restore; the re-upgrade then silently broke every
form save for two hours because that manual restore was never reverted (§5).
Both halves are now on 08.20 and verified. Every command below was actually
run. **This part supersedes Part 12's phase ordering.***

---

## 0. The one-line lesson

**Client and server upgrade as a matched pair.** Part 12 treats the client as
Phase 6, an afterthought after the server is deployed and smoke-tested. That
ordering is wrong for a fork that builds its own client, and it is what caused
the outage on 29 August. Upstream never hits this because eLife deploys both
halves from the same tag simultaneously; version skew between client and server
is structurally impossible for them and structurally possible for us.

**Corrected order:** merge and build the client FIRST, locally, until it
compiles clean. Only then deploy — client and server together, or client first.
Never server alone. (Verified 29 Aug: new client + old server works; old client
+ new server does not. Skew is asymmetric because this release only *removed*
schema fields.)

**Second lesson, same day, more expensive:** **any manual schema change made
during a rollback must be reverted by hand before re-upgrading.** Migrations are
recorded by name and never re-run. The column restored by hand to make the old
server work (§4) survived into the re-upgraded server, whose model rejected it —
and every `updateManuscript` failed validation for two hours (§5).

**Third lesson, about method:** **error log first.** `scripts/diagnose.sh --quick`
(§9) before any hypothesis. The §5 error sat in `fly logs` the entire time.

---

## 1. Identifying which version is actually running

**`grep version /home/node/app/package.json` is NOT a valid version check.**
The `cokoapps/kotahi-server:2026.07.03-0` image reports `2026.06.29-0` in its
package.json — eLife's CI built the image before the version-bump commit landed.
Verified 29 Aug: package.json tracks the tag correctly in the *git tags*
(06.29→06.29, 07.03→07.03, 08.20→08.20), but the *image* does not.

**Use a code fingerprint instead.** Pick a string that exists in the target
version and not the one before it, in a file we do NOT overlay, and grep the
container at both the plain and `dist/` paths:

```bash
fly ssh console -a iplaces-test-server -C "sh -c 'grep -c \"<string>\" \
  /home/node/app/<path> /home/node/app/dist/<path>'"
```

Known-good fingerprints:

| Version | File (no `packages/server/` prefix in-image) | String |
|---|---|---|
| ≥ 2026.07.03-0 | `api/rest/coar/inbox.js` | `No payload provided` |
| ≥ 2026.08.20-0 | `controllers/manuscript/manuscriptCommsUtils.js` | `typeof archivePeriodDays` |

Finding a new fingerprint for the next release: unpack both tags, then
`diff -rq old/packages/server new/packages/server`, pick a changed file that
isn't in the overlay set, and take a distinctive literal from the diff.

---

## 2. What 2026.08.20-0 actually changed (verified diff, 07.03 → 08.20)

116 server files, 275 client files. Releases folded in: 08.11-0, 08.13-0,
08.19-0, 08.19-1, 08.20-0. **CHANGES.md "Deployment changes" was empty** — see
§4 for why that mattered.

**Server — the overlay set (all nine COPY sources from `server-fix/Dockerfile`):**

| Overlay | 07.03 → 08.20 |
|---|---|
| `services/publishing/datacite/fieldsTransformers.js` | unchanged |
| `services/publishing/datacite/index.js` | unchanged |
| `api/rest/cmsUpload/endpoint.js` | unchanged |
| `controllers/manuscript/manuscript.controllers.js` | unchanged |
| `services/handlebars.service.js` | unchanged |
| `permissions.js` | unchanged |
| `config/storage/forms-journal/submit.json` | unchanged |
| `station-master/cmsTemplateFiles/` | n/a (ours) |
| `controllers/pdfExport.controllers.js` | **1 line**: `require('fs-extra')` → `require('fs')` |

Only one new migration: `1783674872-remove-menu-pinned.ts`, dropping
`users.menu_pinned`. No new env vars, no root Dockerfile change.

**Client — two breakages waiting in the merge (NOT yet fixed as of this writing):**

1. **The theme module lost its exports.** `app/theme/color.js`, `spacing.js`
   and `typography.js` were deleted; `theme/index.jsx` no longer has a default
   export or a `color` export (it exports `makeTheme` now). Any custom
   component doing `import theme, { color } from '../../../../theme'` is a hard
   Vite build failure. Upstream's own fix in `AuthorsInput.jsx`: drop the
   import, use `th('color.gray80')` and `th('borderRadius')` from `@coko/client`.
   **`StationAuthorsInput.jsx` was cloned from `AuthorsInput.jsx` at the 07.03
   vintage and almost certainly carries this import.** Find all of them:
   ```bash
   grep -rln "from '.*/theme'" packages/client/app/components/
   ```
2. **`gridUnit` halved, 8px → 4px.** Upstream doubled every `grid(n)` call to
   compensate. Our components did not get that pass, so they render at half
   spacing until the numbers are doubled.

**Client — our registration surfaces, all safe:**
`ReadonlyFieldData.jsx` untouched upstream. `FormTemplate.jsx` (3 lines,
styled-component padding) and `Elements.js` (6 lines, a scalar-override guard —
the "Last edit date read-only" fix) changed only in areas we did not patch.

Also changed and worth smoke-testing: most of `component-cms-manager` (the file
browser used to edit Flax templates) and a new Menu/Pages UI.

---

## 3. The server upgrade (this part worked — reusable as-is)

```bash
# 1. Pull the pristine base from the NEW image (Docker Desktop must be running)
mkdir -p ~/Desktop/new-base
docker run --rm cokoapps/kotahi-server:<new-tag> \
  cat /home/node/app/controllers/pdfExport.controllers.js \
  > ~/Desktop/new-base/pdfExport.controllers.js
head -5 ~/Desktop/new-base/pdfExport.controllers.js   # real JS, not a warning

# 2. Confirm what drifted
diff ~/Desktop/new-base/pdfExport.controllers.js \
     server-fix/overlays/controllers/pdfExport.controllers.js
#    expect: our guard lines + whatever upstream changed. Nothing else.

# 3. Re-pin: assert-guarded, re-runs abort loudly
python3 << 'PYEOF'
src = open('/Users/erinrobinson/Desktop/new-base/pdfExport.controllers.js').read()
anchor = "  articleData.files = await getFilesWithUrl(articleData.files)"
assert src.count(anchor) == 1, f"anchor count {src.count(anchor)}"
assert "typeof articleData.meta.source" not in src, "already patched"
guard = """  // Metadata-only records have no body, so meta.source is null. cheerio.load()
  // (inside replaceImageSrc) throws on non-strings, so coerce to an empty string.
  if (!articleData.meta) articleData.meta = {}
  if (typeof articleData.meta.source !== 'string') articleData.meta.source = ''

"""
open('server-fix/overlays/controllers/pdfExport.controllers.js','w').write(
    src.replace(anchor, guard + anchor))
print("WRITTEN")
PYEOF
node --check server-fix/overlays/controllers/pdfExport.controllers.js
md5 -q server-fix/overlays/controllers/pdfExport.controllers.js
diff ~/Desktop/new-base/pdfExport.controllers.js \
     server-fix/overlays/controllers/pdfExport.controllers.js   # guard lines ONLY

# 4. Bump the tag
python3 -c "
p='server-fix/Dockerfile'; s=open(p).read()
assert s.count('FROM cokoapps/kotahi-server:<old-tag>')==1
open(p,'w').write(s.replace('FROM cokoapps/kotahi-server:<old-tag>',
                            'FROM cokoapps/kotahi-server:<new-tag>'))
print('BUMPED')"
grep -n "^FROM" server-fix/Dockerfile
grep -c "^COPY" server-fix/Dockerfile        # 18 as of Aug 2026 (9 sources × 2 paths)

# 5. Commit clean, then deploy
git status --short                            # must be empty after commit
scripts/deploy-iplaces-server.sh --verify-only
scripts/deploy-iplaces-server.sh
```

**The md5 cross-check:** when Claude builds the same file in its sandbox, compare
hashes before deploying. 29 Aug value for the 08.20 re-pin:
`700131200e3bb42dd6136a7e33025831` (288 lines). `md5 -q` on Mac, `md5sum` in
containers.

**Post-deploy, verify the BASE IMAGE landed** — the guard suite does not
(see §5):

```bash
fly ssh console -a iplaces-test-server -C "sh -c 'grep -c \"<new-version-fingerprint>\" \
  /home/node/app/<path> /home/node/app/dist/<path>'"
fly ssh console -a iplaces-test-server -C "sh -c 'grep -c \"typeof articleData.meta.source\" \
  /home/node/app/controllers/pdfExport.controllers.js \
  /home/node/app/dist/controllers/pdfExport.controllers.js'"
```

---

## 4. The `menuPinned` incident — anatomy of a skew lockout

**Symptom.** After the server-only upgrade, every login attempt at
publish.iplacesalliance.org bounced straight back to the login page. Both
normal and incognito windows. No error visible to the user.

**Mechanism (verified in source, not inferred).** 2026.08.11-0 introduced a new
Menu/Pages UI and removed `menuPinned` from the user schema entirely:
`api/graphql/user/user.graphql`, `models/user/user.model.js`,
`controllers/user.controllers.js`, plus the migration dropping the column. The
07.03 client's `CURRENT_USER` query — run on every page load to establish
identity — explicitly requests `menuPinned` (`app/queries/user.queries.ts`, and
again in `util.queries.ts`). Requesting a field the schema does not define is a
GraphQL **validation** error, so the query never executes, `currentUser` comes
back null, and the app reads that as unauthenticated. Loop.

**The rollback trap.** Reverting the server image restores the schema but
**does not run the migration's `down()`**. So `menuPinned: Boolean!` is
advertised again while `users.menu_pinned` is still dropped — a non-null field
backed by a missing column, which errors identically. *Same symptom, different
cause.* Rolling back a migration-bearing release is therefore two steps, not one.

**The fix** (definition copied from upstream's own `down()`):

```bash
cat > /tmp/check-menu.sql << 'EOF'
\pset pager off
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'menu_pinned';
EOF
fly postgres connect -a iplaces-test-db2 < /tmp/check-menu.sql   # 0 rows = dropped

cat > /tmp/fix-menu.sql << 'EOF'
\pset pager off
ALTER TABLE users ADD COLUMN menu_pinned boolean NOT NULL DEFAULT true;
EOF
fly postgres connect -a iplaces-test-db2 < /tmp/fix-menu.sql
```

No restart needed — it's a schema read at query time. Existing users all get
`true` (pinned menu), which was the prior default.

**This turned out to be wrong.** The migration did NOT run again on the
re-upgrade — see §5. The column has to be dropped by hand.

**Generalise it:** any upstream release that *removes* a GraphQL field is a
client lockout for an older client. Before upgrading the server, diff the schema:

```bash
diff <old>/packages/server/api/graphql/user/user.graphql \
     <new>/packages/server/api/graphql/user/user.graphql
```
and grep the client's `app/queries/` for anything removed.

---

## 5. The `menuPinned` column trap — two hours of silent save failures

**Sequence.** First 08.20 deploy ran the migration and dropped
`users.menu_pinned`; coko-server recorded the migration as complete. Rollback to
07.03 → the column was restored by hand (§4) so the non-null schema field could
resolve. Second 08.20 deploy → migration already recorded → **skipped** → the
hand-restored column survived into a server whose User model no longer declares
it.

**Symptom.** Every form edit — title, funding, contributors, related
identifiers, all of them, on the editor's Metadata tab — appeared to save and
never persisted. `manuscripts.updated` kept moving (from publishes), which made
it look like saves were landing. Publishing still worked; DataCite kept
receiving the stale payload; Flax rendered the stale data. It presented as a
funding-serializer bug, then a RepeatableFieldRows bug, then a form-builder bug.
It was none of those.

**Mechanism (verified).** The 08.20 User model validates strictly (no
additional properties). *Reading* a user is fine — the new client never asks
for `menuPinned`, so login worked. But `updateManuscript` fetches the manuscript
`withGraphFetched('[reviews.user, files, tasks]')`, merges the delta, and saves
the whole graph via `updateAndFetchById(id, updatedMs.$toJson())`. Any user in
that graph carries `menuPinned` from the leftover column → validation throws:

```
"level":"ERROR" … "message":"menuPinned: must NOT have additional properties"
```

**Where it was.** `fly logs -a iplaces-test-server --no-tail | grep -o
'"level":"ERROR"[^}]*'` — the first thing that should have been run, and the
last thing that was.

**Fix.** Finish what the migration would have done:

```bash
cat > /tmp/drop-menu.sql << 'EOF'
\pset pager off
ALTER TABLE users DROP COLUMN IF EXISTS menu_pinned;
SELECT column_name FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'menu_pinned';
\q
EOF
fly postgres connect -a iplaces-test-db2 < /tmp/drop-menu.sql   # expect 0 rows
```

No restart needed. Verified immediately after: title, funding (two ROR funders),
contributors, related identifiers all persisted; `UpdateManuscript` visible in
the operations log; zero ERROR lines.

**Two timing facts learned while chasing this, both real and both upstream:**

- **Form autosave is ~4 s of stacked debounce** (1 s in `FormTemplate`, 3 s in
  `SubmitPage`/`DecisionPage`). Editing then publishing inside that window
  publishes the pre-edit record. Hands off for ten seconds before publish. A
  station-admin usability trap; not a bug of ours.
- **First publish of a new record produces a Flax page with no DOI.** The
  rebuild fetches before the DOI write-back to `submission.$doi` lands (side.njk
  reads `article.parsedSubmission.$doi` everywhere). Any later republish fixes
  it. Verified on 137: absent after first publish, present after second. Open
  item — see §10.

---

## 6. Guard-suite gap (OPEN — fix before the next upgrade)

`scripts/deploy-iplaces-server.sh` returned **ALL GUARDS PASSED** both for the
08.20 deploy and for the rollback to 07.03. It cannot distinguish them: every
marker it checks (`funderid`, `getRelatedItems`, `brandName`,
`refreshLocalContextWriteback`, `await uploadCms`) is ours and unchanged across
both versions. **No guard covers the base image version.**

Proposed addition — a base-image fingerprint guard, one variable to flip per
upgrade alongside `LATEST_PATCH_MARKER`:

```
BASE_IMAGE_FINGERPRINT="typeof archivePeriodDays"
BASE_IMAGE_FINGERPRINT_PATH="controllers/manuscript/manuscriptCommsUtils.js"
```
checked at both the plain and `dist/` paths, post-deploy only.

Also note: `fly deploy` printed a **"not listening on the expected address"**
warning naming `[::]:5010`, while the guard's real HTTPS GET returned 404 (i.e.
the proxy reached the app). Read as a mid-boot port snapshot; the successful GET
is the authoritative signal. Not investigated further.

---

## 7. State at end of 29 August

- **Server: 2026.08.20-0**, verified by fingerprint (`typeof archivePeriodDays`
  at both paths), pdfExport guard present, `menuPinned` absent from schema,
  `users.menu_pinned` dropped. Branch `iplaces-prod-config` @ `8f4061f5c`.
- **Client: 2026.08.20-0 merged** into `repeatable-group-spike`, five theme
  imports fixed, built locally, deployed, all nine custom components confirmed
  in the bundle by string-literal grep. Branch @ `d5afed271`.
- Login, dashboard, forms, editor Metadata tab saves, form builder Field
  Properties, CMS file browser, publish, DOI minting, DataCite payload, Flax
  build (91 = 91): all verified working.
- `~/Desktop/iplaces-backup-20260829.dump` — 2.2 MB pre-upgrade `-Fc` dump.
- `~/Desktop/new-base/pdfExport.controllers.js` — pristine 08.20 base copy.
- `scripts/diagnose.sh` on both branches.
- Test records: 136 (published, has funding), 137 (test submission, currently
  unpublished, two funders).

---

## 8. The client upgrade (done — reusable sequence)

Fork builds its own client, so "upgrade" = merge the tag + fix what upstream
deleted + build locally + deploy. **`packages/client` is a standalone yarn
project** (no root workspaces — root `package.json` has no `workspaces` key);
`yarn install` must run *inside* `packages/client`, or the new lockfile is
never applied and the old `node_modules` silently persists (bit us: lockfile
said `@coko/client` 2.5.0, installed was 2.0.0, build failed on
`useNotification`).

```bash
git checkout repeatable-group-spike && git fetch upstream --tags
git merge <new-tag>                                   # 08.20: clean, 492 files
git diff --name-only <new-tag> HEAD -- packages/client/app > /tmp/mine.txt   # our 23 files
while read f; do grep -Hn "from '.*/theme'" "$f"; done < /tmp/mine.txt      # deleted-module imports
# fix hits (08.20: five files, one import line each, th() replacements — §2)
cd packages/client && yarn install && ./node_modules/.bin/coko-client-build   # LOCAL BUILD GATE
grep -c "<string literal from a custom component>" _build/assets/index-*.js  # reachability
cd ../.. && git add -A && git commit -m "Client <tag> merge: <what was fixed>"
git push origin repeatable-group-spike
fly image show -a iplaces-test-client                 # record rollback digest FIRST
cd packages/client && fly deploy
```

Then log in against the OLD server (asymmetric skew makes this safe), then
bring the server forward (§3), then §5's column check if a rollback happened in
between.

08.20-specific: `gridUnit` 8px → 4px did not visibly hurt our components in
practice; left alone. The Menu/Pages UI is Kotahi editorial chrome, unrelated to
the Flax site menu (a `.njk` in the CMS file browser).

---

## 9. `scripts/diagnose.sh`

One-shot dump; paste the whole output. `--quick` = server ERROR lines + last 20
GraphQL operation names (two seconds — run this before any hypothesis). Full run
adds: machine state for all seven apps; server version fingerprints (07.03,
08.20, pdfExport guard, menuPinned schema); `users.menu_pinned` presence; last
5 manuscripts by `updated`; version-row counts; Flax built-vs-data counts;
pagedjs healthcheck + recent htmlToPDF lines.

Gotchas baked in: SQL file ends with `\q` (without it `fly postgres connect`
holds the pipe open and the script stops after the DB section); ssh command
strings end with `true` (a legitimate zero-count grep otherwise trips the
"ssh failed" branch); DB output is filtered to psql result rows only — column
headers and `\echo` labels are lost to pty formatting, accepted.

**The rule that goes with it, now in Claude's memory for this project:** when
anything silently fails, `scripts/diagnose.sh --quick` is the first command.
Erin enforces it with *"did you check the error log?"*

---

## 10. Open items carried forward

- **pagedjs returns 500 on `POST /api/htmlToPDF`** for every record (bodyless
  and with body). Healthcheck 200, auth 200 ("client is valid"), then 500 with an
  80-byte body and no `msg` field — an unhandled exception, not pagedjs's own
  error handling. Machine is 2 GB, no Chromium errors logged, `pg-boss`
  "Connection terminated unexpectedly" on every resume. The app **suspends and
  resumes** (not stop/start) — suspend restores a memory snapshot, and a live
  Chromium + DB pool across a suspend is a plausible cause. Untested next step:
  `fly machine restart 48ee06eb061418 -a iplaces-pagedjs` then retry; if that
  fixes it, disable auto-suspend on that app. Pre-existing; nothing touched it
  today.
- **DOI missing on first publish** (§5). Fix is ordering: the Flax rebuild must
  fire after the DOI write-back, or `side.njk` should fall back to
  `manuscripts.doi` (would need the field added to Flax's GraphQL query — it
  isn't fetched today). Workaround until then: publish twice.
- **Rotate the Postgres password.** `DATABASE_URL` was pasted in the clear.
  Fly-internal address, so hygiene not emergency — but update the server
  secret at the same time.
- **Note to Ash and Vukile:** 2026.08.11-0 removed `menuPinned` from the user
  schema with an empty "Deployment changes" section; any older client hits a
  login redirect loop. Ask that schema-field removals be flagged there.
- **Base-image fingerprint guard** (§6) — add to `deploy-iplaces-server.sh`.
- **Part 12's overlay inventory table is stale** (five listed; Dockerfile has
  nine COPY sources / 18 lines). Read the Dockerfile, not the table.
- **Prod-stack upgrade:** same ritual, client first.
