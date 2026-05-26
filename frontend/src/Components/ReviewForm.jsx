import { useState } from "react";
import { useUser } from "@clerk/react";
export function ReviewForm({album, onAddReview})
{
    const [reviewText, setReviewText] = useState("");
    const [rating, setRating] = useState("");
    const { user } = useUser();


    const handleSubmit = (e) => {
        e.preventDefault();

        const newReview = {
            userId: user.id,
            spotifyId: album.id,
            title: album.title,
            artist: album.artist,
            cover: album.imgs?.[0]?.url,
            rating,
            reviewText,
            date: Date.now()
        };
        onAddReview(newReview);

        setReviewText("");
        setRating(0);
        console.log("Review submitted:", newReview);

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
