# July 5, 2026 — Session Summary: From "Plan an Approach" to DataCite 4.7 in Production

*Read this tomorrow morning. It reconstructs not just what shipped, but how each decision led to the next — because the process is the reusable part.*

---

## The arc in one paragraph

The day started with a planning question: how should the iPlaces form be able to write the complete DataCite 4.7 schema, when Kotahi's form is flat except for authors? By evening, Gump's production form was writing typed contributors (people and organizations, ROR-backed or free-text), related identifiers with full DataCite vocabularies, publisher overrides, and correct publication years into real DataCite payloads — through a custom-built client, three new form components, a shared schema module, and three serializer patches, all running on an upstream Kotahi release that was three versions ahead of us at breakfast.

## Part 1 — The plan (morning)

**The reframe that shaped everything:** this was never a database problem. Kotahi's `submission` column is a JSON blob that already holds arbitrary nesting ($authors proves it). The real work was three separable layers: (1) the canonical data shape in the JSON, (2) the form UI to author it, (3) the serializer that turns it into DataCite payloads. Plan each independently; ship each independently.

**Key architectural decisions made up front:**
- Mirror DataCite's own JSON attribute names in submission fields, so the serializer becomes a thin passthrough instead of a mapping layer.
- Passthrough-with-fallback pattern: new form arrays merge with (never replace) legacy derivations, so every existing manuscript serializes unchanged.
- Prove the data path before the UI: the blob and serializer could be validated by hand-written JSON before any component existed.

**The blocker inventory:** the stock client has exactly one structured repeatable component (AuthorsInput). Adding more had been blocked for months by React error #130 in from-source client builds.

## Part 2 — Checking upstream changed the plan (late morning)

Before building anything, we checked eLifePathways' repo. Three discoveries redirected the day:

1. **Three new releases** since our pinned 2026.04.27-0, including a switch to a TypeScript build system and a mass .js→.jsx migration — which meant our React #130 was very plausibly a casualty of building a mid-migration tree, not a bug in our code.
2. **`getAuthorFields()` in shared/authorsFieldDefinitions.js** — upstream had already made author sub-fields declarative, with a comment inviting extension. Our generic component wasn't a foreign graft; it was their own pattern, generalized.
3. **Upstream fixed a Fly.io Postgres connection issue** adjacent to our knex pool exhaustion.

Decision: **upgrade first, build second.** Component work had to target the new tree anyway.

## Part 3 — The upgrade (midday) → became Recipe Part 12

Executed the full ritual, every step verified empirically:

- **Backup before migrations** (pg_dump via fly proxy; 1.6 MB; never needed — but the crash we later hit occurred *before* migrations, which the backup discipline let us know was safe).
- **Inspect the new image before deploying:** `docker run --rm <image> cat/ls/diff` revealed the TypeScript build mirrors everything into `/home/node/app/dist` — logic-identical, reformatted. Rule derived: **every overlay COPYs to both the plain path and its dist/ twin.**
- **Overlay porting by diff:** pristine-image-base vs. our patched files. Two files ported unchanged; **pdfExport.controllers.js required a full re-pin** because upstream had migrated it to the new config/createFile style — deploying our old-vintage pin would have caused the exact crash-loop our own PATCHES.md warned about, in mirror image.
- **The boot crash and its diagnosis:** `ERR_MODULE_NOT_FOUND` on config.ts, crash-looping at "Load config." Root-caused by reading @coko/server's actual source from npm: the config loader roots at `dist/` **only when NODE_ENV === 'production'**. Our server ran in dev mode (for the GraphQL sandbox). One `fly secrets set NODE_ENV=production` fixed it. Crash happened pre-migration → database untouched → rollback would have been trivial.
- **Client bump revealed later to have silently not happened** — the Fly app's *stored* config pinned the old image and won over our flags. Lesson: `fly image show` after every client deploy; deploy with an explicit `-c fly.toml`.

## Part 4 — The spike: killing React #130 (afternoon)

