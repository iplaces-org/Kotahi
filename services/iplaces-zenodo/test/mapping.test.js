/* Run: node --test services/iplaces-zenodo/test/ (no network, no npm install) */
const test = require("node:test");
const assert = require("node:assert");
const { toRdm, toLegacy, submissionToDatacite } = require("../mapping");

// Shaped like GET https://api.datacite.org/dois/<doi>?publisher=true&affiliation=true
const attrs = {
  doi: "10.60950/49ea2494-d39e-4d1c-9675-6ebb202ccf6e",
  titles: [{ title: "Coral survey, Cook's Bay" }, { title: "Relevé corallien", titleType: "TranslatedTitle" }],
  creators: [
    { name: "Moorea Reef", affiliation: [] },
    {
      name: "Davies, Neil", nameType: "Personal", givenName: "Neil", familyName: "Davies",
      nameIdentifiers: [{ nameIdentifier: "https://orcid.org/0000-0001-8085-5014", nameIdentifierScheme: "ORCID" }],
      affiliation: [{ name: "UC Berkeley", affiliationIdentifier: "https://ror.org/01an7q238", affiliationIdentifierScheme: "ROR" }],
    },
  ],
  publisher: { name: "UC Berkeley Gump South Pacific Research Station", publisherIdentifier: "https://ror.org/01an7q238" },
  contributors: [{ name: "UC Berkeley Gump South Pacific Research Station", nameType: "Organizational", contributorType: "Sponsor", affiliation: [] }],
  subjects: [{ subject: "Ecology" }, { subject: "coral" }, { subject: "Coral" }],
  fundingReferences: [
    { funderName: "National Science Foundation", funderIdentifier: "https://ror.org/021nxhr62", funderIdentifierType: "ROR", awardNumber: "OCE-1637396", awardTitle: "MCR LTER", awardUri: "https://www.nsf.gov/awardsearch/showAward?AWD_ID=1637396" },
    { funderName: "Gordon and Betty Moore Foundation" },
  ],
  dates: [
    { date: "2026-11-14", dateType: "Issued" },
    { date: "2026-11-01T00:00:00Z", dateType: "Accepted" },
    { date: "2026-01/2026-04", dateType: "Coverage" },
    { date: "2026-03/", dateType: "Collected" },
  ],
  language: "en",
  version: "2",
  types: { resourceTypeGeneral: "Project", resourceType: "Project" },
  relatedIdentifiers: [
    { relatedIdentifier: "10.5281/zenodo.123", relatedIdentifierType: "DOI", relationType: "References", resourceTypeGeneral: "Dataset" },
    { relatedIdentifier: "https://doi.org/10.60950/journal", relatedIdentifierType: "DOI", relationType: "IsPublishedIn" },
  ],
  rightsList: [
    { rights: "Creative Commons Attribution 4.0 International", rightsUri: "https://creativecommons.org/licenses/by/4.0/legalcode", rightsIdentifier: "cc-by-4.0", rightsIdentifierScheme: "SPDX" },
    { rights: "BC Provenance (BC P)", rightsUri: "https://localcontexts.org/label/bc-provenance/" },
  ],
  descriptions: [
    { description: "Line one.\n\nLine <two> & more.", descriptionType: "Abstract" },
    { description: "Transects at 10 m.", descriptionType: "Methods" },
  ],
  geoLocations: [
    { geoLocationPlace: "Mo'orea", geoLocationPoint: { pointLatitude: "-17.49", pointLongitude: "-149.83" } },
    { geoLocationBox: { westBoundLongitude: -150, eastBoundLongitude: -149, southBoundLatitude: -18, northBoundLatitude: -17 } },
  ],
};

