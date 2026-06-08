
export function ReviewList({reviews, onRemoveReview})
{
    const formatReviewDate = (date) => {
        if (!date) {
            return "Date unavailable";
        }

        const parsedDate = new Date(date);
        return Number.isNaN(parsedDate.getTime())
            ? "Date unavailable"
            : parsedDate.toLocaleDateString();
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
                    <div className="review-card-header">
                        <p className="review-card-rating">Rating: {review.rating}/5</p>
                        <p className="review-card-date">{formatReviewDate(review.date)}</p>
                        {review.cover && (
                            <img className="review-card-image" src={review.cover} alt={`${review.title} cover`} />
                        )}
                    </div>
                    <p className="review-card-copy">{review.reviewText}</p>
                    <button className="review-delete-button" onClick={() => onRemoveReview(review._id)}>Delete Review</button>
                </article>
            ))}
        </div>

    );
}

export default ReviewList
