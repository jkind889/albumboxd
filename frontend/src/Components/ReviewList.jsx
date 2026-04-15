
export function ReviewList({reviews, onRemoveReview})
{
    if (reviews.length === 0) return <p>No reviews yet.</p>;


    return (
        <div>
            {reviews.map((review, index) => (
                <div key={index}>
                    <p>Rating: {review.rating}</p>
                    <p>{review.reviewText}</p>
                    <p>{new Date(review.date).toLocaleDateString()}</p>
                    <button onClick={() => onRemoveReview(review.date)}>Delete Review</button>
                </div>
            ))}
        </div>

    );
}

export default ReviewList