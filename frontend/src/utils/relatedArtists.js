import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "./apiErrors";

const RELATED_ARTIST_LIMIT = 12;

export async function fetchSimilarArtists(spotifyArtistId, { signal } = {}) {
  const response = await fetch(
    `${API_BASE_URL}/explore/artists/${encodeURIComponent(spotifyArtistId)}/similar?limit=${RELATED_ARTIST_LIMIT}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(
      await getApiErrorMessage(response, "Related artists request failed"),
    );
  }

  return response.json();
}
