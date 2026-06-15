import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";     

export function SearchResults()
{
  const [searchresults, setResults] = useState([])
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const page = Math.max(Number.parseInt(searchParams.get("page") || "1", 10) || 1, 1);
  

    useEffect(() =>{
      async function fetchResults() {
        if (!query) {
          setResults([])
          setHasNextPage(false)
          return;
        }

        setLoading(true)

        fetch(`http://localhost:3000/search/search?q=${encodeURIComponent(query)}&page=${page}`)
        .then(res => res.json())
        .then(data => {
          console.log(data)
          const results = Array.isArray(data) ? data : data.results;
          setResults(Array.isArray(results) ? results : [])
          setHasNextPage(Boolean(data?.hasNextPage))
        })
        .catch(() => {
          setResults([])
          setHasNextPage(false)
        })
        .finally(() => setLoading(false))
      }

      fetchResults();
    }, [query, page])

  function updatePage(nextPage) {
    const nextParams = new URLSearchParams(searchParams);

    nextParams.set("page", String(nextPage));
    setSearchParams(nextParams);
  }

  

  return (
    <section className="search-results-page">
        <div className="search-results-header">
          <p className="search-results-kicker">Search results</p>
          <h2>{query ? `Albums matching "${query}"` : "Search for an album"}</h2>
          <p className="search-results-summary">
            {loading
              ? "Loading albums..."
              : `${searchresults.length} album${searchresults.length === 1 ? "" : "s"} on page ${page}`}
          </p>
        </div>

        <div className="results-grid">
          {Array.isArray(searchresults) && searchresults.map((result) => (
            // When a result is clicked, navigate to the album detail page using the album's ID
            <article className="result-card" key={result.id} onClick={() => navigate(`/album/${result.id}`)}>
              <img className="result-cover" src={result.cover} alt={`${result.title} cover`} />
              <h3>{result.title}</h3>
              <p>{result.artist}</p>
              <span className="result-year">{result.year || "Year unknown"}</span>
            </article>
          ))}

          {!loading && query && searchresults.length === 0 && (
            <div className="results-empty">
              No albums matched that search.
            </div>
          )}
        </div>

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
