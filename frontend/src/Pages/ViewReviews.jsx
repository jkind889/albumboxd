import { useState, useEffect, useMemo } from "react";
import ReviewList from "../Components/ReviewList";


export function ViewReviews()
{
    const [reviews, setReviews] = useState([]);



    
    useEffect(() => {
        const stored = JSON.parse(localStorage.getItem("reviews")) || [];
        setReviews(stored);
    }, []);

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
            <ReviewList reviews={recentReviews} />
            <h3>Popular Reviews</h3>
            <ReviewList reviews={popularReviews} />
        </div>
    );


}


export default ViewReviews;