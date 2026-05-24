const USER_AGENT = "animeonterminal/0.1 (+https://github.com/local/animeonterminal)";
const REQUEST_TIMEOUT_MS = 15000;
const QUERY_ALIASES = new Map([
  ["bocchi", "hitori gotou"],
  ["bocchi the rock", "hitori gotou"]
]);

export async function resolveCharacter(query, options = {}) {
  const searchQuery = QUERY_ALIASES.get(canonicalName(query)) || query;
  const providers = providerOrder(options.provider);
  const automatic = !options.provider || options.provider === "auto";
  const errors = [];
  const results = [];

  for (const provider of providers) {
    try {
      const result = await provider.search(searchQuery);
      if (result?.imageUrl) {
        if (!automatic || result.matchScore >= 80) {
          return result;
        }

        results.push(result);
      }
    } catch (error) {
      errors.push(`${provider.name}: ${error.message}`);
    }
  }

  if (results.length) {
    return bestProviderResult(results);
  }

  const detail = errors.length ? ` Provider errors: ${errors.join("; ")}` : "";
  throw new Error(`No character image found for "${query}".${detail}`);
}

export async function downloadImage(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Image download failed (${response.status})`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function providerOrder(provider) {
  const all = [jikanProvider, anilistProvider, acdbProvider];
  if (!provider || provider === "auto") return all;

  const found = all.find((entry) => entry.name === provider);
  if (!found) {
    throw new Error(`Unknown provider "${provider}". Use auto, anilist, jikan, or acdb.`);
  }

  return [found];
}

const anilistProvider = {
  name: "anilist",
  async search(query) {
    const graphql = `
      query ($search: String) {
        Page(perPage: 25) {
          characters(search: $search, sort: FAVOURITES_DESC) {
            id
            siteUrl
            favourites
            name {
              full
              native
              alternative
            }
            image {
              large
              medium
            }
            media(perPage: 5, sort: POPULARITY_DESC) {
              nodes {
                title {
                  romaji
                  english
                  native
                }
              }
            }
          }
        }
      }
    `;
    const results = [];

    for (const search of queryVariants(query)) {
      let payload;
      try {
        payload = await fetchJson("https://graphql.anilist.co", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT
          },
          body: JSON.stringify({ query: graphql, variables: { search } })
        });
      } catch {
        continue;
      }

      for (const character of payload?.data?.Page?.characters || []) {
        const result = {
          provider: "anilist",
          id: character.id,
          name: character.name?.full || query,
          nativeName: character.name?.native || null,
          aliases: character.name?.alternative || [],
          mediaTitles: mediaTitles(character.media?.nodes),
          imageUrl: character.image?.large || character.image?.medium || null,
          imageCandidates: imageCandidates("anilist", character.image?.large, character.image?.medium),
          sourceUrl: character.siteUrl || `https://anilist.co/character/${character.id}`,
          popularity: character.favourites || 0
        };

        result.score = scoreCharacter(query, result);
        results.push(result);
      }

      if (results.some((result) => result.score >= 96)) break;
    }

    return cleanResult(pickBest(results));
  }
};

const jikanProvider = {
  name: "jikan",
  async search(query) {
    const results = [];

    for (const search of queryVariants(query)) {
      const url = new URL("https://api.jikan.moe/v4/characters");
      url.searchParams.set("q", search);
      url.searchParams.set("limit", "25");
      url.searchParams.set("order_by", "favorites");
      url.searchParams.set("sort", "desc");

      const payload = await fetchJson(url);
      for (const character of payload?.data || []) {
        const result = {
          provider: "jikan",
          id: character.mal_id,
          name: character.name || query,
          nativeName: character.name_kanji || null,
          aliases: character.nicknames || [],
          mediaTitles: [],
          imageUrl: character.images?.jpg?.image_url || character.images?.webp?.image_url || null,
          imageCandidates: imageCandidates(
            "jikan",
            character.images?.jpg?.image_url,
            character.images?.webp?.image_url
          ),
          sourceUrl: character.url || `https://myanimelist.net/character/${character.mal_id}`,
          popularity: character.favorites || 0
        };

        result.score = scoreCharacter(query, result);
        results.push(result);
      }

      if (results.some((result) => result.score >= 96)) break;
    }

    return cleanResult(pickBest(results));
  }
};

const acdbProvider = {
  name: "acdb",
  async search(query) {
    const results = [];

    for (const candidate of queryVariants(query)) {
      const url = new URL("https://www.animecharactersdatabase.com/api_series_characters.php");
      url.searchParams.set("character_q", candidate);

      const text = await fetchText(url);
      if (text.trim() === "-1") continue;

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        continue;
      }

      for (const character of payload?.search_results || []) {
        const result = {
          provider: "acdb",
          id: character.id,
          name: character.name || query,
          nativeName: null,
          aliases: [],
          mediaTitles: character.anime_name ? [character.anime_name] : [],
          imageUrl: character.character_image || null,
          imageCandidates: imageCandidates("acdb", character.character_image),
          sourceUrl: `https://www.animecharactersdatabase.com/characters.php?id=${character.id}`,
          popularity: 0
        };

        result.score = scoreCharacter(query, result);
        results.push(result);
      }
    }

    return cleanResult(pickBest(results));
  }
};

