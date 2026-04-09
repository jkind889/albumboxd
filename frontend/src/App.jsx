import { BrowserRouter, Routes, Route } from "react-router-dom";
import SearchBar from "./Components/Searchbar";
import SearchResults from "./Pages/SearchResults";
import AlbumDetail from "./Components/AlbumDetail";

export function App() {
   return (
    <BrowserRouter>
      <div className="app-shell">
        <SearchBar />

        <Routes>
          <Route path="/search" element={<SearchResults />} />
          <Route path="/album/:id" element={<AlbumDetail />} />
        </Routes>
      </div>
    </BrowserRouter>
  );


}

export default App
