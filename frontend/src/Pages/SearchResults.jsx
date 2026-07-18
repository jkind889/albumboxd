import { API_BASE_URL } from "../config/api";
import { memo, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ReactFlow, Background, Controls, Handle, Position } from "@xyflow/react";
import AsyncState from "../Components/Loading/AsyncState";
import RelatedArtistInspector from "../Components/RelatedArtistInspector";
import { getApiErrorMessage } from "../utils/apiErrors";
import "@xyflow/react/dist/style.css";

const SEARCH_VIEW_MODES = new Set(["grid", "list", "graph"]);

const AlbumNode = memo(function AlbumNode({ data }) {
  const title = data.title || "Untitled album";
  const artist = data.artist || "Unknown artist";

  return (
    <article className="explore-album-node">
      <Link to={`/album/${data.id}`}>
        <Handle className="explore-node-handle" type="target" position={Position.Top} />
        {data.cover ? (
          <img className="explore-album-cover" src={data.cover} alt={`${title} cover`} />
        ) : (
          <div className="explore-album-cover explore-album-cover-fallback" aria-hidden="true">
            {title.slice(0, 1)}
          </div>
        )}
        <div className="explore-album-copy">
          <strong>{title}</strong>
          <span>{artist}</span>
        </div>
      </Link>
    </article>
  );
});

const ArtistNode = memo(function ArtistNode({ data }) {
  return (
    <div className="explore-artist-node">
      <span>{data.label}</span>
      <Handle className="explore-node-handle" type="source" position={Position.Bottom} />
    </div>
  );
});

const nodeTypes = {
  albumNode: AlbumNode,
  artistNode: ArtistNode,
};

const GRAPH_ALBUMS_PER_COLUMN = 4;
const GRAPH_ALBUM_COLUMN_GAP = 220;
const GRAPH_ALBUM_ROW_GAP = 255;
const GRAPH_ARTIST_GROUP_GAP = 170;
const GRAPH_START_X = 90;
const GRAPH_ARTIST_Y = 90;
const GRAPH_ALBUM_START_Y = 250;

function getArtistLabel(album) {
  return album.artist || "Unknown artist";
}

function getPrimaryArtistIdentity(album) {
  const label = getArtistLabel(album);
  const primarySpotifyId = String(
    album.artistId || album.artistRefs?.[0]?.spotifyId || "",
  ).trim();

  return {
    key: primarySpotifyId ? `spotify:${primarySpotifyId}` : `name:${label}`,
    label,
  };
}

function getArtistNodeId(artistKey) {
  return `artist:${artistKey}`;
}

function getInspectableArtists(results) {
  const artistsBySpotifyId = new Map();

  for (const album of Array.isArray(results) ? results : []) {
    const artistRefs = Array.isArray(album.artistRefs) ? album.artistRefs : [];

    for (const artistRef of artistRefs) {
      const spotifyId = String(artistRef?.spotifyId || "").trim();

      if (!spotifyId || artistsBySpotifyId.has(spotifyId)) {
        continue;
      }

      artistsBySpotifyId.set(spotifyId, {
        spotifyId,
        name: String(artistRef.name || album.artist || "Unknown artist").trim(),
      });
    }

    const primarySpotifyId = String(album.artistId || "").trim();

    if (primarySpotifyId && !artistsBySpotifyId.has(primarySpotifyId)) {
      artistsBySpotifyId.set(primarySpotifyId, {
        spotifyId: primarySpotifyId,
        name: String(album.artist || "Unknown artist").trim(),
      });
    }
  }

  return [...artistsBySpotifyId.values()];
}

function buildGraphElements(results) {
  const artistsByKey = new Map();

  for (const album of results) {
    const artist = getPrimaryArtistIdentity(album);
    const existingArtist = artistsByKey.get(artist.key);

    artistsByKey.set(artist.key, {
      ...artist,
      albumCount: (existingArtist?.albumCount || 0) + 1,
    });
  }

  let nextArtistX = GRAPH_START_X;
  const artistLayouts = new Map();

  for (const artist of artistsByKey.values()) {
    const columnCount = Math.max(
      1,
      Math.ceil(artist.albumCount / GRAPH_ALBUMS_PER_COLUMN),
    );
    const groupWidth = (columnCount - 1) * GRAPH_ALBUM_COLUMN_GAP;

    artistLayouts.set(artist.key, {
      startX: nextArtistX,
      centerX: nextArtistX + (groupWidth / 2),
    });

    nextArtistX += (columnCount * GRAPH_ALBUM_COLUMN_GAP) + GRAPH_ARTIST_GROUP_GAP;
  }

  const artistNodes = [...artistsByKey.values()].map((artist) => {
    const layout = artistLayouts.get(artist.key);

    return {
      id: getArtistNodeId(artist.key),
      position: {
        x: layout.centerX,
        y: GRAPH_ARTIST_Y,
      },
      data: {
        label: artist.label,
      },
      type: "artistNode",
    };
  });

  const artistAlbumIndexes = new Map();
  const albumNodes = results.map((album) => {
    const artist = getPrimaryArtistIdentity(album);
    const albumIndexForArtist = artistAlbumIndexes.get(artist.key) || 0;
    const layout = artistLayouts.get(artist.key);
    const column = Math.floor(albumIndexForArtist / GRAPH_ALBUMS_PER_COLUMN);
    const row = albumIndexForArtist % GRAPH_ALBUMS_PER_COLUMN;

    artistAlbumIndexes.set(artist.key, albumIndexForArtist + 1);

    return {
      id: album.id,
      position: {
        x: layout.startX + (column * GRAPH_ALBUM_COLUMN_GAP),
        y: GRAPH_ALBUM_START_Y + (row * GRAPH_ALBUM_ROW_GAP),
      },
      data: {
        title: album.title,
        artist: artist.label,
        cover: album.cover,
        id: album.id,
      },
      type: "albumNode",
    };
  });

  const edges = results.map((album) => {
    const artist = getPrimaryArtistIdentity(album);

    return {
      id: `${getArtistNodeId(artist.key)}-${album.id}`,
      source: getArtistNodeId(artist.key),
      target: album.id,
    };
  });

  return {
    nodes: [...artistNodes, ...albumNodes],
    edges,
  };
}

