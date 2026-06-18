const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();

function normalizeApiUrl(value) {
  const url = value.replace(/\/+$/, "");

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) {
    return `http://${url}`;
  }

  return `https://${url}`;
}

export const API_BASE_URL = normalizeApiUrl(configuredApiUrl || "http://localhost:3000");