test("records API: everything with a place in Zenodo comes through", () => {
  const { metadata: m, files, access } = toRdm(attrs, { doi: attrs.doi });
  assert.deepStrictEqual(files, { enabled: true });
  assert.strictEqual(access.files, "public");
  assert.strictEqual(m.title, "Coral survey, Cook's Bay");
  assert.deepStrictEqual(m.additional_titles, [{ title: "Relevé corallien", type: { id: "translated-title" } }]);
  assert.strictEqual(m.publisher, "UC Berkeley Gump South Pacific Research Station");
  assert.deepStrictEqual(m.subjects, [{ subject: "Ecology" }, { subject: "coral" }]);
  assert.deepStrictEqual(m.funding, [
    { funder: { name: "National Science Foundation" }, award: { number: "OCE-1637396", title: { en: "MCR LTER" }, identifiers: [{ scheme: "url", identifier: "https://www.nsf.gov/awardsearch/showAward?AWD_ID=1637396" }] } },
    { funder: { name: "Gordon and Betty Moore Foundation" } },
  ]);
  assert.deepStrictEqual(m.creators[0], { person_or_org: { type: "organizational", name: "Moorea Reef" } });
  assert.deepStrictEqual(m.creators[1], {
    person_or_org: { type: "personal", family_name: "Davies", given_name: "Neil", identifiers: [{ scheme: "orcid", identifier: "0000-0001-8085-5014" }] },
    affiliations: [{ name: "UC Berkeley" }],
  });
  assert.strictEqual(m.contributors[0].role.id, "sponsor");
  assert.deepStrictEqual(m.rights, [
    { id: "cc-by-4.0" },
    { title: { en: "BC Provenance (BC P)" }, link: "https://localcontexts.org/label/bc-provenance/" },
  ]);
  assert.deepStrictEqual(m.dates, [
    { date: "2026-01/2026-04", type: { id: "coverage" } },
    { date: "2026-03", type: { id: "collected" }, description: "Collected from 2026-03 to present" },
  ]);
  assert.deepStrictEqual(m.locations.features[0], { place: "Mo'orea", geometry: { type: "Point", coordinates: [-149.83, -17.49] } });
  assert.strictEqual(m.locations.features[1].geometry.type, "Polygon");
  assert.deepStrictEqual(m.languages, [{ id: "eng" }]);
  assert.strictEqual(m.version, "2");
  assert.strictEqual(m.description, "<p>Line one.</p><p>Line &lt;two&gt; &amp; more.</p>");
  assert.deepStrictEqual(m.additional_descriptions, [{ description: "<p>Transects at 10 m.</p>", type: { id: "methods" } }]);
  assert.deepStrictEqual(m.related_identifiers, [
    { identifier: attrs.doi, scheme: "doi", relation_type: { id: "issupplementto" }, resource_type: { id: "other" } },
    { identifier: "10.5281/zenodo.123", scheme: "doi", relation_type: { id: "references" }, resource_type: { id: "dataset" } },
  ]);
});

test("deposit API fallback: keywords, publisher, funders (in notes)", () => {
  const { metadata: m } = toLegacy(attrs, { doi: attrs.doi });
  assert.deepStrictEqual(m.keywords, ["Ecology", "coral"]);
  assert.strictEqual(m.imprint_publisher, "UC Berkeley Gump South Pacific Research Station");
  assert.strictEqual(m.license, "cc-by-4.0");
  assert.strictEqual(m.access_right, "open");
  assert.match(m.notes, /National Science Foundation, award OCE-1637396/);
  assert.match(m.notes, /Gordon and Betty Moore Foundation/);
  assert.match(m.notes, /BC Provenance/);
  assert.deepStrictEqual(m.creators[1], { name: "Davies, Neil", orcid: "0000-0001-8085-5014", affiliation: "UC Berkeley" });
  assert.deepStrictEqual(m.contributors[0].type, "sponsor");
  assert.deepStrictEqual(m.dates[0], { type: "Coverage", start: "2026-01", end: "2026-04" });
  assert.deepStrictEqual(m.locations[0], { place: "Mo'orea", lat: -17.49, lon: -149.83 });
  assert.strictEqual(m.language, "eng");
  assert.strictEqual(m.related_identifiers[0].relation, "isSupplementTo");
});

test("community terms (no licence): no licence invented", () => {
  const lc = { ...attrs, rightsList: [{ rights: "TK Notice", rightsUri: "https://localcontexts.org/notice/tk-notice/" }] };
  assert.ok(!toRdm(lc).metadata.rights.some(r => r.id));
  const legacy = toLegacy(lc).metadata;
  assert.strictEqual(legacy.license, undefined);
  assert.strictEqual(legacy.access_right, "restricted");
});

test("no DOI: Kotahi submission is mapped the same way", () => {
  const sub = {
    $title: "Reef notes",
    $abstract: "<p>Ramassage de d&#xE9;chets</p>",
    $authors: [{ firstName: "Jane", lastName: "Doe", orcid: "https://orcid.org/0000-0002-0000-0000", ror: [{ label: "Tetiaroa Society", value: "https://ror.org/04p8xrf95" }] }],
    topics: ["Science"],
    keywords: "coral, reef",
    fundingReferences: [{ funder: { label: "NSF", value: "https://ror.org/021nxhr62" }, awardNumber: "1" }],
    license: "CC-BY-4.0",
    coverageDate: "2026-01/2026-04",
  };
  const m = toRdm(submissionToDatacite(sub)).metadata;
  assert.strictEqual(m.description, "<p>Ramassage de déchets</p>");
  assert.deepStrictEqual(m.subjects.map(s => s.subject), ["Science", "coral", "reef"]);
  assert.deepStrictEqual(m.funding, [{ funder: { name: "NSF" }, award: { number: "1" } }]);
  assert.deepStrictEqual(m.rights, [{ id: "cc-by-4.0" }]);
  assert.strictEqual(m.creators[0].affiliations[0].name, "Tetiaroa Society");
  assert.strictEqual(m.related_identifiers, undefined);
});
