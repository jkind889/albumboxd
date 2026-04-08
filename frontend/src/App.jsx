import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./Components/Home";
import SearchResults from "./Components/SearchResults";

export function App() {
  return(
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/search" element={<SearchResults />} />
      </Routes>
    </BrowserRouter>
  )


}

export default App
