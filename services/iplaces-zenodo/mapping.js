/* ============================================================
   iPlaces record -> Zenodo draft metadata.

   Source of truth is the record's DOI metadata at DataCite (what the
   station registered), so funders, keywords, publisher, contributors,
   places, coverage dates, language, version and licence all come
   through, exactly as the DOI carries them. When the record has no DOI,
   or DataCite can't be read, the Kotahi submission is turned into the
   same DataCite shape (submissionToDatacite) and mapped the same way.

   Two outputs:
   - toRdm():    Zenodo's current records API (POST /api/records). It has
                 a place for nearly everything, including funders that are
                 not in Zenodo's grant list.
   - toLegacy(): Zenodo's older deposit API (POST /api/deposit/depositions),
                 used only if the records API refuses the draft. It has no
                 place for free-text funders or extra titles, so those go
                 into Additional notes.

   Left off on purpose (they describe the iPlaces article itself, not the
   files deposited next to it; copying them would make the Zenodo record
   claim to BE the article): the article's own dates of submission,
   acceptance and issue, its alternate identifiers (e.g. RAMS application
   IDs), its journal/issue, and relations such as IsPublishedIn, IsPartOf,
   HasPart, IsVersionOf. The Zenodo draft points back to the article with
   "is supplement to <iPlaces DOI>", and the article's DataCite record
   keeps all of those.
   ============================================================ */

