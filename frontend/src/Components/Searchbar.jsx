import { useState } from "react";
import { useNavigate } from "react-router-dom";


export function SearchBar()
{
    const [input, setInput] = useState("")
    const navigate = useNavigate()

    const handleSubmit = (e) => 
    {
        e.preventDefault();
        // Navigate to the search results page with the query as a URL parameter
        navigate(`/search?q=${input}`)
    };

    return (
    <form onSubmit={handleSubmit}>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Search albums..."
      />
      <button type="submit">Search</button>
    </form>
  );


}



export default SearchBar;