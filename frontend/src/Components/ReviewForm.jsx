import { useState } from "react";


export function ReviewForm({albumId, onAddReview})
{
    const [reviewText, setReviewText] = useState("");
    const [rating, setRating] = useState("");
    
    const handleSubmit = (e) => {
        e.preventDefault();

        const newReview = {
            albumId,
            rating,
            reviewText,
            date: Date.now()
        };
        onAddReview(newReview);

        setReviewText("");
        setRating(0);

    };

    


    return (
        <form onSubmit={handleSubmit}>
            <input
                type="text"
                min="1"
                max="5"
                value={rating}
                onChange={(e) => setRating(parseInt(e.target.value))}
            />

            <textarea
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
                placeholder="Write your review here..."
            />

            <button type="submit">Submit Review</button>
        </form>
                

    );

}

export default ReviewForm;
