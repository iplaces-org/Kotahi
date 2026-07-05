# PART 10 — Cloning a station from Gump (the two seeds)

*Derived from reading the eLifePathways repo + extracting Gump's live config off `iplaces-test-server`, then actually baking + deploying it, June 2026. Goal: make a new `station` group seed as a full Gump clone — Gump's questionnaire **and** Gump's site look — with zero per-station hand-editing.*

> **CORRECTION (June 2026):** an earlier draft of this recipe assumed you could
> invent a new `:station` instance type that seeds generically from a
> `forms-station/` folder. **That does not work** — it crash-loops the boot and
> breaks the dashboard. Two hard constraints (documented below) force a simpler
> design: **a "station" is just a `:journal` group**, exactly how Gump itself is
> defined (`gumpstation:journal`). You clone Gump by folding Gump's form into the
> journal form and overlaying Gump's CMS look. The dead-end is written up under
> "Why not a new instance type" so nobody re-attempts it.

## What actually defines a "station," and where each piece is seeded from

A station is a **`:journal`** group. Two things make it look and behave like Gump, each seeded from an on-disk folder baked into the server image (not from the live Gump group):

**1. The questionnaire (form) → `packages/server/config/storage/forms-journal/submit.json`**
- `INSTANCE_GROUPS` entries are `groupName:instanceName`. For a station, `instanceName` is **`journal`** (e.g. `newstation:journal`).
- `scripts/seedForms.js` picks the submission form by instance type: `SUBMISSION_FORM_PATHS[config.formData.instanceName]`. For `journal` that is `forms-journal/submit.json`. **So to give every new journal group Gump's form, you overlay `forms-journal/submit.json` with Gump's form.** (Tradeoff: this makes Gump's form the form for *all* new `:journal` groups. Existing groups — incl. `gumpstation` — are untouched, because their form already exists in the DB and the seeder skips-if-exists.)
- **`review.json` / `decision.json` are NOT instance-scoped** (this was the old OPEN question — now confirmed). `seedForms.js` reads them from the base `forms/` folder for every type via fixed `REVIEW_FORM_PATH` / `DECISION_FORM_PATH`. Only `submit.json` is per-instance. So Gump's custom review/decision (if any) would need a different mechanism; in practice the generic review/decision are fine.

**2. The site look (CMS template files) → `packages/server/config/cmsTemplateFiles/`**
- One generic tree (`layouts/`, `_partials/`, `theme/`, `content/`, `data/`, `index.md`). On seed, `scripts/seedCmsFiles.js` walks this folder and copies it into the new group's CMS file store.
- **Instance-type-independent:** it seeds for *any* new group regardless of type, and **only if the group has no CMS folder yet** (`existFolder` check) — so re-seeding never clobbers an existing station, and existing groups (incl. Gump) are untouched by a master change.

## Why not a new `:station` instance type (the dead-end — do not re-attempt)

Two hardcoded gates make a brand-new instance type far more expensive than it looks:

1. **Server seed scripts hardcode the valid types.** `scripts/seedConfig.js` has a `switch (instanceName)` with cases only for `preprint1/preprint2/prc/journal` and a **`default` that falls back to `journal`**. `scripts/seedForms.js`'s `SUBMISSION_FORM_PATHS` has no `station` key. So a `:station` entry silently seeds as a journal with `forms-journal` — *unless* you overlay both scripts to add a `station` case/path (doable; same wrapper pattern).

2. **The client enum is compiled into the prebuilt client bundle — this is the blocker.** `packages/client/app/components/component-config-manager/src/ui/schema.jsx` (~line 5707) declares `instanceName: { enum: ['preprint1','preprint2','prc','journal'], default: 'journal' }`. The deployed dashboard (`iplaces-test-client`, running the prebuilt `cokoapps/kotahi-client:<tag>` image) validates each group's stored config against this enum. A stored `instanceName: 'station'` makes the client reject the config — *"instanceName should be equal to one of the allowed values"* — and **the dashboard refuses to render**. The enum is minified into a webpack chunk, so the COPY-overlay trick can't patch it; fixing it needs a full **client source rebuild + redeploy** (a separate, heavier app + build, not an image overlay).

Net: a custom instance type buys you nothing here and costs a client rebuild. Use `journal`.

## The form-schema gotcha (will crash-loop the boot if skipped)

Gump's form pulled over GraphQL serializes empty fields as JSON **`null`**. The `Form` model's AJV schema (`packages/server/models/form/form.model.js`) requires several of these to be **non-nullable strings**: `uploadAttachmentSource`, `s3Url`, `s3Bucket`, `s3Region`, `s3AccessId`, `s3AccessToken`, and `options[].labelColor`. A `null` there throws a `ValidationError` *inside the boot-time seed transaction* → the server never listens on 3000 → **502 crash-loop** for as long as that group is in `INSTANCE_GROUPS`.

**Fix before baking:** recursively strip every `null`-valued key from `submit.json`. The generic `forms-journal` form simply omits these keys, so absent-is-fine; null-is-fatal. After stripping, validate against the real schema before deploying — easiest is to upload the file into the running container and run `Form.fromJson({purpose:'submit',category:'submission',structure:<file>,groupId:'00000000-...'})`; no throw = valid.

```js
// strip nulls recursively (Node, no deps)
const fs = require('fs')
const data = JSON.parse(fs.readFileSync(path, 'utf8'))
;(function strip(v){ if(Array.isArray(v)) return v.forEach(strip)
  if(v && typeof v==='object') for(const k of Object.keys(v)){ if(v[k]===null) delete v[k]; else strip(v[k]) } })(data)
fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
```

## Where a live group's CMS files physically live (the "file browser")

Not one place — **two, working as a pair:**
- **Catalog:** Postgres table `cms_file_templates` — one row per file/folder, `groupId`-scoped, tree built via `parentId`, top folder is `rootFolder:true` and named after the group. This is what the client's **File Browser** tab shows.
- **Bytes:** Tigris/S3 object storage. Each `cms_file_templates.fileId` → a `@coko/server` `File` row whose `storedObjects[].url` points at the blob. `getCmsFileContent(fileId)` fetches the blob server-side and returns it as text.

## Extracting Gump's real config (the repo ships only generic)

The repo's `forms-journal` and `cmsTemplateFiles` are eLife **generic** — they do **not** contain Gump's custom fields or partials. Gump's real versions exist only in the live group and must be pulled out. All over the **public GraphQL API**, no DB/Tigris creds, no token (shield: `forms` / `formForPurposeAndCategory` = `allow`; CMS read queries open on this server):
- Form: `{ forms { purpose groupId structure { … } } }`, filter by `groupId`. (Verify children count to confirm you grabbed Gump's: Gump's submit form is 36 children vs generic 25.)
- CMS: `{ getActiveCmsFilesTree }` (set header `group-id: <groupId>`) → JSON tree; for each node with a `fileId`, `getCmsFileContent(id: fileId){ content }`; rewrite the folder tree to disk.
- Then **strip nulls** from the pulled `submit.json` (see above) before baking.

## De-slug rule (do this before baking, or every clone points back at Gump)

The slug is a **string** at `cmsConfig.group.name`. `cmsConfig.group` is an **object** (`{ id, name }`) — using it bare prints `[object Object]`. Swap every hardcoded `gumpstation` for `{{ cmsConfig.group.name }}`. In Gump's templates that was 5 spots across 3 files:
- `layouts/base.njk` ×3 — `og:image`, `og:url`, JSON-LD `url`
- `layouts/_partials/side.njk` ×1 — the **Zenodo button** `&group=…` (the critical one)
- `layouts/_partials/metaror-menu.njk` ×1 — the login link

Hosts are a per-deployment constant, separate from the slug: `iplaces-test-flax.fly.dev`, `iplaces-test-client.fly.dev` (leave the Zenodo host `iplaces-zenodo.fly.dev`). **CAVEAT:** the static `data/cmsConfig.json` reads `name:"kotahi"`; the live server injects the real group at render (proven by `linkHandler(cmsConfig.group,…)` producing correctly-scoped links). The source templates being de-slugged is verifiable statically; the runtime resolution to the slug only shows on a **built/published page** — so build one page for the new group and confirm the Zenodo `&group=` reads the new slug, not `kotahi`.
Also drop the empty `_partials/new file.njk` (mis-click), and keep query-driven content pages OUT of the master (keep only `content/pages/page.njk`); copy specific pages per station as needed.

## The bake (same wrapper-Dockerfile pattern as the Flax font fix)

Don't build from source. Wrapper image over the prebuilt server. **In-image paths are flattened** — the prebuilt `cokoapps/kotahi-server` image roots the server package directly at `/home/node/app` (NOT under `packages/server`); proven by the DataCite patch landing at `/home/node/app/services/...`. So `packages/server/config/...` → `/home/node/app/config/...`. This overlay lives in `server-fix/Dockerfile` alongside the DataCite patch so one image carries everything; deploy via the guarded `scripts/deploy-iplaces-server.sh`.

```dockerfile
FROM cokoapps/kotahi-server:<tag>

# DataCite patch (unrelated, kept here so one image carries everything)
COPY packages/server/services/publishing/datacite/fieldsTransformers.js \
     /home/node/app/services/publishing/datacite/fieldsTransformers.js

# (a) Gump's (null-stripped, schema-valid) form -> becomes the journal form, so
#     every new :journal group seeds Gump's questionnaire.
COPY packages/server/config/storage/forms-journal/submit.json \
     /home/node/app/config/storage/forms-journal/submit.json

# (b) De-slugged Gump CMS look -> the single shared tree, seeded for any new group.
COPY station-master/cmsTemplateFiles/ \
     /home/node/app/config/cmsTemplateFiles/
```

If you use a deploy-scoped `.dockerignore` (we do), un-ignore each COPY source by walking its parent dirs in.

Then deploy the image FIRST, and only AFTER it is live add the new group (the new group must be seeded by the image that already carries Gump's form + look, or `seedCmsFiles`' skip-if-exists locks in the wrong look):

```
scripts/deploy-iplaces-server.sh            # confirm + deploy + guards
# then, separately:
fly secrets set INSTANCE_GROUPS="gumpstation:journal,<newstation>:journal" --app iplaces-test-server
# and bump EXPECTED_INSTANCE_GROUPS in scripts/deploy-iplaces-server.sh to match,
# or the post-deploy env guard fails.
```

Watch the boot log for the seed block:
- `Added "<newstation>" group to database.`
- `Added "journal" instance type config to database for "<newstation>" group.`  ← journal, so the client dashboard renders
- `Added submission form from ../config/storage/forms-journal/submit.json for "<newstation>" group` ← Gump's form

A brand-new `:journal` group is then born with Gump's form and Gump's look; Gump itself is untouched. Verify: submit-form children = 36 (matches Gump); `getActiveCmsFilesTree` (with `group-id` header) returns the look tree; the dashboard loads (config is `journal`).

**Deliverable from this session:** the overlay in `server-fix/` (Dockerfile + `.dockerignore.deploy`) + the null-stripped Gump form at `packages/server/config/storage/forms-journal/submit.json` + the de-slugged `station-master/cmsTemplateFiles/`. (`station-master/forms-station/` is now vestigial — the form lives in `forms-journal`.)
