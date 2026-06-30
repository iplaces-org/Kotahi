# iPlaces test server: prebuilt Coko image + the DataCite overlay patch + the
# Gump-clone seed overlays. Build context is the REPO ROOT (see
# scripts/deploy-iplaces-server.sh), so each COPY source is the real tracked
# file/folder -- the only source of truth.
# To bump the base image, change the tag here (see PATCHES.md "Update ritual").
#
# NOTE on the in-image paths below: the prebuilt cokoapps/kotahi-server image
# roots the server package directly at /home/node/app (NOT under
# packages/server). Proven by the DataCite patch landing at
# /home/node/app/services/... and that overlay's guard passing in-container.
# Verify once before a bake: fly ssh console --app iplaces-test-server \
#   -C "ls /home/node/app/config /home/node/app/config/storage".
FROM cokoapps/kotahi-server:2026.04.27-0

# (1) DataCite overlays (see PATCHES.md):
#   - fieldsTransformers.js (Patch 1): funderIdentifier uses the ROR id (funderid).
#   - index.js (Patch 2): schemaVersion = kernel-4 so DataCite validates against
#     4.6 and accepts resourceTypeGeneral values like "Project" (otherwise coerced
#     to "Other"); resourceTypeGeneral <- submission.resourcetype and resourceType
#     <- submission.ifother (omitted when blank); objectType is never used.
COPY packages/server/services/publishing/datacite/fieldsTransformers.js \
     /home/node/app/services/publishing/datacite/fieldsTransformers.js
COPY packages/server/services/publishing/datacite/index.js \
     /home/node/app/services/publishing/datacite/index.js

# (2) Gump-clone seeds. A "station" is just a journal-type group (exactly how
#     Gump itself is defined: gumpstation:journal) -- so we DON'T invent a new
#     instance type (the compiled client's config-manager enum only allows
#     preprint1/preprint2/prc/journal; a custom "station" instanceName makes the
#     client reject the config and the dashboard fails to render). Instead:
#       (a) overlay forms-journal/submit.json with Gump's (sanitized, schema-
#           valid) submission form, so every new :journal group seeds Gump's form;
#       (b) overlay cmsTemplateFiles -- the single shared, de-slugged Gump CMS
#           look tree, seeded for any new group. Existing groups are untouched
#           (seedCmsFiles only seeds groups with no CMS folder yet).
COPY packages/server/config/storage/forms-journal/submit.json \
     /home/node/app/config/storage/forms-journal/submit.json
COPY station-master/cmsTemplateFiles/ \
     /home/node/app/config/cmsTemplateFiles/

# (3) cmsUpload endpoint overlay. Same flattened path convention as the DataCite
#     overlay above: the prebuilt image drops the packages/server/ prefix, so
#     packages/server/api/... lands at /home/node/app/api/...
COPY packages/server/api/rest/cmsUpload/endpoint.js \
     /home/node/app/api/rest/cmsUpload/endpoint.js
