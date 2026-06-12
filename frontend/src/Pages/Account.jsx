import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  RedirectToSignIn,
  SignInButton,
  UserProfile,
  useAuth,
  useUser,
} from "@clerk/react";

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "saved", label: "Saved Albums" },
  { id: "reviews", label: "Reviews" },
  { id: "settings", label: "Settings" },
];

function formatDate(value) {
  if (!value) {
    return "Date unavailable";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getArtistName(album) {
  if (Array.isArray(album.artists) && album.artists.length > 0) {
    return album.artists.join(", ");
  }

  return album.artist || "Artist unknown";
}

function ProfileEmptyState({ title, body }) {
  return (
    <div className="profile-empty-state">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function AlbumCover({ src, title }) {
  if (!src) {
    return <div className="profile-cover-fallback">No cover</div>;
  }

  return <img className="profile-cover" src={src} alt={`${title} cover`} />;
}

export function Account() {
  const { getToken, isSignedIn } = useAuth();
  const { user, isLoaded } = useUser();
  const { userId: publicUserId } = useParams();
  const location = useLocation();
  const isPublicProfile = Boolean(publicUserId);
  const [activeTab, setActiveTab] = useState("overview");
  const [savedAlbums, setSavedAlbums] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [profile, setProfile] = useState({
    userId: "",
    bio: "",
    favoriteAlbums: [],
    followerCount: 0,
    followingCount: 0,
    isFollowing: false,
    isCurrentUser: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isFollowSaving, setIsFollowSaving] = useState(false);
  const [error, setError] = useState("");
  const publicProfileState = location.state?.profileUser || {};
  const canManageProfile = !isPublicProfile;
  const availableTabs = useMemo(
    () => (canManageProfile ? tabs : tabs.filter((tab) => tab.id !== "settings")),
    [canManageProfile],
  );

  useEffect(() => {
    let isCurrent = true;

    async function fetchProfileData() {
      if (!isPublicProfile && !isSignedIn) {
        setSavedAlbums([]);
        setReviews([]);
        setProfile({
          userId: "",
          bio: "",
          favoriteAlbums: [],
          followerCount: 0,
          followingCount: 0,
          isFollowing: false,
          isCurrentUser: false,
        });
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError("");

        const token = isSignedIn ? await getToken() : null;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        let savedData = [];
        let reviewsData = [];
        let profileData;

        if (isPublicProfile) {
          const profileResponse = await fetch(
            `http://localhost:3000/profile/${encodeURIComponent(publicUserId)}`,
            { headers },
          );

          if (!profileResponse.ok) {
            throw new Error("Failed to load profile data");
          }

          profileData = await profileResponse.json();
        } else {
          const [savedResponse, reviewsResponse, profileResponse] = await Promise.all([
            fetch("http://localhost:3000/collections/collection", { headers }),
            fetch("http://localhost:3000/reviews/review/user/", { headers }),
            fetch("http://localhost:3000/profile/me", { headers }),
          ]);

          if (!savedResponse.ok || !reviewsResponse.ok || !profileResponse.ok) {
            throw new Error("Failed to load profile data");
          }

          [savedData, reviewsData, profileData] = await Promise.all([
            savedResponse.json(),
            reviewsResponse.json(),
            profileResponse.json(),
          ]);
        }

        if (!isCurrent) {
          return;
        }

        setSavedAlbums(Array.isArray(savedData) ? savedData : []);
        setReviews(Array.isArray(reviewsData) ? reviewsData : []);
        setProfile({
          userId: profileData.userId || publicUserId || "",
          bio: typeof profileData.bio === "string" ? profileData.bio : "",
          favoriteAlbums: Array.isArray(profileData.favoriteAlbums) ? profileData.favoriteAlbums : [],
          followerCount: Number(profileData.followerCount) || 0,
          followingCount: Number(profileData.followingCount) || 0,
          isFollowing: Boolean(profileData.isFollowing),
          isCurrentUser: Boolean(profileData.isCurrentUser),
        });
      } catch (profileError) {
        console.error(profileError);

        if (isCurrent) {
          setSavedAlbums([]);
          setReviews([]);
          setProfile({
            userId: publicUserId || "",
            bio: "",
            favoriteAlbums: [],
            followerCount: 0,
            followingCount: 0,
            isFollowing: false,
            isCurrentUser: false,
          });
          setError(isPublicProfile
            ? "Could not load this profile right now."
            : "Could not load your profile right now.");
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    fetchProfileData();

    return () => {
      isCurrent = false;
    };
  }, [getToken, isPublicProfile, isSignedIn, publicUserId]);

  useEffect(() => {
    if (!availableTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, availableTabs]);

  const averageRating = useMemo(() => {
    if (reviews.length === 0) {
      return "--";
    }

    const total = reviews.reduce((sum, review) => sum + (Number(review.rating) || 0), 0);
    return (total / reviews.length).toFixed(1);
  }, [reviews]);

  const recentActivity = useMemo(() => {
    const savedActivity = savedAlbums.map((album) => ({
      id: `saved-${album.spotifyId}`,
      type: "Saved album",
      title: album.title || "Untitled album",
      subtitle: getArtistName(album),
      cover: album.cover,
      spotifyId: album.spotifyId,
      date: album.savedAt,
    }));

    const reviewActivity = reviews.map((review) => ({
      id: `review-${review._id}`,
      type: "Reviewed album",
      title: review.title || "Untitled album",
      subtitle: `${review.rating}/5 rating`,
      cover: review.cover,
      spotifyId: review.spotifyId,
      date: review.date,
    }));

    return [...savedActivity, ...reviewActivity]
      .sort((first, second) => new Date(second.date) - new Date(first.date))
      .slice(0, 8);
  }, [savedAlbums, reviews]);

  const sortedReviews = useMemo(() => (
    [...reviews].sort((first, second) => new Date(second.date) - new Date(first.date))
  ), [reviews]);
  const latestSavedAlbums = useMemo(() => savedAlbums.slice(0, 6), [savedAlbums]);
  const latestReviews = useMemo(() => sortedReviews.slice(0, 4), [sortedReviews]);
  const favoriteAlbums = profile.favoriteAlbums;

  async function removeSavedAlbum(spotifyId) {
    const token = await getToken();
    const response = await fetch(
      `http://localhost:3000/collections/collection/album/${spotifyId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      console.error("Failed to remove album from saved albums");
      return;
    }

    setSavedAlbums((currentAlbums) => (
      currentAlbums.filter((album) => album.spotifyId !== spotifyId)
    ));
  }

  async function removeReview(reviewId) {
    const token = await getToken();
    const response = await fetch(
      `http://localhost:3000/reviews/review/user/${reviewId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      console.error("Failed to delete review");
      return;
    }

    setReviews((currentReviews) => (
      currentReviews.filter((review) => review._id !== reviewId)
    ));
  }

  async function updateFollowState(nextFollowing) {
    if (!profile.userId || isFollowSaving) {
      return;
    }

    try {
      setIsFollowSaving(true);
      setError("");

      const token = await getToken();
      const response = await fetch(
        `http://localhost:3000/profile/${encodeURIComponent(profile.userId)}/follow`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ following: nextFollowing }),
        },
      );

      if (!response.ok) {
        throw new Error("Failed to update follow status");
      }

      const data = await response.json();

      setProfile((currentProfile) => ({
        ...currentProfile,
        followerCount: Number(data.followerCount) || 0,
        followingCount: Number(data.followingCount) || 0,
        isFollowing: Boolean(data.isFollowing),
        isCurrentUser: Boolean(data.isCurrentUser),
      }));
    } catch (followError) {
      console.error(followError);
      setError("Could not update follow status right now.");
    } finally {
      setIsFollowSaving(false);
    }
  }

  const displayName = isPublicProfile
    ? publicProfileState.username || profile.userId || "albumboxd user"
    : user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || "Your profile";
  const profileImageUrl = isPublicProfile ? publicProfileState.imageUrl : user?.imageUrl;
  const joinedDate = !isPublicProfile && user?.createdAt ? formatDate(user.createdAt) : null;
  const profileKicker = isPublicProfile ? "Profile" : "Current user";
  const showFollowButton = isPublicProfile && !profile.isCurrentUser && (!isSignedIn || !isLoading);

  function renderOverview() {
    return (
      <div className="profile-overview-grid">
        <section className="profile-panel profile-wide-panel">
          <div className="profile-section-header">
            <h2>Favorite Albums</h2>
          </div>

          {favoriteAlbums.length === 0 ? (
            <ProfileEmptyState
              title="No favorites chosen"
              body={canManageProfile
                ? "Choose up to five favorite albums from edit profile."
                : "Favorite albums will show up here once this listener chooses them."}
            />
          ) : (
            <div className="profile-favorites-grid">
              {favoriteAlbums.map((album, index) => (
                <Link
                  className="profile-favorite-card"
                  key={album.spotifyId}
                  to={`/album/${album.spotifyId}`}
                >
                  <span className="profile-favorite-rank">{index + 1}</span>
                  <AlbumCover src={album.cover} title={album.title} />
                  <h3>{album.title || "Untitled album"}</h3>
                  <p>{getArtistName(album)}</p>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="profile-panel">
          <div className="profile-section-header">
            <h2>Recent Activity</h2>
          </div>

          {recentActivity.length === 0 ? (
            <ProfileEmptyState
              title="No activity yet"
              body={canManageProfile
                ? "Save an album or write a review to start building your profile."
                : "Public activity is not available for this profile yet."}
            />
          ) : (
            <div className="profile-activity-list">
              {recentActivity.map((activity) => (
                <Link
                  className="profile-activity-item"
                  key={activity.id}
                  to={`/album/${activity.spotifyId}`}
                >
                  <AlbumCover src={activity.cover} title={activity.title} />
                  <div>
                    <span>{activity.type}</span>
                    <h3>{activity.title}</h3>
                    <p>{activity.subtitle}</p>
                  </div>
                  <time>{formatDate(activity.date)}</time>
                </Link>
              ))}
            </div>
          )}
        </section>

        <aside className="profile-panel">
          <div className="profile-section-header">
            <h2>Recently Saved</h2>
          </div>

          {latestSavedAlbums.length === 0 ? (
            <ProfileEmptyState
              title="No saved albums"
              body={canManageProfile
                ? "Albums you save will show up here."
                : "Saved albums are not available for this profile yet."}
            />
          ) : (
            <div className="profile-mini-album-list">
              {latestSavedAlbums.map((album) => (
                <Link
                  className="profile-mini-album"
                  key={album.spotifyId}
                  to={`/album/${album.spotifyId}`}
                >
                  <AlbumCover src={album.cover} title={album.title} />
                  <div>
                    <h3>{album.title || "Untitled album"}</h3>
                    <p>{getArtistName(album)}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </aside>

        <section className="profile-panel profile-wide-panel">
          <div className="profile-section-header">
            <h2>Latest Reviews</h2>
          </div>

          {latestReviews.length === 0 ? (
            <ProfileEmptyState
              title="No reviews yet"
              body={canManageProfile
                ? "Reviews you write will appear on your profile."
                : "Reviews are not available on public profiles yet."}
            />
          ) : (
            <div className="profile-review-list">
              {latestReviews.map((review) => (
                <article className="profile-review-card" key={review._id}>
                  <Link className="profile-review-album" to={`/album/${review.spotifyId}`}>
                    <AlbumCover src={review.cover} title={review.title} />
                    <div>
                      <h3>{review.title || "Untitled album"}</h3>
                      <p>{review.artist || "Artist unknown"}</p>
                    </div>
                  </Link>
                  <div className="profile-review-meta">
                    <span>{review.rating}/5</span>
                    <time>{formatDate(review.date)}</time>
                  </div>
                  <p className="profile-review-copy">{review.reviewText}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  function renderSavedAlbums() {
    if (savedAlbums.length === 0) {
      return (
        <ProfileEmptyState
          title="No saved albums"
          body={canManageProfile
            ? "Save albums from their detail pages and they will collect here."
            : "Saved albums are not available for this profile yet."}
        />
      );
    }

    return (
      <div className="profile-album-grid">
        {savedAlbums.map((album) => (
          <article className="profile-album-card" key={album.spotifyId}>
            <Link to={`/album/${album.spotifyId}`} className="profile-album-card-link">
              <AlbumCover src={album.cover} title={album.title} />
              <h3>{album.title || "Untitled album"}</h3>
              <p>{getArtistName(album)}</p>
              <span>{album.year || "Year unknown"}</span>
            </Link>
            {canManageProfile && (
              <button
                className="profile-secondary-button"
                type="button"
                onClick={() => removeSavedAlbum(album.spotifyId)}
              >
                Remove
              </button>
            )}
          </article>
        ))}
      </div>
    );
  }

  function renderReviews() {
    if (sortedReviews.length === 0) {
      return (
        <ProfileEmptyState
          title="No reviews yet"
          body={canManageProfile
            ? "Your album reviews will live here once you write them."
            : "Reviews are not available on public profiles yet."}
        />
      );
    }

    return (
      <div className="profile-review-list">
        {sortedReviews.map((review) => (
          <article className="profile-review-card" key={review._id}>
            <Link className="profile-review-album" to={`/album/${review.spotifyId}`}>
              <AlbumCover src={review.cover} title={review.title} />
              <div>
                <h3>{review.title || "Untitled album"}</h3>
                <p>{review.artist || "Artist unknown"}</p>
              </div>
            </Link>
            <div className="profile-review-meta">
              <span>{review.rating}/5</span>
              <time>{formatDate(review.date)}</time>
            </div>
            <p className="profile-review-copy">{review.reviewText}</p>
            {canManageProfile && (
              <button
                className="profile-secondary-button"
                type="button"
                onClick={() => removeReview(review._id)}
              >
                Delete Review
              </button>
            )}
          </article>
        ))}
      </div>
    );
  }

  function renderActiveTab() {
    if (isLoading) {
      return (
        <ProfileEmptyState
          title="Loading profile"
          body={canManageProfile
            ? "Pulling together your saved albums and reviews."
            : "Pulling together this listener's profile."}
        />
      );
    }

    if (error) {
      return <ProfileEmptyState title="Profile unavailable" body={error} />;
    }

    if (activeTab === "overview") {
      return renderOverview();
    }

    if (activeTab === "saved") {
      return renderSavedAlbums();
    }

    if (activeTab === "reviews") {
      return renderReviews();
    }

    return (
      <div className="profile-settings-panel">
        <UserProfile />
      </div>
    );
  }

  if (!isPublicProfile && !isSignedIn) {
    return <RedirectToSignIn />;
  }

  return (
    <>
      <section className="profile-page">
        <header className="profile-hero">
          <div className="profile-identity">
            {isLoaded && profileImageUrl ? (
              <img className="profile-avatar" src={profileImageUrl} alt={`${displayName} avatar`} />
            ) : (
              <div className="profile-avatar profile-avatar-fallback">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}

            <div>
              <p className="profile-kicker">{profileKicker}</p>
              <div className="profile-name-row">
                <h1>{displayName}</h1>
                {showFollowButton && (
                  isSignedIn ? (
                    <button
                      className="profile-follow-button"
                      type="button"
                      disabled={isFollowSaving || isLoading}
                      onClick={() => updateFollowState(!profile.isFollowing)}
                    >
                      {isFollowSaving ? "Saving..." : profile.isFollowing ? "Following" : "Follow"}
                    </button>
                  ) : (
                    <SignInButton mode="modal">
                      <button className="profile-follow-button" type="button">
                        Follow
                      </button>
                    </SignInButton>
                  )
                )}
              </div>
              {joinedDate && <p className="profile-joined">Listening since {joinedDate}</p>}
              {profile.bio && <p className="profile-bio">{profile.bio}</p>}
              {canManageProfile && (
                <Link className="profile-edit-link" to="/account/edit">Edit Profile</Link>
              )}
            </div>
          </div>

          <div className="profile-stat-grid" aria-label="Profile stats">
            <div>
              <span>Saved</span>
              <strong>{savedAlbums.length}</strong>
            </div>
            <div>
              <span>Reviews</span>
              <strong>{reviews.length}</strong>
            </div>
            <div>
              <span>Avg. Rating</span>
              <strong>{averageRating}</strong>
            </div>
            <div>
              <span>Followers</span>
              <strong>{profile.followerCount}</strong>
            </div>
            <div>
              <span>Following</span>
              <strong>{profile.followingCount}</strong>
            </div>
          </div>
        </header>

        <nav className="profile-tabs" aria-label="Profile sections">
          {availableTabs.map((tab) => (
            <button
              className={activeTab === tab.id ? "profile-tab profile-tab-active" : "profile-tab"}
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="profile-tab-panel">
          {renderActiveTab()}
        </div>
      </section>
    </>
  );
}

export default Account;
