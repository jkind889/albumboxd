import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@clerk/react";
import ReviewList from "../Components/ReviewList";

export function ViewReviews()
{
    const [reviews, setReviews] = useState([]);
    const  { getToken } = useAuth();

    
    
    useEffect(() => {
        async function fetchReviews() {
            const token = await getToken();

            const response = await fetch(`http://localhost:3000/reviews/review/user/`, {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });
            const data = await response.json();
            setReviews(data);
        }

        fetchReviews();
    }, [getToken]);

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
                <ReviewList reviews={recentReviews} onRemoveReview={removeReview} />
            </section>

            <section className="reviews-section">
                <div className="reviews-section-header">
                    <h2>Highest Rated</h2>
                </div>
                <ReviewList reviews={popularReviews} onRemoveReview={removeReview} />
            </section>
        </main>
    );


}


export default ViewReviews;
