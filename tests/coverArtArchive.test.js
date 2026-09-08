const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCoverArtResolver,
  extractBarcodes,
  extractMusicBrainzReferences,
  normalizeIdentityText,
} = require("../lib/coverArtArchive");

const GROUP = "11111111-1111-4111-8111-111111111111";
const GROUP_TWO = "33333333-3333-4333-8333-333333333333";
const RELEASE = "22222222-2222-4222-8222-222222222222";
const RELEASE_TWO = "44444444-4444-4444-8444-444444444444";
const RELEASE_THREE = "55555555-5555-4555-8555-555555555555";
const BARCODE = "012345678905";

function response(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    async json() { return data; },
  };
}

function caaGroupData({ release = RELEASE, image = 12, thumbnail = "https://example.invalid/500.jpg", approved = true, front = true } = {}) {
  return {
    releases: release ? [{ id: release }] : [],
    images: [{ approved, front, image, thumbnails: thumbnail ? { "500": thumbnail } : {} }],
  };
}

function fakeNetwork(routes) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers });
    const route = routes.find((candidate) => candidate.match(url, options));
    if (!route) throw new Error(`unexpected network request: ${options.method} ${url}`);
    return typeof route.result === "function" ? route.result(url, options, calls) : route.result;
  };
  return { calls, fetchFn };
}

function fixedClock() {
  return new Date("2026-08-26T12:00:00.000Z");
}

test("extracts only valid canonical MusicBrainz identities and ignores arbitrary hosts", () => {
  const extracted = extractMusicBrainzReferences({
    externalReferences: [
      { provider: "musicbrainz", entityType: "release-group", externalId: GROUP },
      { provider: "other", entityType: "release", externalId: RELEASE, url: `https://musicbrainz.org/release/${RELEASE}` },
    ],
    supportingSources: [
      { url: `https://musicbrainz.org/release-group/${GROUP}/?utm_source=test` },
      { url: `https://evil.example/musicbrainz/release/${GROUP}` },
    ],
  });
  assert.deepEqual(extracted.releaseGroupMbids, [GROUP]);
  assert.deepEqual(extracted.releaseMbids, [RELEASE]);
  assert.equal(extracted.invalid, false);
  assert.equal(normalizeIdentityText("Beyoncé — Live!"), "beyonce live");
  assert.deepEqual(extractBarcodes({
    externalReferences: [{ provider: "barcode", entityType: "release", externalId: "0123-4567-8905" }],
  }), { barcodes: [BARCODE], invalid: false });
});

test("resolves a release-group reference, selecting its CAA release and requiring a 500 thumbnail", async () => {
  const network = fakeNetwork([
    { match: (url, options) => options.method === "GET" && url === `https://coverartarchive.org/release-group/${GROUP}`, result: response(caaGroupData({ image: "12" })) },
    { match: (url, options) => options.method === "HEAD" && url === `https://coverartarchive.org/release/${RELEASE}/front-500`, result: response(null, 200, { "content-type": "image/jpeg" }) },
  ]);
  const resolver = createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock, musicBrainzIntervalMs: 0 });
  const outcome = await resolver.resolve({
    title: "A record",
    artistDisplayName: "An artist",
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP }],
  });

  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.cover, `https://coverartarchive.org/release/${RELEASE}/front-500`);
  assert.deepEqual(outcome.provenance, {
    source: "cover-art-archive",
    resolutionMethod: "release-group-reference",
    method: "release-group",
    releaseGroupMbid: GROUP,
    releaseMbid: RELEASE,
    imageId: 12,
    size: 500,
    canonicalUrl: `https://coverartarchive.org/release/${RELEASE}/front-500`,
    verifiedAt: "2026-08-26T12:00:00.000Z",
  });
  assert.equal(network.calls.length, 2);
  assert.equal(network.calls[1].method, "HEAD");
});

