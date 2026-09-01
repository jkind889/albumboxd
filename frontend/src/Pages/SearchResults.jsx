import { API_BASE_URL } from "../config/api";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AsyncState from "../Components/Loading/AsyncState";
import ExternalAlbumCard from "../Components/ExternalAlbumCard";
import { getApiErrorMessage } from "../utils/apiErrors";

const EXTERNAL_SEARCH_LIMIT = 12;

export function SearchResults() {
  const [searchresults, setResults] = useState([]);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState("");
  const [externalState, setExternalState] = useState("idle");
  const [catalogMatches, setCatalogMatches] = useState([]);
  const [externalCandidates, setExternalCandidates] = useState([]);
  const [externalRetry, setExternalRetry] = useState(0);

  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const page = Math.max(Number.parseInt(searchParams.get("page") || "1", 10) || 1, 1);
  const viewParam = searchParams.get("view") || "grid";
  const viewMode = viewParam === "list" ? "list" : "grid";

  useEffect(() => {
    let shouldIgnore = false;
    const controller = new AbortController();

    function resetExternalResults() {
      setExternalLoading(false);
      setExternalError("");
      setExternalState("idle");
      setCatalogMatches([]);
      setExternalCandidates([]);
    }

    async function fetchExternalResults() {
      setExternalLoading(true);
      setExternalState("loading");
      setExternalError("");

      try {
        const searchParams = new URLSearchParams({
          q: query,
          limit: String(EXTERNAL_SEARCH_LIMIT),
        });
        const response = await fetch(`${API_BASE_URL}/search/external?${searchParams.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await getApiErrorMessage(
            response,
            "External results are temporarily unavailable.",
          ));
        }

        const data = await response.json();
        if (shouldIgnore) return;

        setCatalogMatches(Array.isArray(data?.catalogMatches) ? data.catalogMatches : []);
        setExternalCandidates(Array.isArray(data?.candidates) ? data.candidates : []);
        setExternalState("ready");
      } catch (searchError) {
        if (shouldIgnore || searchError.name === "AbortError") return;

        setExternalError(searchError.message || "External results are temporarily unavailable.");
        setExternalState("error");
      } finally {
        if (!shouldIgnore) setExternalLoading(false);
      }
    }

    async function fetchResults() {
      resetExternalResults();

      if (!query) {
        setResults([]);
        setHasNextPage(false);
        setError("");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      setResults([]);
      setHasNextPage(false);

      try {
        const response = await fetch(
          `${API_BASE_URL}/search/search?q=${encodeURIComponent(query)}&page=${page}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error(await getApiErrorMessage(response, "Search request failed"));
        }

        const data = await response.json();
        if (shouldIgnore) return;

        const results = Array.isArray(data) ? data : data.results;
        const localResults = Array.isArray(results) ? results : [];
        setResults(localResults);
        setHasNextPage(Boolean(data?.hasNextPage));
        setLoading(false);

        if (page === 1 && localResults.length === 0) {
          await fetchExternalResults();
        }
      } catch (searchError) {
        if (shouldIgnore || searchError.name === "AbortError") return;

        setResults([]);
        setHasNextPage(false);
        setError(searchError.message || "Unable to load search results.");
        setLoading(false);
      } finally {
        if (!shouldIgnore) setLoading(false);
      }
    }

    fetchResults();

    return () => {
      shouldIgnore = true;
      controller.abort();
    };
  }, [query, page, externalRetry]);

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

  function renderResults(results = searchresults) {
    return (
      <div className={viewMode === "list" ? "results-list" : "results-grid"}>
        {Array.isArray(results) && results.map((result) => (
          <Link className="result-card" key={result.albumId} to={`/album/${result.albumId}`}>
            {result.cover ? (
              <img className="result-cover" src={result.cover} alt={`${result.title} cover`} />
            ) : (
              <span className="result-cover result-cover-fallback" aria-label="No cover available">No cover</span>
            )}
            <span className="result-copy">
              <h3>{result.title}</h3>
              <p>{result.artistDisplayName}</p>
            </span>
            <span className="result-year">{result.releaseYear || "Year unknown"}</span>
          </Link>
        ))}
      </div>
    );
  }

  function renderExternalResults() {
    if (externalState === "error") {
      return (
        <section className="external-search-message" role="alert">
          <p className="external-search-message-kicker">External discovery unavailable</p>
          <h3>We couldn’t check MusicBrainz right now.</h3>
          <p>
            External results are temporarily unavailable.
            {externalError ? ` ${externalError}` : ""}
          </p>
          <button
            className="external-search-retry"
            type="button"
            onClick={() => setExternalRetry((current) => current + 1)}
          >
            Try external search again
          </button>
        </section>
      );
    }

    return (
      <div className="external-search-results">
        <section className="external-search-intro" aria-labelledby="external-search-heading">
          <p className="external-search-kicker">External discovery</p>
          <h3 id="external-search-heading">No albums in Rescened matched this search.</h3>
          <p>These MusicBrainz results are not in the catalog yet. You can suggest one for community review.</p>
        </section>

        {catalogMatches.length > 0 ? (
          <section className="external-catalog-matches" aria-labelledby="catalog-matches-heading">
            <div className="external-section-heading">
              <p className="external-search-kicker">Known identities</p>
              <h3 id="catalog-matches-heading">Already in Rescened</h3>
            </div>
            {renderResults(catalogMatches)}
          </section>
        ) : null}

        {externalCandidates.length > 0 ? (
          <section className="external-candidates" aria-labelledby="external-candidates-heading">
            <div className="external-section-heading">
              <p className="external-search-kicker">MusicBrainz release groups</p>
              <h3 id="external-candidates-heading">Candidates to add</h3>
            </div>
            <div className="external-candidates-grid">
              {externalCandidates.map((candidate) => (
                <ExternalAlbumCard key={candidate.externalId} candidate={candidate} />
              ))}
            </div>
          </section>
        ) : null}

        {catalogMatches.length === 0 && externalCandidates.length === 0 ? (
          <p className="external-search-no-results">MusicBrainz did not return any usable release groups for this query.</p>
        ) : null}
      </div>
    );
  }

  const isExternalMiss = Boolean(
    query && page === 1 && !loading && !error && searchresults.length === 0,
  );
  const hasExternalResults = catalogMatches.length > 0 || externalCandidates.length > 0;
  const hasVisibleResults = searchresults.length > 0 || hasExternalResults;
  const isLoading = loading || externalLoading;

  return (
    <section className="search-results-page">
        <div className="search-results-header">
          <p className="search-results-kicker">Search results</p>
          <h2>{query || "Search"}</h2>
          <div className="search-results-toolbar">
            <p className="search-results-summary">
              {isLoading
                ? externalLoading ? "Searching MusicBrainz..." : "Loading albums..."
                : isExternalMiss && hasExternalResults
                  ? `${catalogMatches.length + externalCandidates.length} discovery result${catalogMatches.length + externalCandidates.length === 1 ? "" : "s"}`
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
            </div>
          </div>
        </div>

        <AsyncState
          isLoading={isLoading && Boolean(query)}
          error={error}
          isEmpty={!isLoading && !error && Boolean(query) && !hasVisibleResults && !isExternalMiss}
          loadingVariant="grid"
          loadingMessage={externalLoading ? "Searching MusicBrainz" : "Loading search results"}
          errorTitle="Search unavailable"
          emptyTitle="No albums matched that search."
        >
          {searchresults.length > 0 ? renderResults() : isExternalMiss ? renderExternalResults() : null}
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
