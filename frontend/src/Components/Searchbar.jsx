import {useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export function SearchBar()
{
    const [input, setInput] = useState("")
    const [suggestions, setSuggestions] = useState([]);
    const [showDropdown, setShowDropdown] = useState(false);
    const navigate = useNavigate()


  
    useEffect(() => {
       const timeoutId = setTimeout(() => {
        if (!input) {
            setSuggestions([]);
            setShowDropdown(false);
            return;
        }

        fetch(`http://localhost:3000/search/search?q=${input}`)
          .then(res => res.json())
          .then(data => setSuggestions(data.slice(0, 5)))
          }, 200); // Add a debounce delay of 200ms before making the API call

          return () => clearTimeout(timeoutId); // Clear the timeout if the input changes before the fetch completes
        }, [input]);

        useEffect(() => {
          const handleClick = () => setShowDropdown(false);

          document.addEventListener("click", handleClick);
          return () => document.removeEventListener("click", handleClick);
        }, []);


    const handleSubmit = (e) => 
    {
        e.preventDefault();
        // Navigate to the search results page with the query as a URL parameter

        if (!input) return;
        
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
        onChange={(e) => { setInput(e.target.value); setShowDropdown(true); }}
        onFocus={() => setShowDropdown(true)}
        placeholder="Search albums..."
      />
      <button type="submit">Search</button>
    <div onClick={(e) => e.stopPropagation()}>
      {showDropdown && suggestions.length > 0 && (
        <ul className="suggestions-dropdown">
          {suggestions.map((suggestion) => (
            <li key={suggestion.id} onClick={() => { navigate(`/album/${suggestion.id}`); setShowDropdown(false); }}>
             <img src={suggestion.cover} className="suggestion-cover" alt={suggestion.title} />
             {suggestion.title} - {suggestion.artist}
            </li>
          ))}
        </ul>
      )}
      </div>






    </form>
  );


}



export default SearchBar;