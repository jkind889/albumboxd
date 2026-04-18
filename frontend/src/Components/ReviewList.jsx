
export function ReviewList({reviews, onRemoveReview})
{
    if (reviews.length === 0) {
        return (
            <div className="review-list-empty">
                <p>No reviews yet.</p>
            </div>
        );
    }


    return (
        <div className="review-list">
            {reviews.map((review, index) => (
                <article className="review-card" key={index}>
                    <div className="review-card-header">
                        <p className="review-card-rating">Rating: {review.rating}/5</p>
                        <p className="review-card-date">{new Date(review.date).toLocaleDateString()}</p>
                    </div>
                    <p className="review-card-copy">{review.reviewText}</p>
                    <button className="review-delete-button" onClick={() => onRemoveReview(review.date)}>Delete Review</button>
                </article>
            ))}
        </div>

    );
}

export default ReviewList
