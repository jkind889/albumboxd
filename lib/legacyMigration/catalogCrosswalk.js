const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");
const { LegacyMigrationError, canonicalHash } = require("./runtime");
const { createMusicBrainzClient } = require("./musicBrainz");

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALBUM_COLLECTIONS = ["albumcatalogs", "albums", "boarditems", "reviews", "likes", "notifications", "userprofiles"];

function normalizeMbid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MBID_PATTERN.test(normalized) ? normalized : "";
}

function text(value) { return String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim(); }

function idString(value) { return value && value.toHexString ? value.toHexString() : String(value || ""); }

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function providerKey(row) { return text(row?.spotifyId); }

function rowReleaseGroup(row) {
  return normalizeMbid(row?.musicBrainzReleaseGroupId || row?.releaseGroupMbid);
}

function rowReleaseIds(row) {
  const values = [ ...(Array.isArray(row?.musicBrainzReleaseIds) ? row.musicBrainzReleaseIds : []), row?.representativeReleaseMbid, row?.releaseMbid ];
  return [...new Set(values.map(normalizeMbid).filter(Boolean))];
}

function identityKeyForCatalog(id) { return `catalog:${idString(id)}`; }
function identityKeyForProvider(value) { return `provider:${text(value)}`; }

function mergeIdentity(left, right) {
  if (!left) return right;
  if (!right) return left;
  left.catalogIds = [...new Set([...left.catalogIds, ...right.catalogIds])];
  left.providerKeys = [...new Set([...left.providerKeys, ...right.providerKeys])];
  left.sourceRows.push(...right.sourceRows);
  left.social = left.social || right.social;
  if (!left.catalogRow && right.catalogRow) left.catalogRow = right.catalogRow;
  return left;
}

function collectLegacyIdentities(sourceDocuments) {
  const byKey = new Map();
  const aliases = new Map();
  const ensure = (key, seed = {}) => {
    if (!key) return null;
    if (!byKey.has(key)) byKey.set(key, { key, catalogIds: [], providerKeys: [], sourceRows: [], social: false, ...seed });
    return byKey.get(key);
  };
  const link = (leftKey, rightKey) => {
    if (!leftKey || !rightKey || leftKey === rightKey) return;
    const left = byKey.get(leftKey);
    const right = byKey.get(rightKey);
    if (!left || !right) return;
    const merged = mergeIdentity(left, right);
    byKey.set(leftKey, merged);
    byKey.set(rightKey, merged);
  };
  const catalogRows = sourceDocuments.albumcatalogs || [];
  for (const row of catalogRows) {
    const catalogId = idString(row._id);
    const key = identityKeyForCatalog(catalogId);
    const identity = ensure(key, { catalogRow: row });
    identity.catalogIds.push(catalogId);
    identity.sourceRows.push({ collection: "albumcatalogs", id: catalogId });
    const spotify = providerKey(row);
    if (spotify) {
      const provider = identityKeyForProvider(spotify);
      ensure(provider, { providerKeys: [spotify] });
      link(key, provider);
      aliases.set(provider, key);
    }
    aliases.set(key, key);
  }
  const touch = (collection, row, keys) => {
    const usable = keys.filter(Boolean);
    if (!usable.length) return;
    let identity = byKey.get(aliases.get(usable[0]) || usable[0]);
    if (!identity) identity = ensure(usable[0]);
    identity.social = true;
    identity.sourceRows.push({ collection, id: idString(row._id) });
    for (const key of usable) {
      const alias = aliases.get(key) || key;
      ensure(alias, { providerKeys: key.startsWith("provider:") ? [key.slice(9)] : [] });
      link(identity.key, alias);
      aliases.set(key, identity.key);
    }
  };
  for (const row of sourceDocuments.albums || []) touch("albums", row, [row.albumCatalogId && identityKeyForCatalog(row.albumCatalogId), providerKey(row) && identityKeyForProvider(providerKey(row))]);
  for (const row of sourceDocuments.boarditems || []) touch("boarditems", row, [row.albumCatalogId && identityKeyForCatalog(row.albumCatalogId), providerKey(row) && identityKeyForProvider(providerKey(row))]);
  for (const row of sourceDocuments.reviews || []) touch("reviews", row, [row.albumCatalogId && identityKeyForCatalog(row.albumCatalogId), providerKey(row) && identityKeyForProvider(providerKey(row))]);
  for (const row of sourceDocuments.likes || []) if (row.targetType === "album") touch("likes", row, [row.albumCatalogId && identityKeyForCatalog(row.albumCatalogId), providerKey(row) && identityKeyForProvider(providerKey(row))]);
  for (const row of sourceDocuments.notifications || []) touch("notifications", row, [providerKey(row) && identityKeyForProvider(providerKey(row))]);
  for (const row of sourceDocuments.userprofiles || []) {
    for (const item of [...(row.favoriteAlbums || []), row.listeningNextAlbum].filter(Boolean)) {
      touch("userprofiles", row, [item.albumCatalogId && identityKeyForCatalog(item.albumCatalogId), item.spotifyId && identityKeyForProvider(item.spotifyId)]);
    }
  }
  const unique = new Map();
  for (const identity of byKey.values()) {
    const canonical = identity.catalogIds[0] ? identityKeyForCatalog(identity.catalogIds[0]) : identity.key;
    if (!unique.has(canonical)) unique.set(canonical, identity);
  }
  return [...unique.values()].map((identity) => ({
    ...identity,
    catalogIds: [...new Set(identity.catalogIds)],
    providerKeys: [...new Set(identity.providerKeys)],
    sourceRows: identity.sourceRows,
    social: Boolean(identity.social),
  }));
}

