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
        -> read the record from Kotahi GraphQL, and its DOI metadata
           from DataCite (mapping.js)
        -> POST /api/records (draft, prefilled); if Zenodo refuses,
           POST /api/deposit/depositions
        -> redirect user to the draft's edit form

   The client secret + user token live only here, never on the page.
   Node 18+ (global fetch). Express.
   ============================================================ */

const express = require("express");
const crypto  = require("crypto");
const { toRdm, toLegacy, submissionToDatacite, bareDoi } = require("./mapping");

/* ---------------- CONFIG (all via env / fly secrets) ---------------- */
const PORT             = process.env.PORT || 8080;
const ZENODO_BASE      = process.env.ZENODO_BASE || "https://sandbox.zenodo.org"; // prod: https://zenodo.org
const CLIENT_ID        = process.env.ZENODO_CLIENT_ID;
const CLIENT_SECRET    = process.env.ZENODO_CLIENT_SECRET;
const SERVICE_BASE_URL = process.env.SERVICE_BASE_URL;     // e.g. https://iplaces-zenodo.fly.dev (no trailing slash)
const KOTAHI_SERVER    = process.env.KOTAHI_SERVER;        // e.g. https://iplaces-test-server.fly.dev (server origin)
const STATE_SECRET     = process.env.STATE_SECRET;         // any long random string, for signing the OAuth state
const DATACITE_API      = process.env.DATACITE_API || "https://api.datacite.org";           // public REST API, no login
const DATACITE_TEST_API = process.env.DATACITE_TEST_API || "https://api.test.datacite.org"; // test DOIs
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

/* ---------- the record's DOI metadata at DataCite (public, no login) ----------
   This is what the station registered, so the Zenodo draft carries the
   same funders, keywords, publisher, contributors, places and licence.
   Test DOIs ($doiIsTest, or the station in test mode) live on DataCite's
   test server. Returns null when there is no DOI or DataCite can't be
   read; the caller then maps the Kotahi submission instead. */
async function getDataciteAttributes(sub) {
  const doi = bareDoi(sub.$doi);
  if (!doi) return null;
  const bases = sub.$doiIsTest ? [DATACITE_TEST_API] : [DATACITE_API, DATACITE_TEST_API];
  for (const base of bases) {
    try {
      const r = await uaFetch(`${base}/dois/${encodeURIComponent(doi)}?publisher=true&affiliation=true`, {
        headers: { Accept: "application/vnd.api+json" },
      });
      if (r.status === 404) continue;
      const j = await readJson(r, "DataCite");
      if (!r.ok || !j.data || !j.data.attributes) throw new Error(`HTTP ${r.status}`);
      return j.data.attributes;
    } catch (e) {
      console.error(`DataCite read failed for ${doi} at ${base}:`, e.message);
    }
  }
  return null;
}

/* ---------- create the draft in the USER's account ----------
   First Zenodo's records API, which has a place for nearly every DataCite
   field (free-text funders included). If Zenodo refuses that, the older
   deposit API, which takes less (funders go into Additional notes).
   Returns the URL of the draft's edit page. */
async function createDraft(userToken, attrs, ctx) {
  const auth = { "Content-Type": "application/json", Authorization: "Bearer " + userToken };

  const rdm = toRdm(attrs, ctx);
  try {
    const r = await uaFetch(ZENODO_BASE + "/api/records", { method: "POST", headers: auth, body: JSON.stringify(rdm) });
    const j = await readJson(r, "Zenodo records API");
    if (r.ok && j.id) {
      // A draft is saved even when some fields fail Zenodo's checks; those
      // fields are listed here and the depositor sees them in the form.
      if (Array.isArray(j.errors) && j.errors.length)
        console.error("draft saved with field errors", j.id, JSON.stringify(j.errors));
      return (j.links && j.links.self_html) || ZENODO_BASE + "/uploads/" + j.id;
    }
    console.error("records API refused the draft", r.status, JSON.stringify(j));
  } catch (e) {
    console.error("records API failed:", e.message);
  }

  const legacy = toLegacy(attrs, ctx);
  const depRes = await uaFetch(ZENODO_BASE + "/api/deposit/depositions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(legacy),
  });
  const dep = await readJson(depRes, "Zenodo deposit API");
  if (!depRes.ok) {
    console.error("draft rejected", depRes.status, JSON.stringify(dep));
    const err = new Error("Zenodo rejected the draft");
    err.html =
      "<h3>Zenodo rejected the draft</h3><pre>" +
      JSON.stringify(dep, null, 2).replace(/</g, "&lt;") +
      "</pre><p>Sent metadata:</p><pre>" +
      JSON.stringify(legacy, null, 2).replace(/</g, "&lt;") + "</pre>";
    throw err;
  }
  return (dep.links && dep.links.html) || ZENODO_BASE + "/uploads/" + dep.id;
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

    // 2. metadata: the record's DOI at DataCite, else the Kotahi submission
    const submission = await getArticle(group, shortId);
    const fromDatacite = await getDataciteAttributes(submission);
    const attrs = fromDatacite || submissionToDatacite(submission);
    const ctx = {
      doi: submission.$doi,
      resourceTypeGeneral: (attrs.types && attrs.types.resourceTypeGeneral) || submission.resourcetype || submission.$resourcetype,
    };
    console.log(`draft for ${group}/${shortId} from ${fromDatacite ? "DataCite" : "Kotahi submission"}`);

    // 3. create the draft in the USER's account
    let editUrl;
    try {
      editUrl = await createDraft(userToken, attrs, ctx);
    } catch (e) {
      if (e.html) return res.status(502).send(e.html);
      throw e;
    }

    // 4. send the user to their prefilled, editable draft
    res.redirect(editUrl);
  } catch (e) {
    console.error("deposit flow error:", e.message);
    res.status(500).type("text/plain").send("Deposit flow error: " + e.message);
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`zenodo deposit service on :${PORT} (${ZENODO_BASE})`));
