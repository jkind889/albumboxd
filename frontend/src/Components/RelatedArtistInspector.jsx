import { useEffect, useRef, useState } from "react";
import { fetchSimilarArtists } from "../utils/relatedArtists";
import AsyncState from "./Loading/AsyncState";

function formatWeight(value) {
  const weight = Number(value);

  if (!Number.isFinite(weight)) {
    return "--";
  }

  return `${Math.round(Math.min(Math.max(weight, 0), 1) * 100)}%`;
}

function formatRawScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : "--";
}

function formatFetchedAt(value) {
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

export function RelatedArtistInspector({ artists = [], loadSimilarArtists = fetchSimilarArtists }) {
  const [selectedSpotifyId, setSelectedSpotifyId] = useState(() => artists[0]?.spotifyId || "");
  const [payload, setPayload] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const activeRequestRef = useRef({ controller: null, sequence: 0 });
  const selectedArtist = artists.find((artist) => artist.spotifyId === selectedSpotifyId) || artists[0] || null;
  const neighbors = Array.isArray(payload?.neighbors) ? payload.neighbors : [];

  useEffect(() => () => {
    activeRequestRef.current.sequence += 1;
    activeRequestRef.current.controller?.abort();
  }, []);

  function cancelActiveRequest() {
    activeRequestRef.current.sequence += 1;
    activeRequestRef.current.controller?.abort();
    activeRequestRef.current.controller = null;
  }

  function handleArtistChange(event) {
    cancelActiveRequest();
    setSelectedSpotifyId(event.target.value);
    setPayload(null);
    setError("");
    setIsLoading(false);
  }

  async function handleInspect(event) {
    event.preventDefault();

    if (!selectedArtist?.spotifyId || isLoading) {
      return;
    }

    cancelActiveRequest();
    const controller = new AbortController();
    const requestSequence = activeRequestRef.current.sequence;
    activeRequestRef.current.controller = controller;
    setIsLoading(true);
    setError("");
    setPayload(null);

    try {
      const nextPayload = await loadSimilarArtists(selectedArtist.spotifyId, {
        signal: controller.signal,
      });

      if (activeRequestRef.current.sequence !== requestSequence) {
        return;
      }

      setPayload(nextPayload);
    } catch (requestError) {
      if (
        controller.signal.aborted
        || activeRequestRef.current.sequence !== requestSequence
      ) {
        return;
      }

      setError(requestError.message || "Unable to load related artists.");
    } finally {
      if (activeRequestRef.current.sequence === requestSequence) {
        activeRequestRef.current.controller = null;
        setIsLoading(false);
      }
    }
  }

  return (
    <section className="related-artist-inspector" aria-labelledby="related-artist-inspector-title">
      <div className="related-artist-inspector-header">
        <div>
          <p>Related artist inspector</p>
          <h3 id="related-artist-inspector-title">Seed to neighborhood</h3>
        </div>
        <span>{artists.length} indexed artist{artists.length === 1 ? "" : "s"} on this page</span>
      </div>

      <form className="related-artist-inspector-controls" onSubmit={handleInspect}>
        <label htmlFor="related-artist-seed">Seed artist</label>
        <select
          id="related-artist-seed"
          value={selectedArtist?.spotifyId || ""}
          onChange={handleArtistChange}
          disabled={artists.length === 0}
        >
          {artists.length === 0 ? (
            <option value="">No indexed artists on this page</option>
          ) : artists.map((artist) => (
            <option key={artist.spotifyId} value={artist.spotifyId}>
              {artist.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!selectedArtist || isLoading}>
          {isLoading ? "Inspecting..." : "Inspect"}
        </button>
      </form>

      {!payload && !isLoading && !error ? (
        <p className="related-artist-inspector-prompt">
          {artists.length > 0
            ? "Choose a seed and inspect its ListenBrainz neighborhood."
            : "Search for an indexed Spotify artist to inspect its neighborhood."}
        </p>
      ) : (
        <AsyncState
          isLoading={isLoading}
          error={error}
          loadingVariant="page"
          loadingMessage="Loading related artists"
          errorTitle="Neighborhood unavailable"
        >
          <div className="related-artist-inspector-results">
            <dl className="related-artist-inspector-metadata">
              <div>
                <dt>Seed</dt>
                <dd>
                  <strong>{payload?.seed?.name || selectedArtist?.name || "Unknown artist"}</strong>
                  <code>{payload?.seed?.musicBrainzId || "MBID unavailable"}</code>
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  <strong>{payload?.source || "Unknown"}</strong>
                  <span>{payload?.algorithm || "Algorithm unavailable"}</span>
                </dd>
              </div>
              <div>
                <dt>Cache</dt>
                <dd>
                  <strong>{payload?.cacheStatus || "Unknown"}</strong>
                  <span>
                    Identity {payload?.identityCacheStatus || "unknown"} · fetched {formatFetchedAt(payload?.fetchedAt)}
                  </span>
                  <span>Spotify mapping {payload?.spotifyMappingStatus || "complete"}</span>
                  <span>Refresh due {formatFetchedAt(payload?.expiresAt)}</span>
                </dd>
              </div>
            </dl>

            {neighbors.length > 0 ? (
              <ol className="related-artist-card-grid">
                {neighbors.map((neighbor, index) => (
                  <li
                    className="related-artist-card"
                    key={neighbor.musicBrainzId || `${neighbor.name || "artist"}-${index}`}
                  >
                    <div className="related-artist-card-heading">
                      <span>#{neighbor.rank || index + 1}</span>
                      <strong>{neighbor.name || "Unknown artist"}</strong>
                      <em>{formatWeight(neighbor.weight)}</em>
                    </div>
                    {neighbor.comment ? <p>{neighbor.comment}</p> : null}
                    <div className="related-artist-card-facts">
                      <span>{neighbor.artistType || "Type unknown"}</span>
                      <span>{neighbor.gender || "Gender unknown"}</span>
                      <span>Score {formatRawScore(neighbor.rawScore)}</span>
                      <span>
                        {Array.isArray(neighbor.spotifyArtists) && neighbor.spotifyArtists.length > 0
                          ? `${neighbor.spotifyArtists.length} Spotify mapping${neighbor.spotifyArtists.length === 1 ? "" : "s"}`
                          : "MBID only"}
                      </span>
                    </div>
                    <code>{neighbor.musicBrainzId || "MBID unavailable"}</code>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="related-artist-inspector-prompt">
                This artist does not have a usable ListenBrainz neighborhood yet.
              </p>
            )}

            <details className="related-artist-json">
              <summary>Raw JSON</summary>
              <pre><code>{JSON.stringify(payload, null, 2)}</code></pre>
            </details>
          </div>
        </AsyncState>
      )}
    </section>
  );
}

export default RelatedArtistInspector;
