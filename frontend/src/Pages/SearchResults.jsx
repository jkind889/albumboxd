import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";     

export function SearchResults()
{
  const [searchresults, setResults] = useState([])
  const navigate = useNavigate();

  const [searchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  

    useEffect(() =>{
      if (!query) return;


      fetch(`http://localhost:3000/api/search?q=${query}`)
      .then(res => res.json())
      .then(data => {setResults(data)})

    }, [query])


  

  return (
    <>
        <div className="results-grid">
          {searchresults.map((result) => (
            // When a result is clicked, navigate to the album detail page using the album's ID
            <article className="result-card" key={result.id} onClick={() => navigate(`/album/${result.id}`)}>
              <img className="result-cover" src={result.cover} alt={`${result.title} cover`} />
              <h3>{result.title}</h3>
              <p>{result.artist}</p>
            </article>

            
          ))}
        </div>
    </>
  )


}

export default SearchResults;