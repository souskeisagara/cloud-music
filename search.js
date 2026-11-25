// Search discovery, hot keywords, suggestions, and multi-kind search (songs, artists, playlists, albums).

import {
  avatarCover,
  count,
  eapiRequest,
  mapAlbumItem,
  mapPlaylistItem,
  mapSongItem,
  positiveID,
  text,
} from "./api.js";
import { fetchPlaylistTracks } from "./catalog.js";
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

async function hotKeywords() {
  const body = await eapiRequest("/api/search/hot", { type: 1111 });
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
      avatarURL: avatarCover(row?.img1v1Url || row?.picUrl, 192),
    },
    description: alias || undefined,
    videos: count(row?.musicSize),
  };
}

async function discovery(kind, page) {
  const copy = t();
  const hot = page === 1 ? await hotKeywords().catch(() => []) : undefined;

  if (kind === "series") {
    const body = await eapiRequest("/api/playlist/list", {
      cat: "全部",
      order: "hot",
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      total: true,
    });
    const items = (body?.playlists || []).map((pl) => mapPlaylistItem(pl, copy.playlistTag)).filter(Boolean);
    return {
      items,
      nextCursor: body?.more && items.length > 0 ? String(page + 1) : "",
      hotKeywords: hot,
      kinds: SUPPORTED_KINDS,
    };
  }

  const { tracks } = await fetchPlaylistTracks("3778678", 30);
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
    return {
      creators: page === 1 ? creators.slice(0, 20) : [],
      nextCursor: "",
      hotKeywords: hot,
      kinds: SUPPORTED_KINDS,
    };
  }

  const items = page === 1 ? tracks.map((s) => mapSongItem(s)).filter(Boolean) : [];
  return {
    items,
    nextCursor: "",
    hotKeywords: hot,
    kinds: SUPPORTED_KINDS,
  };
}

export async function search({ query = "", kind = "all", cursor = "" } = {}) {
  const copy = t();
  const keyword = text(query);
  const activeKind = kind || "all";
  const page = pageIndex(cursor);
  if (!keyword) {
    return discovery(activeKind, page);
  }
  const offset = (page - 1) * PAGE_SIZE;

  if (activeKind === "creator") {
    const body = await eapiRequest("/api/cloudsearch/pc", {
      s: keyword,
      type: 100,
      limit: PAGE_SIZE,
      offset,
      total: true,
    });
    const artists = Array.isArray(body?.result?.artists) ? body.result.artists : [];
    const creators = artists.map(mapArtistCreator).filter(Boolean);
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
      eapiRequest("/api/cloudsearch/pc", {
        s: keyword,
        type: 1000,
        limit: 12,
        offset: (page - 1) * 12,
        total: true,
      }),
      page === 1
        ? eapiRequest("/api/cloudsearch/pc", {
            s: keyword,
            type: 10,
            limit: 8,
            offset: 0,
            total: true,
          }).catch(() => null)
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

  const body = await eapiRequest("/api/cloudsearch/pc", {
    s: keyword,
    type: 1,
    limit: PAGE_SIZE,
    offset,
    total: true,
  });
  const songs = Array.isArray(body?.result?.songs) ? body.result.songs : [];
  const items = songs.map((s) => mapSongItem(s)).filter(Boolean);
  const total = count(body?.result?.songCount) ?? items.length;
  return {
    items,
    total,
    nextCursor: items.length > 0 && offset + PAGE_SIZE < total ? String(page + 1) : "",
    kinds: SUPPORTED_KINDS,
  };
}

export async function searchSuggest({ query = "" } = {}) {
  const term = text(query);
  if (!term) return { suggestions: [] };
  const body = await eapiRequest("/api/search/suggest/keyword", { s: term }).catch(() => null);
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
