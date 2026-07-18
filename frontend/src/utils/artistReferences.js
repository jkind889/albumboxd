function normalizeName(value, fallback = "Unknown artist") {
  const name = String(value || "").trim();
  return name || fallback;
}

export function getArtistCandidates(results, query = "") {
  const artistsBySpotifyId = new Map();

  for (const album of Array.isArray(results) ? results : []) {
    const artistRefs = Array.isArray(album?.artistRefs) ? album.artistRefs : [];
    const normalizedRefs = artistRefs.length > 0
      ? artistRefs
      : [{ spotifyId: album?.artistId, name: album?.artist }];

    for (const artistRef of normalizedRefs) {
      const spotifyId = String(artistRef?.spotifyId || "").trim();

      if (!spotifyId) {
        continue;
      }

      const existingArtist = artistsBySpotifyId.get(spotifyId);
      const name = normalizeName(artistRef?.name, normalizeName(album?.artist));

      artistsBySpotifyId.set(spotifyId, {
        spotifyId,
        spotifyUrl: String(artistRef?.spotifyUrl || existingArtist?.spotifyUrl || "").trim(),
        name: existingArtist?.name || name,
        cover: existingArtist?.cover || album?.cover || "",
        albumCount: (existingArtist?.albumCount || 0) + 1,
      });
    }
  }

  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();

  return [...artistsBySpotifyId.values()].sort((left, right) => {
    const leftName = left.name.toLocaleLowerCase();
    const rightName = right.name.toLocaleLowerCase();
    const leftExact = normalizedQuery && leftName === normalizedQuery ? 1 : 0;
    const rightExact = normalizedQuery && rightName === normalizedQuery ? 1 : 0;

    if (leftExact !== rightExact) {
      return rightExact - leftExact;
    }

    const leftStartsWith = normalizedQuery && leftName.startsWith(normalizedQuery) ? 1 : 0;
    const rightStartsWith = normalizedQuery && rightName.startsWith(normalizedQuery) ? 1 : 0;

    if (leftStartsWith !== rightStartsWith) {
      return rightStartsWith - leftStartsWith;
    }

    if (left.albumCount !== right.albumCount) {
      return right.albumCount - left.albumCount;
    }

    return left.name.localeCompare(right.name);
  });
}
