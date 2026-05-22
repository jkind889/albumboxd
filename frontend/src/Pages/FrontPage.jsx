import ReviewList from "../Components/ReviewList";
import FeaturedAlbum from "../Components/FeaturedAlbums";
import RecentlySaved from "../Components/RecentlySaved";
import {useState, useEffect, useMemo} from "react";
import { useNavigate } from "react-router-dom";

export function FrontPage() {
    const [reviews, setReviews] = useState([]);
    const navigate = useNavigate();


    
    useEffect(() => {

        async function fetchReviews()
        {
            const response = await fetch("http://localhost:3000/reviews/reviewlist");
            const data = await response.json();
            setReviews(data);
        }
        fetchReviews();
    }, []);

    const popularReviews = useMemo(() => {
        return [...reviews]
            .sort((a, b) => b.rating - a.rating) 
            .slice(0, 5);
    }, [reviews]);





    return (
        <div className="front-page">
            <h1>Welcome to AlbumBoxd</h1>
            <p>Discover and review your favorite albums!</p>
            <button className="explore-button" onClick={() => navigate("/collection")}>
                Explore Now
            </button>



            <div className= "featuredbanner">
                <FeaturedAlbum />
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
                <h3>Popular Reviews</h3>
                <ReviewList reviews={popularReviews} onRemoveReview={() => {}} />
            </div>
        </div>
    );
}

export default FrontPage;