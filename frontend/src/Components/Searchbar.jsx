import {useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export function SearchBar()
{
    const [input, setInput] = useState("")
    // const [recent, setRecent] = useState([])
    const navigate = useNavigate()


    useEffect(() => {
        // const history = JSON.parse(localStorage.getItem("history")) || [];
        // setRecent(history);
    }, []);


    const handleSubmit = (e) => 
    {
        e.preventDefault();
        // Navigate to the search results page with the query as a URL parameter


        const history = JSON.parse(localStorage.getItem("history")) || [];

        const updated = [input, ...history.filter(item => item !== input)].slice(0, 5);

        const limited = updated.slice(0, 5);

        localStorage.setItem("history", JSON.stringify(limited));

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