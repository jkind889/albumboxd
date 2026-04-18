import { useState } from "react";

export function ReviewForm({album, onAddReview})
{
    const [reviewText, setReviewText] = useState("");
    const [rating, setRating] = useState("");
    
    const handleSubmit = (e) => {
        e.preventDefault();

        const newReview = {
            albumId: album.id,
            albumTitle: album.title,
            artist: album.artist,
            rating,
            reviewText,
            date: Date.now()
        };
        onAddReview(newReview);

        setReviewText("");
        setRating(0);

    };

    


    return (
        <form className="review-form-card" onSubmit={handleSubmit}>
            <div className="review-form-header">
                <div>
                    <p className="review-form-kicker">Your review</p>
                    <h2>Log {album.title}</h2>
                </div>
            </div>

            <label className="review-form-field">
                <span>Rating</span>
                <input
                    type="number"
                    min="1"
                    max="5"
                    value={rating}
                    onChange={(e) => setRating(parseInt(e.target.value))}
                    placeholder="1-5"
                />
            </label>

            <label className="review-form-field">
                <span>Review</span>
                <textarea
                    value={reviewText}
                    onChange={(e) => setReviewText(e.target.value)}
                    placeholder="Write your review here..."
                    rows="5"
                />
            </label>

            <button className="review-submit-button" type="submit">Submit Review</button>
        </form>
                

    );

}

export default ReviewForm;
