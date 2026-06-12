import FeaturedAlbums from "../Components/FeaturedAlbums";
import PopularAlbums from "../Components/PopularAlbums";
import RecentlySaved from "../Components/RecentlySaved";
import { useNavigate } from "react-router-dom";

export function FrontPage() {
    const navigate = useNavigate();

    return (
        <div className="front-page">
            <section className="front-hero">
                <div className="front-hero-copy">
                    <p className="front-hero-kicker">For You</p>
                    <h1>AlbumBoxd</h1>
                    <p>Cycle through community picks, jump into the album page, and see which records are earning attention right now.</p>
                    <button className="explore-button" onClick={() => navigate("/collection")}>
                        Explore Collection
                    </button>
                </div>
                <FeaturedAlbums limit={5} />
            </section>

            <section className="front-section">
                <h3>Recently Saved</h3>
                <RecentlySaved />
            </section>

            <section className="front-section">
                <h3>Popular Albums</h3>
                <PopularAlbums limit={5} window="30d" />
            </section>
        </div>
    );
}

export default FrontPage;