- Built the local toolchain (Node 24 via nvm, yarn 4.9.2 via corepack), cut a **spike branch from the exact release tag**, ran the new **Vite dev server** against the live test server.
- Auth on localhost solved with the **token trick**: ORCID login always redirects to the configured client, so copy the JWT into localhost's Local Storage (or use the `/login?token=` route).
- **CORS see-saw discovered dead:** the new server accepts a comma-separated origin list — both fly client and localhost served simultaneously.
- Wrote **RelatedIdentifiersInput** (cloned from AuthorsInput's pattern), registered it in FormTemplate's `elements` map — **and Vite compiled it cleanly. React #130 never reproduced.** The old blocker died with the old build system.
- Added the field to **testclone3's** form (never gumpstation first) via a small **dry-run-by-default GraphQL script** using the form builder's own `updateFormElement` mutation. Rendered, saved, persisted.
- Along the way: discovered the form builder's "List of contributors" option is just a second AuthorsInput (always existed); and got the crucial correction that **the "test" stack IS Gump's production** — which retroactively justified every bit of production-grade caution and set the coupling rule below.

## Part 5 — Custom client in production (late afternoon)

- **The coupling rule, demonstrated live:** a form field naming a component couples that group's form to the client build. Testclone3's form crashed the deployed (stock) client the moment the field existed — the exact failure we were protecting gumpstation from. **Client deploys before form edits, always.**
- Built and deployed **our own client image** with upstream's `packages/client/Dockerfile-production` — after defeating the stored-config trap by saving, correcting, and **committing a canonical fly.toml** (`dockerfile = 'Dockerfile-production'` instead of the pinned old image). Build took ~64 seconds, not the feared 15 minutes.
- Verification pattern for client deploys: **grep the built bundle inside the machine** for a string unique to the new code — Vite tree-shakes, so a component that compiles but isn't *registered* silently vanishes from the bundle (this later caught the unregistered PublisherInput).

## Part 6 — Serializer Patches 3–5 (evening)

All server patches followed one ritual: **generate the patched file from the tag base + verified prior patches with anchor-asserted string replacement → Erin diffs against her repo copy → diff must show ONLY the new patch → eyeball → cp, commit, deploy, guards.**

- **Patch 3 — relatedIdentifiers passthrough:** form rows merge with legacy citation/$dois behavior. Proven in a live payload: old IsCitedBy + new form rows side by side. (Side quest: the publish may have minted a real DOI on Gump's prefix from testclone3 — sandbox status still to confirm.)
- **Patch 4 — contributors, publisher override, publicationYear:** `getFormContributors` (both nameTypes, ROR-vs-free-text by whether the value contains ror.org), `getPublisherWithOverride`, and `getPublicationYear` with the fallback chain explicit-year → **year of existing submission.datePublished** → current year. The datePublished chain meant NO new form field was needed for prior-year publishing — typing "2023" in the existing field just works.
- **Patch 5 — publisher object shape** (see the bug below).
- Payload proof: four contributor shapes correct in one publish — group Sponsor (legacy), ROR org with nameIdentifiers, free-text org with name only, personal with ORCID + ROR affiliation.

## Part 7 — Session A: the component architecture (evening)

Refactored to the target architecture in one pass:
- **`shared/dataciteFieldDefinitions.js`** — single schema module: all controlled vocabularies (relationTypes, contributorTypes, resourceTypeGeneral incl. 4.7's Poster/Presentation, etc.) and per-array field definitions. Every future DataCite array is just another export here.
- **`RepeatableFieldRows.jsx`** — one generic renderer: text / select / **ror** field types, `showIf` conditionals (powers the person/organization toggle), `createOptionPosition="first"` so free-text creation is always reachable above long ROR result lists.
- **ContributorsInput** and refactored **RelatedIdentifiersInput** as ~25-line wrappers. The **ror field type** reuses AuthorsInput's own SEARCH_ROR GraphQL query and async-creatable select: search the registry or keep free text, `{label, value}` convention matching the serializer's existing `includes('ror.org')` logic.
- **PublisherInput** — single-value ROR search (publisher is single by DataCite schema; contributor affiliation is single only by our simplification → Session B item).

**The best bug of the day:** PublisherInput's selection wouldn't stick. Root cause read straight from FormTemplate's generic onChange: it extracts `.value` from ANY object passed to it — flattening `{label, value}` to a bare string. Arrays are immune (no .value property), which is why every other component worked. Fix: store `{label, ror}` — a key the wrapper doesn't hijack — converting at the react-select boundary; serializer reads `raw.ror || raw.value`. **Rule: single-object component values must never use a `value` key.** (Worth mentioning in the eLife email — it's a sharp edge in their own wrapper.)

## What's live on gumpstation's production form right now

Contributors (person/org toggle, contributorType vocabulary, ROR search with free-text), Related identifiers (five fields, three DataCite vocabularies), Publisher (ROR search, empty = station), plus the pre-existing datePublished now driving publicationYear — all flowing through Patches 3–5 into DataCite on publish. Both git branches clean and pushed; canonical fly.toml tracked; all deploys guard-verified.

## The process patterns worth keeping (the real takeaway)

1. **Check upstream before building** — two of the day's three breakthroughs came from reading eLife's repo, not writing code.
2. **Empirical over assumed:** base files from the running image, never the repo or memory; diffs that must show only the intended change; bundle greps; dry-run-by-default scripts; guards after every deploy. Every one of these caught something real today.
3. **Prove on the throwaway, ship to production:** testclone3 absorbed every first attempt (and one real crash) so gumpstation never saw a broken state.
4. **Coupling rules beat cleverness:** client-before-form; both-paths COPYs; branch roles (config branch = server + recipes; spike branch = client; Vite serves whatever's checked out).
5. **When something "works everywhere else," the difference IS the diagnosis** (arrays vs. single objects in FormTemplate's onChange).

## Next session queue (in order)

1. Multi-affiliation contributor field (`isMulti` on the ror type + definition flag + serializer maps array)
2. End-to-end publisher payload proof (ROR-picked publisher → publish → full publisher object in payload)
3. Confirm testclone3's DataCite sandbox status / hide the possibly-real test DOI (10.60950/b97d743f-…); point testclone3 at sandbox
4. Bookkeeping sweep: Part 12 additions (NODE_ENV, dist/ twins, client build procedure, fly image show check, multi-origin CORS, bundle-grep, FormTemplate .value trap, branch roles); delete fly.toml relics; .Rhistory → gitignore; consider renaming the spike branch (it's not a spike anymore — it builds the production client)
5. The Ash/Vukile email — now describing a shipped system: parameterized field definitions on their own getAuthorFields pattern, working components, and the onChange flattening bug as a courtesy heads-up
6. Session B: funding references (multi-funder), dates, subjects mapping; then the long tail (titles, alternateIdentifiers, rights, geoLocations, relatedItems); then bake the completed form into station-master's seed

*One day. Planning question to production system. The recipes carry the how; this carries the why.*
