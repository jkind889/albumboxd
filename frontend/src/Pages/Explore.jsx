import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import RelatedArtistGraph from "../Components/RelatedArtistGraph";
import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "../utils/apiErrors";
import { getArtistCandidates } from "../utils/artistReferences";
import { getRenderedMappedNeighbors } from "../utils/relatedArtistGraph";
import {
  fetchArtistCollaborations,
  fetchSimilarArtists,
} from "../utils/relatedArtists";
import "./Explore.css";

const ARTIST_SEARCH_LIMIT = 12;
const EVIDENCE_LABELS = {
  album_credit: "Album credit",
  same_track: "Same track",
};

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function searchArtistCandidates(query, { signal } = {}) {
  const searchParams = new URLSearchParams({
    q: query,
    limit: String(ARTIST_SEARCH_LIMIT),
  });
  const response = await fetch(
    `${API_BASE_URL}/search/search?${searchParams.toString()}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response, "Artist search failed"));
  }

  const data = await response.json();
  const results = Array.isArray(data) ? data : data?.results;

  return getArtistCandidates(results, query).slice(0, ARTIST_SEARCH_LIMIT);
}

function CollaborationAlbumCard({ album }) {
  const evidenceTypes = Array.isArray(album?.evidenceTypes)
    ? album.evidenceTypes
    : [];
  const sharedTracks = Array.isArray(album?.sharedTracks)
    ? album.sharedTracks
    : [];

  return (
    <article className="explore-collaboration-card">
      <Link
        className="explore-collaboration-card-cover"
        to={`/album/${album.spotifyId}`}
        aria-label={`Open ${album.title}`}
      >
        {album.cover ? (
          <img src={album.cover} alt="" />
        ) : (
          <span aria-hidden="true">{String(album.title || "A").slice(0, 1)}</span>
        )}
      </Link>
      <div className="explore-collaboration-card-copy">
        <div className="explore-collaboration-card-heading">
          <Link to={`/album/${album.spotifyId}`}>{album.title || "Unknown album"}</Link>
          <span>{album.year && album.year !== "unknown" ? album.year : "Year unknown"}</span>
        </div>
        <div className="explore-collaboration-card-badges" aria-label="Collaboration evidence">
          {evidenceTypes.map((type) => (
            <span key={type}>{EVIDENCE_LABELS[type] || type}</span>
          ))}
        </div>
        {sharedTracks.length > 0 ? (
          <p>
            <strong>Matching track{sharedTracks.length === 1 ? "" : "s"}:</strong>{" "}
            {sharedTracks.map((track) => track.title || "Unknown track").join(", ")}
          </p>
        ) : (
          <p>Both artists are billed in the album credit.</p>
        )}
      </div>
    </article>
  );
}

function CollaborationPanel({
  collaboratorName,
  entry,
  onRetry,
  seedName,
}) {
  if (!collaboratorName) {
    return null;
  }

  const status = entry?.status || "loading";
  const data = entry?.data || null;
  const albums = Array.isArray(data?.albums) ? data.albums : [];
  const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : albums.length;

  return (
    <section
      className={`explore-collaboration-panel explore-collaboration-panel-${status}${albums.length > 0 ? " explore-collaboration-panel-has-albums" : ""}`}
      aria-labelledby="explore-collaboration-title"
      aria-live={status === "error" ? undefined : "polite"}
      role={status === "error" ? "alert" : undefined}
    >
      <header>
        <div>
          <p>Local collaboration evidence</p>
          <h3 id="explore-collaboration-title">{seedName} + {collaboratorName}</h3>
        </div>
        <span>Partial coverage · AlbumCatalog only</span>
      </header>

      {status === "loading" ? (
        <p className="explore-collaboration-message">
          Searching the local album catalog for shared credits…
        </p>
      ) : null}

      {status === "error" ? (
        <div className="explore-collaboration-message explore-collaboration-message-error">
          <div>
            <strong>Collaboration albums unavailable</strong>
            <span>{entry?.error || "Unable to inspect the local album catalog."}</span>
          </div>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      ) : null}

      {status === "success" && albums.length === 0 ? (
        <p className="explore-collaboration-message">
          No collaboration was found in the local catalog. Coverage is incomplete, so this does not prove the artists have never collaborated.
        </p>
      ) : null}

      {status === "success" && albums.length > 0 ? (
        <>
          <p className="explore-collaboration-message">
            Showing {albums.length} of {total} locally cached collaboration album{total === 1 ? "" : "s"}. Coverage is incomplete.
          </p>
          <div className="explore-collaboration-card-grid">
            {albums.map((album) => (
              <CollaborationAlbumCard album={album} key={album.spotifyId} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function Explore() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = String(searchParams.get("q") || "").trim();
  const selectedSpotifyId = String(searchParams.get("artist") || "").trim();
  const selectedNameFromUrl = String(searchParams.get("name") || "").trim();
  const expandedSpotifyId = String(searchParams.get("with") || "").trim();
  const [searchInput, setSearchInput] = useState(query);
  const [candidates, setCandidates] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [payload, setPayload] = useState(null);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState("");
  const [graphAttempt, setGraphAttempt] = useState(0);
  const [collaborationCache, setCollaborationCache] = useState({
    seedSpotifyId: "",
    entries: {},
  });
  const [collaborationAttempt, setCollaborationAttempt] = useState(0);
  const activePayload = String(payload?.seed?.spotifyId || "") === selectedSpotifyId
    ? payload
    : null;
  const renderedMappedNeighbors = useMemo(
    () => getRenderedMappedNeighbors(activePayload),
    [activePayload],
  );
  const selectedCollaborator = renderedMappedNeighbors.find(
    (neighbor) => neighbor.spotifyId === expandedSpotifyId,
  ) || null;
  const activeCollaborationEntries = collaborationCache.seedSpotifyId === selectedSpotifyId
    ? collaborationCache.entries
    : {};
  const collaborationEntry = selectedCollaborator
    ? activeCollaborationEntries[selectedCollaborator.spotifyId]
    : null;
  const collaborationStatus = selectedCollaborator
    ? collaborationEntry?.status || "loading"
    : "idle";
  const collaborationAlbums = collaborationEntry?.status === "success"
    && Array.isArray(collaborationEntry.data?.albums)
    ? collaborationEntry.data.albums
    : [];
  const selectedCandidate = candidates.find(
    (candidate) => candidate.spotifyId === selectedSpotifyId,
  );
  const selectedName = selectedNameFromUrl
    || selectedCandidate?.name
    || activePayload?.seed?.name
    || "Selected artist";

  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  useEffect(() => {
    setCollaborationCache((currentCache) => {
      if (currentCache.seedSpotifyId === selectedSpotifyId) {
        return currentCache;
      }

      return {
        seedSpotifyId: selectedSpotifyId,
        entries: {},
      };
    });
  }, [selectedSpotifyId]);

  useEffect(() => {
    if (!query) {
      setCandidates([]);
      setSearchError("");
      setIsSearching(false);
      return undefined;
    }

    const controller = new AbortController();
    let isCurrent = true;

    setIsSearching(true);
    setSearchError("");

    searchArtistCandidates(query, { signal: controller.signal })
      .then((nextCandidates) => {
        if (isCurrent) {
          setCandidates(nextCandidates);
        }
      })
      .catch((error) => {
        if (isCurrent && error.name !== "AbortError") {
          setCandidates([]);
          setSearchError(error.message || "Unable to search for artists.");
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsSearching(false);
        }
      });

    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [query, searchAttempt]);

  useEffect(() => {
    if (!selectedSpotifyId) {
      setPayload(null);
      setGraphError("");
      setIsGraphLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    let isCurrent = true;

    setPayload(null);
    setGraphError("");
    setIsGraphLoading(true);

    fetchSimilarArtists(selectedSpotifyId, { signal: controller.signal })
      .then((nextPayload) => {
        if (isCurrent) {
          setPayload(nextPayload);
        }
      })
      .catch((error) => {
        if (isCurrent && error.name !== "AbortError") {
          setGraphError(error.message || "Unable to load this artist neighborhood.");
        }
      })
      .finally(() => {
        if (isCurrent) {
          setIsGraphLoading(false);
        }
      });

    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [graphAttempt, selectedSpotifyId]);

  useEffect(() => {
    if (!expandedSpotifyId || !activePayload || selectedCollaborator) {
      return;
    }

    setSearchParams((currentParams) => {
      if (String(currentParams.get("with") || "").trim() !== expandedSpotifyId) {
        return currentParams;
      }

      const nextParams = new URLSearchParams(currentParams);
      nextParams.delete("with");
      return nextParams;
    }, { replace: true });
  }, [activePayload, expandedSpotifyId, selectedCollaborator, setSearchParams]);

  const hasCachedCollaboration = collaborationEntry?.status === "success";

  useEffect(() => {
    if (!activePayload || !selectedCollaborator || hasCachedCollaboration) {
      return undefined;
    }

    const controller = new AbortController();
    const seedSpotifyId = selectedSpotifyId;
    const collaboratorSpotifyId = selectedCollaborator.spotifyId;
    let isCurrent = true;

    setCollaborationCache((currentCache) => {
      const entries = currentCache.seedSpotifyId === seedSpotifyId
        ? currentCache.entries
        : {};

      return {
        seedSpotifyId,
        entries: {
          ...entries,
          [collaboratorSpotifyId]: {
            status: "loading",
            data: null,
            error: "",
          },
        },
      };
    });

    fetchArtistCollaborations(seedSpotifyId, collaboratorSpotifyId, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!isCurrent) {
          return;
        }

        setCollaborationCache((currentCache) => {
          if (currentCache.seedSpotifyId !== seedSpotifyId) {
            return currentCache;
          }

          return {
            ...currentCache,
            entries: {
              ...currentCache.entries,
              [collaboratorSpotifyId]: {
                status: "success",
                data,
                error: "",
              },
            },
          };
        });
      })
      .catch((error) => {
        if (!isCurrent || error.name === "AbortError") {
          return;
        }

        setCollaborationCache((currentCache) => {
          if (currentCache.seedSpotifyId !== seedSpotifyId) {
            return currentCache;
          }

          return {
            ...currentCache,
            entries: {
              ...currentCache.entries,
              [collaboratorSpotifyId]: {
                status: "error",
                data: null,
                error: error.message || "Unable to inspect collaboration albums.",
              },
            },
          };
        });
      });

    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [
    activePayload,
    collaborationAttempt,
    hasCachedCollaboration,
    selectedCollaborator,
    selectedSpotifyId,
  ]);

  function handleSearch(event) {
    event.preventDefault();
    const nextQuery = searchInput.trim();

    if (!nextQuery) {
      return;
    }

    const nextParams = new URLSearchParams();
    nextParams.set("q", nextQuery);
    setSearchParams(nextParams);
    setSearchAttempt((attempt) => attempt + 1);
  }

  const selectArtist = useCallback((artist) => {
    const spotifyId = String(artist?.spotifyId || "").trim();

    if (!spotifyId) {
      return;
    }

    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams);
      nextParams.set("artist", spotifyId);
      nextParams.set("name", String(artist?.name || "Artist"));
      nextParams.delete("with");
      return nextParams;
    });
  }, [setSearchParams]);

  const selectCollaborator = useCallback((artist) => {
    const spotifyId = String(artist?.spotifyId || "").trim();

    if (!spotifyId) {
      return;
    }

    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams);

      if (String(currentParams.get("with") || "").trim() === spotifyId) {
        nextParams.delete("with");
      } else {
        nextParams.set("with", spotifyId);
      }

      return nextParams;
    });
  }, [setSearchParams]);

  const retryCollaboration = useCallback(() => {
    if (!selectedCollaborator) {
      return;
    }

    setCollaborationCache((currentCache) => {
      if (currentCache.seedSpotifyId !== selectedSpotifyId) {
        return currentCache;
      }

      return {
        ...currentCache,
        entries: {
          ...currentCache.entries,
          [selectedCollaborator.spotifyId]: {
            status: "loading",
            data: null,
            error: "",
          },
        },
      };
    });
    setCollaborationAttempt((attempt) => attempt + 1);
  }, [selectedCollaborator, selectedSpotifyId]);

  return (
    <section className="explore-page">
      <header className="explore-page-header">
        <div>
          <p className="explore-page-kicker">MusicBrainz · ListenBrainz</p>
          <h1>Explore</h1>
          <p className="explore-page-deck">
            Pick a seed artist, follow the strongest relationships, and keep moving through the graph.
          </p>
        </div>
      </header>

      <section className="explore-seed-search" aria-labelledby="explore-seed-search-title">
        <div className="explore-seed-search-copy">
          <p>Choose a seed</p>
          <h2 id="explore-seed-search-title">Search artists or albums</h2>
        </div>
        <form className="explore-seed-search-form" onSubmit={handleSearch}>
          <label htmlFor="explore-artist-query">Artist or album name</label>
          <div>
            <input
              id="explore-artist-query"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Try Björk, Radiohead, Madvillain…"
              autoComplete="off"
            />
            <button type="submit" disabled={!searchInput.trim() || isSearching}>
              {isSearching ? "Searching…" : "Find artist"}
            </button>
          </div>
        </form>

        {searchError ? (
          <div className="explore-inline-state explore-inline-state-error" role="alert">
            <p>{searchError}</p>
            <button type="button" onClick={() => setSearchAttempt((attempt) => attempt + 1)}>
              Retry search
            </button>
          </div>
        ) : null}

        {!searchError && query && !isSearching && candidates.length === 0 ? (
          <p className="explore-inline-state">
            No indexed artists were found for “{query}”. Try an artist or one of their albums.
          </p>
        ) : null}

        {!isSearching && candidates.length > 0 ? (
          <div className="explore-candidate-strip" aria-label="Artist matches">
            {candidates.map((candidate) => (
              <button
                className={candidate.spotifyId === selectedSpotifyId ? "explore-candidate-active" : ""}
                key={candidate.spotifyId}
                type="button"
                onClick={() => selectArtist(candidate)}
              >
                {candidate.cover ? (
                  <img src={candidate.cover} alt="" />
                ) : (
                  <span className="explore-candidate-cover-fallback" aria-hidden="true">
                    {candidate.name.slice(0, 1)}
                  </span>
                )}
                <span>
                  <strong>{candidate.name}</strong>
                  <small>{candidate.albumCount} matching album{candidate.albumCount === 1 ? "" : "s"}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {!selectedSpotifyId ? (
        <section className="explore-empty-state">
          <p>Search for an artist to resolve its Spotify ID to MusicBrainz and map its ListenBrainz neighborhood.</p>
        </section>
      ) : null}

      {selectedSpotifyId && isGraphLoading ? (
        <section className="explore-graph-state" role="status" aria-live="polite">
          <p>Resolving neighborhood</p>
          <h2>{selectedName}</h2>
          <span>Spotify identity → MusicBrainz MBID → ListenBrainz relationships</span>
        </section>
      ) : null}

      {selectedSpotifyId && !isGraphLoading && graphError ? (
        <section className="explore-graph-state explore-graph-state-error" role="alert">
          <p>Neighborhood unavailable</p>
          <h2>{selectedName}</h2>
          <span>{graphError}</span>
          <button type="button" onClick={() => setGraphAttempt((attempt) => attempt + 1)}>
            Retry neighborhood
          </button>
        </section>
      ) : null}

      {activePayload && !isGraphLoading && !graphError ? (
        <>
          <RelatedArtistGraph
            payload={activePayload}
            selectedSpotifyArtistId={selectedCollaborator?.spotifyId || ""}
            collaborationAlbums={collaborationAlbums}
            collaborationStatus={collaborationStatus}
            onSelectArtist={selectCollaborator}
            onExploreArtist={selectArtist}
          />

          <CollaborationPanel
            collaboratorName={selectedCollaborator?.name || ""}
            entry={collaborationEntry}
            onRetry={retryCollaboration}
            seedName={selectedName}
          />

          <details className="explore-data-inspector">
            <summary>
              <span>Inspect graph data</span>
              <strong>{activePayload.cacheStatus || "unknown"}</strong>
            </summary>
            <dl>
              <div>
                <dt>Seed MBID</dt>
                <dd>{activePayload.seed?.musicBrainzId || "Unavailable"}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{activePayload.source || "Unknown"}</dd>
              </div>
              <div>
                <dt>Identity cache</dt>
                <dd>{activePayload.identityCacheStatus || "Unknown"}</dd>
              </div>
              <div>
                <dt>Spotify mappings</dt>
                <dd>{activePayload.spotifyMappingStatus || "Unknown"}</dd>
              </div>
              <div>
                <dt>Fetched</dt>
                <dd>{formatDate(activePayload.fetchedAt)}</dd>
              </div>
              <div>
                <dt>Refresh due</dt>
                <dd>{formatDate(activePayload.expiresAt)}</dd>
              </div>
            </dl>
            <p className="explore-data-algorithm">
              <strong>Algorithm</strong>
              <code>{activePayload.algorithm || "Unavailable"}</code>
            </p>
            <pre><code>{JSON.stringify(activePayload, null, 2)}</code></pre>
          </details>
        </>
      ) : null}
    </section>
  );
}

export default Explore;
