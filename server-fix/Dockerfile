# iPlaces test server: prebuilt Coko image + the DataCite overlay patch + the
# Gump-clone seed overlays. Build context is the REPO ROOT (see
# scripts/deploy-iplaces-server.sh), so each COPY source is the real tracked
# file/folder -- the only source of truth.
# To bump the base image, change the tag here (see PATCHES.md "Update ritual").
#
# NOTE on the in-image paths: the server package roots at /home/node/app (no
# packages/server prefix). NEW in 2026.07.03-0: the TypeScript build mirrors
# the app into /home/node/app/dist (verified: dist copies are identical in
# logic, reformatted only), and we don't know which copy runs -- so EVERY
# overlay is COPYed to both the plain path and its dist/ twin.
FROM cokoapps/kotahi-server:2026.07.03-0

# (1) DataCite overlays (see PATCHES.md):
#   - fieldsTransformers.js (Patch 1): funderIdentifier uses the ROR id (funderid).
#   - index.js (Patch 2): schemaVersion = kernel-4; resourceTypeGeneral <-
#     submission.resourcetype; resourceType <- submission.ifother (omitted when
#     blank); checkPayload reads resourcetype not objectType.
COPY packages/server/services/publishing/datacite/fieldsTransformers.js \
     /home/node/app/services/publishing/datacite/fieldsTransformers.js
COPY packages/server/services/publishing/datacite/fieldsTransformers.js \
     /home/node/app/dist/services/publishing/datacite/fieldsTransformers.js
COPY packages/server/services/publishing/datacite/index.js \
     /home/node/app/services/publishing/datacite/index.js
COPY packages/server/services/publishing/datacite/index.js \
     /home/node/app/dist/services/publishing/datacite/index.js

# (2) Gump-clone seeds. A "station" is just a journal-type group; overlay
#     forms-journal/submit.json + the de-slugged cmsTemplateFiles tree.
#     Existing groups untouched (seedCmsFiles only seeds empty groups).
COPY packages/server/config/storage/forms-journal/submit.json \
     /home/node/app/config/storage/forms-journal/submit.json
COPY packages/server/config/storage/forms-journal/submit.json \
     /home/node/app/dist/config/storage/forms-journal/submit.json
COPY station-master/cmsTemplateFiles/ \
     /home/node/app/config/cmsTemplateFiles/
COPY station-master/cmsTemplateFiles/ \
     /home/node/app/dist/config/cmsTemplateFiles/

# (3) cmsUpload endpoint overlay: await + try/catch around uploadCms so upload
#     errors surface as HTTP 500 instead of vanishing.
COPY packages/server/api/rest/cmsUpload/endpoint.js \
     /home/node/app/api/rest/cmsUpload/endpoint.js
COPY packages/server/api/rest/cmsUpload/endpoint.js \
     /home/node/app/dist/api/rest/cmsUpload/endpoint.js

# (3b) Patch 12: manuscript controller refreshes Local Contexts at publish and
#      writes the fresh snapshot back to the manuscript (form + Flax + DOI from
#      one fetch). First patch to overlay this file -- see PATCHES.md.
COPY packages/server/controllers/manuscript/manuscript.controllers.js \
     /home/node/app/controllers/manuscript/manuscript.controllers.js
COPY packages/server/controllers/manuscript/manuscript.controllers.js \
     /home/node/app/dist/controllers/manuscript/manuscript.controllers.js

# (3c) brandName template variable: processData exposes
#      groupIdentity.brandName (fallback: group slug) to email templates as
#      {{ brandName }}; "Station Name" added to the variable picker. Makes
#      notification templates station-agnostic / clone-ready.
COPY packages/server/services/handlebars.service.js \
     /home/node/app/services/handlebars.service.js
COPY packages/server/services/handlebars.service.js \
     /home/node/app/dist/services/handlebars.service.js

# (4) pdfExport crash guard. RE-PINNED 2026-07 to the 2026.07.03-0 image's own
#     copy (config.get('pagedjs') / new createFile signature) + the 5-line
#     meta.source guard. Verified: diff vs image copy shows guard lines only.
#     Re-pin again after every base-image bump: see PATCHES.md "Update ritual".
COPY server-fix/overlays/controllers/pdfExport.controllers.js \
     /home/node/app/controllers/pdfExport.controllers.js
COPY server-fix/overlays/controllers/pdfExport.controllers.js \
     /home/node/app/dist/controllers/pdfExport.controllers.jsCOPY packages/server/permissions.js /home/node/app/permissions.js
COPY packages/server/permissions.js /home/node/app/dist/permissions.js
