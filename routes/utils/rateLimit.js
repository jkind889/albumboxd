const {
  RateLimiterMemory,
  RateLimiterRes,
} = require("rate-limiter-flexible");

const DEFAULT_TRUST_PROXY_HOPS = 0;
const RATE_LIMIT_ERROR_CODE = "RATE_LIMITED";

const RATE_LIMITS = {
  globalApi: {
    keyPrefix: "albumboxd:global-api",
    points: 300,
    duration: 5 * 60,
    message: "Too many requests. Please slow down and try again soon.",
  },
  spotifyFallback: {
    keyPrefix: "albumboxd:spotify-fallback",
    points: 60,
    duration: 10 * 60,
    message: "Too many Spotify-backed requests. Please try again soon.",
  },
  search: {
    keyPrefix: "albumboxd:search",
    points: 90,
    duration: 60,
    message: "Too many searches. Please slow down and try again soon.",
  },
  relatedArtist: {
    keyPrefix: "albumboxd:related-artist",
    points: 30,
    duration: 10 * 60,
    message: "Too many related-artist lookups. Please try again soon.",
  },
  albumSave: {
    keyPrefix: "albumboxd:album-save",
    points: 30,
    duration: 10 * 60,
    message: "Too many save attempts. Please try again soon.",
  },
  reviewCreate: {
    keyPrefix: "albumboxd:review-create",
    points: 6,
    duration: 10 * 60,
    message: "Too many review submissions. Please try again soon.",
  },
  reviewMutation: {
    keyPrefix: "albumboxd:review-mutation",
    points: 30,
    duration: 10 * 60,
    message: "Too many review updates. Please try again soon.",
  },
  likeMutation: {
    keyPrefix: "albumboxd:like-mutation",
    points: 120,
    duration: 10 * 60,
    message: "Too many like updates. Please try again soon.",
  },
};

