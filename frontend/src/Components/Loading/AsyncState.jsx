function SkeletonLine({ className = "" }) {
  return <span className={`async-skeleton-line ${className}`} />;
}

function GridSkeleton() {
  return (
    <div className="async-skeleton-grid" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="async-skeleton-card" key={index}>
          <span className="async-skeleton-cover" />
          <SkeletonLine className="async-skeleton-line-wide" />
          <SkeletonLine />
          <SkeletonLine className="async-skeleton-line-short" />
        </div>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="async-skeleton-list" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, index) => (
        <div className="async-skeleton-row" key={index}>
          <span className="async-skeleton-thumb" />
          <SkeletonLine className="async-skeleton-line-wide" />
          <SkeletonLine />
          <SkeletonLine className="async-skeleton-line-short" />
          <SkeletonLine className="async-skeleton-line-tiny" />
        </div>
      ))}
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="async-skeleton-profile" aria-hidden="true">
      <div>
        <span className="async-skeleton-avatar" />
      </div>
      <div>
        <SkeletonLine className="async-skeleton-line-title" />
        <SkeletonLine className="async-skeleton-line-wide" />
        <SkeletonLine />
        <div className="async-skeleton-pill-row">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="async-skeleton-detail" aria-hidden="true">
      <span className="async-skeleton-poster" />
      <div>
        <SkeletonLine className="async-skeleton-line-title" />
        <SkeletonLine className="async-skeleton-line-wide" />
        <SkeletonLine />
        <SkeletonLine className="async-skeleton-line-short" />
        <div className="async-skeleton-pill-row">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="async-skeleton-page" aria-hidden="true">
      <SkeletonLine className="async-skeleton-line-title" />
      <SkeletonLine className="async-skeleton-line-wide" />
      <SkeletonLine />
    </div>
  );
}

function LoadingSkeleton({ variant }) {
  if (variant === "grid") {
    return <GridSkeleton />;
  }

  if (variant === "list") {
    return <ListSkeleton />;
  }

  if (variant === "profile") {
    return <ProfileSkeleton />;
  }

  if (variant === "detail") {
    return <DetailSkeleton />;
  }

  return <PageSkeleton />;
}

export function AsyncState({
  isLoading = false,
  error = "",
  isEmpty = false,
  loadingVariant = "page",
  loadingMessage = "Loading...",
  errorTitle = "Something went wrong",
  emptyTitle = "Nothing here yet",
  emptyBody = "",
  children,
}) {
  if (isLoading) {
    return (
      <div className={`async-state async-state-loading async-state-${loadingVariant}`} role="status" aria-live="polite">
        <LoadingSkeleton variant={loadingVariant} />
        <span className="async-state-sr">{loadingMessage}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="async-state async-state-message" role="alert">
        <h3>{errorTitle}</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="async-state async-state-message">
        <h3>{emptyTitle}</h3>
        {emptyBody && <p>{emptyBody}</p>}
      </div>
    );
  }

  return children;
}

export default AsyncState;
