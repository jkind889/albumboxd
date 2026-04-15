import { useState, useEffect } from "react";

export function ViewReviews()
{
    const [reviews, setReviews] = useState([]);
    
    useEffect(() => {
        const stored = JSON.parse(localStorage.getItem("reviews")) || [];
        setReviews(stored);
    }, []);


    return (
        <div>
            {reviews.map((review) => (
                <div key={review.date}>
                    <p>Rating: {review.rating}</p>
                    <p>Album: {review.albumTitle} by {review.artist}</p>
                    <p>{review.reviewText}</p>
                    <p>{new Date(review.date).toLocaleDateString()}</p>
                </div>
            ))}
        </div>
    );

}


export default ViewReviews;