import { API_BASE_URL } from "../config/api";
import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@clerk/react";
import { useParams } from "react-router-dom";
import ReviewList from "../Components/ReviewList";
import { getApiErrorMessage } from "../utils/apiErrors";

export function ViewReviews()
{
    const [reviews, setReviews] = useState([]);
    const [error, setError] = useState("");
    const [likeMessage, setLikeMessage] = useState("");
    const [editMessage, setEditMessage] = useState("");
    const [editingReview, setEditingReview] = useState(null);
    const [reviewDateSort, setReviewDateSort] = useState("latest");
    const  { getToken, userId: viewerId } = useAuth();
    const { userId } = useParams();
    const isPublicReviewList = Boolean(userId);
    const canManageReviews = !isPublicReviewList;

    
    
    useEffect(() => {
        async function fetchReviews() {
            const encodedUserId = userId ? encodeURIComponent(userId) : "";
            const reviewUrl = isPublicReviewList
                ? `${API_BASE_URL}/reviews/review/user/${encodedUserId}`
                : `${API_BASE_URL}/reviews/review/user/`;
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
        const res = await fetch(`${API_BASE_URL}/reviews/review/user/${id}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });
        if (!res.ok) {
            const message = await getApiErrorMessage(res, "Failed to delete review");
            console.error("Failed to delete review");
            setEditMessage(message);
            return;
        }
        setReviews((prev) => prev.filter((review) => review._id !== id));
    };

    async function editReview(id, updates) {
        setEditMessage("");

        try {
            const token = await getToken();
            const res = await fetch(`${API_BASE_URL}/reviews/review/user/${id}`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify(updates)
            });

            if (!res.ok) {
                throw new Error(await getApiErrorMessage(res, "Failed to edit review"));
            }

            const updatedReview = await res.json();
            setReviews((prev) => (
                prev.map((review) => (
                    review._id === id ? updatedReview : review
                ))
            ));
            setEditingReview(null);
            return true;
        } catch (reviewError) {
            console.error(reviewError);
            setEditMessage(reviewError.message || "Could not edit that review.");
            return false;
        }
    }

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
            const response = await fetch(`${API_BASE_URL}/likes/review/${reviewId}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ liked: nextLiked }),
            });

            if (!response.ok) {
                throw new Error(await getApiErrorMessage(response, "Failed to update review like"));
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
            setLikeMessage(likeError.message || "Could not update that like.");
        }
    }





    const dateSortedReviews = useMemo(() => {
        const sortDirection = reviewDateSort === "earliest" ? 1 : -1;

        return [...reviews]
            .sort((a, b) => sortDirection * (new Date(a.date) - new Date(b.date)));
    }, [reviews, reviewDateSort]);

    const mostLikedReviews = useMemo(() => {
        return [...reviews]
            .sort((a, b) => (
                (Number(b.likeCount) || 0) - (Number(a.likeCount) || 0)
                || (Number(b.rating) || 0) - (Number(a.rating) || 0)
                || new Date(b.date) - new Date(a.date)
            ));
    }, [reviews]);

    const dateSortedReviewHeading = reviewDateSort === "earliest"
        ? "Earliest Reviews"
        : "Latest Reviews";



    return (
        <main className="reviews-page">
            <section className="reviews-section">
                <div className="reviews-section-header">
                    <div>
                        <p className="reviews-kicker">Review shelf</p>
                        <h1>{dateSortedReviewHeading}</h1>
                    </div>
                    <div className="reviews-sort-control">
                        <label htmlFor="review-date-sort">When reviewed</label>
                        <select
                            id="review-date-sort"
                            value={reviewDateSort}
                            onChange={(event) => setReviewDateSort(event.target.value)}
                        >
                            <option value="latest">Latest first</option>
                            <option value="earliest">Earliest first</option>
                        </select>
                    </div>
                </div>
                {error && <p className="review-list-error">{error}</p>}
                <ReviewList
                    listId="recent"
                    reviews={dateSortedReviews}
                    onRemoveReview={canManageReviews ? removeReview : undefined}
                    onEditReview={canManageReviews ? editReview : undefined}
                    editingReview={editingReview}
                    onStartEdit={(reviewId, listId) => setEditingReview({ reviewId, listId })}
                    onCancelEdit={() => {
                        setEditingReview(null);
                        setEditMessage("");
                    }}
                    onToggleReviewLike={toggleReviewLike}
                    likeMessage={likeMessage}
                    editMessage={editMessage}
                />
            </section>

            <section className="reviews-section">
                <div className="reviews-section-header">
                    <h2>Most Liked</h2>
                </div>
                <ReviewList
                    listId="most-liked"
                    reviews={mostLikedReviews}
                    onRemoveReview={canManageReviews ? removeReview : undefined}
                    onEditReview={canManageReviews ? editReview : undefined}
                    editingReview={editingReview}
                    onStartEdit={(reviewId, listId) => setEditingReview({ reviewId, listId })}
                    onCancelEdit={() => {
                        setEditingReview(null);
                        setEditMessage("");
                    }}
                    onToggleReviewLike={toggleReviewLike}
                    likeMessage={likeMessage}
                    editMessage={editMessage}
                />
            </section>
        </main>
    );


}


export default ViewReviews;
