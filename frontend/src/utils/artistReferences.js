export function getArtistNames(album) {
  if (Array.isArray(album?.artistCredits) && album.artistCredits.length) {
    return album.artistCredits.map((credit) => credit.name).filter(Boolean);
  }
  return album?.artistDisplayName ? [album.artistDisplayName] : [];
}
