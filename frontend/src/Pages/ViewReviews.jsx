import { useState, useEffect, useMemo } from "react";
import ReviewList from "../Components/ReviewList";


export function ViewReviews()
{
    const [reviews, setReviews] = useState([]);



    
    useEffect(() => {
        async function fetchReviews() {
            const response = await fetch("http://localhost:3000/reviews/reviewlist");
            const data = await response.json();
            setReviews(data);
        }

        fetchReviews();
    }, []);

    async function removeReview(id) {
        const res = await fetch(`http://localhost:3000/reviews/review/${id}`, {
            method: "DELETE"
        });
        if (!res.ok) {
            console.error("Failed to delete review");
            return;
        }
        setReviews((prev) => prev.filter((review) => review._id !== id));
    };




    const recentReviews = useMemo(() => {
        return [...reviews]
            .sort((a, b) => new Date(b.date) - new Date(a.date)) 
            .slice(0, 5);
    }, [reviews]);

    const popularReviews = useMemo(() => {
        return [...reviews]
            .sort((a, b) => b.rating - a.rating) 
            .slice(0, 5);
    }, [reviews]);



    return (
        <div>
            <h3>Recent Reviews</h3>
            <ReviewList reviews={recentReviews} onRemoveReview={removeReview} />
            <h3>Popular Reviews</h3>
            <ReviewList reviews={popularReviews} onRemoveReview={removeReview} />
        </div>
    );


}


export default ViewReviews;