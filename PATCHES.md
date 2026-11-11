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
- `server-fix/overlays/controllers/orcid.controllers.js`: 2026.11.03-0 image
  plain copy (== tag) + login hook before `done(...)`, non-fatal (+ Patch 30).
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
`allow`, with no login. Upstream 2026.10.12 leaves 60 operations unlisted,
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

Fix (same night): a rule for a field that is not in the running schema
makes graphql-shield throw at startup ("Shield cannot find them in your
schema"), and the server never listens (HTTP 502). The first version of this
patch listed the eight `reference` and `payloadVerifier` queries
(`checkApiPayload`, `formatCitation`, `getReferenceFromDoi`, ...), whose
`.graphql` files exist upstream but are commented out of
`api/graphql/index.js`, so they are not in the schema. Those rules are
removed. The check must read the `typeDefFilePaths` list in
`api/graphql/index.js`, not every `.graphql` file. `team`/`teams` come from
@coko/server's own team model and are in the schema.

After an upstream bump, re-run the check that every `Query`, `Mutation` and
`Subscription` field in `api/**/*.graphql` has an entry here; a new upstream
operation is open to anyone until it does. Plugins mounted at `/custom` can
add operations too.

## Patch 27 — other users' emails only for station staff (2026-10-24)

**File:** `server-fix/overlays/api/graphql/user/user.resolvers.js` (pinned to
the 2026.11.03-0 image's plain copy of `api/graphql/user/user.resolvers.js`,
copied to both the plain and `dist/` paths).

### What it does
The `User` type is `isAuthenticated`, so any logged-in user could read any
user's `email` through `user(id)`, `searchUsers`, team lists, chat messages,
review authors and so on. The overlay adds field resolvers for `User.email`
and the `email` on `User.defaultIdentity` / `User.identities`. The email is
returned only to:

- the user themselves (`currentUser` keeps working);
- admins;
- the current station's (`group-id` header) group managers, group admins and
  editors (an editor team on any record of that station), and only for users
  in that station's `user` team. An editor at one station does not see the
  emails of another station's users.

Everyone else gets `null`, with no error. It is done in the resolvers and not
as a shield rule because a denied field fails the whole query (team lists and
the chat @-mention search would break). Subscriptions carry no `group-id`, so
there only the user themselves and admins see an email. The answers are memoised
on `ctx` so a list of users costs two or three lookups per request.

The "Add existing author" picker does not use these queries (it reads
published records, Recipe Part 19), so it is unaffected. Note: `searchUsers`
itself errors in the 2026.10.12-0 image (`User.model` is undefined in the
upstream controller); this patch does not change that.

**Upgrade:** re-pin to the new image's own `user.resolvers.js` and re-add the
`iplaces Patch 27` lines. If upstream adds a new `User` field that carries an
email, add it here too.

## Patch 28 — attaching a file needs a role on the record (2026-10-24)

### What it does
`createFile` and `uploadFiles` were `isAuthenticated`, so any logged-in user
could attach a file to any record, review, config or CMS layout. New helper
`userCanAddFileTo` follows Patch 25:

- a record (`createFile` `meta.manuscriptId`, `uploadFiles` `entityId`): its
  editors, the record's group managers and group admins, and its authors
  while that version is not published;
- a review (`meta.reviewId`): those editors and managers, the review's own
  author, or a member of the record's reviewer or collaborative reviewer
  team, but not on a decision. `meta.manuscriptId` must be a version of the
  review's record, as it also names the storage folder;
- anything else (logo, favicon, CMS layout images, or no object): group
  managers and group admins of the current group, and the config or CMS
  layout must belong to that group;
- admins: everything.

`uploadFile` (no record, used for the docx upload when starting a
submission) stays `isAuthenticated`.

TRAP: these two rules use `cache: 'no_cache'`. With `cache: 'strict'`
graphql-shield hashes the args, the `Upload` promise in them makes that
throw, and every upload is refused. Any future rule on an upload mutation
needs `no_cache` or `contextual`.

## Patch 29 — emails say the station title, not "Kotahi" (2026-10-24)

### What it does
The seeded email templates had "Kotahi | ..." subjects and a "Kotahi team"
sign-off. `config/defaultEmailTemplates.js` now uses `{{ brandName }}`
(Patch 3c: the group's Settings > Configuration > Group Identity > Group
name, falling back to the group slug), so Gump's reviewer invitation reads
"iPlaces Gump Station | Reviewer invitation" and "iPlaces Gump Station team".

Only NEW groups are seeded from this file (`seedGroups` skips a group that
already has templates). Existing stations were fixed once in the database
(`planning/email-branding/` in the project files). When a new station is
created, set its Group name before anyone is emailed, or emails show the
slug.

`scripts/seedGroups.js` (overlay `server-fix/overlays/scripts/`, pinned to
the 2026.11.03-0 image's plain copy) gets the same change for the
@mention notification template it writes itself. It also tags the Task
notification template by matching its exact subject, so that match now
accepts `{{ brandName }} | Task notification` too. Without it a new
station's task template would never get type `taskNotification`.

Both overlays are copied to plain + dist. The defaultEmailTemplates.js repo
copy equals the image's plain copy plus these text changes. Re-pin both on
image bumps.

## Patch 30 — ORCID login tokens are not kept (2026-11-03)

### What it does
- `server-fix/overlays/controllers/orcid.controllers.js`: a first ORCID login
  no longer stores the ORCID OAuth access and refresh tokens in
  `identities.oauth`. The access token is passed in memory to
  `fetchUserDetails` for the one name/affiliation lookup it was kept for.
  Called without a token (only Crossref publishing does that; iPlaces uses
  DataCite), `fetchUserDetails` returns empty details instead of throwing.
- `server-fix/overlays/api/rest/orcid/orcid.js` (new overlay, 2026.11.03-0
  image plain copy + Patch 30): the request logger (pino-http in
  @coko/server) wrote the callback's `Location` header, i.e.
  `/<station>/login?token=<JWT>`, into the server log on every login. The
  route now hands the logger the address without its query string; the
  browser still gets the full redirect.
- Existing tokens: `upgrades/kotahi-2026.11.03/orcid-tokens-*.sql` in the
  project files sets `identities.oauth` to NULL (run after the deploy).

## Patch 31 — publish once: the DOI is saved before the Flax rebuild (2026-11-03)

### What it does
`publishManuscript` mints the DataCite DOI, then asks Flax to rebuild, and
only saves the DOI (and the Patch 12 Local Contexts refresh) after every
step. Flax reads the record from the database, so the first publish built
the article page without its DOI and editors published twice. Now the DOI
and the submission are saved as soon as DataCite returns, before the Flax
step. Non-fatal; the final save repeats it. Upstream bug (also in
2026.11.03-0); not reported upstream (Erin's rule).

## Patch 32 — activity-log lines name the station, not Kotahi (2026-11-03)

### What it does
The editorial discussion and task logs said "Editor Decision sent by Kotahi
to …", "Submission Confirmation Email sent by Kotahi to …" and so on. They now
say "sent by iPlaces Gump Station to …": the station's Group name
(Settings > Configuration > Group Identity), with "iPlaces " in front when the
name doesn't already start with it (WAMS shows "iPlaces WAMS"). Fallback is
plain "iPlaces"; the helper never throws.

- `packages/server/services/stationSenderName.js`: iPlaces-only helper.
- `manuscript.controllers.js` (overlay 3b): the five "sent by Kotahi" lines.
- `task.controllers.js`: not overlaid. The Dockerfile patches its one line in
  the image's own plain and dist copies, and fails the build if the line
  isn't there. Re-check after every base-image bump.
- `deploy-iplaces-server.sh`: `guard_sender_name_landed`.

Only new log lines change; lines already in the database keep "Kotahi".

## Patch 33 — reviewers never receive author email addresses (2026-11-06)

### What it does
A reviewer's Metadata tab showed the station author field as raw JSON,
author email addresses included, because the GraphQL `manuscript` query hands
the whole submission to anyone with a role on the record. Now the
`Manuscript.submission` field resolver (shared by every query that returns a
manuscript or published manuscript) calls `submissionForUser`, which removes
every key containing "email", at any depth, unless the user is a global admin,
the station's group manager or group admin, an editor of the record (senior,
handling, editor; checked on the version and its first version) or one of its
authors. Reviewers, invited reviewers, collaborative reviewers and anonymous
callers get no emails.

- `manuscript.controllers.js` (overlay 3b): `userMaySeeAuthorEmails`,
  `submissionForUser` (reuses Patch 19's `stripEmails`).
- `manuscript.resolvers.js`: not overlaid. The Dockerfile patches the
  `submission(parent)` resolver in the image's own plain and dist copies and
  fails the build if either line isn't found exactly once. Re-check after
  every base-image bump.
- `deploy-iplaces-server.sh`: `guard_reviewer_emails_landed`.
- Client (`repeatable-group-spike`): the read-only Metadata tab renders
  `StationAuthorsInput` and `AuthorsInput` as a name list (name, ROR
  affiliation, ORCID link), never an email; the JSON fallback for unknown
  object fields drops email keys too.

## 2026.11.03-0 re-pin notes (2026-11-03)
- Patch 15: `createManuscript` is gone upstream; the submit-blocked check is
  now on `createSubmission: and(userCanCreateSubmission, userIsNotSubmitBlocked)`.
- Patch 17: `user.controllers.js` re-pinned to the tag source (plain copy)
  instead of the dist/ compiled copy.
- Patch 26: dropped what eLife now rules itself: the CMS file mutations,
  `generateNewToken` (same roles as ours), and the CMS queries, where
  upstream is stricter (`cmsPage`, `getCmsFilesTree`, `getCmsFileContent`,
  `getFoldersList` need a group admin; Flax reads `cmsLayout`, `cmsPages`,
  `getActiveCmsFilesTree`, still `allow`). Removed rules for operations
  eLife deleted: `createManuscript`, `createTeam`, `updateRecentTab`,
  `uploadFile`, `docxToHtml`. New upstream operations come with upstream
  rules (`createSubmission`, `dashboardData`, `hasToken`,
  `newSubmissionSettings`, `userNotifications`, `dismiss*UserNotification*`,
  `newSubmissionProgress`).
- Patch 27: uses the new request loaders (`getRequestLoaders(ctx)`).
- Team `objectType` for station teams is now lowercase `'group'` (migration
  1793265002). SQL that filters `object_type = 'Group'` finds nothing after
  the upgrade.

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
4. Permission check (Patch 26), before any deploy:
   `node scripts/check-permission-rules.js <new-tag>` (needs
   `git fetch upstream --tags`). It must print `OK`.
   - **NO RULE** lines: eLife added a server action; until it has a rule in
     `permissions.js` anyone can call it without logging in. Add a rule
     matching the page that uses it (see the Patch 26 groups).
   - **NOT IN SCHEMA** lines: eLife removed or switched off an action we
     have a rule for; the server will not start (HTTP 502) until that rule
     is removed.
   The deploy script runs the same check as a pre-flight guard.
5. Drop what eLife fixed. For each iPlaces patch in `permissions.js` and the
   controller overlays (Patches 19 to 26), check whether the new upstream
   copy now does the same thing (for example, a rule we added now exists
   upstream, or upstream's `addReviewer` checks the invitation). If it
   does, take upstream's version and delete ours and its PATCHES.md entry,
   so later merges get smaller. Note what was dropped in the commit message.
6. Deploy with `scripts/deploy-iplaces-server.sh` and confirm all guards pass.
7. Re-verify a funded record reaches DataCite with the ROR (the patch's whole
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

## Patch 34 — first online date as the fallback publication date (2026-11-06)

### What it does
`manuscripts.published` is reset on every (re)publish, so it can't stand in
for a publication date. On publish, if `submission.firstPublishedOn` is not
set yet, it is set once (YYYY-MM-DD) to the earliest `published` date of any
version of the record, or to now on a first publish, and never overwritten.

The publication date everywhere is `submission.datePublished` (the editor's
original date) when filled in, else `firstPublishedOn`, else the last publish
date. When an editor fills in `datePublished` later, it takes over on the next
publish/rebuild.

- `manuscript.controllers.js` (overlay): `publishManuscript` sets it.
- `fieldsTransformers.js` (overlay): DataCite `publicationYear` and `Issued`
  fall back to it.
- Shared Flax templates: `base.njk` (citation_publication_date, JSON-LD
  datePublished) and `_partials/side.njk` (Published row, Cite year).
- Backfill for records published before this patch:
  `server-fix/scripts/first-online-date/1-check.sql`, `2-fix.sql`.

## Patch 35 — DataCite test mode per station (2026-11-11)

Each station keeps its real DataCite settings (login, password, doiPrefix) and,
beside them, test ones (testLogin, testPassword, testDoiPrefix). The
"Use test DOIs" switch (`useSandbox`) picks which set is used AND which server
is called (api.test.datacite.org or api.datacite.org), so switching is one tick
and nothing is retyped. A blank test field falls back to the real value, so
stations configured before this behave exactly as before.

- `services/publishing/datacite/utils.js`: `getActiveDatacite(datacite)`;
  `getDoi` uses the active prefix.
- `services/publishing/datacite/index.js`: `requestToDatacite`,
  `verifySubmission`, `checkPayload` use it; new `checkDataciteConnection`
  (GET /clients/<login> on that server: repository exists there and owns the
  prefix; GET /dois/random?prefix= with the login: password accepted).
  Creates nothing.
- `controllers/manuscript/manuscript.controllers.js`: the "is DataCite on"
  checks (publish, unpublish/hide) use the active login.
- New query `dataciteConnectionCheck` (config.graphql, config.resolvers.js),
  rule `or(userIsGroupAdmin, userIsAdmin)` in permissions.js.
- `server-fix/overlays/controllers/config/configUtils.js`: upstream
  2026.11.03-0 file + testPassword masked, testLogin/testPassword stripped
  from the public config.

Client side (repeatable-group-spike): test fields on the DataCite settings,
test-mode banner, connection status after Save, and the Save fix.

### Patch 35b — shared iPlaces DataCite test account (2026-11-11)

Erin: ticking "Use test DOIs" should be all a station needs. In test mode
`getActiveDatacite` now uses, in order: the station's own testLogin /
testPassword / testDoiPrefix (config only, not in the form), then the shared
iPlaces test account from the server environment, then the real value.
Shared account = Fly secrets on iplaces-test-server:
IPLACES_DATACITE_TEST_LOGIN, IPLACES_DATACITE_TEST_PASSWORD,
IPLACES_DATACITE_TEST_PREFIX (a DataCite Fabrica Test repository).
Real DOIs stay per station, entered by hand.

### Patch 35c — per-record test DOIs, public test-DOI links (2026-11-11)

- An editor can tick "Publish this record with a test DOI" in the record's
  Publishing section (client); it sets `submission.$testDoi`.
  `configForRecord` (datacite/index.js) then sends that record to the
  sandbox with the shared test account even when the station is on real
  DOIs. Untick and republish to give it a real DOI.
- Publish stores `submission.$doiIsTest` (true when the DOI came from the
  sandbox). Unpublish hides a test DOI on the sandbox, a real one on DataCite.
- Station templates (station-master, cms-sync push): test DOIs link to
  https://handle.test.datacite.org/<doi> (public, no login) and are marked
  "(test DOI)"; citation_doi, JSON-LD identifier, DataCite Commons button,
  connections and revisions panels are left out for test DOIs.

### Patch 35d — reserve a DOI without publishing (2026-11-11)

- New mutation `reserveDataciteDoi(id)` (config.graphql, config.resolvers.js,
  permission `userCanPublishManuscript`) calls `reserveDoi` in
  datacite/index.js. It creates a DRAFT DOI at DataCite: the same DOI that
  Publish will use (prefix + record id, or the suffix of an existing `$doi`).
  Drafts don't resolve, aren't public, and can still be deleted at DataCite.
- The record gets `doi`, `submission.$doi`, `$doiIsTest` and
  `$doiReserved: true`. Publish later finds the draft and PUTs it with event
  'publish' (existing code path), and sets `$doiReserved: false`.
- Follows test mode: a test station or a record with `$testDoi` reserves on
  the sandbox with the shared test account. Refuses published records and
  records from another station (group-id header).
- Client: "Reserve DOI" button in the record's Publishing section.

## Patch 37 — every station gets its own brand colours (2026-11-11)

Kotahi seeds every new group with the same green (`#3aae2a`), in both
`configs.form_data.groupIdentity` (the Kotahi app) and, the first time the
CMS is opened, `cms_layouts` (the public station pages). That green also
fails the 4.5:1 contrast check against white.

`server-fix/overlays/scripts/seedGroups.js` now calls
`assignStationColours` right after `seedConfig`. If a group's primary colour
is still the Kotahi default, it sets a primary and secondary colour: a fixed
pair for the five current stations, otherwise the first pair from a rotation
of eight that no other group uses yet. It also updates that group's
`cms_layouts` row if one exists and is still green. Colours set by hand are
never touched. Every colour in the lists passes 4.5:1 against white.

Server-only (seedGroups runs at boot). The public pages pick up a changed
`cms_layouts` colour on the next Flax rebuild (CMS > Layout > Publish, or a
cms-sync push).

## Patch 38 — users can remove their own profile picture (2026-11-11)

Kotahi only had upload, which replaces the old picture, so once someone added a
picture there was no way back to the default avatar (Erin, in WAMS).

- New mutation `removeProfilePicture: User` (no arguments, acts on
  `ctx.userId` only). Schema: `server-fix/schema-extensions/user.graphql`, an
  extra `extend type Mutation` block that `server-fix/Dockerfile` appends to the
  image's own `api/graphql/user/user.graphql` (plain and dist). The build fails
  if the file is missing or already has `removeProfilePicture` (upstream added
  it: drop this patch).
- Resolver in the `user.resolvers.js` overlay; controller
  `removeProfilePicture` in the `user.controllers.js` overlay: sets
  `users.profile_picture` to null, then deletes the file (as `profileUpload`
  does for a replaced picture; a failed delete is logged, not fatal).
- Rule `removeProfilePicture: isAuthenticated` in permissions.js (safe because
  the resolver never takes a user id).
- `scripts/check-permission-rules.js` reads `server-fix/schema-extensions/`
  too, so the new rule is not reported as "not in schema".

Client side (repeatable-group-spike): "Remove picture" button on your own
Profile page, shown only when you have a picture.

By hand (no deploy): `UPDATE users SET profile_picture = NULL WHERE id = '<id>';`
Users are shared by all stations, so a picture shows (and is cleared) everywhere.
