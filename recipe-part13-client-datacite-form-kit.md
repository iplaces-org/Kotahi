# PART 13 — Custom client + DataCite form kit

*Companion to Part 12 (which covers server/base-image upgrades). This part covers the iPlaces client fork, the DataCite form components, serializer Patches 3–7, form-field operations, and mass data operations. Everything here was proven in production July 5–7, 2026.*

## The two-branch model (read this before touching anything)

| Branch | Contains | Deploys | Work here |
|---|---|---|---|
| `iplaces-prod-config` | server-fix/ overlays, recipes, station-master, seed files | `iplaces-test-server` via `scripts/deploy-iplaces-server.sh` | serializer patches, seeds, docs |
| `repeatable-group-spike` | upstream tag `2026.07.03-0` + iPlaces client components + canonical `packages/client/fly.toml` | `iplaces-test-client` via `fly deploy -c fly.toml` | components, form builder catalog |

**Rules:**
- The Vite dev server serves WHATEVER BRANCH IS CHECKED OUT. Switching to the config branch mid-session silently turns localhost into the stock client → custom-component forms crash with "something went wrong." Switch back after server work.
- Never do server work on the client branch or vice versa.
- The branch name lies — it's not a spike anymore; it builds the production client. (Rename to `iplaces-client` pending.)
- `upstream` remote = eLifePathways, fetch-only, push DISABLED.

## Client build & deploy

Canonical config: `packages/client/fly.toml`, committed (force-added past gitignore — NEVER let it exist only on disk; it has been lost to a branch switch once). `[build] dockerfile = 'Dockerfile-production'`.

```
cd packages/client            # on the client branch
fly deploy -c fly.toml --remote-only
```

Build takes ~60–90 s (19 stages, Depot). **Traps, each hit once:**
- The Fly app's STORED config can pin an old prebuilt image and silently win over flags. Always deploy with explicit `-c fly.toml`. Verify after EVERY client deploy: `fly image show -a iplaces-test-client` → must show `registry.fly.io/iplaces-test-client`, not docker-hub-mirror.
- A deploy that prints "Searching for image ... remotely" and finishes in seconds DID NOT BUILD — it pulled a prebuilt image from stored config.
- The client auto-stops when idle (`min_machines_running = 0`). "has no started VMs" from `fly ssh console` usually means asleep, not broken — wake it by loading the site in a browser first.
- The "WARNING app not listening on 0.0.0.0:4000" during deploy is boot-timing noise on this app; the site loading is the real test.

**Bundle-grep verification (mandatory after component deploys):** Vite tree-shakes — a component file that compiles but is never imported silently vanishes from the bundle. Grep the built JS in the machine for a string unique to the new code (not just the component name — a string only the NEW version contains, e.g. a distinctive prop):

```
fly ssh console -a iplaces-test-client -C "sh -c 'grep -rl STRING /home/node/app/_build 2>/dev/null | head -1'"
```

Path prints = deployed. Silence = not in the bundle (usually: registration missing).

## Adding a form component — the checklist

1. Component file in `packages/client/app/components/component-submit/src/components/`
2. **Render registration** in `FormTemplate.jsx`: import line + entry in the `elements` map. (File without registration = tree-shaken to nothing; this exact miss shipped once.)
3. **Builder registration** in `component-formbuilder/src/components/config/Elements.js`, BOTH structures: the type map (unlocks the Field Properties panel — type label, required via `validate: validateCollection` for arrays) and the custom-field list (makes it placeable from the builder's add-field menu). Without this the builder shows the field with a blank type; clicking Save on that blank modal can wipe the component — CANCEL, never Save, on a blank-type modal.
4. Localhost hot-reload test → commit → `fly deploy -c fly.toml` → bundle-grep → only THEN any form-field additions.

**THE FormTemplate `.value` TRAP (critical for any single-value component):** FormTemplate's generic onChange extracts `.value` from ANY object passed to it — `{label, value}` gets flattened to a bare string before storage. Arrays are immune (no `.value` property), which is why array components never hit it. Single-object component values MUST avoid a `value` key (PublisherInput stores `{label, ror}`, converting to/from react-select's `{label, value}` at the select boundary). Symptom: selection "won't stick." Worth flagging in any upstream PR.

## Form-field operations & the coupling rule

**COUPLING RULE (a form once crashed for all users of a group over this):** a form field naming a component couples that group's form to the client build. The instant the field exists, every client without the component crashes on that form. Order is always: client deployed → THEN field added. TextField/stock components are exempt. Removing fields never touches data (values stay in submission JSON; serializer fallbacks read JSON, not the form).

**Tooling:** `add-datacite-fields.mjs <group> <fieldKey> [--write]` — catalog-driven upsert (converts in place by reusing element id; idempotent; dry-run default; bare run lists the catalog: relatedIdentifiers, contributors, publisher, funding, keywords). The form builder can also place these now (post Elements.js registration) — the script remains the recorded/repeatable path for station onboarding.

## Serializer patch inventory (server-fix overlays; deploy per Part 12)

