# iplaces-zenodo

The "Add files to Zenodo" button on every station's article page
(`station-master/cmsTemplateFiles/layouts/_partials/side.njk`) links here. The
service signs the depositor in to their own Zenodo account (OAuth, scope
`deposit:write`: it can create and edit drafts, never publish), reads the
published record from Kotahi, and creates a prefilled draft in their account.
The depositor's Zenodo key is used once and never stored.

Source copied from the running Fly app on 2026-11-03 (it was not in any repo
before then).

## Settings (Fly secrets on iplaces-zenodo)

| Name | What |
|---|---|
| `ZENODO_BASE` | `https://zenodo.org` (code defaults to sandbox if unset) |
| `ZENODO_CLIENT_ID`, `ZENODO_CLIENT_SECRET` | the Zenodo OAuth app (zenodo.org → Account → Applications) |
| `STATE_SECRET` | random string that signs the 10-minute OAuth state |
| `KOTAHI_SERVER` | Kotahi server origin, e.g. `https://api.iplacesalliance.org` |
| `SERVICE_BASE_URL` | `https://iplaces-zenodo.fly.dev` (the callback URL registered in the Zenodo app is this + `/zenodo/callback`) |

## What goes into the Zenodo draft (mapping.js)

The draft is filled from the record's DOI metadata at DataCite (public API,
no login; test DOIs from api.test.datacite.org), so it carries what the
station registered: title and other titles, creators (ORCIDs,
affiliations), contributors with their roles, abstract and other
descriptions, keywords and topics, publisher, funders and awards,
licence and other rights (Local Contexts labels and notices as links),
coverage and collection dates, places with coordinates, language and
version, plus "is supplement to" the iPlaces DOI and any Cites /
References / IsDerivedFrom / Requires links. If the record has no DOI or
DataCite can't be read, the Kotahi submission is mapped the same way.

Left off on purpose, because they describe the article and not the files:
the article's submitted/accepted/issued dates, alternate identifiers
(RAMS application IDs), journal and issue, and relations such as
IsPublishedIn, IsPartOf, HasPart.

The draft is created with Zenodo's records API (`/api/records`). If Zenodo
refuses that, the older deposit API is used; it has no place for
free-text funders, so they are written into Additional notes there.

Tests (no network): `node --test services/iplaces-zenodo/test/mapping.test.js`

The service holds no Kotahi signing key and no Kotahi user, so Kotahi key
rotations and user clean-ups don't affect it.

## Deploy

From this folder: `fly deploy -a iplaces-zenodo`. Check: open
`https://iplaces-zenodo.fly.dev/health` (prints `ok`), then click "Add files to
Zenodo" on any published record.

Rollback: `fly releases -a iplaces-zenodo --image | head -4`, then
`fly deploy -a iplaces-zenodo --image <previous image>`.

## Known trap

Zenodo's anti-bot filter answers unnamed clients with an HTML "403 Forbidden ...
unusual traffic" page. Every outgoing request therefore sends
`User-Agent: iPlaces-Zenodo-Deposit/1.0 (+https://iplacesalliance.org)`.
Failures are logged (`fly logs -a iplaces-zenodo`) and shown as plain text.
