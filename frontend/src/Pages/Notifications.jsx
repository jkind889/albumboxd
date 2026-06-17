import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import AsyncState from "../Components/Loading/AsyncState";

function formatNotificationDate(value) {
  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return "Date unavailable";
  }

  return parsedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getNotificationCopy(notification) {
  const actorName = notification.actor?.username || "Someone";

  if (notification.type === "review_like") {
    return `${actorName} liked your review`;
  }

  if (notification.type === "follow") {
    return `${actorName} followed you`;
  }

  return `${actorName} sent you a notification`;
}

function getNotificationPath(notification) {
  if (notification.type === "review_like" && notification.spotifyId) {
    return `/album/${notification.spotifyId}`;
  }

  if (notification.type === "follow" && notification.actorUserId) {
    return `/profile/${encodeURIComponent(notification.actorUserId)}`;
  }

  return "/account";
}

function getNotificationTypeLabel(notification) {
  if (notification.type === "review_like") {
    return "Review like";
  }

  if (notification.type === "follow") {
    return "Follow";
  }

  return "Notification";
}

export function Notifications() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let isCurrent = true;

    async function fetchNotifications() {
      if (!isLoaded) {
        return;
      }

      if (!isSignedIn) {
        setIsLoading(false);
        setNotifications([]);
        return;
      }

      try {
        setIsLoading(true);
        setError("");

        const token = await getToken();
        const response = await fetch("http://localhost:3000/notifications", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error("Failed to load notifications");
        }

        const data = await response.json();

        if (!isCurrent) {
          return;
        }

        setNotifications(Array.isArray(data.notifications) ? data.notifications : []);
      } catch (notificationError) {
        console.error(notificationError);

        if (isCurrent) {
          setError("Could not load your notifications right now.");
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    fetchNotifications();

    return () => {
      isCurrent = false;
    };
  }, [getToken, isLoaded, isSignedIn]);

  const sortedNotifications = useMemo(() => [...notifications].sort((first, second) => (
    new Date(second.createdAt) - new Date(first.createdAt)
  )), [notifications]);

  return (
    <section className="notifications-page">
      <div className="notifications-header">
        <div>
          <p className="reviews-kicker">Account</p>
          <h1>Notifications</h1>
        </div>
      </div>

      <AsyncState
        isLoading={isLoading || !isLoaded}
        error={error}
        isEmpty={sortedNotifications.length === 0}
        loadingVariant="list"
        loadingMessage="Loading notifications..."
        errorTitle="Notifications unavailable"
        emptyTitle="No notifications yet"
        emptyBody="Likes and follows will appear here when listeners interact with you."
      >
        <div className="notifications-list">
          {sortedNotifications.map((notification) => (
            <Link
              className={notification.readAt ? "notification-row" : "notification-row notification-row-unread"}
              key={notification._id}
              to={getNotificationPath(notification)}
            >
              {!notification.readAt && <span className="notification-unread-dot" aria-label="Unread notification" />}
              <div className="notification-avatar-wrap">
                {notification.actor?.imageUrl ? (
                  <img
                    className="notification-avatar"
                    src={notification.actor.imageUrl}
                    alt=""
                  />
                ) : (
                  <span className="notification-avatar notification-avatar-fallback">
                    {(notification.actor?.username || "A").slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="notification-copy">
                <span>{getNotificationTypeLabel(notification)}</span>
                <h2>{getNotificationCopy(notification)}</h2>
                {notification.review ? (
                  <p>{notification.review.title || "Untitled album"} by {notification.review.artist || "Unknown artist"}</p>
                ) : (
                  <p>{notification.actor?.username || notification.actorUserId}</p>
                )}
              </div>
              <time dateTime={notification.createdAt}>{formatNotificationDate(notification.createdAt)}</time>
            </Link>
          ))}
        </div>
      </AsyncState>
    </section>
  );
}

export default Notifications;
