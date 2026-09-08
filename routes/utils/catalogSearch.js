const SEARCH_FIELDS = [
  "title",
  "artistDisplayName",
  "artistCredits.name",
  "label",
];
const APOSTROPHE_PATTERN = "['’]";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchPattern(value) {
  const normalized = String(value ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();

  return [...normalized]
    .map((character) => (character === "'" || character === "’" ? APOSTROPHE_PATTERN : escapeRegex(character)))
    .join("");
}

function buildCatalogSearchQuery(value) {
  const pattern = buildSearchPattern(value);
  if (!pattern) return {};

  return {
    $or: SEARCH_FIELDS.map((field) => ({
      [field]: { $regex: pattern, $options: "i" },
    })),
  };
}

module.exports = {
  buildCatalogSearchQuery,
  buildSearchPattern,
  escapeRegex,
};