test("one release-group identity takes precedence over multiple edition references", async () => {
  const network = fakeNetwork([
    { match: (url, options) => options.method === "GET" && url === `https://coverartarchive.org/release-group/${GROUP}`, result: response(caaGroupData()) },
    { match: (url, options) => options.method === "HEAD" && url === `https://coverartarchive.org/release/${RELEASE}/front-500`, result: response(null, 200, { "content-type": "image/jpeg" }) },
  ]);
  const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({
    externalReferences: [
      { provider: "musicbrainz", entityType: "release-group", externalId: GROUP },
      { provider: "musicbrainz", entityType: "release", externalId: RELEASE_TWO },
      { provider: "musicbrainz", entityType: "release", externalId: RELEASE_THREE },
    ],
  });
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.releaseMbid, RELEASE);
  assert.equal(outcome.derivedReferences.some((reference) => reference.externalId === RELEASE_TWO), true);
  assert.equal(outcome.derivedReferences.some((reference) => reference.externalId === RELEASE_THREE), true);
  assert.equal(outcome.derivedReferences.some((reference) => reference.externalId === RELEASE), true);
});

test("accepts the CAA singular release URL and never treats the large image URL as an image ID", async () => {
  const network = fakeNetwork([
    {
      match: (url, options) => options.method === "GET",
      result: response({
        release: `http://musicbrainz.org/release/${RELEASE}`,
        images: [{ approved: true, front: true, id: 123, image: "https://ia800.example.invalid/large.jpg", thumbnails: { "500": "https://ia800.example.invalid/500.jpg" } }],
      }),
    },
    { match: (url, options) => options.method === "HEAD", result: response(null, 200, { "content-type": "image/jpeg" }) },
  ]);
  const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP }],
  });
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.provenance.imageId, 123);
  assert.equal(network.calls[1].url, `https://coverartarchive.org/release/${RELEASE}/front-500`);
});

test("resolves a direct release reference without using a release-group endpoint", async () => {
  const network = fakeNetwork([
    { match: (url, options) => options.method === "GET" && url === `https://coverartarchive.org/release/${RELEASE}`, result: response(caaGroupData({ release: RELEASE, image: 99 })) },
    { match: (url, options) => options.method === "HEAD", result: response(null, 200, { "content-type": "image/jpeg" }) },
  ]);
  const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({
    title: "A record",
    artistDisplayName: "An artist",
    externalReferences: [{ provider: "musicbrainz", entityType: "release", externalId: RELEASE }],
  });
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.provenance.releaseGroupMbid, null);
  assert.equal(outcome.provenance.releaseMbid, RELEASE);
  assert.equal(network.calls[0].url.includes("release-group"), false);
});

test("uses an exact MusicBrainz barcode match, with an identifying user agent", async () => {
  const network = fakeNetwork([
    {
      match: (url, options) => options.method === "GET" && url.startsWith("https://musicbrainz.org/ws/2/release?") && url.includes("barcode%3A012345678905"),
      result: response({ releases: [{ id: RELEASE, title: "Björk", "release-group": { id: GROUP }, "artist-credit": [{ name: "Björk" }] }] }),
    },
    { match: (url, options) => options.method === "GET" && url === `https://coverartarchive.org/release-group/${GROUP}`, result: response(caaGroupData({ release: RELEASE, image: 100 })) },
    { match: (url, options) => options.method === "HEAD", result: response(null, 200, { "content-type": "image/jpeg" }) },
  ]);
  const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock, musicBrainzIntervalMs: 0 }).resolve({
    title: "Bjork",
    artistCredits: [{ name: "Bjork", role: "main" }],
    barcode: BARCODE,
  });
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.provenance.resolutionMethod, "barcode");
  assert.equal(network.calls[0].headers["User-Agent"].includes("RescenedCoverResolver"), true);
  assert.deepEqual(outcome.derivedReferences.map((reference) => reference.entityType), ["release-group", "release"]);
});

test("does not fuzzy-match barcode results and reports metadata mismatches", async () => {
  const network = fakeNetwork([
    {
      match: () => true,
      result: response({ releases: [{ id: RELEASE, title: "Other record", "release-group": { id: GROUP }, "artist-credit": [{ name: "An artist" }] }] }),
    },
  ]);
  const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock, musicBrainzIntervalMs: 0 }).resolve({
    title: "A record",
    artistDisplayName: "An artist",
    barcode: BARCODE,
  });
  assert.equal(outcome.status, "unresolved");
  assert.equal(outcome.reason, "metadata_mismatch");
  assert.equal(network.calls.length, 1);
});

