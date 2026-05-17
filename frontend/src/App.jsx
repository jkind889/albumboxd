import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./App.css";
import SearchBar from "./Components/Searchbar";
import SearchResults from "./Pages/SearchResults";
import AlbumDetail from "./Components/AlbumDetail";
import Collection from "./Pages/Collection";
import ViewReviews from "./Pages/ViewReviews";
import FrontPage from "./Pages/FrontPage";
import Layout from "./Layout";
import 'bootstrap/dist/css/bootstrap.min.css';

export function App() {
   return (
    <BrowserRouter>
      <div className="app-shell">
        <Layout />

        <Routes>
            <Route path="/search" element={<SearchResults />} />
            <Route path="/Home" element={<FrontPage />} />
            <Route path="/collection" element={<Collection />} />
            <Route path="/album/:id" element={<AlbumDetail />} />
            <Route path="/reviews" element={<ViewReviews />} />
        </Routes>
      </div>
    </BrowserRouter>
  );


}

export default App