function bestProviderResult(results) {
  results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return providerRank(b.provider) - providerRank(a.provider);
  });

  return cleanResult(results[0]);
}

function queryVariants(query) {
  const normalized = query.trim().replace(/\s+/g, " ");
  const words = normalized.split(" ");
  const titleCase = words.map(capitalize).join(" ");
  const longVowel = words.map(addLongVowel).join(" ");
  const titleLongVowel = longVowel.split(" ").map(capitalize).join(" ");
  const variants = [normalized, titleCase, longVowel, titleLongVowel];

  if (words.length === 2) {
    variants.push(`${capitalize(words[1])} ${capitalize(words[0])}`);
  }

  return [...new Set(variants)];
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;
}

function addLongVowel(word) {
  const lower = word.toLowerCase();

  if (lower.endsWith("oh")) return `${word.slice(0, -2)}ou`;
  if (lower.endsWith("o") && lower.length > 2) return `${word}u`;
  return word;
}

function pickBest(results) {
  const deduped = [];
  const seen = new Set();

  for (const result of results) {
    if (!result?.imageUrl) continue;

    const key = `${result.provider}:${result.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }

  deduped.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.popularity || 0) - (a.popularity || 0);
  });

  const best = deduped[0];
  if (!best || best.score < 50) return null;

  best.matchScore = best.score;
  return best;
}

function cleanResult(result) {
  if (!result) return null;

  const clean = { ...result };
  delete clean.score;
  delete clean.popularity;
  return clean;
}

function imageCandidates(provider, ...urls) {
  return uniqueImageCandidates(
    urls
      .filter(Boolean)
      .map((url) => ({ provider, url }))
  );
}

function uniqueImageCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    if (!candidate?.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }

  return unique;
}

function providerRank(provider) {
  if (provider === "anilist") return 3;
  if (provider === "jikan") return 2;
  if (provider === "acdb") return 1;
  return 0;
}

function scoreCharacter(query, result) {
  const queryName = canonicalName(query);
  const queryTokens = tokenSet(queryName);
  const names = [result.name, result.nativeName, ...(result.aliases || [])];
  let best = 0;

  for (const name of names) {
    const candidate = canonicalName(name);
    if (!candidate) continue;

    const candidateTokens = tokenSet(candidate);
    let score = 0;

    if (candidate === queryName) {
      score = 100;
    } else if (sameTokens(queryTokens, candidateTokens)) {
      score = 96;
    } else {
      const matchedQueryTokens = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
      const matchedCandidateTokens = [...candidateTokens].filter((token) => queryTokens.has(token)).length;
      score = Math.round((matchedQueryTokens / Math.max(1, queryTokens.size)) * 70);

      if (matchedQueryTokens === queryTokens.size) score += 15;
      if (matchedCandidateTokens === candidateTokens.size) score += candidateTokens.size === 1 ? 15 : 5;
      if (candidate.includes(queryName) || queryName.includes(candidate)) score += 5;
      if (candidateTokens.size === 1 && queryTokens.size > 1 && matchedCandidateTokens === 1) {
        score = Math.max(score, 84);
      }
    }

    best = Math.max(best, score);
  }

  return best;
}

function canonicalName(value = "") {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\boh\b/g, "o")
    .replace(/ou\b/g, "o")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(value.split(" ").filter(Boolean));
}

function sameTokens(a, b) {
  if (a.size !== b.size) return false;
  return [...a].every((token) => b.has(token));
}

function mediaTitles(nodes = []) {
  const titles = [];

  for (const node of nodes) {
    const title = node?.title?.english || node?.title?.romaji || node?.title?.native;
    if (title && !titles.includes(title)) titles.push(title);
  }

  return titles;
}

async function fetchJson(url, options = {}) {
  const response = await fetchResponseWithRetry(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(options.headers || {})
    }
  });

  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetchResponseWithRetry(url, {
    ...options,
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": USER_AGENT,
      ...(options.headers || {})
    }
  });

  return response.text();
}

async function fetchResponseWithRetry(url, options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchWithTimeout(url, options);
    if (response.ok) return response;

    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      const retryAfter = Number.parseFloat(response.headers.get("retry-after") || "");
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 750;
      await sleep(clampDelay(delay));
      continue;
    }

    throw new Error(`${response.status} ${response.statusText}`);
  }

  throw new Error("request failed");
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("request timed out");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function clampDelay(value) {
  return Math.min(3000, Math.max(250, value));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