test("rejects barcode results spanning multiple release groups", async () => {
  const network = fakeNetwork([{ match: () => true, result: response({ releases: [
    { id: RELEASE, title: "A record", "release-group": { id: GROUP }, "artist-credit": [{ name: "An artist" }] },
    { id: RELEASE_TWO, title: "A record", "release-group": { id: GROUP_TWO }, "artist-credit": [{ name: "An artist" }] },
  ] }) }]);
  const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock, musicBrainzIntervalMs: 0 }).resolve({ title: "A record", artistDisplayName: "An artist", barcode: BARCODE });
  assert.equal(outcome.reason, "barcode_ambiguity");
  assert.equal(network.calls.length, 1);
});

test("rejects conflicting identities before any provider call", async () => {
  const network = fakeNetwork([]);
  const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({
    externalReferences: [
      { provider: "musicbrainz", entityType: "release-group", externalId: GROUP },
      { provider: "musicbrainz", entityType: "release-group", externalId: GROUP_TWO },
    ],
  });
  assert.equal(outcome.reason, "conflicting_identity");
  assert.equal(network.calls.length, 0);

  const releaseConflict = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({
    externalReferences: [
      { provider: "musicbrainz", entityType: "release", externalId: RELEASE },
      { provider: "musicbrainz", entityType: "release", externalId: RELEASE_TWO },
    ],
  });
  assert.equal(releaseConflict.reason, "conflicting_identity");
  assert.equal(network.calls.length, 0);
});

test("requires an approved front and a 500px thumbnail", async (t) => {
  await t.test("no approved front", async () => {
    const network = fakeNetwork([{ match: () => true, result: response(caaGroupData({ approved: false })) }]);
    const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({ externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP }] });
    assert.equal(outcome.reason, "no_approved_front");
  });
  await t.test("approved front without 500px", async () => {
    const network = fakeNetwork([{ match: () => true, result: response(caaGroupData({ thumbnail: "" })) }]);
    const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({ externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP }] });
    assert.equal(outcome.reason, "no_500px_image");
  });
  await t.test("deprecated large thumbnail alias is accepted as the 500px rendition", async () => {
    const network = fakeNetwork([
      {
        match: (url, options) => options.method === "GET",
        result: response({
          release: `https://musicbrainz.org/release/${RELEASE}`,
          images: [{
            approved: true,
            front: true,
            id: 321,
            thumbnails: { large: `http://coverartarchive.org/release/${RELEASE}/321-500.jpg` },
          }],
        }),
      },
      {
        match: (url, options) => options.method === "HEAD" && url === `https://coverartarchive.org/release/${RELEASE}/front-500`,
        result: response(null, 200, { "content-type": "image/jpeg" }),
      },
    ]);
    const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({
      externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP }],
    });
    assert.equal(outcome.status, "resolved");
    assert.equal(outcome.cover, `https://coverartarchive.org/release/${RELEASE}/front-500`);
    assert.deepEqual(network.calls.map(({ method }) => method), ["GET", "HEAD"]);
  });
  await t.test("rejects a canonical endpoint that does not advertise an image", async () => {
    const network = fakeNetwork([
      { match: (url, options) => options.method === "GET", result: response(caaGroupData()) },
      { match: (url, options) => options.method === "HEAD", result: response(null, 200, { "content-type": "text/html" }) },
    ]);
    const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({ externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP }] });
    assert.equal(outcome.reason, "invalid_response");
  });
});

test("catalog barcode references resolve exactly and preserve identities when artwork is absent", async () => {
  const network = fakeNetwork([
    {
      match: (url, options) => options.method === "GET" && url.startsWith("https://musicbrainz.org/ws/2/release?"),
      result: response({
        count: 1,
        releases: [{
          id: RELEASE,
          barcode: BARCODE,
          title: "A record",
          "release-group": { id: GROUP },
          "artist-credit": [{ name: "An artist" }],
        }],
      }),
    },
    {
      match: (url, options) => options.method === "GET" && url === `https://coverartarchive.org/release-group/${GROUP}`,
      result: response(null, 404),
    },
  ]);
  const outcome = await createCoverArtResolver({
    fetchFn: network.fetchFn,
    clock: fixedClock,
    musicBrainzIntervalMs: 0,
  }).resolve({
    proposedMetadata: { title: "A record", artistCredits: [{ name: "An artist" }] },
    externalReferences: [{ provider: "barcode", entityType: "release", externalId: BARCODE }],
  });
  assert.equal(outcome.reason, "no_approved_front");
  assert.deepEqual(
    outcome.derivedReferences.map(({ entityType, externalId }) => ({ entityType, externalId })),
    [
      { entityType: "release-group", externalId: GROUP },
      { entityType: "release", externalId: RELEASE },
    ],
  );
  assert.equal(network.calls.length, 2);
});

