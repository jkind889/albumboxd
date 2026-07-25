const assert = require("node:assert/strict");
const test = require("node:test");

const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const albumGenreEnrichmentPath = require.resolve("../routes/utils/albumGenreEnrichment");
const scriptPath = require.resolve("../scripts/enrichAlbumGenres");

let albums = [];
const enrichmentCalls = [];

function loadBackfillScript() {
  delete require.cache[scriptPath];

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      find: () => ({
        sort() {
          return this;
        },
        cursor() {
          return (async function* getAlbums() {
            for (const album of albums) {
              yield album;
            }
          }());
        },
      }),
    },
  };

  require.cache[albumGenreEnrichmentPath] = {
    id: albumGenreEnrichmentPath,
    filename: albumGenreEnrichmentPath,
    loaded: true,
    exports: {
      enrichAlbumGenres: async (spotifyId, options) => {
        enrichmentCalls.push({ spotifyId, options });
        return { status: "resolved" };
      },
      isAlbumGenreEnrichmentDue: (album, options) => (
        Boolean(album.due) || Boolean(options.force)
      ),
    },
  };

  return require("../scripts/enrichAlbumGenres");
}

test.beforeEach(() => {
  albums = [];
  enrichmentCalls.length = 0;
});

test("backfill arguments support dry-run, force, and positive limits", () => {
  const { parseArguments } = loadBackfillScript();

  assert.deepEqual(parseArguments([
    "--dry-run",
    "--force",
    "--limit=25",
  ]), {
    dryRun: true,
    force: true,
    limit: 25,
  });
  assert.deepEqual(parseArguments(["--limit", "10"]), {
    dryRun: false,
    force: false,
    limit: 10,
  });
  assert.throws(() => parseArguments(["--limit=0"]), /positive integer/);
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
});

test("dry-run counts eligible albums without starting provider work", async () => {
  albums = [
    { spotifyId: "album_1", due: true },
    { spotifyId: "album_2", due: false },
    { spotifyId: "album_3", due: true },
  ];
  const { runBackfill } = loadBackfillScript();
  const summary = await runBackfill({
    dryRun: true,
    force: false,
    limit: Number.POSITIVE_INFINITY,
  });

  assert.equal(summary.eligible, 2);
  assert.equal(summary.resolved, 0);
  assert.deepEqual(enrichmentCalls, []);
});

test("write mode processes eligible albums sequentially and resumes from persisted state", async () => {
  albums = [
    { spotifyId: "album_fresh", due: false },
    { spotifyId: "album_due_1", due: true },
    { spotifyId: "album_due_2", due: true },
  ];
  const { runBackfill } = loadBackfillScript();
  const summary = await runBackfill({
    dryRun: false,
    force: false,
    limit: 1,
  });

  assert.equal(summary.eligible, 1);
  assert.equal(summary.resolved, 1);
  assert.deepEqual(enrichmentCalls, [
    {
      spotifyId: "album_due_1",
      options: { force: false },
    },
  ]);
});
