export async function getApiErrorMessage(response, fallback) {
  const data = await response.json().catch(() => ({}));

  if (response.status === 429) {
    return data.error || "Slow down and try again soon.";
  }

  return data.error || fallback;
}