/* ---------- small helpers ---------- */
const arr = v => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const str = v => (v == null ? "" : String(v).trim());
const lower = v => str(v).toLowerCase();
const bareDoi = v => str(v).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "");
const bareOrcid = v => str(v).replace(/^https?:\/\/orcid\.org\//i, "");
const bareRor = v => str(v).replace(/^https?:\/\/ror\.org\//i, "");
const uniqBy = (list, key) => {
  const seen = new Set();
  return list.filter(x => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const escapeHtml = s =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// DataCite descriptions are plain text (older records: JATS/HTML). Zenodo's
// description is HTML, so paragraphs become <p> and markup is not trusted.
// Only text that is clearly markup (has a closing tag or <br>) is
// stripped, so plain text such as "depth <10 m>" survives.
const looksLikeMarkup = s => /<\/[a-z]|<br\s*\/?>/i.test(s);
const stripTags = s =>
  !looksLikeMarkup(String(s)) ? String(s) : String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const toHtml = text => {
  const plain = stripTags(text).replace(/\r/g, "").trim();
  if (!plain) return "";
  return plain
    .split(/\n{2,}/)
    .map(p => "<p>" + escapeHtml(p.trim()).replace(/\n/g, "<br>") + "</p>")
    .join("");
};

/* ---------- vocabularies ---------- */

// DataCite resourceTypeGeneral -> Zenodo resource type id (used for the
// "is supplement to" link and for copied related identifiers).
const DATACITE_TO_ZENODO_TYPE = {
  Dataset: "dataset",
  Software: "software",
  ComputationalNotebook: "software",
  PhysicalObject: "physicalobject",
  Audiovisual: "video",
  Sound: "video",
  Image: "image",
  Event: "event",
  Model: "model",
  Workflow: "workflow",
  JournalArticle: "publication-article",
  Preprint: "publication-preprint",
  Book: "publication-book",
  BookChapter: "publication-section",
  Dissertation: "publication-thesis",
  Report: "publication-report",
  ConferencePaper: "publication-conferencepaper",
  ConferenceProceeding: "publication-conferenceproceeding",
  DataPaper: "publication-datapaper",
  Journal: "publication-journal",
  PeerReview: "publication-peerreview",
  OutputManagementPlan: "publication-datamanagementplan",
  Standard: "publication-standard",
  StudyRegistration: "publication-preprint",
  Text: "publication",
  Award: "other",
  Collection: "other",
  Instrument: "other",
  InteractiveResource: "other",
  Project: "other",
  Service: "other",
  Other: "other",
};
const zenodoType = rtg => DATACITE_TO_ZENODO_TYPE[str(rtg)] || "other";

// Zenodo contributor roles = DataCite contributorType, lower-cased.
const ZENODO_ROLES = new Set([
  "contactperson", "datacollector", "datacurator", "datamanager", "distributor",
  "editor", "hostinginstitution", "producer", "projectleader", "projectmanager",
  "projectmember", "registrationagency", "registrationauthority", "relatedperson",
  "researcher", "researchgroup", "rightsholder", "sponsor", "supervisor",
  "translator", "workpackageleader", "other",
]);
const zenodoRole = t => (ZENODO_ROLES.has(lower(t)) ? lower(t) : "other");

const TITLE_TYPES = {
  alternativetitle: "alternative-title",
  subtitle: "subtitle",
  translatedtitle: "translated-title",
  other: "other",
};

const DESCRIPTION_TYPES = {
  abstract: "abstract",
  methods: "methods",
  seriesinformation: "series-information",
  tableofcontents: "table-of-contents",
  technicalinfo: "technical-info",
  other: "other",
};

// Dates that describe the content (when/where data was collected, what
// period it covers). The article's own Submitted/Accepted/Issued/Updated/
// Available dates are not the deposit's dates and are left off.
const CONTENT_DATE_TYPES = { collected: "collected", coverage: "coverage", valid: "valid", other: "other", created: "created" };

// Relations that hold for the deposited files as much as for the article.
const COPIED_RELATIONS = new Set(["cites", "references", "isderivedfrom", "requires"]);

// Identifier schemes Zenodo accepts on related identifiers.
const ZENODO_ID_SCHEMES = new Set([
  "ark", "arxiv", "ads", "crossreffunderid", "cstr", "doi", "ean13", "eissn",
  "grid", "hal", "handle", "igsn", "isbn", "isni", "issn", "istc", "lissn",
  "lsid", "pmid", "purl", "rrid", "upc", "url", "urn", "wikidata",
]);
const zenodoScheme = t => {
  const s = lower(t).replace(/\s+/g, "");
  if (s === "bibcode") return "ads";
  return ZENODO_ID_SCHEMES.has(s) ? s : null;
};

// Zenodo wants ISO 639-3. DataCite usually carries ISO 639-1.
const LANG_639_1_TO_3 = {
  en: "eng", fr: "fra", ty: "tah", es: "spa", de: "deu", pt: "por", it: "ita",
  nl: "nld", ja: "jpn", zh: "zho", ko: "kor", ru: "rus", mi: "mri", sm: "smo",
  to: "ton", fj: "fij", id: "ind", ms: "msa", tl: "tgl", vi: "vie", ar: "ara",
  hi: "hin", da: "dan", sv: "swe", no: "nor", fi: "fin", pl: "pol", el: "ell",
  tr: "tur", he: "heb", la: "lat", ca: "cat", eu: "eus", ga: "gle", cy: "cym",
};
const zenodoLanguage = v => {
  const code = lower(v).split(/[-_]/)[0];
  if (/^[a-z]{3}$/.test(code)) return code;
  return LANG_639_1_TO_3[code] || null;
};

// Zenodo licence ids are lower-case SPDX ids. These are the ones iPlaces
// offers (plus a few common ones); anything else goes as a custom rights
// entry with its name and link, so nothing is lost.
const ZENODO_LICENSES = new Set([
  "cc-by-4.0", "cc-by-sa-4.0", "cc-by-nc-4.0", "cc-by-nc-sa-4.0", "cc-by-nd-4.0",
  "cc-by-nc-nd-4.0", "cc0-1.0", "mit", "apache-2.0", "cc-by-3.0", "cc-by-sa-3.0",
  "odc-by-1.0", "odbl-1.0", "pddl-1.0", "gpl-3.0-only", "bsd-3-clause",
]);

/* ---------- DataCite record pieces ---------- */

const publisherName = p => (p && typeof p === "object" ? str(p.name) : str(p));

const mainTitle = attrs => {
  const titles = arr(attrs.titles);
  const t = titles.find(x => x && !x.titleType) || titles[0];
  return t ? str(t.title) : "";
};

const nameParts = c => {
  let family = str(c.familyName);
  let given = str(c.givenName);
  if (!family && !given && str(c.name).includes(",")) {
    const [f, ...g] = str(c.name).split(",");
    family = f.trim();
    given = g.join(",").trim();
  }
  return { family, given };
};

const idsOf = c => arr(c.nameIdentifiers).filter(n => n && str(n.nameIdentifier));
const orcidOf = c => {
  const n = idsOf(c).find(x => lower(x.nameIdentifierScheme) === "orcid");
  return n ? bareOrcid(n.nameIdentifier) : "";
};
const rorOf = c => {
  const n = idsOf(c).find(x => lower(x.nameIdentifierScheme) === "ror");
  return n ? bareRor(n.nameIdentifier) : "";
};
const affiliationNames = c =>
  uniqBy(
    arr(c.affiliation)
      .map(a => (typeof a === "string" ? a : a && a.name))
      .map(str)
      .filter(Boolean),
    x => x.toLowerCase(),
  );

// A DataCite creator/contributor -> Zenodo person_or_org.
// A creator with no nameType (iPlaces more-than-human authors: a place or
// a being) has to be "personal" or "organizational" in Zenodo; it goes as
// organizational with its name, which keeps the name intact.
const isPersonal = c => {
  if (lower(c.nameType) === "personal") return true;
  if (lower(c.nameType) === "organizational") return false;
  return Boolean(str(c.familyName) || str(c.givenName) || orcidOf(c));
};

const rdmPersonOrOrg = c => {
  if (isPersonal(c)) {
    const { family, given } = nameParts(c);
    const orcid = orcidOf(c);
    return {
      type: "personal",
      family_name: family || str(c.name) || "Unknown",
      ...(given ? { given_name: given } : {}),
      ...(orcid ? { identifiers: [{ scheme: "orcid", identifier: orcid }] } : {}),
    };
  }
  const ror = rorOf(c);
  return {
    type: "organizational",
    name: str(c.name) || "Unknown",
    ...(ror ? { identifiers: [{ scheme: "ror", identifier: ror }] } : {}),
  };
};

const rdmAffiliations = c => affiliationNames(c).map(name => ({ name }));

const rdmCreators = attrs =>
  arr(attrs.creators)
    .filter(c => c && (str(c.name) || str(c.familyName) || str(c.givenName)))
    .map(c => {
      const affs = rdmAffiliations(c);
      return { person_or_org: rdmPersonOrOrg(c), ...(affs.length ? { affiliations: affs } : {}) };
    });

const rdmContributors = attrs =>
  arr(attrs.contributors)
    .filter(c => c && (str(c.name) || str(c.familyName) || str(c.givenName)))
    .map(c => {
      const affs = rdmAffiliations(c);
      return {
        person_or_org: rdmPersonOrOrg(c),
        role: { id: zenodoRole(c.contributorType) },
        ...(affs.length ? { affiliations: affs } : {}),
      };
    });

const subjectsOf = attrs =>
  uniqBy(
    arr(attrs.subjects).map(s => (typeof s === "string" ? s : s && s.subject)).map(str).filter(Boolean),
    x => x.toLowerCase(),
  );

const fundingOf = attrs =>
  arr(attrs.fundingReferences)
    .filter(f => f && str(f.funderName))
    .map(f => ({
      funderName: str(f.funderName),
      funderIdentifier: str(f.funderIdentifier),
      funderIdentifierType: str(f.funderIdentifierType),
      awardNumber: str(f.awardNumber),
      awardTitle: str(f.awardTitle),
      awardUri: str(f.awardUri),
    }));

const rdmFunding = attrs =>
  fundingOf(attrs).map(f => {
    const award =
      f.awardNumber || f.awardTitle
        ? {
            ...(f.awardNumber ? { number: f.awardNumber } : {}),
            ...(f.awardTitle ? { title: { en: f.awardTitle } } : {}),
            ...(/^https?:\/\//i.test(f.awardUri) ? { identifiers: [{ scheme: "url", identifier: f.awardUri }] } : {}),
          }
        : null;
    // Funder goes by name: Zenodo only takes an id from its own funder
    // list, and an id it doesn't know would bounce the field.
    return { funder: { name: f.funderName }, ...(award ? { award } : {}) };
  });

const rightsOf = attrs =>
  arr(attrs.rightsList).filter(r => r && (str(r.rights) || str(r.rightsIdentifier) || str(r.rightsUri)));

const licenceId = r => {
  const id = lower(r.rightsIdentifier);
  return ZENODO_LICENSES.has(id) ? id : null;
};

const rdmRights = attrs =>
  uniqBy(
    rightsOf(attrs).map(r => {
      const id = licenceId(r);
      if (id) return { id };
      const link = /^https?:\/\//i.test(str(r.rightsUri)) ? str(r.rightsUri) : null;
      return {
        title: { en: str(r.rights) || str(r.rightsIdentifier) || link },
        ...(link ? { link } : {}),
      };
    }),
    x => x.id || x.title.en,
  );

// "2026-01/2026-04" stays a range; "2026-03/" (open-ended) can't be sent
// as a range, so it goes as its start date with a note.
const splitDate = d => {
  const s = str(d);
  if (!s.includes("/")) return { date: s.slice(0, 10), open: false };
  const [a, b] = s.split("/").map(x => str(x).slice(0, 10));
  if (a && b) return { date: a === b ? a : `${a}/${b}`, start: a, end: b, open: false };
  return { date: a || b, start: a, end: b, open: true };
};

const contentDates = attrs =>
  arr(attrs.dates)
    .filter(d => d && str(d.date) && CONTENT_DATE_TYPES[lower(d.dateType)])
    .map(d => {
      const parts = splitDate(d.date);
      const info = str(d.dateInformation);
      const note = parts.open ? `${d.dateType} from ${parts.start || "?"} to ${parts.end || "present"}` : "";
      return { ...parts, type: CONTENT_DATE_TYPES[lower(d.dateType)], dateType: str(d.dateType), description: [info, note].filter(Boolean).join("; ") };
    })
    .filter(d => d.date);

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const geoOf = attrs =>
  arr(attrs.geoLocations)
    .filter(Boolean)
    .map(g => {
      const place = str(g.geoLocationPlace);
      const p = g.geoLocationPoint || {};
      const lat = num(p.pointLatitude);
      const lon = num(p.pointLongitude);
      const b = g.geoLocationBox || {};
      const w = num(b.westBoundLongitude), e = num(b.eastBoundLongitude);
      const s = num(b.southBoundLatitude), n = num(b.northBoundLatitude);
      const poly = arr(g.geoLocationPolygon)
        .flatMap(x => (Array.isArray(x) ? x : [x]))
        .map(x => x && x.polygonPoint)
        .filter(Boolean)
        .map(pt => [num(pt.pointLongitude), num(pt.pointLatitude)])
        .filter(([x, y]) => x != null && y != null);
      let geometry = null;
      if (lat != null && lon != null) geometry = { type: "Point", coordinates: [lon, lat] };
      else if ([w, e, s, n].every(v => v != null))
        geometry = { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
      else if (poly.length >= 4) geometry = { type: "Polygon", coordinates: [poly] };
      return { place, geometry, lat, lon };
    })
    .filter(g => g.place || g.geometry);

const copiedRelations = attrs =>
  arr(attrs.relatedIdentifiers)
    .filter(r => r && str(r.relatedIdentifier) && COPIED_RELATIONS.has(lower(r.relationType)))
    .map(r => ({
      identifier: lower(r.relatedIdentifierType) === "doi" ? bareDoi(r.relatedIdentifier) : str(r.relatedIdentifier),
      scheme: zenodoScheme(r.relatedIdentifierType),
      relation: lower(r.relationType),
      relationType: str(r.relationType),
      resourceType: r.resourceTypeGeneral ? zenodoType(r.resourceTypeGeneral) : null,
    }))
    .filter(r => r.scheme);

const descriptionsOf = attrs => {
  const all = arr(attrs.descriptions).filter(d => d && str(d.description));
  const abstract = all.find(d => lower(d.descriptionType) === "abstract") || null;
  const others = all.filter(d => d !== abstract);
  return { abstract, others };
};

const versionOf = attrs => str(attrs.version);
const languageOf = attrs => zenodoLanguage(attrs.language);

const today = () => new Date().toISOString().slice(0, 10);

/* ---------- Zenodo records API (InvenioRDM) ---------- */
function toRdm(attrs, { doi, resourceTypeGeneral } = {}) {
  const title = mainTitle(attrs) || "Untitled";
  const { abstract, others } = descriptionsOf(attrs);
  const creators = rdmCreators(attrs);
  const contributors = rdmContributors(attrs);
  const subjects = subjectsOf(attrs);
  const publisher = publisherName(attrs.publisher);
  const funding = rdmFunding(attrs);
  const rights = rdmRights(attrs);
  const dates = contentDates(attrs).map(d => ({
    date: d.date,
    type: { id: d.type },
    ...(d.description ? { description: d.description } : {}),
  }));
  const features = geoOf(attrs).map(g => ({
    ...(g.place ? { place: g.place } : {}),
    ...(g.geometry ? { geometry: g.geometry } : {}),
  }));
  const lang = languageOf(attrs);
  const version = versionOf(attrs);

  const additionalTitles = arr(attrs.titles)
    .filter(t => t && t.titleType && str(t.title) && str(t.title) !== title)
    .map(t => ({ title: str(t.title), type: { id: TITLE_TYPES[lower(t.titleType)] || "other" } }));

  const additionalDescriptions = others.map(d => ({
    description: toHtml(d.description),
    type: { id: DESCRIPTION_TYPES[lower(d.descriptionType)] || "other" },
  }));

  const rtg = resourceTypeGeneral || (attrs.types && attrs.types.resourceTypeGeneral);
  const related = [
    ...(doi
      ? [{ identifier: bareDoi(doi), scheme: "doi", relation_type: { id: "issupplementto" }, resource_type: { id: zenodoType(rtg) } }]
      : []),
    ...copiedRelations(attrs).map(r => ({
      identifier: r.identifier,
      scheme: r.scheme,
      relation_type: { id: r.relation },
      ...(r.resourceType ? { resource_type: { id: r.resourceType } } : {}),
    })),
  ];

  const metadata = {
    resource_type: { id: "dataset" }, // the deposit is the files; the depositor can change it
    title,
    publication_date: today(),
    creators: creators.length ? creators : [{ person_or_org: { type: "personal", family_name: "Unknown" } }],
    description: (abstract && toHtml(abstract.description)) || "<p>" + escapeHtml(title) + "</p>",
    ...(additionalTitles.length ? { additional_titles: additionalTitles } : {}),
    ...(additionalDescriptions.length ? { additional_descriptions: additionalDescriptions } : {}),
    ...(contributors.length ? { contributors } : {}),
    ...(subjects.length ? { subjects: subjects.map(subject => ({ subject })) } : {}),
    ...(publisher ? { publisher } : {}),
    ...(funding.length ? { funding } : {}),
    ...(rights.length ? { rights } : {}),
    ...(dates.length ? { dates } : {}),
    ...(features.length ? { locations: { features } } : {}),
    ...(lang ? { languages: [{ id: lang }] } : {}),
    ...(version ? { version } : {}),
    ...(related.length ? { related_identifiers: related } : {}),
  };

  return {
    metadata,
    files: { enabled: true },
    access: { record: "public", files: "public" },
  };
}

/* ---------- Zenodo deposit API (legacy, fallback only) ---------- */
function toLegacy(attrs, { doi, resourceTypeGeneral } = {}) {
  const title = mainTitle(attrs) || "Untitled";
  const { abstract, others } = descriptionsOf(attrs);

  const legacyPerson = c => {
    const personal = isPersonal(c);
    const { family, given } = nameParts(c);
    const name = personal ? [family || str(c.name), given].filter(Boolean).join(", ") : str(c.name);
    const orcid = orcidOf(c);
    const affs = affiliationNames(c);
    return {
      name: name || "Unknown",
      ...(orcid ? { orcid } : {}),
      ...(affs.length ? { affiliation: affs.join("; ") } : {}),
    };
  };

  const creators = arr(attrs.creators).filter(c => c && (str(c.name) || str(c.familyName))).map(legacyPerson);
  const contributors = arr(attrs.contributors)
    .filter(c => c && (str(c.name) || str(c.familyName)))
    .map(c => ({ ...legacyPerson(c), type: zenodoRole(c.contributorType) }));

  // The deposit API only takes grants from Zenodo's own list, so funders
  // are written out in Additional notes instead.
  const funderLines = fundingOf(attrs).map(f =>
    [f.funderName, f.awardNumber && `award ${f.awardNumber}`, f.awardTitle && `"${f.awardTitle}"`, f.awardUri]
      .filter(Boolean)
      .join(", "),
  );

  const rights = rightsOf(attrs);
  const licence = rights.map(licenceId).find(Boolean) || null;
  const otherRights = rights.filter(r => !licenceId(r));
  const extraTitles = arr(attrs.titles).filter(t => t && t.titleType && str(t.title) && str(t.title) !== title);

  const notes = [
    funderLines.length && "<p><strong>Funding</strong></p><ul>" + funderLines.map(l => "<li>" + escapeHtml(l) + "</li>").join("") + "</ul>",
    otherRights.length &&
      "<p><strong>Rights</strong></p><ul>" +
        otherRights.map(r => "<li>" + escapeHtml([str(r.rights), str(r.rightsUri)].filter(Boolean).join(": ")) + "</li>").join("") +
        "</ul>",
    extraTitles.length &&
      "<p><strong>Other titles</strong></p><ul>" + extraTitles.map(t => "<li>" + escapeHtml(`${t.titleType}: ${t.title}`) + "</li>").join("") + "</ul>",
    ...others.map(d => `<p><strong>${escapeHtml(d.descriptionType || "Other")}</strong></p>` + toHtml(d.description)),
  ].filter(Boolean);

  const rtg = resourceTypeGeneral || (attrs.types && attrs.types.resourceTypeGeneral);
  const related = [
    ...(doi ? [{ identifier: bareDoi(doi), relation: "isSupplementTo", resource_type: zenodoType(rtg) }] : []),
    ...copiedRelations(attrs).map(r => ({
      identifier: r.identifier,
      relation: r.relationType.charAt(0).toLowerCase() + r.relationType.slice(1),
      ...(r.resourceType ? { resource_type: r.resourceType } : {}),
    })),
  ];

  const dates = contentDates(attrs).map(d => ({
    type: d.dateType.charAt(0).toUpperCase() + d.dateType.slice(1),
    ...(d.start || d.end ? { ...(d.start ? { start: d.start } : {}), ...(d.end ? { end: d.end } : {}) } : { start: d.date, end: d.date }),
    ...(d.description ? { description: d.description } : {}),
  }));

  const locations = geoOf(attrs).map(g => ({
    place: g.place || "Location",
    ...(g.lat != null && g.lon != null ? { lat: g.lat, lon: g.lon } : {}),
  }));

  const subjects = subjectsOf(attrs);
  const publisher = publisherName(attrs.publisher);
  const lang = languageOf(attrs);
  const version = versionOf(attrs);

  const metadata = {
    upload_type: "dataset",
    title,
    creators: creators.length ? creators : [{ name: "Unknown" }],
    description: (abstract && toHtml(abstract.description)) || "<p>" + escapeHtml(title) + "</p>",
    // With no licence (e.g. Community terms (Local Contexts)) the deposit
    // API would stamp CC0 on an open dataset, so the files start
    // restricted and the depositor decides.
    access_right: licence ? "open" : "restricted",
    ...(licence ? { license: licence } : {}),
    ...(subjects.length ? { keywords: subjects } : {}),
    ...(publisher ? { imprint_publisher: publisher } : {}),
    ...(contributors.length ? { contributors } : {}),
    ...(dates.length ? { dates } : {}),
    ...(locations.length ? { locations } : {}),
    ...(lang ? { language: lang } : {}),
    ...(version ? { version } : {}),
    ...(notes.length ? { notes: notes.join("") } : {}),
    ...(related.length ? { related_identifiers: related } : {}),
  };
  return { metadata };
}

/* ---------- Kotahi submission -> DataCite-shaped attributes (fallback) ----------
   Same field names the Kotahi DataCite serializer reads
   (packages/server/services/publishing/datacite/fieldsTransformers.js). */
const SPDX_NAMES = {
  "cc-by-4.0": "Creative Commons Attribution 4.0 International",
  "cc-by-sa-4.0": "Creative Commons Attribution Share Alike 4.0 International",
  "cc-by-nc-4.0": "Creative Commons Attribution Non Commercial 4.0 International",
  "cc-by-nc-sa-4.0": "Creative Commons Attribution Non Commercial Share Alike 4.0 International",
  "cc-by-nd-4.0": "Creative Commons Attribution No Derivatives 4.0 International",
  "cc-by-nc-nd-4.0": "Creative Commons Attribution Non Commercial No Derivatives 4.0 International",
  "cc0-1.0": "Creative Commons Zero v1.0 Universal",
  mit: "MIT License",
  "apache-2.0": "Apache License 2.0",
};

const labelOf = v => (v && typeof v === "object" ? str(v.label) : str(v));
const affList = v => arr(v).map(labelOf).filter(Boolean).map(name => ({ name }));

function submissionToDatacite(sub = {}) {
  const humans = arr(sub.$authors)
    .filter(a => a && (a.firstName || a.lastName))
    .map(a => ({
      nameType: "Personal",
      givenName: [a.firstName, a.middleName].filter(Boolean).join(" "),
      familyName: str(a.lastName),
      ...(a.orcid ? { nameIdentifiers: [{ nameIdentifierScheme: "ORCID", nameIdentifier: bareOrcid(a.orcid) }] } : {}),
      affiliation: affList(a.ror),
    }));
  const mth = arr(sub.moreThanHumanAuthors)
    .filter(m => m && m.name)
    .map(m => ({ name: str(m.name), affiliation: affList(m.custodialAffiliation), position: m.position }));
  const creators = [
    ...mth.filter(m => m.position === "First"),
    ...humans,
    ...mth.filter(m => m.position !== "First"),
  ].map(({ position, ...c }) => c);

  const contributors = arr(sub.contributors)
    .filter(c => c && c.contributorType)
    .map(c => ({
      contributorType: c.contributorType,
      nameType: c.nameType,
      name: str(c.name) || [c.familyName, c.givenName].filter(Boolean).join(", "),
      givenName: str(c.givenName),
      familyName: str(c.familyName),
      ...(c.orcid ? { nameIdentifiers: [{ nameIdentifierScheme: "ORCID", nameIdentifier: bareOrcid(c.orcid) }] } : {}),
      affiliation: affList(c.affiliation),
    }))
    .filter(c => c.name || c.familyName);

  const funding = arr(sub.fundingReferences)
    .filter(r => r && r.funder && labelOf(r.funder))
    .map(r => ({ funderName: labelOf(r.funder), awardNumber: r.awardNumber, awardTitle: r.awardTitle, awardUri: r.awardUri }));
  if (!funding.length && sub.Funding)
    funding.push({ funderName: sub.Funding, awardNumber: sub.awardnumber, awardTitle: sub.awardtitle, awardUri: sub.awarduri });

  const subjects = [
    ...arr(sub.topics),
    ...(typeof sub.keywords === "string" ? sub.keywords.split(",") : arr(sub.keywords)),
  ]
    .map(labelOf)
    .filter(Boolean)
    .map(subject => ({ subject }));

  const rightsList = arr(sub.license)
    .map(str)
    .filter(v => v && lower(v) !== "localcontexts")
    .map(v =>
      SPDX_NAMES[lower(v)] ? { rights: SPDX_NAMES[lower(v)], rightsIdentifier: lower(v) } : { rights: v },
    );

  return {
    titles: [
      { title: str(sub.$title) },
      ...arr(sub.titles).filter(t => t && t.title).map(t => ({ title: t.title, titleType: t.titleType || "Other" })),
    ],
    creators,
    contributors,
    descriptions: sub.$abstract ? [{ descriptionType: "Abstract", description: stripTags(sub.$abstract) }] : [],
    subjects,
    fundingReferences: funding,
    rightsList,
    publisher: labelOf(sub.publisher),
    dates: sub.coverageDate ? [{ dateType: "Coverage", date: str(sub.coverageDate) }] : [],
    relatedIdentifiers: arr(sub.relatedIdentifiers),
    types: { resourceTypeGeneral: sub.resourcetype || sub.$resourcetype },
  };
}

module.exports = { toRdm, toLegacy, submissionToDatacite, bareDoi, stripTags, toHtml };
