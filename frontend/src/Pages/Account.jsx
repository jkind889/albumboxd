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
  { id: "activity", label: "Activity" },
  { id: "listenNext", label: "Listen next" },
  { id: "network", label: "Network" },
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

function formatMonthYear(value) {
  if (!value) {
    return "Month unavailable";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Month unavailable";
  }

  return date.toLocaleDateString(undefined, {
    month: "long",
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
  const requestedTab = location.state?.activeTab;
  const [activeTab, setActiveTab] = useState(requestedTab || "overview");
  const [savedViewMode, setSavedViewMode] = useState("grid");
  const [savedAlbums, setSavedAlbums] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [activityItems, setActivityItems] = useState([]);
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
        setActivityItems([]);
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
        let activityData = [];
        let profileData;

        if (isPublicProfile) {
          const encodedPublicUserId = encodeURIComponent(publicUserId);
          const [profileResponse, reviewsResponse] = await Promise.all([
            fetch(`http://localhost:3000/profile/${encodedPublicUserId}`, { headers }),
            fetch(`http://localhost:3000/reviews/review/user/${encodedPublicUserId}`),
          ]);

          if (!profileResponse.ok || !reviewsResponse.ok) {
            throw new Error("Failed to load profile data");
          }

          [profileData, reviewsData] = await Promise.all([
            profileResponse.json(),
            reviewsResponse.json(),
          ]);
        } else {
          const [savedResponse, reviewsResponse, profileResponse, activityResponse] = await Promise.all([
            fetch("http://localhost:3000/collections/collection", { headers }),
            fetch("http://localhost:3000/reviews/review/user/", { headers }),
            fetch("http://localhost:3000/profile/me", { headers }),
            fetch("http://localhost:3000/profile/me/activity", { headers }),
          ]);

          if (!savedResponse.ok || !reviewsResponse.ok || !profileResponse.ok || !activityResponse.ok) {
            throw new Error("Failed to load profile data");
          }

          [savedData, reviewsData, profileData, activityData] = await Promise.all([
            savedResponse.json(),
            reviewsResponse.json(),
            profileResponse.json(),
            activityResponse.json(),
          ]);
        }

        if (!isCurrent) {
          return;
        }

        setSavedAlbums(Array.isArray(savedData) ? savedData : []);
        setReviews(Array.isArray(reviewsData) ? reviewsData : []);
        setActivityItems(Array.isArray(activityData) ? activityData : []);
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
          setActivityItems([]);
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

  useEffect(() => {
    if (requestedTab && availableTabs.some((tab) => tab.id === requestedTab)) {
      setActiveTab(requestedTab);
    }
  }, [availableTabs, requestedTab]);

  const averageRating = useMemo(() => {
    if (reviews.length === 0) {
      return "--";
    }

    const total = reviews.reduce((sum, review) => sum + (Number(review.rating) || 0), 0);
    return (total / reviews.length).toFixed(1);
  }, [reviews]);

  const sortedReviews = useMemo(() => (
    [...reviews].sort((first, second) => new Date(second.date) - new Date(first.date))
  ), [reviews]);
  const sortedSavedAlbums = useMemo(() => (
    [...savedAlbums].sort((first, second) => new Date(second.savedAt) - new Date(first.savedAt))
  ), [savedAlbums]);
  const latestSavedAlbums = useMemo(() => sortedSavedAlbums.slice(0, 6), [sortedSavedAlbums]);
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
    : user?.username || user?.fullName || user?.primaryEmailAddress?.emailAddress || "Your profile";
  const profileImageUrl = isPublicProfile ? publicProfileState.imageUrl : user?.imageUrl;
  const profileKicker = isPublicProfile ? "Profile" : "Current user";
  const showFollowButton = isPublicProfile && !profile.isCurrentUser && (!isSignedIn || !isLoading);
  const profileHandle = displayName;
  const sidebarFacts = [
    { label: "Albums", value: savedAlbums.length },
    { label: "Reviews", value: reviews.length },
    { label: "Avg. Rating", value: averageRating },
    { label: "Followers", value: profile.followerCount },
    { label: "Following", value: profile.followingCount },
  ];
  const recentReviewCount = latestReviews.length;

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
            <h2>Recent Reviews</h2>
          </div>

          {latestReviews.length === 0 ? (
            <ProfileEmptyState
              title="No reviews yet"
              body={canManageProfile
                ? "Reviews you write will appear here."
                : "Reviews are not available on this profile yet."}
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

        <section className="profile-panel">
          <div className="profile-section-header">
            <h2>Popular Reviews</h2>
          </div>

          <ProfileEmptyState
            title="Popular reviews coming soon"
            body="This space is ready for ranked reviews once review engagement data is available."
          />
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
      <section className="profile-saved-section">
        <div className="profile-saved-toolbar">
          <div>
            <h2>Saved Albums</h2>
            <p>{sortedSavedAlbums.length} albums on this shelf</p>
          </div>
          <div className="profile-view-toggle" aria-label="Saved albums view">
            <button
              className={savedViewMode === "grid" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setSavedViewMode("grid")}
            >
              Grid
            </button>
            <button
              className={savedViewMode === "list" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setSavedViewMode("list")}
            >
              List
            </button>
          </div>
        </div>

        {savedViewMode === "grid" ? (
          <div className="profile-album-grid">
            {sortedSavedAlbums.map((album) => (
              <article className="profile-album-card" key={album.spotifyId}>
                <Link to={`/album/${album.spotifyId}`} className="profile-album-card-link">
                  <AlbumCover src={album.cover} title={album.title} />
                  <h3>{album.title || "Untitled album"}</h3>
                  <p>{getArtistName(album)}</p>
                  <span>Saved {formatMonthYear(album.savedAt)}</span>
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
        ) : (
          <div className="profile-saved-list">
            {sortedSavedAlbums.map((album) => (
              <article className="profile-saved-row" key={album.spotifyId}>
                <Link to={`/album/${album.spotifyId}`} className="profile-saved-album">
                  <AlbumCover src={album.cover} title={album.title} />
                  <div>
                    <h3>{album.title || "Untitled album"}</h3>
                    <p>{getArtistName(album)}</p>
                  </div>
                </Link>
                <div className="profile-saved-date">
                  <span>Saved</span>
                  <strong>{formatMonthYear(album.savedAt)}</strong>
                </div>
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
        )}
      </section>
    );
  }

  function renderActivity() {
    if (isPublicProfile) {
      return (
        <ProfileEmptyState
          title="Activity is private"
          body="Following activity is only available from your own profile."
        />
      );
    }

    if (activityItems.length === 0) {
      return (
        <ProfileEmptyState
          title="No activity yet"
          body="Follow listeners with reviews and their latest activity will show up here."
        />
      );
    }

    return (
      <div className="profile-activity-list">
        {activityItems.map((activity) => {
          const actor = activity.actor || {};
          const album = activity.album || {};
          const actorName = actor.username || "albumboxd user";
          const actorState = {
            profileUser: {
              username: actorName,
              imageUrl: actor.imageUrl || "",
            },
          };

          return (
            <article className="profile-activity-item" key={activity.id}>
              <AlbumCover src={album.cover} title={album.title || "Album"} />
              <div>
                <span>Reviewed</span>
                <h3>
                  <Link to={`/profile/${actor.userId}`} state={actorState}>
                    {actorName}
                  </Link>
                  {" reviewed "}
                  <Link to={`/album/${album.spotifyId}`}>
                    {album.title || "Untitled album"}
                  </Link>
                </h3>
                <p>{album.artist || "Artist unknown"}</p>
                {activity.reviewText && <p className="profile-review-copy">{activity.reviewText}</p>}
              </div>
              <div className="profile-activity-meta">
                {activity.rating && <strong>{activity.rating}/5</strong>}
                <time>{formatDate(activity.createdAt)}</time>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  function renderListenNext() {
    return (
      <ProfileEmptyState
        title="Listen next coming soon"
        body="Recommendations and queue-style picks can live here once that logic is ready."
      />
    );
  }

  function renderNetwork() {
    return (
      <ProfileEmptyState
        title="Network coming soon"
        body="Followers, following, and social listening updates will live here once the network layer is built."
      />
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

    if (activeTab === "activity") {
      return renderActivity();
    }

    if (activeTab === "listenNext") {
      return renderListenNext();
    }

    if (activeTab === "network") {
      return renderNetwork();
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

  function renderProfileAction(className = "profile-follow-button") {
    if (!showFollowButton) {
      return null;
    }

    if (isSignedIn) {
      return (
        <button
          className={className}
          type="button"
          disabled={isFollowSaving || isLoading}
          onClick={() => updateFollowState(!profile.isFollowing)}
        >
          {isFollowSaving ? "Saving..." : profile.isFollowing ? "Following" : "Follow"}
        </button>
      );
    }

    return (
      <SignInButton mode="modal">
        <button className={className} type="button">
          Follow
        </button>
      </SignInButton>
    );
  }


  return (
    <>
      <section className="profile-page">
        <div className="profile-layout">
          <main className="profile-main">
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
                    {renderProfileAction()}
                  </div>
                  <p className="profile-joined">{profileHandle}</p>
                  {profile.bio && <p className="profile-bio">{profile.bio}</p>}
                  {canManageProfile && (
                    <Link className="profile-edit-link" to="/account/edit">Edit Profile</Link>
                  )}
                </div>
              </div>

              <div className="profile-hero-links" aria-label="Profile links">
                <button type="button" onClick={() => setActiveTab("saved")}>
                  <span>Albums</span>
                  <strong>{savedAlbums.length}</strong>
                </button>
                <button type="button" onClick={() => setActiveTab("reviews")}>
                  <span>Reviews</span>
                  <strong>{reviews.length}</strong>
                </button>
                <Link to="/account/edit">
                  <span>Social Links</span>
                  <strong>Future</strong>
                </Link>
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
          </main>

          <aside className="profile-sidebar" aria-label="Profile details">
            <div className="profile-sidebar-card">
              <div className="profile-sidebar-banner" />
              <div className="profile-sidebar-body">
                <div className="profile-sidebar-heading">
                  {isLoaded && profileImageUrl ? (
                    <img className="profile-sidebar-avatar" src={profileImageUrl} alt={`${displayName} avatar`} />
                  ) : (
                    <div className="profile-sidebar-avatar profile-avatar-fallback">
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <h2>{displayName}</h2>
                    <p>{profileHandle}</p>
                  </div>
                </div>

                {profile.bio ? (
                  <p className="profile-sidebar-bio">{profile.bio}</p>
                ) : (
                  <p className="profile-sidebar-bio">
                    {canManageProfile
                      ? "Add a bio from edit profile to introduce your listening shelf."
                      : "This listener has not added a bio yet."}
                  </p>
                )}

                <dl className="profile-sidebar-facts">
                  {sidebarFacts.map((fact) => (
                    <div key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>

                <div className="profile-sidebar-section">
                  <h3>Log</h3>
                  {latestSavedAlbums.length === 0 ? (
                    <p>No saved albums logged yet.</p>
                  ) : (
                    <div className="profile-sidebar-log">
                      {latestSavedAlbums.map((album) => (
                        <Link key={album.spotifyId} to={`/album/${album.spotifyId}`}>
                          <span>{formatMonthYear(album.savedAt)}</span>
                          <strong>{album.title || "Untitled album"}</strong>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>

                <div className="profile-sidebar-section">
                  <h3>Activity Log</h3>
                  <div className="profile-sidebar-copy-list">
                    <p>{savedAlbums.length} saved albums</p>
                    <p>{reviews.length} reviews</p>
                    <p>{recentReviewCount} recent reviews</p>
                  </div>
                </div>

                <div className="profile-sidebar-section">
                  <h3>Ratings Scale</h3>
                  <div className="profile-rating-scale" aria-label="Rating scale">
                    <span>1</span>
                    <div />
                    <span>5</span>
                  </div>
                </div>

                <div className="profile-sidebar-section">
                  <h3>Settings</h3>
                  {canManageProfile ? (
                    <Link className="profile-sidebar-button" to="/account/edit">Update Profile</Link>
                  ) : (
                    renderProfileAction("profile-sidebar-button")
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}

export default Account;
