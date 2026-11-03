/* ============================================================
   iPlaces → Zenodo deposit service
   Per-user OAuth. Creates a prefilled DRAFT in the user's own
   Zenodo account, then redirects them to it to add files,
   review, and publish themselves.

   Flow:
     /zenodo/start?shortId=132&group=gumpstation
        -> redirect to Zenodo OAuth authorize
     /zenodo/callback?code=..&state=..
        -> exchange code for the USER's token
        -> read article metadata from Kotahi GraphQL
        -> POST /api/deposit/depositions (draft, prefilled)
        -> redirect user to draft.links.html (the edit form)

   The client secret + user token live only here, never on the page.
   Node 18+ (global fetch). Express.
   ============================================================ */

const express = require("express");
const crypto  = require("crypto");

/* ---------------- CONFIG (all via env / fly secrets) ---------------- */
const PORT             = process.env.PORT || 8080;
const ZENODO_BASE      = process.env.ZENODO_BASE || "https://sandbox.zenodo.org"; // prod: https://zenodo.org
const CLIENT_ID        = process.env.ZENODO_CLIENT_ID;
const CLIENT_SECRET    = process.env.ZENODO_CLIENT_SECRET;
const SERVICE_BASE_URL = process.env.SERVICE_BASE_URL;     // e.g. https://iplaces-zenodo.fly.dev (no trailing slash)
const KOTAHI_SERVER    = process.env.KOTAHI_SERVER;        // e.g. https://iplaces-test-server.fly.dev (server origin)
const STATE_SECRET     = process.env.STATE_SECRET;         // any long random string, for signing the OAuth state
const SCOPE            = "deposit:write";                  // add " deposit:actions" only if you later want the SERVER to publish
// Zenodo's anti-bot filter answers unnamed clients (Node's default "node") with
// an HTML "403 Forbidden ... unusual traffic" page (seen 2026-11-03), so every
// outgoing request names this service.
const USER_AGENT       = "iPlaces-Zenodo-Deposit/1.0 (+https://iplacesalliance.org)";
/* -------------------------------------------------------------------- */

/* ---------- outgoing HTTP: always send USER_AGENT, and fail with a readable
   message (status + start of body) when a JSON API answers with HTML ---------- */
function uaFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) } });
}
async function readJson(res, what) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`${what} answered HTTP ${res.status} with non-JSON: ${snippet}`);
  }
}

const REDIRECT_URI = SERVICE_BASE_URL + "/zenodo/callback";
const app = express();

/* ---------- signed, stateless OAuth state (survives multi-instance) ---------- */
const b64url  = b => Buffer.from(b).toString("base64url");
const unb64   = s => Buffer.from(s, "base64url").toString("utf8");
function signState(obj) {
  const body = b64url(JSON.stringify({ ...obj, ts: Date.now() }));
  const mac  = crypto.createHmac("sha256", STATE_SECRET).update(body).digest("base64url");
  return body + "." + mac;
}
function verifyState(state) {
  const [body, mac] = String(state || "").split(".");
  if (!body || !mac) throw new Error("malformed state");
  const expect = crypto.createHmac("sha256", STATE_SECRET).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) throw new Error("bad state signature");
  const obj = JSON.parse(unb64(body));
  if (Date.now() - obj.ts > 10 * 60 * 1000) throw new Error("state expired");
  return obj;
}

/* ---------- pull one article's submission from Kotahi GraphQL (reads are open) ---------- */
async function getArticle(group, shortId) {
  const safeGroup = String(group).replace(/[^a-z0-9_-]/gi, "");
  const query = `{ manuscriptsPublishedSinceDate(groupName: "${safeGroup}", startDate: "2000-01-01") { shortId submission } }`;
  const r = await uaFetch(KOTAHI_SERVER.replace(/\/$/, "") + "/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "apollo-require-preflight": "true" },
    body: JSON.stringify({ query }),
  });
  const j = await readJson(r, "Kotahi");
  if (j.errors) throw new Error("Kotahi GraphQL: " + JSON.stringify(j.errors));
  const list = (j.data && j.data.manuscriptsPublishedSinceDate) || [];
  const hit  = list.find(m => String(m.shortId) === String(shortId));
  if (!hit) throw new Error(`No published article with shortId ${shortId} in group ${safeGroup}`);
  return JSON.parse(hit.submission);   // submission is a JSON string
}

/* ---------- iPlaces (DataCite resourceTypeGeneral) -> Zenodo related_identifiers resource_type ----------
   The related-identifier resource_type uses Zenodo's OWN combined-type vocabulary
   ("publication-article", "image-figure", "dataset", "software", "other", ...),
   NOT the DataCite vocabulary and NOT the deposit upload_type list. Anything with
   no Zenodo equivalent falls back to "other".
   NOTE: the callback already echoes Zenodo's raw rejection on a 400, so if any one
   slug below is refused by your Zenodo instance, you'll see exactly which and can
   drop it to its top-level type (e.g. "publication") or "other". */
