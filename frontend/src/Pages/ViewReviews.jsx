import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { useParams } from "react-router-dom";
import ReviewList from "../Components/ReviewList";

export function ViewReviews()
{
    const [reviews, setReviews] = useState([]);
    const [error, setError] = useState("");
    const [likeMessage, setLikeMessage] = useState("");
    const  { getToken, userId: viewerId } = useAuth();
    const { userId } = useParams();
    const isPublicReviewList = Boolean(userId);
    const canManageReviews = !isPublicReviewList;

    
    
    useEffect(() => {
        async function fetchReviews() {
            const encodedUserId = userId ? encodeURIComponent(userId) : "";
            const reviewUrl = isPublicReviewList
                ? `http://localhost:3000/reviews/review/user/${encodedUserId}`
                : "http://localhost:3000/reviews/review/user/";
            const token = viewerId ? await getToken() : null;
            const headers = token ? { Authorization: `Bearer ${token}` } : {};

            const response = await fetch(reviewUrl, { headers });

            if (!response.ok) {
                throw new Error("Failed to fetch reviews");
            }

            const data = await response.json();
            setReviews(Array.isArray(data) ? data : []);
        }

        fetchReviews().catch((reviewError) => {
            console.error(reviewError);
            setReviews([]);
            setError("Could not load reviews right now.");
        });
    }, [canManageReviews, getToken, isPublicReviewList, userId, viewerId]);

    async function removeReview(id) {
        const token = await getToken();
        const res = await fetch(`http://localhost:3000/reviews/review/user/${id}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });
        if (!res.ok) {
            console.error("Failed to delete review");
            return;
        }
        setReviews((prev) => prev.filter((review) => review._id !== id));
    };

    function updateReviewLikeState(reviewId, nextState) {
        setReviews((currentReviews) => (
            currentReviews.map((review) => (
                review._id === reviewId ? { ...review, ...nextState } : review
            ))
        ));
    }

    async function toggleReviewLike(review) {
        if (!viewerId) {
            setLikeMessage("Sign in to like reviews.");
            return;
        }

        const reviewId = review._id;
        const nextLiked = !review.likedByViewer;
        const previousLikeCount = Number(review.likeCount) || 0;
        const nextLikeCount = Math.max(0, previousLikeCount + (nextLiked ? 1 : -1));

        setLikeMessage("");
        updateReviewLikeState(reviewId, {
            likedByViewer: nextLiked,
            likeCount: nextLikeCount,
        });

        try {
            const token = await getToken();
            const response = await fetch(`http://localhost:3000/likes/review/${reviewId}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ liked: nextLiked }),
            });

            if (!response.ok) {
                throw new Error("Failed to update review like");
            }

            const data = await response.json();
            updateReviewLikeState(reviewId, {
                likedByViewer: Boolean(data.likedByViewer),
                likeCount: Number(data.likeCount) || 0,
            });
        } catch (likeError) {
            console.error(likeError);
            updateReviewLikeState(reviewId, {
                likedByViewer: Boolean(review.likedByViewer),
                likeCount: previousLikeCount,
            });
            setLikeMessage("Could not update that like.");
        }
    }





    const recentReviews = useMemo(() => {
        return [...reviews]
            .sort((a, b) => new Date(b.date) - new Date(a.date)) 
            .slice(0, 5);
    }, [reviews]);

    const popularReviews = useMemo(() => {
        return [...reviews]
            .sort((a, b) => (
                (Number(b.likeCount) || 0) - (Number(a.likeCount) || 0)
                || (Number(b.rating) || 0) - (Number(a.rating) || 0)
                || new Date(b.date) - new Date(a.date)
            ))
            .slice(0, 5);
    }, [reviews]);



    return (
        <main className="reviews-page">
            <section className="reviews-section">
                <div className="reviews-section-header">
                    <h1>Reviews</h1>
                    <div className="reviews-filter-row" aria-hidden="true">
                        <span>Rating</span>
                        <span>Diary Year</span>
                        <span>Sort by When Reviewed</span>
                    </div>
                </div>
                {error && <p className="review-list-error">{error}</p>}
                <ReviewList
                    reviews={recentReviews}
                    onRemoveReview={canManageReviews ? removeReview : undefined}
                    onToggleReviewLike={toggleReviewLike}
                    likeMessage={likeMessage}
                />
            </section>

            <section className="reviews-section">
                <div className="reviews-section-header">
                    <h2>Highest Rated</h2>
                </div>
                <ReviewList
                    reviews={popularReviews}
                    onRemoveReview={canManageReviews ? removeReview : undefined}
                    onToggleReviewLike={toggleReviewLike}
                    likeMessage={likeMessage}
                />
            </section>
        </main>
    );


}


export default ViewReviews;
