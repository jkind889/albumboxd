import LikeButton from "./LikeButton";

export function ReviewList({reviews, onRemoveReview, onToggleReviewLike, likeMessage})
{
    const canRemoveReviews = typeof onRemoveReview === "function";

    const formatReviewDate = (date) => {
        if (!date) {
            return "Date unavailable";
        }

        const parsedDate = new Date(date);
        return Number.isNaN(parsedDate.getTime())
            ? "Date unavailable"
            : parsedDate.toLocaleDateString();
    };

    const formatRatingStars = (rating) => {
        const numericRating = Number(rating) || 0;
        const fullStars = Math.floor(numericRating);
        const hasHalfStar = numericRating % 1 >= 0.5;

        return `${"★".repeat(fullStars)}${hasHalfStar ? "½" : ""}`;
    };

    if (reviews.length === 0) {
        return (
            <div className="review-list-empty">
                <p>No reviews yet.</p>
            </div>
        );
    }


    return (
        <div className="review-list">
            {reviews.map((review) => (
                <article className="review-card" key={review._id}>
                    <div className="review-card-poster">
                        {review.cover && (
                            <img className="review-card-image" src={review.cover} alt={`${review.title} cover`} />
                        )}
                        {!review.cover && (
                            <div className="review-card-image-fallback">No cover</div>
                        )}
                    </div>
                    <div className="review-card-content">
                        <div className="review-card-title-row">
                            <h2>{review.title || "Untitled album"}</h2>
                            {review.year && <span>{review.year}</span>}
                        </div>
                        <div className="review-card-meta">
                            <span className="review-card-rating" aria-label={`${review.rating} out of 5`}>
                                {formatRatingStars(review.rating)}
                            </span>
                            <span>Reviewed {formatReviewDate(review.date)}</span>
                        </div>
                        <p className="review-card-copy">{review.reviewText}</p>
                        <div className="review-card-actions">
                            <LikeButton
                                liked={Boolean(review.likedByViewer)}
                                count={review.likeCount}
                                label="review"
                                message={likeMessage}
                                onToggle={() => onToggleReviewLike?.(review)}
                            />
                        </div>
                        {canRemoveReviews && (
                            <button className="review-delete-button" onClick={() => onRemoveReview(review._id)}>Delete Review</button>
                        )}
                    </div>
                </article>
            ))}
        </div>

    );
}

export default ReviewList
