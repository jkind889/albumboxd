import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { useParams } from "react-router-dom";
import ReviewList from "../Components/ReviewList";

export function ViewReviews()
{
    const [reviews, setReviews] = useState([]);
    const [error, setError] = useState("");
    const  { getToken } = useAuth();
    const { userId } = useParams();
    const isPublicReviewList = Boolean(userId);
    const canManageReviews = !isPublicReviewList;

    
    
    useEffect(() => {
        async function fetchReviews() {
            const encodedUserId = userId ? encodeURIComponent(userId) : "";
            const reviewUrl = isPublicReviewList
                ? `http://localhost:3000/reviews/review/user/${encodedUserId}`
                : "http://localhost:3000/reviews/review/user/";
            const token = canManageReviews ? await getToken() : null;
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
    }, [canManageReviews, getToken, isPublicReviewList, userId]);

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
                />
            </section>

            <section className="reviews-section">
                <div className="reviews-section-header">
                    <h2>Highest Rated</h2>
                </div>
                <ReviewList
                    reviews={popularReviews}
                    onRemoveReview={canManageReviews ? removeReview : undefined}
                />
            </section>
        </main>
    );


}


export default ViewReviews;
