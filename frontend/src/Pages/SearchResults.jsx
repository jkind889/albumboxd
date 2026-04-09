import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";     

export function SearchResults()
{
  const [searchresults, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate();

  const [searchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  

    useEffect(() =>{
      if (!query) {
        setResults([])
        return;
      }

      setLoading(true)

      fetch(`http://localhost:3000/api/search?q=${query}`)
      .then(res => res.json())
      .then(data => {
        console.log(data)
        setResults(data)})
      .catch(() => setResults([]))
      .finally(() => setLoading(false))
    }, [query])


  

  return (
    <section className="search-results-page">
        <div className="search-results-header">
          <p className="search-results-kicker">Search results</p>
          <h2>{query ? `Albums matching "${query}"` : "Search for an album"}</h2>
          <p className="search-results-summary">
            {loading
              ? "Loading albums..."
              : `${searchresults.length} album${searchresults.length === 1 ? "" : "s"} found`}
          </p>
        </div>

        <div className="results-grid">
          {console.log(searchresults)}
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
    </section>
  )


}

export default SearchResults;
