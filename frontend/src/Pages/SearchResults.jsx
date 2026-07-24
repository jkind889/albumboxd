import { API_BASE_URL } from "../config/api";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AsyncState from "../Components/Loading/AsyncState";
import { getApiErrorMessage } from "../utils/apiErrors";

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
  const viewMode = viewParam === "list" ? "list" : "grid";


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
