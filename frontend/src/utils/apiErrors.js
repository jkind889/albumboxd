function formatRetryAfter(seconds) {
  const retryAfterSeconds = Number(seconds);

  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return "";
  }

  if (retryAfterSeconds < 60) {
    const roundedSeconds = Math.ceil(retryAfterSeconds);
    return `${roundedSeconds} second${roundedSeconds === 1 ? "" : "s"}`;
  }

  const roundedMinutes = Math.ceil(retryAfterSeconds / 60);
  return `${roundedMinutes} minute${roundedMinutes === 1 ? "" : "s"}`;
}

export async function getApiErrorMessage(response, fallback) {
  const data = await response.json().catch(() => ({}));

  if (response.status === 429) {
    const retryAfter = formatRetryAfter(
      data.retryAfterSeconds || response.headers?.get?.("Retry-After"),
    );
    const message = data.error || "You have reached the request limit.";

    return retryAfter ? `${message} Try again in ${retryAfter}.` : message;
  }

  return data.error || fallback;
}
