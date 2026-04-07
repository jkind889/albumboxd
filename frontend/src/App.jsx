import { useState, useEffect } from "react";
import SearchBar from "./Components/Searchbar";
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
    <div>
      <SearchBar onSearch={setQuery} />



      {searchresults.map(result => (
        <div key={result.id}>
            <img src={result.cover}/>
            <h3>{result.title}</h3>
            <p>{result.artist}</p>
          </div>
      ))}
    </div>
    </>
  )


}




export default App