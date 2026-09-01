import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import SuggestionForm from "../Components/Community/SuggestionForm";
import { API_BASE_URL } from "../config/api";
import {
  communityErrorFrom,
  formatCommunityDate,
  requestCommunityJson,
} from "../features/community/community";

function EditorError({ error, onRetry = null }) {
  if (!error) {
    return null;
  }

  return (
    <div className="community-error" role="alert">
      <p className="community-error-message">{error.message || "Something went wrong."}</p>
      {error.code ? <p className="community-error-code">Code: {error.code}</p> : null}
      {error.details?.length ? (
        <ul className="community-error-details">
          {error.details.map((detail, index) => <li key={`${detail}-${index}`}>{detail}</li>)}
        </ul>
      ) : null}
      {error.retryAfterSeconds ? (
        <p className="community-error-retry-after">Try again in about {error.retryAfterSeconds} seconds.</p>
      ) : null}
      {onRetry ? (
        <button className="community-error-retry" type="button" onClick={onRetry}>Try again</button>
      ) : null}
    </div>
  );
}

export function SuggestionEditor({ mode = "create" }) {
  const { submissionId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const isRevision = mode === "revise";
  const externalMbid = isRevision ? "" : (searchParams.get("mbid") || "").trim();
  const [submission, setSubmission] = useState(null);
  const [loadStatus, setLoadStatus] = useState(isRevision || externalMbid ? "idle" : "ready");
  const [loadError, setLoadError] = useState(null);
  const [mutationStatus, setMutationStatus] = useState("idle");
  const [mutationError, setMutationError] = useState(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function loadEditorData() {
      if (!isRevision && !externalMbid) {
        setSubmission(null);
        setLoadError(null);
        setLoadStatus("ready");
        return;
      }

      if (isRevision && !submissionId) {
        setLoadError({
          message: "No suggestion ID was provided.",
          code: "MISSING_SUBMISSION_ID",
          details: [],
        });
        setLoadStatus("error");
        return;
      }

      setLoadStatus("loading");
      setLoadError(null);
      setSubmission(null);

      try {
        let data;
        if (isRevision) {
          const token = await getToken();
          if (controller.signal.aborted) return;
          data = await requestCommunityJson(
            `${API_BASE_URL}/suggestions/${encodeURIComponent(submissionId)}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: controller.signal,
            },
            "Could not load this suggestion for revision.",
          );
        } else {
          data = await requestCommunityJson(
            `${API_BASE_URL}/search/musicbrainz/release-group/${encodeURIComponent(externalMbid)}`,
            { signal: controller.signal },
            "Could not load this MusicBrainz release group.",
          );

          if (!data?.proposedMetadata) {
            const alreadyInCatalogError = new Error("This album is already in the Rescened catalog.");
            alreadyInCatalogError.code = "ALBUM_ALREADY_IN_CATALOG";
            alreadyInCatalogError.details = data?.albumId ? ["Open the catalog album instead of submitting a duplicate suggestion."] : [];
            alreadyInCatalogError.albumId = data?.albumId || "";
            throw alreadyInCatalogError;
          }
        }

        if (controller.signal.aborted) return;
        setSubmission(data);
        setLoadStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadError(communityErrorFrom(
          error,
          isRevision ? "Could not load this suggestion for revision." : "Could not load this MusicBrainz release group.",
        ));
        setLoadStatus("error");
      }
    }

    loadEditorData();
    return () => controller.abort();
  }, [externalMbid, getToken, isRevision, refreshIndex, submissionId]);

  async function submitSuggestion(payload) {
    setMutationStatus("loading");
    setMutationError(null);

    try {
      const token = await getToken();
      const endpoint = isRevision
        ? `${API_BASE_URL}/suggestions/${encodeURIComponent(submissionId)}/revise`
        : `${API_BASE_URL}/suggestions`;
      const data = await requestCommunityJson(
        endpoint,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        },
        isRevision ? "Could not submit this revision." : "Could not create this suggestion.",
      );

      setMutationStatus("success");
      navigate(`/suggestions/${data.submissionId}`, {
        replace: isRevision,
        state: {
          notice: isRevision
            ? "Revision submitted. The suggestion is back in the moderation queue."
            : "Suggestion submitted for community review.",
        },
      });
    } catch (error) {
      setMutationError(communityErrorFrom(
        error,
        isRevision ? "Could not submit this revision." : "Could not create this suggestion.",
      ));
      setMutationStatus("error");
    }
  }

  const latestChangeRequest = isRevision
    ? [...(submission?.moderationHistory || [])]
      .reverse()
      .find((event) => ["request_changes", "requested_changes"].includes(event.action))
    : null;
  const revisionBlocked = isRevision && submission && submission.status !== "needs_changes";
  const externalPrefill = !isRevision && Boolean(externalMbid);

  return (
    <section className="community-page community-editor-page">
      <div className="community-page-frame community-editor-frame">
        <nav className="community-breadcrumb" aria-label="Suggestions breadcrumb">
          <Link
            className="community-back-link"
            to={submissionId ? `/suggestions/${submissionId}` : "/search"}
          >
            ← {submissionId ? "Suggestion detail" : "Your suggestions"}
          </Link>
        </nav>

        <header className="community-page-header community-editor-header">
          <div className="community-page-heading-copy">
            <p className="community-page-kicker">{isRevision ? "Contributor revision" : "New catalog proposal"}</p>
            <h1 className="community-page-title">{isRevision ? "Revise an album suggestion" : "Suggest an album"}</h1>
            <p className="community-page-description">
              {isRevision
                ? "Update the complete record—not only the requested fields—then return it to the queue."
                : externalPrefill
                  ? "Review this MusicBrainz record, complete any missing evidence, and send it to the community queue."
                  : "Build a reviewable album record and back every proposal with reliable source evidence."}
            </p>
          </div>
        </header>

        {loadStatus === "loading" ? (
          <div className="community-loading" role="status" aria-live="polite">
            <span className="community-loading-index">Loading</span>
            <p className="community-loading-message">
              {externalPrefill ? "Preparing MusicBrainz release group…" : "Preparing the latest revision…"}
            </p>
          </div>
        ) : null}
        {loadStatus === "error" ? (
          <EditorError
            error={loadError}
            onRetry={() => setRefreshIndex((current) => current + 1)}
          />
        ) : null}

        {revisionBlocked ? (
          <section className="suggestion-editor-blocked">
            <p className="suggestion-editor-blocked-index">Revision unavailable</p>
            <h2 className="suggestion-editor-blocked-title">This suggestion is not awaiting changes.</h2>
            <p className="suggestion-editor-blocked-description">
              Only suggestions with a “Changes requested” status can be revised.
            </p>
            <Link className="community-primary-link" to={`/suggestions/${submission.submissionId}`}>Return to suggestion</Link>
          </section>
        ) : null}

        {latestChangeRequest?.reason && !revisionBlocked ? (
          <aside className="suggestion-editor-request" aria-labelledby="suggestion-editor-request-title">
            <div className="suggestion-editor-request-heading">
              <p className="suggestion-editor-request-kicker">Moderator request</p>
              <h2 className="suggestion-editor-request-title" id="suggestion-editor-request-title">What needs to change</h2>
              <time className="suggestion-editor-request-date" dateTime={latestChangeRequest.createdAt || undefined}>
                {formatCommunityDate(latestChangeRequest.createdAt)}
              </time>
            </div>
            <p className="suggestion-editor-request-reason">{latestChangeRequest.reason}</p>
          </aside>
        ) : null}

        {loadStatus === "ready" && !revisionBlocked ? (
          <SuggestionForm
            key={isRevision ? `${submission?.submissionId}-${submission?.currentRevision}` : "create"}
            initialValue={submission}
            onSubmit={submitSuggestion}
            submitLabel={isRevision ? "Submit revised record" : "Send for review"}
            submittingLabel={isRevision ? "Submitting revision…" : "Sending suggestion…"}
            isSubmitting={mutationStatus === "loading"}
            error={mutationError}
            formId={isRevision ? "community-revision-form" : "community-create-form"}
          />
        ) : null}
      </div>
    </section>
  );
}

export default SuggestionEditor;