const DATACITE_TO_ZENODO_RELATED = {
  // direct, unambiguous
  Dataset:               "dataset",
  Software:              "software",
  ComputationalNotebook: "software",
  PhysicalObject:        "physicalobject",
  Audiovisual:           "video",
  Sound:                 "video",          // Zenodo files audio under its video/audio type
  Image:                 "image",          // Zenodo accepts the bare type, no subtype needed
  Event:                 "event",
  Model:                 "model",
  Workflow:              "workflow",
  JournalArticle:        "publication-article",
  Preprint:              "publication-preprint",
  Book:                  "publication-book",
  BookChapter:           "publication-section",
  Dissertation:          "publication-thesis",
  Report:                "publication-report",
  ConferencePaper:       "publication-conferencepaper",
  ConferenceProceeding:  "publication-conferenceproceeding",
  DataPaper:             "publication-datapaper",
  Journal:               "publication-journal",
  PeerReview:            "publication-peerreview",
  OutputManagementPlan:  "publication-datamanagementplan",
  Standard:              "publication-standard",
  StudyRegistration:     "publication-preprint",   // registered study filed under preprint in Zenodo
  Text:                  "publication",             // generic textual work, no subtype
  // no Zenodo equivalent -> "other" (the six you confirmed missing; fallback covers them anyway)
  Award:                 "other",
  Collection:            "other",
  Instrument:            "other",
  InteractiveResource:   "other",
  Project:               "other",          // <- the case you flagged
  Service:               "other",
  Other:                 "other",
};

/* ---------- map a Kotahi submission -> Zenodo deposit metadata ---------- */
function buildZenodoMetadata(sub) {
  const bareOrcid = s => String(s || "").replace(/^https?:\/\/orcid\.org\//i, "").trim();
  const creators = (sub.$authors || []).map(a => {
    const name = [a.lastName, [a.firstName, a.middleName].filter(Boolean).join(" ")]
                   .filter(Boolean).join(", ");
    const c = { name: name || "Unknown" };
    if (a.orcid) c.orcid = bareOrcid(a.orcid);
    return c;
  });

  const meta = {
    upload_type: "dataset",                         // best guess; the user can change it in the form
    title: sub.$title || "Untitled",
    creators: creators.length ? creators : [{ name: "Unknown" }],
    description: sub.$abstract || sub.$title || "Supplementary files.",
    access_right: "open",
    license: "cc-by-sa-4.0",                        // see note below — first thing to drop if you get a 400
  };

  if (sub.$doi) {
    // resource_type describes the iPlaces article being supplemented, so it
    // follows the article's own DataCite resourcetype (not a fixed "other").
    const rt = sub.resourcetype || sub.$resourcetype;
    meta.related_identifiers = [{
      identifier: sub.$doi,
      relation: "isSupplementTo",
      resource_type: DATACITE_TO_ZENODO_RELATED[rt] || "other",
    }];
  }
  return { metadata: meta };
}

/* ---------- routes ---------- */
app.get("/health", (_req, res) => res.send("ok"));

app.get("/zenodo/start", (req, res) => {
  const { shortId, group } = req.query;
  if (!shortId || !group) return res.status(400).send("Missing shortId or group.");
  const state = signState({ shortId: String(shortId), group: String(group) });
  const url = new URL(ZENODO_BASE + "/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/zenodo/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).type("text/plain").send("Zenodo authorization denied: " + error);
    const { shortId, group } = verifyState(state);

    // 1. exchange code for the USER's access token
    const tokRes = await uaFetch(ZENODO_BASE + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tok = await readJson(tokRes, "Zenodo token endpoint");
    if (!tokRes.ok || !tok.access_token) {
      console.error("token exchange failed", tokRes.status, JSON.stringify(tok));
      return res.status(502).type("text/plain").send("Token exchange failed: " + JSON.stringify(tok));
    }
    const userToken = tok.access_token;   // used once, below; never stored

    // 2. metadata from Kotahi
    const submission = await getArticle(group, shortId);
    const payload    = buildZenodoMetadata(submission);

    // 3. create the draft in the USER's account
    const depRes = await uaFetch(ZENODO_BASE + "/api/deposit/depositions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + userToken,
      },
      body: JSON.stringify(payload),
    });
    const dep = await readJson(depRes, "Zenodo deposit API");
    if (!depRes.ok) {
      console.error("draft rejected", depRes.status, JSON.stringify(dep));
      // surface the RAW Zenodo error so you can see exactly which field bounced
      return res.status(502).send(
        "<h3>Zenodo rejected the draft</h3><pre>" +
        JSON.stringify(dep, null, 2).replace(/</g, "&lt;") +
        "</pre><p>Sent metadata:</p><pre>" +
        JSON.stringify(payload, null, 2).replace(/</g, "&lt;") + "</pre>"
      );
    }

    // 4. send the user to their prefilled, editable draft
    const editUrl = (dep.links && dep.links.html) || (ZENODO_BASE + "/uploads/" + dep.id);
    res.redirect(editUrl);
  } catch (e) {
    console.error("deposit flow error:", e.message);
    res.status(500).type("text/plain").send("Deposit flow error: " + e.message);
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`zenodo deposit service on :${PORT} (${ZENODO_BASE})`));