test("every MusicBrainz retry passes through the one-request-per-second gate", async () => {
  let currentTime = Date.parse("2026-08-26T12:00:00.000Z");
  const sleeps = [];
  let attempts = 0;
  const network = fakeNetwork([{
    match: () => true,
    result: () => {
      attempts += 1;
      return attempts === 1 ? response(null, 503) : response({ releases: [] });
    },
  }]);
  const resolver = createCoverArtResolver({
    fetchFn: network.fetchFn,
    clock: () => new Date(currentTime),
    sleepFn: async (milliseconds) => {
      sleeps.push(milliseconds);
      currentTime += milliseconds;
    },
  });
  const outcome = await resolver.resolve({
    title: "A record",
    artistDisplayName: "An artist",
    barcode: BARCODE,
  });
  assert.equal(outcome.reason, "no_identity");
  assert.equal(attempts, 2);
  assert.equal(resolver.stats.musicBrainzRequests, 2);
  assert.equal(sleeps.reduce((total, milliseconds) => total + milliseconds, 0), 1_000);
});

test("does not accept a truncated barcode result page as unambiguous", async () => {
  const network = fakeNetwork([{
    match: () => true,
    result: response({
      count: 2,
      releases: [{
        id: RELEASE,
        barcode: BARCODE,
        title: "A record",
        "release-group": { id: GROUP },
        "artist-credit": [{ name: "An artist" }],
      }],
    }),
  }]);
  const outcome = await createCoverArtResolver({
    fetchFn: network.fetchFn,
    clock: fixedClock,
    musicBrainzIntervalMs: 0,
  }).resolve({ title: "A record", artistDisplayName: "An artist", barcode: BARCODE });
  assert.equal(outcome.reason, "invalid_response");
  assert.equal(network.calls.length, 1);
});

test("retries transient CAA responses and honors Retry-After", async () => {
  const sleeps = [];
  let attempts = 0;
  const network = fakeNetwork([
    {
      match: (url, options) => options.method === "GET",
      result: () => {
        attempts += 1;
        return attempts === 1 ? response(null, 429, { "retry-after": "2" }) : response(caaGroupData());
      },
    },
    { match: (url, options) => options.method === "HEAD", result: response(null, 200, { "content-type": "image/jpeg" }) },
  ]);
  const outcome = await createCoverArtResolver({
    fetchFn: network.fetchFn,
    clock: fixedClock,
    sleepFn: async (milliseconds) => sleeps.push(milliseconds),
    musicBrainzIntervalMs: 0,
  }).resolve({ externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP }] });
  assert.equal(outcome.status, "resolved");
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(attempts, 2);
});

test("approval profile makes one short attempt and never fetches a submitted cover URL", async () => {
  let calls = 0;
  const resolver = createCoverArtResolver({
    fetchFn: async () => {
      calls += 1;
      return response(null, 503);
    },
    clock: fixedClock,
  });
  const outcome = await resolver.resolve({
    title: "A record",
    artistDisplayName: "An artist",
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP }],
    coverSourceUrl: "https://submitted.example/cover.jpg",
  }, { profile: "approval" });
  assert.equal(outcome.reason, "transient_provider_failure");
  assert.equal(calls, 1);
});

test("no identity performs no network work", async () => {
  const network = fakeNetwork([]);
  const outcome = await createCoverArtResolver({ fetchFn: network.fetchFn, clock: fixedClock }).resolve({ title: "A record", artistDisplayName: "An artist" });
  assert.equal(outcome.reason, "no_identity");
  assert.equal(network.calls.length, 0);
});
