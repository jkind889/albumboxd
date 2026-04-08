import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";     
import SearchBar from "./Components/Searchbar";

import "./App.css";
export function SearchResults()
{
  const [searchresults, setResults] = useState([])

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
            <article className="result-card" key={result.id}>
              <img className="result-cover" src={result.cover} alt={`${result.title} cover`} />
              <h3>{result.title}</h3>
              <p>{result.artist}</p>
            </article>
          ))}
        </div>
    </>
  )


}