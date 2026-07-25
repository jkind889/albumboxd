import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import 'bootstrap/dist/css/bootstrap.min.css';
import "./App.css";
import SearchResults from "./Pages/SearchResults";
import AlbumDetail from "./Components/AlbumDetail";
import ViewReviews from "./Pages/ViewReviews";
import ReviewDispatches from "./Pages/ReviewDispatches";
import FrontPage from "./Pages/FrontPage";
import Layout from "./Layout";
import Account from "./Pages/Account";
import EditProfile from "./Pages/EditProfile";
import ProfileNetwork from "./Pages/ProfileNetwork";
import Boards from "./Pages/Boards";
import BoardDetail from "./Pages/BoardDetail";
import Notifications from "./Pages/Notifications";
import ProtectedRoute from "./Components/ProtectedRoute";

export function App() {
   return (
    <BrowserRouter>
      <div className="app-shell">
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<FrontPage />} />
            <Route path="/search" element={<SearchResults />} />
            <Route path="/boards" element={<Boards />} />
            <Route path="/boards/:boardId" element={<BoardDetail />} />
            <Route
              path="/collection"
              element={<Navigate to="/account" state={{ activeTab: "saved" }} replace />}
            />
            <Route path="/album/:id" element={<AlbumDetail />} />
            <Route path="/album/:id/reviews" element={<AlbumDetail />} />
            <Route path="/viewreviews" element={
            <ProtectedRoute>
              <ViewReviews />
            </ProtectedRoute>} />
            <Route path="/review-dispatches" element={<ReviewDispatches />} />
            <Route path="/account" element={<Account />} />
            <Route path="/account/network" element={<ProfileNetwork />} />
            <Route path="/notifications" element={
              <ProtectedRoute>
                <Notifications />
              </ProtectedRoute>} />
            <Route path="/profile/:userId/reviews" element={<ViewReviews />} />
            <Route path="/profile/:userId/network" element={<ProfileNetwork />} />
            <Route path="/profile/:userId/boards/:boardId" element={<BoardDetail />} />
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