class RateLimitExceededError extends Error {
  constructor(retryAfterSeconds, message) {
    super(message || "Too many requests. Please try again soon.");
    this.name = "RateLimitExceededError";
    this.code = RATE_LIMIT_ERROR_CODE;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function getTrustProxyHops() {
  const parsedHops = Number.parseInt(
    process.env.TRUST_PROXY_HOPS || `${DEFAULT_TRUST_PROXY_HOPS}`,
    10,
  );

  return Number.isFinite(parsedHops) && parsedHops > 0 ? parsedHops : DEFAULT_TRUST_PROXY_HOPS;
}

function createRateLimiter(options) {
  return new RateLimiterMemory({
    keyPrefix: options.keyPrefix,
    points: options.points,
    duration: options.duration,
    blockDuration: options.blockDuration || 0,
  });
}

function getRequestUserId(req) {
  if (req.userId) {
    return req.userId;
  }

  try {
    const { getAuth } = require("@clerk/express");
    return getAuth(req).userId || "";
  } catch {
    return "";
  }
}

function getIpRateLimitKey(req) {
  const forwardedFor = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)[0];
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || forwardedFor || "unknown";

  return `ip:${ip}`;
}

function getUserOrIpRateLimitKey(req) {
  const userId = getRequestUserId(req);

  return userId ? `user:${userId}` : getIpRateLimitKey(req);
}

function getAuthenticatedUserRateLimitKey(req) {
  return req.userId ? `user:${req.userId}` : getUserOrIpRateLimitKey(req);
}

function getRetryAfterSeconds(rejectedResult) {
  const retryMs = rejectedResult?.msBeforeNext || 1000;
  return Math.max(1, Math.ceil(retryMs / 1000));
}

function buildRateLimitPayload(error) {
  return {
    error: error.message || "Too many requests. Please try again soon.",
    code: RATE_LIMIT_ERROR_CODE,
    retryAfterSeconds: error.retryAfterSeconds || 1,
  };
}

function setRetryAfterHeader(res, retryAfterSeconds) {
  if (typeof res.set === "function") {
    res.set("Retry-After", String(retryAfterSeconds));
    return;
  }

  if (typeof res.setHeader === "function") {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }
}

function sendRateLimitError(res, error) {
  setRetryAfterHeader(res, error.retryAfterSeconds || 1);
  return res.status(429).json(buildRateLimitPayload(error));
}

function isRateLimitError(error) {
  return error?.code === RATE_LIMIT_ERROR_CODE;
}

async function consumeRateLimit(limiter, key, message) {
  try {
    await limiter.consume(key);
  } catch (error) {
    if (error instanceof RateLimiterRes || typeof error?.msBeforeNext === "number") {
      throw new RateLimitExceededError(getRetryAfterSeconds(error), message);
    }

    console.error("Rate limiter failed open after unexpected error.", error);
  }
}

function createRateLimitMiddleware(limiter, options = {}) {
  const keyGenerator = options.keyGenerator || getIpRateLimitKey;
  const message = options.message || "Too many requests. Please try again soon.";

  return async (req, res, next) => {
    try {
      await consumeRateLimit(limiter, keyGenerator(req), message);
      next();
    } catch (error) {
      if (isRateLimitError(error)) {
        return sendRateLimitError(res, error);
      }

      next(error);
    }
  };
}

const globalApiLimiter = createRateLimiter(RATE_LIMITS.globalApi);
const spotifyFallbackLimiter = createRateLimiter(RATE_LIMITS.spotifyFallback);
const searchLimiter = createRateLimiter(RATE_LIMITS.search);
const relatedArtistLimiter = createRateLimiter(RATE_LIMITS.relatedArtist);
const albumSaveLimiter = createRateLimiter(RATE_LIMITS.albumSave);
const reviewCreateLimiter = createRateLimiter(RATE_LIMITS.reviewCreate);
const reviewMutationLimiter = createRateLimiter(RATE_LIMITS.reviewMutation);
const likeMutationLimiter = createRateLimiter(RATE_LIMITS.likeMutation);

async function consumeSpotifyRateLimit(key) {
  return consumeRateLimit(
    spotifyFallbackLimiter,
    key,
    RATE_LIMITS.spotifyFallback.message,
  );
}

module.exports = {
  RATE_LIMIT_ERROR_CODE,
  RATE_LIMITS,
  RateLimitExceededError,
  albumSaveRateLimit: createRateLimitMiddleware(albumSaveLimiter, {
    keyGenerator: getAuthenticatedUserRateLimitKey,
    message: RATE_LIMITS.albumSave.message,
  }),
  buildRateLimitPayload,
  consumeRateLimit,
  consumeSpotifyRateLimit,
  createRateLimitMiddleware,
  createRateLimiter,
  getAuthenticatedUserRateLimitKey,
  getIpRateLimitKey,
  getTrustProxyHops,
  getUserOrIpRateLimitKey,
  globalApiRateLimit: createRateLimitMiddleware(globalApiLimiter, {
    keyGenerator: getIpRateLimitKey,
    message: RATE_LIMITS.globalApi.message,
  }),
  isRateLimitError,
  likeMutationRateLimit: createRateLimitMiddleware(likeMutationLimiter, {
    keyGenerator: getAuthenticatedUserRateLimitKey,
    message: RATE_LIMITS.likeMutation.message,
  }),
  reviewCreateRateLimit: createRateLimitMiddleware(reviewCreateLimiter, {
    keyGenerator: getAuthenticatedUserRateLimitKey,
    message: RATE_LIMITS.reviewCreate.message,
  }),
  reviewMutationRateLimit: createRateLimitMiddleware(reviewMutationLimiter, {
    keyGenerator: getAuthenticatedUserRateLimitKey,
    message: RATE_LIMITS.reviewMutation.message,
  }),
  relatedArtistRateLimit: createRateLimitMiddleware(relatedArtistLimiter, {
    keyGenerator: getUserOrIpRateLimitKey,
    message: RATE_LIMITS.relatedArtist.message,
  }),
  searchRateLimit: createRateLimitMiddleware(searchLimiter, {
    keyGenerator: getIpRateLimitKey,
    message: RATE_LIMITS.search.message,
  }),
  sendRateLimitError,
};
