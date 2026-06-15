import FeaturedAlbums from "../Components/FeaturedAlbums";
import NewOnAlbumboxd from "../Components/NewOnAlbumboxd";
import PopularAlbums from "../Components/PopularAlbums";
import PopularReviews from "../Components/PopularReviews";
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
                    <button
                        className="explore-button"
                        onClick={() => navigate("/account", { state: { activeTab: "saved" } })}
                    >
                        View Saved Albums
                    </button>
                </div>
                <FeaturedAlbums limit={5} />
            </section>

            <section className="front-section">
                <div className="front-section-heading">
                    <h3>New on albumboxd</h3>
                </div>
                <NewOnAlbumboxd limit={6} />
            </section>

            <section className="front-section">
                <div className="front-section-heading">
                    <h3>Popular Albums</h3>
                    <button className="front-more-button" type="button" onClick={() => navigate("/albums")}>
                        More
                    </button>
                </div>
                <PopularAlbums limit={5} window="30d" />
            </section>

            <section className="front-section">
                <div className="front-section-heading">
                    <h3>Popular Reviews</h3>
                </div>
                <PopularReviews limit={4} />
            </section>

            <section className="front-section front-lists-preview">
                <h3>Popular Lists</h3>
            </section>
        </div>
    );
}

export default FrontPage;
