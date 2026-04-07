import { useState } from "react";

export function SearchBar({ onSearch})
{
    const [input, setInput] = useState("")

    const handleSubmit = (e) => 
    {
        e.preventDefault();
        onSearch(input)
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