| # | What | Semantics |
|---|---|---|
| 1 | funderIdentifier ← funderid (ROR) | fix |
| 2 | schemaVersion kernel-4; resourceTypeGeneral ← resourcetype; resourceType ← ifother (omit blank); checkPayload reads resourcetype | fix |
| 3 | relatedIdentifiers ← form rows | **MERGE** with legacy (citations `IsCitedBy` + `$dois` `HasPart`) |
| 4a | contributors ← form rows (Personal/Organizational, ROR/free-text) | **MERGE** (group Sponsor kept, form rows appended) |
| 4b/5 | publisher override ← `{label, ror}` object or legacy string+publisherRor | **OVERRIDE** when present, else group config |
| 4c | publicationYear ← explicit → year of datePublished (bare `2023` works) → current year | fallback chain |
| 6 | contributor affiliation accepts ARRAY (multi-affiliation) or legacy single object | back-compat |
| 7a | fundingReferences ← form rows | **REPLACE-with-fallback** (rows win; empty → legacy flat fields) |
| 7b | dates ← dateReceived (Submitted) / dateAccepted (Accepted, falls back to publish time) / datePublished or $issueYear (Issued, OMITTED when invalid — dateless-Issued wart fixed). ISO-shape guard: YYYY / YYYY-MM / YYYY-MM-DD only | wiring |
| 7c | subjects ← topics checkboxes (stored as displayed, e.g. "Research") + comma-split submission.keywords | new key |

Why three merge semantics: relations/contributors are additive lists (merge); funding is one coherent list (replace, or re-entered manuscripts would double); publisher is a scalar (override).

**Guard-marker rule (a half-deployed patch stack once passed all guards):** the guard suite must grep for a marker from the LATEST patch (currently `getSubjects`), not just Patch 1's `funderid`. Update the marker every time a patch adds a function. Symptom of the failure it catches: "X is not a function" in the publish error banner — index.js calling what fieldsTransformers doesn't export = the two files are from different patch generations.

**Download-suffix discipline (caused that exact failure):** browsers save repeat downloads as `file (1).js`. Before every `cp` of a downloaded overlay: `ls -lt ~/Downloads/<name>*`, take the newest, and verify content before deploying — `grep -c <new-function> <repo-file>` must be ≥2 (function + export). Never cp without the grep.

## Mass data operations (scripts against manuscripts)

- **`updateManuscript(id, input)` DEEP-MERGES** (`deepMergeObjectsReplacingArrays`): minimal deltas like `{submission: {fundingReferences: [...]}}` are safe — nothing else on the manuscript is touched. Arrays replace wholesale. (This also settles the old "clobber question": partial writes merge.)
- **VERSIONS:** the form and the serializer use a manuscript's LATEST VERSION when versions exist. Any mass read/write must resolve `manuscriptVersions` and target the newest row, or it silently edits ghosts (parent rows nothing renders). Discovered when a migrated record showed empty in the form: parent had the data, latest version didn't.
- **SCOPING:** the `manuscripts` resolver returns rows ACROSS groups for admins; the Manuscript type exposes no group field. Mass scripts cannot filter by group — the dry-run candidate list IS the group filter; eyeball it.
- **Pattern** (embodied in `migrate-flat-funding.mjs`): dry-run default → full per-record preview → `--limit 1 --write` smoke test → verify IN THE FORM (the check that caught versioning) → full `--write` → re-run audit expecting 0 candidates → republish published records so DataCite updates (migration ≠ republication).
- Migrations ADD the new structure and LEAVE legacy fields in place (audit trail; serializer fallback makes them inert).

## Dev-session mechanics

- Warm-up: client branch → `cd packages/client` → `SERVER_URL=https://iplaces-test-server.fly.dev CLIENT_PORT=4000 yarn coko-client-dev`
- **Token trick** (ORCID login on localhost always bounces to the fly client): copy Local Storage key `token` from the fly client, then visit `http://localhost:4000/<group>/login?token=<JWT>&redirectUrl=/<group>/dashboard`. Never click Login on localhost. Tokens ~7 days.
- **CORS:** the server accepts a comma-separated origin list (see-saw is dead). Current: fly client + localhost:4000 simultaneously.
- Node 24 via nvm, yarn 4.9.2 via corepack (auto-pinned by the repo).

## Station onboarding deltas (accumulate for the checklist / station-master)

- New stations get the IPLACES CLIENT IMAGE (registry.fly.io build from the client branch), not the prebuilt cokoapps image
- Form fields: relatedIdentifiers, contributors, publisher, funding, keywords — via `add-datacite-fields.mjs <group> <key> --write` (client must be deployed first) or the form builder
- Bake into station-master `forms-journal/submit.json` once the form set stabilizes (post Session C)
- Per-station DataCite config: sandbox for scratch groups ALWAYS (a scratch group once minted a real findable DOI on the production prefix — findable DOIs cannot be deleted, only demoted to Registered in Fabrica)

## Open items

- Session C: titles/titleTypes, alternateIdentifiers, rights (SPDX shortlist), geoLocation points/boxes, relatedItems (re-enable), language/version, vocab-verify pass against the 4.7 docs (the TODO in dataciteFieldDefinitions.js), optional: keywords chips input, subjectScheme on topics, name property on personal contributors
- eLife email: parameterized field definitions on their getAuthorFields pattern + the `.value` trap heads-up
- Branch rename `repeatable-group-spike` → `iplaces-client`; GitHub default branch → `iplaces-prod-config`
- Flat funding fields removed from gump form (see checklist below) — remove from station-master seed too when baking
