import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./App.css";
import SearchResults from "./Pages/SearchResults";
import AlbumDetail from "./Components/AlbumDetail";
import Collection from "./Pages/Collection";
import ViewReviews from "./Pages/ViewReviews";
import FrontPage from "./Pages/FrontPage";
import Layout from "./Layout";
import Account from "./Pages/Account";
import EditProfile from "./Pages/EditProfile";
import ProtectedRoute from "./Components/ProtectedRoute";
import 'bootstrap/dist/css/bootstrap.min.css';

export function App() {
   return (
    <BrowserRouter>
      <div className="app-shell">
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<FrontPage />} />
            <Route path="/search" element={<SearchResults />} />
            <Route path="/collection" element={
              <ProtectedRoute>
                <Collection />
             </ProtectedRoute>} />
            <Route path="/album/:id" element={<AlbumDetail />} />
            <Route path="/viewreviews" element={
            <ProtectedRoute>
              <ViewReviews />
            </ProtectedRoute>} />
            <Route path="/account" element={<Account />} />
            <Route path="/profile/:userId" element={<Account />} />
            <Route path="/account/edit" element={
              <ProtectedRoute>
                <EditProfile />
              </ProtectedRoute>} />
          </Route>
        </Routes>
      </div>
    </BrowserRouter>
  );


}

export default App
