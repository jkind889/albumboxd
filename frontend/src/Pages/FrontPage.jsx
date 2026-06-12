import FeaturedAlbums from "../Components/FeaturedAlbums";
import PopularAlbums from "../Components/PopularAlbums";
import RecentlySaved from "../Components/RecentlySaved";
import { useNavigate } from "react-router-dom";

export function FrontPage() {
    const navigate = useNavigate();

    return (
        <div className="front-page">
            <h1>Welcome to AlbumBoxd</h1>
            <p>Discover and review your favorite albums!</p>
            <button className="explore-button" onClick={() => navigate("/collection")}>
                Explore Now
            </button>



            <div className= "featuredbanner">
                <FeaturedAlbums limit={5} />
            </div>

            <div className="featuregrid">
                <div className="feature">
                    <h2>Discover New Music</h2>
                    <p>Search for albums, artists, and genres to find your next favorite listen.</p>
                </div>
                <div className="feature">
                    <h2>Save Your Collection</h2>
                    <p>Keep track of the albums you own and want to listen to.</p>
                </div>
                <div className="feature">
                    <h2>Share Your Reviews</h2>
                    <p>Write reviews and share your thoughts with the community.</p>
                </div>
                <div className="feature">
                    <h2>Share Your Reviews</h2>
                    <p>Write reviews and share your thoughts with the community.</p>
                </div>
                <div className="feature">
                    <h2>Share Your Reviews</h2>
                    <p>Write reviews and share your thoughts with the community.</p>
                </div>
                <div className="feature">
                    <h2>Share Your Reviews</h2>
                    <p>Write reviews and share your thoughts with the community.</p>
                </div>
                

            </div>



            <div>
                <h3>Recently Saved</h3>
                <RecentlySaved />
            </div>

            <div>
                <h3>Popular Albums</h3>
                <PopularAlbums limit={5} window="30d" />
            </div>
        </div>
    );
}

export default FrontPage;
