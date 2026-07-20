import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "./apiErrors";

const RELATED_ARTIST_LIMIT = 12;
const COLLABORATION_ALBUM_LIMIT = 3;

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

export async function fetchArtistCollaborations(
  seedSpotifyId,
  collaboratorSpotifyId,
  { signal } = {},
) {
  const response = await fetch(
    `${API_BASE_URL}/explore/artists/${encodeURIComponent(seedSpotifyId)}/collaborations/${encodeURIComponent(collaboratorSpotifyId)}?limit=${COLLABORATION_ALBUM_LIMIT}`,
    { signal },
  );

  if (!response.ok) {
    throw new Error(
      await getApiErrorMessage(response, "Collaboration albums request failed"),
    );
  }

  return response.json();
}
