import { useState, useEffect } from "react";
import SearchBar from "./Components/Searchbar";
import "./App.css";
export function App()
{
  const [query, setQuery] = useState("")
  const [searchresults, setResults] = useState([])

    useEffect(() =>{
      fetch(`http://localhost:3000/api/search?q=${query}`)
      .then(res => res.json())
      .then(data => {
        console.log(data)
        setResults(data)

      });




    }, [query])


  

  return (
    <>
      <div className="app-shell">
        <SearchBar onSearch={setQuery} />
        <div className="results-grid">
          {searchresults.map((result) => (
            <article className="result-card" key={result.id}>
              <img className="result-cover" src={result.cover} alt={`${result.title} cover`} />
              <h3>{result.title}</h3>
              <p>{result.artist}</p>
            </article>
          ))}
        </div>
      </div>
    </>
  )


}




export default App