function SearchResultsGraph({ results }) {
  const graph = useMemo(() => buildGraphElements(results), [results]);
  const inspectableArtists = useMemo(() => getInspectableArtists(results), [results]);
  const artistSignature = inspectableArtists.map((artist) => artist.spotifyId).join(":");

  return (
    <>
      <RelatedArtistInspector
        key={artistSignature}
        artists={inspectableArtists}
      />
      <div className="explore-flow-shell">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          nodesDraggable={false}
        >
          <Background color="#2f3035" gap={28} />
          <Controls />
        </ReactFlow>
      </div>
    </>
  );
}

export function SearchResults()
{
  const [searchresults, setResults] = useState([])
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const page = Math.max(Number.parseInt(searchParams.get("page") || "1", 10) || 1, 1);
  const viewParam = searchParams.get("view") || "grid";
  const viewMode = SEARCH_VIEW_MODES.has(viewParam) ? viewParam : "grid";


    useEffect(() =>{
      let shouldIgnore = false;

      async function fetchResults() {
        if (!query) {
          setResults([])
          setHasNextPage(false)
          setError("")
          setLoading(false);
          return;
        }

        setLoading(true)
        setError("")

        try {
          const res = await fetch(`${API_BASE_URL}/search/search?q=${encodeURIComponent(query)}&page=${page}`)

          if (!res.ok) {
            throw new Error(await getApiErrorMessage(res, "Search request failed"));
          }

          const data = await res.json()

          if (shouldIgnore) {
            return;
          }

          const results = Array.isArray(data) ? data : data.results;
          setResults(Array.isArray(results) ? results : [])
          setHasNextPage(Boolean(data?.hasNextPage))
        } catch (searchError) {
          if (shouldIgnore) {
            return;
          }

          setResults([])
          setHasNextPage(false)
          setError(searchError.message || "Unable to load search results.")
        } finally {
          if (!shouldIgnore) {
            setLoading(false)
          }
        }
      }

      fetchResults();

      return () => {
        shouldIgnore = true;
      };
    }, [query, page])

  function updatePage(nextPage) {
    const nextParams = new URLSearchParams(searchParams);

    nextParams.set("page", String(nextPage));
    setSearchParams(nextParams);
  }

  function updateView(nextViewMode) {
    const nextParams = new URLSearchParams(searchParams);

    if (nextViewMode === "grid") {
      nextParams.delete("view");
    } else {
      nextParams.set("view", nextViewMode);
    }

    setSearchParams(nextParams);
  }

  function renderResults() {
    if (viewMode === "graph") {
      return <SearchResultsGraph results={searchresults} />;
    }

    return (
      <div className={viewMode === "list" ? "results-list" : "results-grid"}>
        {Array.isArray(searchresults) && searchresults.map((result) => (
          <Link className="result-card" key={result.id} to={`/album/${result.id}`}>
            <img className="result-cover" src={result.cover} alt={`${result.title} cover`} />
            <span className="result-copy">
              <h3>{result.title}</h3>
              <p>{result.artist}</p>
            </span>
            <span className="result-year">{result.year || "Year unknown"}</span>
          </Link>
        ))}
      </div>
    );
  }
  
  return (
    <section className="search-results-page">
        <div className="search-results-header">
          <p className="search-results-kicker">Search results</p>
          <h2>{query || "Search"}</h2>
          <div className="search-results-toolbar">
            <p className="search-results-summary">
              {loading
                ? "Loading albums..."
                : `${searchresults.length} album${searchresults.length === 1 ? "" : "s"} on page ${page}`}
            </p>
            <div className="profile-view-toggle search-view-toggle" aria-label="Search results view">
              <button
                className={viewMode === "grid" ? "profile-view-toggle-active" : ""}
                type="button"
                onClick={() => updateView("grid")}
              >
                Grid
              </button>
              <button
                className={viewMode === "list" ? "profile-view-toggle-active" : ""}
                type="button"
                onClick={() => updateView("list")}
              >
                List
              </button>
              <button
                className={viewMode === "graph" ? "profile-view-toggle-active" : ""}
                type="button"
                onClick={() => updateView("graph")}
              >
                Graph
              </button>
            </div>
          </div>
        </div>

        <AsyncState
          isLoading={loading && Boolean(query)}
          error={error}
          isEmpty={!loading && !error && Boolean(query) && searchresults.length === 0}
          loadingVariant="grid"
          loadingMessage="Loading search results"
          errorTitle="Search unavailable"
          emptyTitle="No albums matched that search."
        >
          {renderResults()}
        </AsyncState>

        {query && (page > 1 || hasNextPage) && (
          <div className="search-pagination" aria-label="Search pagination">
            <button
              type="button"
              disabled={loading || page <= 1}
              onClick={() => updatePage(page - 1)}
            >
              Previous
            </button>
            <span>Page {page}</span>
            <button
              type="button"
              disabled={loading || !hasNextPage}
              onClick={() => updatePage(page + 1)}
            >
              Next
            </button>
          </div>
        )}

    </section>
  )


}

export default SearchResults;
