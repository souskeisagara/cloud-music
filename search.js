// Search discovery, hot keywords, suggestions, and multi-kind search (songs, artists, playlists, albums).

import {
  artistAvatar,
  count,
  eapiRequest,
  mapAlbumItem,
  mapPlaylistItem,
  mapSongItem,
  positiveID,
  text,
} from "./api.js";
import { fetchPlaylistTracksPage, hydrateCreatorsAvatars, hydrateItemsArtistAvatars } from "./catalog.js";
import { t } from "./i18n.js";

const SUPPORTED_KINDS = ["all", "video", "creator", "series"];
const PAGE_SIZE = 20;

function pageIndex(cursor) {
  if (!cursor) return 1;
  const n = Number(cursor);
  if (!Number.isSafeInteger(n) || n < 1 || String(n) !== String(cursor)) {
    throw { code: "permission" };
  }
  return n;
}

async function hotKeywords(authOpts = {}) {
  const body = await eapiRequest("/api/search/hot", { type: 1111 }, authOpts);
  const hots = Array.isArray(body?.result?.hots) ? body.result.hots : [];
  return hots
    .map((h) => text(h?.first))
    .filter(Boolean)
    .slice(0, 12);
}

function mapArtistCreator(row) {
  const id = positiveID(row?.id);
  const name = text(row?.name);
  if (!id || !name) return undefined;
  const alias = Array.isArray(row?.alias) && row.alias.length > 0 ? text(row.alias[0]) : "";
  return {
    creator: {
      id,
      name,
      avatarURL: artistAvatar(row, 256),
    },
    description: alias || undefined,
    videos: count(row?.musicSize),
  };
}

async function discovery(kind, page, authOpts = {}) {
  const copy = t();
  const hot = page === 1 ? await hotKeywords(authOpts).catch(() => []) : undefined;

  if (kind === "series") {
    const body = await eapiRequest(
      "/api/playlist/list",
      {
        cat: "全部",
        order: "hot",
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        total: true,
      },
      authOpts
    );
    const items = (body?.playlists || []).map((pl) => mapPlaylistItem(pl, copy.playlistTag)).filter(Boolean);
    return {
      items,
      nextCursor: body?.more && items.length > 0 ? String(page + 1) : "",
      hotKeywords: hot,
      kinds: SUPPORTED_KINDS,
    };
  }

  const { tracks, hasMore } = await fetchPlaylistTracksPage("3778678", (page - 1) * PAGE_SIZE, PAGE_SIZE, authOpts);
  if (kind === "creator") {
    const seen = new Set();
    const creators = [];
    for (const s of tracks) {
      for (const ar of s?.ar || []) {
        const mapped = mapArtistCreator(ar);
        if (!mapped || seen.has(mapped.creator.id)) continue;
        seen.add(mapped.creator.id);
        creators.push(mapped);
      }
    }
    const pageCreators = creators.slice(0, PAGE_SIZE);
    await hydrateCreatorsAvatars(pageCreators);
    return {
      creators: pageCreators,
      nextCursor: hasMore && pageCreators.length > 0 ? String(page + 1) : "",
      hotKeywords: hot,
      kinds: SUPPORTED_KINDS,
    };
  }

  const items = tracks.map((s) => mapSongItem(s)).filter(Boolean);
  await hydrateItemsArtistAvatars(items);
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? String(page + 1) : "",
    hotKeywords: hot,
    kinds: SUPPORTED_KINDS,
  };
}

export async function search({ query = "", kind = "all", cursor = "", secret } = {}) {
  const copy = t();
  const authOpts = { csrf: text(secret?.csrf), musicU: text(secret?.musicU) };
  const keyword = text(query);
  const activeKind = kind || "all";
  const page = pageIndex(cursor);
  if (!keyword) {
    return discovery(activeKind, page, authOpts);
  }
  const offset = (page - 1) * PAGE_SIZE;

  if (activeKind === "creator") {
    const body = await eapiRequest(
      "/api/cloudsearch/pc",
      {
        s: keyword,
        type: 100,
        limit: PAGE_SIZE,
        offset,
        total: true,
      },
      authOpts
    );
    const artists = Array.isArray(body?.result?.artists) ? body.result.artists : [];
    const creators = artists.map(mapArtistCreator).filter(Boolean);
    await hydrateCreatorsAvatars(creators);
    const total = count(body?.result?.artistCount) ?? creators.length;
    return {
      creators,
      total,
      nextCursor: creators.length > 0 && offset + PAGE_SIZE < total ? String(page + 1) : "",
      kinds: SUPPORTED_KINDS,
    };
  }

  if (activeKind === "series") {
    const [plBody, alBody] = await Promise.all([
      eapiRequest(
        "/api/cloudsearch/pc",
        {
          s: keyword,
          type: 1000,
          limit: 12,
          offset: (page - 1) * 12,
          total: true,
        },
        authOpts
      ),
      page === 1
        ? eapiRequest(
            "/api/cloudsearch/pc",
            {
              s: keyword,
              type: 10,
              limit: 8,
              offset: 0,
              total: true,
            },
            authOpts
          ).catch(() => null)
        : Promise.resolve(null),
    ]);
    const playlists = (plBody?.result?.playlists || []).map((pl) => mapPlaylistItem(pl, copy.playlistTag)).filter(Boolean);
    const albums = (alBody?.result?.albums || []).map((al) => mapAlbumItem(al, copy.albumTag)).filter(Boolean);
    const items = page === 1 ? albums.concat(playlists) : playlists;
    const total = count(plBody?.result?.playlistCount) ?? items.length;
    return {
      items,
      total,
      nextCursor: playlists.length > 0 && page * 12 < total ? String(page + 1) : "",
      kinds: SUPPORTED_KINDS,
    };
  }

  const body = await eapiRequest(
    "/api/cloudsearch/pc",
    {
      s: keyword,
      type: 1,
      limit: PAGE_SIZE,
      offset,
      total: true,
    },
    authOpts
  );
  const songs = Array.isArray(body?.result?.songs) ? body.result.songs : [];
  const items = songs.map((s) => mapSongItem(s)).filter(Boolean);
  await hydrateItemsArtistAvatars(items);
  const total = count(body?.result?.songCount) ?? items.length;
  return {
    items,
    total,
    nextCursor: items.length > 0 && offset + PAGE_SIZE < total ? String(page + 1) : "",
    kinds: SUPPORTED_KINDS,
  };
}

export async function searchSuggest({ query = "", secret } = {}) {
  const term = text(query);
  if (!term) return { suggestions: [] };
  const body = await eapiRequest(
    "/api/search/suggest/keyword",
    { s: term },
    { csrf: text(secret?.csrf), musicU: text(secret?.musicU) }
  ).catch(() => null);
  const rows = Array.isArray(body?.result?.allMatch) ? body.result.allMatch : [];
  const seen = new Set();
  const suggestions = [];
  for (let i = 0; i < rows.length; i++) {
    const kw = text(rows[i]?.keyword);
    if (!kw || seen.has(kw.toLowerCase())) continue;
    seen.add(kw.toLowerCase());
    suggestions.push(kw);
    if (suggestions.length >= 8) break;
  }
  return { suggestions };
}
