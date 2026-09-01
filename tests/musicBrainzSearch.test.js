const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MusicBrainzSearchError,
  buildSearchUrl,
  createMusicBrainzSearch,
  mapReleaseGroupToCandidate,
  mapReleaseGroupToSuggestionDraft,
} = require("../lib/musicBrainzSearch");

const GROUP = "11111111-1111-4111-8111-111111111111";
const GROUP_TWO = "22222222-2222-4222-8222-222222222222";
const ARTIST = "33333333-3333-4333-8333-333333333333";

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return data; },
  };
}

function releaseGroup(id = GROUP, overrides = {}) {
  return {
    id,
    title: "Imaginal Disk",
    "artist-credit": [{
      name: "Magdalena Bay",
      joinphrase: "",
      artist: { id: ARTIST, name: "Magdalena Bay" },
    }],
    "primary-type": "Album",
    "secondary-types": [],
    "first-release-date": "2024-08-23",
    ...overrides,
  };
}

test("MusicBrainz search URL normalizes whitespace and escapes Lucene syntax", () => {
  const url = new URL(buildSearchUrl("  A+B:  title  ", 3));

  assert.equal(url.searchParams.get("query"), "A\\+B\\: title");
  assert.equal(url.searchParams.get("limit"), "3");
  assert.equal(url.searchParams.get("fmt"), "json");
});

test("search mapping ranks by upstream score and deduplicates release groups", async () => {
  const calls = [];
  const client = createMusicBrainzSearch({
    intervalMs: 0,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return response({
        "release-groups": [
          { ...releaseGroup(GROUP), score: 65 },
          { ...releaseGroup(GROUP_TWO, { title: "Second Record" }), score: 90 },
          { ...releaseGroup(GROUP), score: 100 },
        ],
      });
    },
  });

  const candidates = await client.searchReleaseGroups("imaginal disk", 12);

  assert.deepEqual(candidates.map((candidate) => candidate.externalId), [GROUP, GROUP_TWO]);
  assert.equal(candidates[0].kind, "external");
  assert.equal(candidates[0].provider, "musicbrainz");
  assert.equal(candidates[0].entityType, "release-group");
  assert.equal(candidates[0].albumId, undefined);
  assert.equal(candidates[0].cover, `https://coverartarchive.org/release-group/${GROUP}/front-250`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["User-Agent"].includes("Rescened"), true);
});

test("normalized concurrent queries share a request and later queries use the bounded cache", async () => {
  let resolveRequest;
  let calls = 0;
  const client = createMusicBrainzSearch({
    intervalMs: 0,
    fetchFn: async () => {
      calls += 1;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  });

  const first = client.searchReleaseGroups("  Imaginal   Disk ", 12);
  const second = client.searchReleaseGroups("imaginal disk", 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  resolveRequest(response({ "release-groups": [releaseGroup()] }));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.length, 1);
  assert.equal(secondResult.length, 1);

  const cached = await client.searchReleaseGroups("IMAGINAL DISK", 12);
  assert.equal(cached.length, 1);
  assert.equal(calls, 1);
  assert.equal(client.stats.networkRequests, 1);
  assert.equal(client.stats.cacheHits, 1);
});

test("exact lookup maps core metadata into the existing suggestion input shape", () => {
  const draft = mapReleaseGroupToSuggestionDraft(releaseGroup());
  const candidate = mapReleaseGroupToCandidate(releaseGroup());

  assert.equal(draft.proposedMetadata.title, "Imaginal Disk");
  assert.equal(draft.proposedMetadata.releaseDatePrecision, "day");
  assert.equal(draft.proposedMetadata.releaseYear, 2024);
  assert.deepEqual(draft.proposedMetadata.artistCredits, [{ name: "Magdalena Bay", role: "main" }]);
  assert.deepEqual(draft.proposedMetadata.tracks, []);
  assert.equal(draft.proposedMetadata.coverSourceUrl, "");
  assert.deepEqual(draft.supportingSources, [{
    type: "musicbrainz",
    url: `https://musicbrainz.org/release-group/${GROUP}`,
  }]);
  assert.deepEqual(draft.externalReferences, [{
    provider: "musicbrainz",
    entityType: "release-group",
    externalId: GROUP,
    url: `https://musicbrainz.org/release-group/${GROUP}`,
  }]);
  assert.equal(candidate.releaseType, "album");
});

test("provider timeout becomes a typed adapter error without retries", async () => {
  let calls = 0;
  const client = createMusicBrainzSearch({
    intervalMs: 0,
    timeoutMs: 5,
    fetchFn: async (url, options) => {
      calls += 1;
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return response({});
    },
  });

  await assert.rejects(
    () => client.searchReleaseGroups("timeout"),
    (error) => error instanceof MusicBrainzSearchError && error.code === "MUSICBRAINZ_REQUEST_FAILED",
  );
  assert.equal(calls, 1);
});

test("MusicBrainz request starts are separated by the configured gate", async () => {
  let now = 0;
  const starts = [];
  const client = createMusicBrainzSearch({
    intervalMs: 1_100,
    nowMs: () => now,
    sleepFn: async (milliseconds) => { now += milliseconds; },
    fetchFn: async () => {
      starts.push(now);
      return response({ "release-groups": [releaseGroup()] });
    },
  });

  await client.searchReleaseGroups("one");
  await client.searchReleaseGroups("two");

  assert.deepEqual(starts, [0, 1_100]);
});
