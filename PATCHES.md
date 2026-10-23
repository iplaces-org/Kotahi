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

## Patch 18 — ORCID author linking (2026-10-19)

### What it does
A user whose ORCID appears in a manuscript's `submission.$authors` is added to
that manuscript's `author` team (full author rights; shows under My
Submissions). Add-only: removing someone from `$authors` does not remove them.
All groups. ORCIDs are compared after stripping `https://orcid.org/` and
upper-casing a final `x`.

- `server-fix/overlays/services/orcidAuthorLink.service.js` (iPlaces-only):
  `linkUserToManuscriptsByOrcid`, `linkAuthorsOfManuscript`.
- `server-fix/overlays/controllers/orcid.controllers.js`: 2026.10.12-0 image
  plain copy (== tag) + login hook before `done(...)`, non-fatal.
- `packages/server/controllers/manuscript/manuscript.controllers.js`:
  `updateManuscript` links authors when the delta carries `$authors`
  (also covers `submitManuscript`), non-fatal.
- `server-fix/scripts/backfill-orcid-authors.js`: idempotent one-off backfill
  (sftp to /home/node/app, run with node).

Re-pin `orcid.controllers.js` at every base-image bump (diff vs the image's
plain copy must show only the Patch 18 lines).

## Patch 19 — no author emails on public read paths (2026-10-22)

### What it does
The public GraphQL queries `manuscriptsPublishedSinceDate`,
`publishedManuscript` and `publishedManuscripts` (all `allow`, no login)
returned the raw submission JSON, so every `$authors` email was readable by
anyone with curl. The station authors typeahead (recipe 19) and the Flax
article pages (`mailto:` in `article-preview.njk`) both read these queries.

- `packages/server/controllers/manuscript/manuscript.controllers.js`:
  `stripEmails` / `withoutEmails` drop every key containing "email", at any
  depth, from the submission those three controllers return. Rows keep name,
  ORCID and affiliation. Typeahead picks now arrive with a blank email.
- `packages/server/permissions.js`: the generic `manuscript(id)` query no
  longer serves a published record to anonymous callers
  (`and(isAuthenticated, manuscriptIsPublished)`); the public article view
  uses `publishedManuscript`, which is stripped.

Not affected: editors/authors (role-gated queries), DataCite (reads the DB at
publish), notification emails (server-side). Existing Flax pages keep their
`mailto:` links until each station is rebuilt.

Residual: a logged-in user with no role can still call `manuscript(id)` on a
published record and see its emails. To close that too, drop the
`and(isAuthenticated, manuscriptIsPublished)` line from the `manuscript` rule.

## Patch 20 — assignUserAsAuthor needs an open invitation (2026-10-22)

### What it does
`assignUserAsAuthor(manuscriptId, userId, invitationId)` was `isAuthenticated`
(upstream TODO), so any logged-in user could put anyone on any manuscript's
author team. The controller only checked that the invitation existed and was
unanswered, not that it was for that manuscript, or for an author.

- `packages/server/permissions.js`: new rule `userHasOpenAuthorInvitation`.
  Passes only when `userId` is the caller, and the invitation is an `AUTHOR`
  invitation for the same `manuscriptId`, still `UNANSWERED` with no
  `responseDate`, and not addressed to a different user.

Not affected: the normal "accept author invitation" link (the client already
sends the caller's id and the invitation's own manuscript), Patch 18 ORCID
linking (server-side, no GraphQL), editors adding authors on the form.

## Patch 21 — authors cannot edit a published version (2026-10-22)

### What it does
`updateManuscript` and `submitManuscript` let any author-team member change a
version that is already `published`, including unpublishing it (Patch 16's
`{status:'unpublished'}` path). Patch 18 puts every ORCID-matched author on
the team, so that is now a lot of people.

- `packages/server/permissions.js`: new rule `manuscriptIsNotPublished`
  (status of the version named by `args.id` is not `published`). The author
  branch of both mutations is now
  `and(userIsAuthorOfManuscript, manuscriptIsNotPublished)`. Editors, group
  managers, group admins and admins are unchanged.

Authors who need a correction ask the station's editor, who edits and
republishes. After an unpublish (status `unpublished`) authors can edit again.
`createNewVersion` is unchanged, but a new version copies the old one's
status, so it stays read-only to authors unless the station sets
`allowAuthorsSubmitNewVersion` (status becomes `revising`).

## Patch 22 — a new version stays off the public site until published (2026-10-22)

### What it does
Kotahi's `createNewVersion` clones the old version, published date included,
and Flax builds each record from its newest version that has a published
date. So when an author started a new version of a published record (station
setting "allow authors to submit a new version"), their unreviewed edits went
public at the next station rebuild.

