export function LikeButton({
  liked,
  count,
  label = "like",
  disabled = false,
  message = "",
  onToggle,
}) {
  const likeCount = Number(count) || 0;
  const buttonLabel = `${liked ? "Unlike" : "Like"} ${label}`;

  return (
    <div className="like-control">
      <button
        className={liked ? "like-button like-button-active" : "like-button"}
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={liked}
        aria-label={buttonLabel}
      >
        <span aria-hidden="true">{liked ? "♥" : "♡"}</span>
        <strong>{likeCount}</strong>
      </button>
      {message && <small className="like-message">{message}</small>}
    </div>
  );
}

export default LikeButton;