function targetReferenceMap(targetRows) {
  const map = new Map();
  for (const row of targetRows) {
    for (const reference of row.externalReferences || []) {
      if (String(reference.provider).toLowerCase() !== "musicbrainz") continue;
      const type = String(reference.entityType || "").toLowerCase();
      const id = normalizeMbid(reference.externalId);
      if (!id || !["release-group", "release"].includes(type)) continue;
      const key = `musicbrainz|${type}|${id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
  }
  return map;
}

function registerTargetReferences(targetReferences, document) {
  for (const reference of document?.externalReferences || []) {
    const provider = String(reference.provider || "").toLowerCase();
    const entityType = String(reference.entityType || "").toLowerCase();
    const externalId = normalizeMbid(reference.externalId);
    if (provider !== "musicbrainz" || !externalId || !["release-group", "release"].includes(entityType)) continue;
    const key = `musicbrainz|${entityType}|${externalId}`;
    const owners = targetReferences.get(key) || [];
    if (!owners.some((owner) => idString(owner._id) === idString(document._id))) owners.push(document);
    targetReferences.set(key, owners);
  }
}

function trackSignature(tracks = []) {
  return tracks.map((track) => `${track.discNumber}:${track.trackNumber}:${track.title}:${track.durationMs}:${track.artistDisplayName}`).join("|");
}

function overrideFor(overrides, identity) {
  // Overrides are deliberately keyed by the opaque legacy Mongo ObjectId.
  // A provider key is never accepted as an override selector.
  const keys = new Set(identity.catalogIds || []);
  return (overrides.albums || []).find((override) => keys.has(String(override.legacyCatalogId || "")));
}

function mbReference(entityType, externalId) {
  const id = normalizeMbid(externalId);
  return { provider: "musicbrainz", entityType, externalId: id, url: `https://musicbrainz.org/${entityType}/${id}` };
}

function provenance(source, group, extra = {}) {
  return { source, license: source === "musicbrainz" ? "CC0" : "source-specific", releaseGroupMbid: group, ...extra };
}

function buildTracks(tracklist, albumId, sourceReleaseMbid, sourceFetchedAt, artistDisplayName) {
  const tracks = tracklist?.tracks || [];
  return {
    tracks: tracks.map((track) => ({
      trackId: crypto.randomUUID(),
      discNumber: track.discNumber,
      trackNumber: track.trackNumber,
      title: track.title,
      durationMs: track.durationMs,
      artistDisplayName: track.artistDisplayName || artistDisplayName,
    })),
    provenance: {
      source: "musicbrainz",
      license: "CC0",
      releaseMbid: sourceReleaseMbid,
      sourceFetchedAt,
      trackSourceMap: tracks.map((track, index) => ({ index, discNumber: track.discNumber, trackNumber: track.trackNumber })),
      albumId,
    },
  };
}

function mergeTarget(existing, incoming, groupMbid) {
  if (!existing) return incoming;
  const merged = { ...incoming, _id: existing._id, albumId: existing.albumId, createdAt: existing.createdAt, updatedAt: existing.updatedAt };
  for (const field of ["title", "artistDisplayName", "artistCredits", "releaseType", "releaseDate", "releaseDatePrecision", "releaseYear", "cover", "externalReferences", "catalogSource", "fieldProvenance"]) {
    // Existing generation-2 canonical and user-owned fields are authoritative;
    // migration is allowed to fill only an empty tracklist or label below.
    if (Object.prototype.hasOwnProperty.call(existing, field)) merged[field] = existing[field];
  }
  if (Array.isArray(existing.tracks) && existing.tracks.length) merged.tracks = existing.tracks;
  if (existing.label) merged.label = existing.label;
  merged.fieldProvenance = { ...(incoming.fieldProvenance || {}), ...(existing.fieldProvenance || {}), _migration: { ...(incoming.fieldProvenance?._migration || {}), existingTarget: true, releaseGroupMbid: groupMbid } };
  return merged;
}

async function resolveIdentity(identity, context) {
  const override = overrideFor(context.overrides || {}, identity);
  const reusedTargetId = override?.albumId || override?.targetAlbumId;
  const reusedTarget = reusedTargetId && context.targetByAlbumId?.get(String(reusedTargetId));
  if (reusedTarget) {
    return {
      identity,
      action: "reused",
      document: reusedTarget,
      match: { tier: 0, reusedTargetAlbumId: reusedTarget.albumId, requestedReleaseMbids: [] },
      issue: null,
    };
  }
  let groupMbid = normalizeMbid(override?.releaseGroupMbid) || rowReleaseGroup(identity.catalogRow);
  let releaseIds = [...new Set([...(rowReleaseIds(identity.catalogRow)), ...(override?.releaseMbid ? [override.releaseMbid] : [])].map(normalizeMbid).filter(Boolean))];
  let matchTier = groupMbid ? 1 : releaseIds.length ? 2 : 0;
  if (!groupMbid && identity.providerKeys.length && context.client) {
    let relation;
    try {
      relation = await context.client.lookupProviderUrl(`https://open.spotify.com/album/${identity.providerKeys[0]}`);
    } catch (error) {
      return { identity, action: "quarantined", issue: error.code || "MUSICBRAINZ_URL_LOOKUP_FAILED", matchTier: 3 };
    }
    const relationGroups = [...new Set(relation.groups.map(normalizeMbid).filter(Boolean))];
    const relationReleases = [...new Set(relation.releases.map(normalizeMbid).filter(Boolean))];
    if (relationGroups.length === 1) { groupMbid = relationGroups[0]; matchTier = 3; }
    if (!releaseIds.length) releaseIds = relationReleases;
  }
  if (!groupMbid && !releaseIds.length) {
    return { identity, action: override?.decision === "archive" ? "archived" : "quarantined", issue: "MANUAL_REVIEW_REQUIRED", matchTier: 4 };
  }
  if (!groupMbid && releaseIds.length) {
    let firstRelease;
    try { firstRelease = await context.client.hydrateRelease(releaseIds[0]); } catch (error) {
      return { identity, action: "quarantined", issue: error.code || "MUSICBRAINZ_RELEASE_LOOKUP_FAILED", matchTier: 2 };
    }
    groupMbid = normalizeMbid(firstRelease.raw?.["release-group"]?.id);
  }
  if (!groupMbid) return { identity, action: "quarantined", issue: "MISSING_RELEASE_GROUP", matchTier };
  let group;
  try { group = await context.client.hydrateReleaseGroup(groupMbid); } catch (error) {
    return { identity, action: "quarantined", issue: error.code || "MUSICBRAINZ_RELEASE_GROUP_LOOKUP_FAILED", matchTier };
  }
  if (group.missing) return { identity, action: "quarantined", issue: "MUSICBRAINZ_RELEASE_GROUP_NOT_FOUND", matchTier };
  groupMbid = normalizeMbid(group.releaseGroupMbid || group.resolvedMbid || groupMbid);
  const targetOwners = context.targetReferences.get(`musicbrainz|release-group|${groupMbid}`) || [];
  if (targetOwners.length > 1) return { identity, action: "quarantined", issue: "TARGET_REFERENCE_CONFLICT", matchTier };
  const existing = targetOwners[0] || null;
  const hydratedReleases = [];
  const releaseIssues = [];
  for (const releaseId of releaseIds) {
    try {
      const release = await context.client.hydrateRelease(releaseId, groupMbid);
      if (!release.missing) hydratedReleases.push(release);
    } catch (error) {
      releaseIssues.push(error.code || "MUSICBRAINZ_RELEASE_LOOKUP_FAILED");
    }
  }
  const validatedReleaseIds = [...new Set(hydratedReleases.map((release) => normalizeMbid(release.releaseMbid)).filter(Boolean))];
  const selectedRelease = hydratedReleases.length === 1 ? hydratedReleases[0] : null;
  const releaseConflict = hydratedReleases.length > 1;
  const albumId = existing?.albumId || crypto.randomUUID();
  const createdAt = validDate(existing?.createdAt) || validDate(identity.catalogRow?.createdAt) || new Date();
  const now = new Date();
  const incoming = {
    _id: existing?._id || new ObjectId(),
    albumId,
    title: group.title,
    artistDisplayName: group.artistDisplayName,
    artistCredits: group.artistCredits,
    releaseType: group.releaseType,
    releaseDate: group.releaseDate,
    releaseDatePrecision: group.releaseDatePrecision,
    releaseYear: group.releaseYear,
    tracks: [],
    label: "",
    cover: "",
    externalReferences: [mbReference("release-group", groupMbid), ...validatedReleaseIds.map((id) => mbReference("release", id))],
    fieldProvenance: {
      title: provenance("musicbrainz", groupMbid, { sourceFetchedAt: group.fetchedAt }),
      artistDisplayName: provenance("musicbrainz", groupMbid, { sourceFetchedAt: group.fetchedAt }),
      artistCredits: provenance("musicbrainz", groupMbid, { sourceFetchedAt: group.fetchedAt }),
      releaseType: provenance("musicbrainz", groupMbid, { sourceFetchedAt: group.fetchedAt }),
      releaseDate: provenance("musicbrainz", groupMbid, { sourceFetchedAt: group.fetchedAt }),
      externalReferences: provenance("musicbrainz", groupMbid, { releaseIds: validatedReleaseIds, sourceFetchedAt: group.fetchedAt }),
      _migration: { importKind: "legacy-migration", matchTier, legacyCatalogIds: identity.catalogIds },
    },
    catalogSource: "import",
    createdAt,
    updatedAt: existing?.updatedAt || now,
  };
  if (selectedRelease && selectedRelease.tracklist.issues.length === 0) {
    const built = buildTracks(selectedRelease.tracklist, albumId, selectedRelease.releaseMbid, selectedRelease.fetchedAt, group.artistDisplayName);
    incoming.tracks = built.tracks;
    incoming.fieldProvenance.tracks = built.provenance;
  } else if (releaseConflict) {
    incoming.fieldProvenance._migration.trackIssue = "AMBIGUOUS_EDITION";
  } else if (selectedRelease?.tracklist.issues.length) {
    incoming.fieldProvenance._migration.trackIssues = selectedRelease.tracklist.issues;
  }
  if (releaseIssues.length) incoming.fieldProvenance._migration.releaseIssues = [...new Set(releaseIssues)];
  if (selectedRelease?.label) {
    incoming.label = selectedRelease.label;
    incoming.fieldProvenance.label = provenance("musicbrainz", groupMbid, { releaseMbid: selectedRelease.releaseMbid, sourceFetchedAt: selectedRelease.fetchedAt });
  }
  const document = mergeTarget(existing, incoming, groupMbid);
  const action = existing ? "reused" : "created";
  return {
    identity,
    action,
    document,
    match: { tier: matchTier, resolvedGroupMbid: groupMbid, requestedReleaseMbids: releaseIds, selectedReleaseMbid: selectedRelease?.releaseMbid || null },
    issue: releaseConflict ? "AMBIGUOUS_EDITION" : selectedRelease?.tracklist.issues?.[0] || null,
    sourceTrackSignature: selectedRelease?.tracklist?.tracks?.length ? trackSignature(selectedRelease.tracklist.tracks) : "",
  };
}

async function buildCatalogCrosswalk({ sourceDocuments, targetRows, overrides = {}, client, onProgress }) {
  const identities = collectLegacyIdentities(sourceDocuments).sort((left, right) => Number(right.social) - Number(left.social) || left.key.localeCompare(right.key));
  const targetReferences = targetReferenceMap(targetRows);
  const targetByAlbumId = new Map(targetRows.filter((row) => row.albumId).map((row) => [String(row.albumId), row]));
  const ambiguousGroups = new Set();
  const results = [];
  for (let index = 0; index < identities.length; index += 1) {
    const result = await resolveIdentity(identities[index], { client, overrides, targetReferences, targetByAlbumId });
    const groupMbid = normalizeMbid(result.match?.resolvedGroupMbid);
    if (groupMbid && ambiguousGroups.has(groupMbid) && result.document) {
      result.document.tracks = [];
      result.document.fieldProvenance = { ...(result.document.fieldProvenance || {}), _migration: { ...(result.document.fieldProvenance?._migration || {}), trackIssue: "AMBIGUOUS_EDITION" } };
      result.issue = "AMBIGUOUS_EDITION";
    } else if (groupMbid && result.document?.tracks?.length) {
      const prior = results.find((item) => normalizeMbid(item.match?.resolvedGroupMbid) === groupMbid && item.document && idString(item.document._id) === idString(result.document._id));
      if (prior?.sourceTrackSignature && result.sourceTrackSignature && prior.sourceTrackSignature !== result.sourceTrackSignature && prior.document.fieldProvenance?._migration?.importKind === "legacy-migration") {
        ambiguousGroups.add(groupMbid);
        prior.document.tracks = [];
        prior.document.fieldProvenance = { ...(prior.document.fieldProvenance || {}), _migration: { ...(prior.document.fieldProvenance?._migration || {}), trackIssue: "AMBIGUOUS_EDITION" } };
        result.document.tracks = [];
        result.document.fieldProvenance = { ...(result.document.fieldProvenance || {}), _migration: { ...(result.document.fieldProvenance?._migration || {}), trackIssue: "AMBIGUOUS_EDITION" } };
        result.issue = "AMBIGUOUS_EDITION";
      }
    }
    if (result.document && ["created", "reused"].includes(result.action)) {
      registerTargetReferences(targetReferences, result.document);
      if (result.document.albumId) targetByAlbumId.set(String(result.document.albumId), result.document);
    }
    results.push(result);
    if (onProgress) onProgress({ index: index + 1, total: identities.length, result });
  }
  const crosswalk = results.map((result) => ({
    legacyCatalogIds: result.identity.catalogIds,
    legacyProviderKeys: result.identity.providerKeys,
    targetObjectId: result.document?._id || null,
    targetAlbumId: result.document?.albumId || null,
    socialPriority: result.identity.social,
    action: result.action,
    issue: result.issue || null,
    match: result.match || null,
  }));
  return {
    identities,
    results,
    crosswalk,
    crosswalkHash: canonicalHash(crosswalk.map(({ legacyProviderKeys, ...safe }) => safe)),
    counts: {
      total: results.length,
      social: results.filter((result) => result.identity.social).length,
      created: results.filter((result) => result.action === "created").length,
      reused: results.filter((result) => result.action === "reused").length,
      quarantined: results.filter((result) => result.action === "quarantined").length,
      archived: results.filter((result) => result.action === "archived").length,
    },
  };
}

module.exports = {
  ALBUM_COLLECTIONS,
  buildCatalogCrosswalk,
  collectLegacyIdentities,
  normalizeMbid,
  rowReleaseGroup,
  rowReleaseIds,
  targetReferenceMap,
};