- `packages/server/controllers/manuscript/manuscript.controllers.js`:
  - `createNewVersion` clears `published` on the new version. It gets a date
    again only when an editor publishes it.
  - `manuscriptsPublishedSinceDate` serves the newest *published* version of
    each record, and leaves a record out when a version newer than that one
    was unpublished (an unpublish never brings back an older version).

The article page keeps showing the last published version while the new one is
in review. Publishing the new version replaces it as before.

## Patch 23 — author emails need a role on the record (2026-10-23)

### What it does
Closes the residual gap left by Patch 19.

- `packages/server/permissions.js`: the `manuscript(id)` query no longer has
  the `and(isAuthenticated, manuscriptIsPublished)` branch, so a logged-in
  user with no role on a published record cannot read it (or its author
  emails). Group managers, group admins, admins, the record's editors,
  authors and reviewers are unchanged. The now-unused `manuscriptIsPublished`
  rule is removed. Every client page that uses `manuscript(id)` is a role
  page (submit, review, decision, production); the public article view uses
  `publishedManuscript`, which Patch 19 strips.
- The top-level `manuscripts` query (every record of every group, drafts and
  emails included) was open to any logged-in user. The client never calls
  it; it is now admin only.

## Patch 24 — invitation and reviewer mutations (2026-10-23)

### What it does
- `updateInvitationStatus` was `allow`. Declining (status `REJECTED`, no
  `userId`) stays open, because the decline link in the invitation email
  works without a login. Accepting needs the logged-in invitee
  (`userId` = caller), and the invitation must still be `UNANSWERED` and not
  addressed to someone else. Admins can still do either.
- `addEmailToBlacklist` was `allow`. Now only for an address whose invitation
  to a record in that group was declined with "do not contact" (the decline
  page saves that reason before it calls this), or for editors, group
  managers, group admins and admins.
- `addReviewer` was `isAuthenticated`, so any logged-in user could put anyone
  on any record's reviewer team, and reviewers can read the whole record.
  Now editors, group managers, group admins and admins, or the invitee
  accepting their own open `REVIEWER`/`COLLABORATIVE_REVIEWER` invitation
  to that record (same shape as Patch 20 for authors).

## Patch 25 — file changes need a role on the file's record (2026-10-23)

### What it does
`deleteFile`, `deleteFiles`, `updateFile` (and `updateTagsFile`, see Patch 26)
were `isAuthenticated` for any file id. New rule `userCanChangeFile`:

- a record's file: its editors, the record's group managers and group
  admins, and its authors while that version is not published (as Patch 21);
- a file on a review (review attachments, decision files): the above editors
  and managers, the review's author, or a member of the record's reviewer or
  collaborative reviewer team;
- any other file (logos, favicon, CMS and export-template assets): group
  managers and group admins of the current group;
- admins: everything. `deleteFiles` needs every id to pass.

## Patch 26 — every GraphQL operation has a rule (2026-10-23)

### What it does
graphql-shield's default for an operation missing from `permissions.js` is
`allow`, with no login. Upstream 2026.10.12 leaves 58 operations unlisted,
including `deleteResource`, `updateResource`, `renameResource` and
`addResourceToFolder` (station CMS files), `generateNewToken` (API tokens),
the email-template mutations, `removeInvitation`, `getEmailInvitedReviewers`
(reviewer emails), `getManuscriptsData` (record export) and `openAi`.

Each now has an explicit rule, under an `iplaces Patch 26` comment in each
of `Query`, `Mutation` and `Subscription`:

- read-only site and CMS queries stay `allow` (`cmsLayout`, `cmsPage(s)`,
  `getActiveCmsFilesTree`, `getCmsFilesTree`, `getCmsFileContent`,
  `getFoldersList`, `flaxHealthCheck`, `groupByName`, `oldConfig`), because
  Flax and logged-out pages may read them;
- CMS file mutations, `generateNewToken`, `checkApiPayload`: group admins and
  admins (as the existing CMS page mutations);
- email templates, COAR inbox: group managers, group admins, admins;
- editor actions (invitations, tasks, proofing, collaborative reviewers,
  article templates, record export): editors, group managers, group admins,
  admins;
- `updateLanguage`: the user themselves, group admins, admins;
- the rest (citations, references, chat, notifications, docx import, OpenAI,
  Local Contexts search): any logged-in user.

After an upstream bump, re-run the check that every `Query`, `Mutation` and
`Subscription` field in `api/**/*.graphql` has an entry here; a new upstream
operation is open to anyone until it does. Plugins mounted at `/custom` can
add operations too.

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
