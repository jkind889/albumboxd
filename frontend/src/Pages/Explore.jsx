import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import RelatedArtistGraph from "../Components/RelatedArtistGraph";
import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "../utils/apiErrors";
import { getArtistCandidates } from "../utils/artistReferences";
import { fetchSimilarArtists } from "../utils/relatedArtists";
import "./Explore.css";

const ARTIST_SEARCH_LIMIT = 12;

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

export function Explore() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = String(searchParams.get("q") || "").trim();
  const selectedSpotifyId = String(searchParams.get("artist") || "").trim();
  const selectedNameFromUrl = String(searchParams.get("name") || "").trim();
  const [searchInput, setSearchInput] = useState(query);
  const [candidates, setCandidates] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [payload, setPayload] = useState(null);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState("");
  const [graphAttempt, setGraphAttempt] = useState(0);
  const selectedCandidate = candidates.find(
    (candidate) => candidate.spotifyId === selectedSpotifyId,
  );
  const selectedName = selectedNameFromUrl
    || selectedCandidate?.name
    || payload?.seed?.name
    || "Selected artist";

  useEffect(() => {
    setSearchInput(query);
  }, [query]);

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
      return nextParams;
    });
  }, [setSearchParams]);

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

      {payload && !isGraphLoading && !graphError ? (
        <>
          <RelatedArtistGraph payload={payload} onExploreArtist={selectArtist} />

          <details className="explore-data-inspector">
            <summary>
              <span>Inspect graph data</span>
              <strong>{payload.cacheStatus || "unknown"}</strong>
            </summary>
            <dl>
              <div>
                <dt>Seed MBID</dt>
                <dd>{payload.seed?.musicBrainzId || "Unavailable"}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{payload.source || "Unknown"}</dd>
              </div>
              <div>
                <dt>Identity cache</dt>
                <dd>{payload.identityCacheStatus || "Unknown"}</dd>
              </div>
              <div>
                <dt>Spotify mappings</dt>
                <dd>{payload.spotifyMappingStatus || "Unknown"}</dd>
              </div>
              <div>
                <dt>Fetched</dt>
                <dd>{formatDate(payload.fetchedAt)}</dd>
              </div>
              <div>
                <dt>Refresh due</dt>
                <dd>{formatDate(payload.expiresAt)}</dd>
              </div>
            </dl>
            <p className="explore-data-algorithm">
              <strong>Algorithm</strong>
              <code>{payload.algorithm || "Unavailable"}</code>
            </p>
            <pre><code>{JSON.stringify(payload, null, 2)}</code></pre>
          </details>
        </>
      ) : null}
    </section>
  );
}

export default Explore;
