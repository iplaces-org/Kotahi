# iPlaces test server: prebuilt Coko image + the single DataCite overlay patch.
# Build context is the REPO ROOT (see scripts/deploy-iplaces-server.sh), so the
# COPY source is the real tracked file -- the only source of truth for the patch.
# To bump the base image, change the tag here (see PATCHES.md "Update ritual").
FROM cokoapps/kotahi-server:2026.04.27-0
COPY packages/server/services/publishing/datacite/fieldsTransformers.js \
     /home/node/app/services/publishing/datacite/fieldsTransformers.js
