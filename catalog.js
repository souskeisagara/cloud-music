// Home browse, charts, genres, item details, song comments, and like interaction.

import {
  artistAvatar,
  avatarCover,
  count,
  eapiRequest,
  mapAlbumItem,
  mapPlaylistItem,
  mapSongItem,
  positiveID,
  sessionCacheDelete,
  sessionCacheGet,
  sessionCacheGetJSON,
  sessionCacheSet,
  sessionCacheSetJSON,
  squareCover,
  text,
  weapiRequest,
} from "./api.js";
import { followArtistByID, getCachedArtistFollowed, readFollowedArtistSet } from "./creator.js";
import { t } from "./i18n.js";

const ARTIST_AVATAR_CACHE_LIMIT = 512;
const artistAvatarCache = new Map();
const SONG_PRIVILEGE_CACHE_LIMIT = 512;
const songPrivilegeCache = new Map();
const LIKED_CACHE_KEY = "liked:songs";
const LIKED_FAIL_KEY = "liked:songs:fail";
let likedCache = { at: 0, ids: new Set() };

export function invalidateLikedSongs(songID = "", enabled = null) {
  likedCache = { at: 0, ids: new Set() };
  sessionCacheDelete(LIKED_CACHE_KEY);
  sessionCacheDelete(LIKED_FAIL_KEY);
  const sid = positiveID(songID);
  if (sid && typeof enabled === "boolean") {
    sessionCacheSet(`liked:song:${sid}`, enabled ? "1" : "0", 180);
  }
}

export function getCachedSongLiked(songID) {
  const sid = positiveID(songID);
  if (!sid) return undefined;
  const override = sessionCacheGet(`liked:song:${sid}`);
  if (override === "1") return true;
  if (override === "0") return false;
  if (likedCache.at > 0 && Date.now() - likedCache.at < 180_000) {
    return likedCache.ids.has(sid);
  }
  const shared = sessionCacheGetJSON(LIKED_CACHE_KEY);
  if (Array.isArray(shared)) {
    const ids = new Set(shared);
    likedCache = { at: Date.now(), ids };
    return ids.has(sid);
  }
  return undefined;
}

export async function readLikedSongSet(uid, csrf = "", musicU = "") {
  const cleanUID = positiveID(uid);
  if (!cleanUID) return null;
  const now = Date.now();
  if (likedCache.at > 0 && now - likedCache.at < 180_000) {
    return likedCache.ids;
  }
  const shared = sessionCacheGetJSON(LIKED_CACHE_KEY);
  if (Array.isArray(shared)) {
    const ids = new Set(shared);
    likedCache = { at: now, ids };
    return ids;
  }
  if (sessionCacheGet(LIKED_FAIL_KEY) === "1") {
    return likedCache.ids;
  }
  try {
    let body;
    try {
      body = await eapiRequest("/api/song/like/get", { uid: Number(cleanUID) }, { csrf, musicU });
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      body = await weapiRequest("/weapi/song/like/get", { uid: Number(cleanUID) }, { csrf });
    }
    const raw = Array.isArray(body?.ids) ? body.ids : [];
    const next = new Set();
    for (let i = 0; i < raw.length; i++) {
      const id = positiveID(raw[i]);
      if (id) next.add(id);
    }
    likedCache = { at: now, ids: next };
    if (next.size <= 15000) {
      sessionCacheSetJSON(LIKED_CACHE_KEY, Array.from(next), 180);
    }
    return next;
  } catch (_) {
    sessionCacheSet(LIKED_FAIL_KEY, "1", 180);
    return likedCache.ids;
  }
}

function rememberPrivilege(songID, priv) {
  if (!songID || !priv || typeof priv !== "object") return;
  if (songPrivilegeCache.size >= SONG_PRIVILEGE_CACHE_LIMIT && !songPrivilegeCache.has(songID)) {
    const oldest = songPrivilegeCache.keys().next().value;
    if (oldest !== undefined) songPrivilegeCache.delete(oldest);
  }
  songPrivilegeCache.set(songID, priv);
  sessionCacheSetJSON(`priv:${songID}`, priv, 600);
}

export function cachedSongPrivilege(songID) {
  const id = positiveID(songID);
  if (!id) return null;
  const local = songPrivilegeCache.get(id);
  if (local) return local;
  const hit = sessionCacheGetJSON(`priv:${id}`);
  if (hit && typeof hit === "object") {
    songPrivilegeCache.set(id, hit);
    return hit;
  }
  return null;
}

function getCachedArtistAvatar(id) {
  if (artistAvatarCache.has(id)) {
    return { hit: true, url: artistAvatarCache.get(id) || "" };
  }
  const shared = sessionCacheGet(`av:${id}`);
  if (shared !== undefined) {
    artistAvatarCache.set(id, shared);
    return { hit: true, url: shared };
  }
  return { hit: false, url: "" };
}

export async function fetchArtistAvatar(artistID) {
  const id = positiveID(artistID);
  if (!id) return undefined;
  const cached = getCachedArtistAvatar(id);
  if (cached.hit) {
    return cached.url || undefined;
  }
  let resolved = "";
  try {
    const body = await eapiRequest("/api/artist/head/info/get", { id: Number(id) });
    resolved = artistAvatar(body?.data?.artist, 256) || "";
  } catch (_) {}
  if (artistAvatarCache.size >= ARTIST_AVATAR_CACHE_LIMIT) {
    const firstKey = artistAvatarCache.keys().next().value;
    if (firstKey !== undefined) artistAvatarCache.delete(firstKey);
  }
  artistAvatarCache.set(id, resolved);
  sessionCacheSet(`av:${id}`, resolved, resolved ? 1800 : 300);
  return resolved || undefined;
}

export async function hydrateItemsArtistAvatars(items, concurrency = 3) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const missingSet = new Set();
  for (let i = 0; i < items.length; i++) {
    const cr = items[i]?.creator;
    const aid = positiveID(cr?.id);
    if (!aid || cr.avatarURL) continue;
    const cached = getCachedArtistAvatar(aid);
    if (cached.hit) {
      if (cached.url) cr.avatarURL = cached.url;
      continue;
    }
    missingSet.add(aid);
  }
  const missing = Array.from(missingSet);
  for (let i = 0; i < missing.length; i += concurrency) {
    const batch = missing.slice(i, i + concurrency);
    await Promise.all(batch.map((aid) => fetchArtistAvatar(aid).catch(() => undefined)));
  }
  for (let i = 0; i < items.length; i++) {
    const cr = items[i]?.creator;
    const aid = positiveID(cr?.id);
    if (!aid || cr.avatarURL) continue;
    const cached = getCachedArtistAvatar(aid);
    if (cached.url) cr.avatarURL = cached.url;
  }
  return items;
}

export async function hydrateCreatorsAvatars(creators, concurrency = 3) {
  if (!Array.isArray(creators) || creators.length === 0) return creators;
  const missingSet = new Set();
  for (let i = 0; i < creators.length; i++) {
    const cr = creators[i]?.creator;
    const aid = positiveID(cr?.id);
    if (!aid || cr.avatarURL) continue;
    const cached = getCachedArtistAvatar(aid);
    if (cached.hit) {
      if (cached.url) cr.avatarURL = cached.url;
      continue;
    }
    missingSet.add(aid);
  }
  const missing = Array.from(missingSet);
  for (let i = 0; i < missing.length; i += concurrency) {
    const batch = missing.slice(i, i + concurrency);
    await Promise.all(batch.map((aid) => fetchArtistAvatar(aid).catch(() => undefined)));
  }
  for (let i = 0; i < creators.length; i++) {
    const cr = creators[i]?.creator;
    const aid = positiveID(cr?.id);
    if (!aid || cr.avatarURL) continue;
    const cached = getCachedArtistAvatar(aid);
    if (cached.url) cr.avatarURL = cached.url;
  }
  return creators;
}

const CHARTS = [
  { id: "3778678", key: "chartHot" },
  { id: "19723756", key: "chartSoar" },
  { id: "3779629", key: "chartNew" },
  { id: "2884035", key: "chartOrigin" },
  { id: "71385702", key: "chartACG" },
  { id: "2809513713", key: "chartWestern" },
  { id: "5059644681", key: "chartJP" },
];

const GENRES = [
  { id: "全部", key: "genreAll" },
  { id: "华语", key: "genreMandarin" },
  { id: "欧美", key: "genreWestern" },
  { id: "日语", key: "genreJapanese" },
  { id: "ACG", key: "genreACG" },
  { id: "流行", key: "genrePop" },
  { id: "摇滚", key: "genreRock" },
  { id: "电子", key: "genreElectronic" },
  { id: "轻音乐", key: "genreLight" },
  { id: "民谣", key: "genreFolk" },
  { id: "古风", key: "genreAncient" },
];

function chartFilters() {
  const copy = t();
  return CHARTS.map((c) => ({ id: c.id, title: copy[c.key] || c.id }));
}

function genreFilters() {
  const copy = t();
  return GENRES.map((g) => ({ id: g.id, title: copy[g.key] || g.id }));
}

const playlistMetaCache = new Map();

export function invalidatePlaylistMeta(playlistID) {
  const id = positiveID(playlistID);
  if (!id) return;
  playlistMetaCache.delete(id);
  sessionCacheDelete(`plmeta:${id}`);
}

function compactPlaylistSummary(pl) {
  if (!pl || typeof pl !== "object") return {};
  return {
    id: pl.id,
    name: pl.name,
    userId: pl.userId,
    coverImgUrl: pl.coverImgUrl,
    description: pl.description,
    playCount: pl.playCount,
    trackCount: pl.trackCount,
    privacy: pl.privacy,
    specialType: pl.specialType,
    creator: pl.creator
      ? {
          userId: pl.creator.userId,
          nickname: pl.creator.nickname,
          avatarUrl: pl.creator.avatarUrl,
        }
      : undefined,
  };
}

function rememberPlaylistMeta(playlistID, playlist) {
  if (playlistMetaCache.size >= 32 && !playlistMetaCache.has(playlistID)) {
    const oldest = playlistMetaCache.keys().next().value;
    if (oldest !== undefined) playlistMetaCache.delete(oldest);
  }
  const ids = (Array.isArray(playlist?.trackIds) ? playlist.trackIds : [])
    .map((x) => positiveID(x?.id))
    .filter(Boolean);
  const initialMap = new Map();
  if (Array.isArray(playlist?.tracks)) {
    for (let i = 0; i < playlist.tracks.length; i++) {
      const sid = positiveID(playlist.tracks[i]?.id);
      if (sid) initialMap.set(sid, playlist.tracks[i]);
    }
  }
  const entry = { playlist, ids, initialMap };
  playlistMetaCache.set(playlistID, entry);
  if (ids.length <= 5000) {
    sessionCacheSetJSON(`plmeta:${playlistID}`, { playlist: compactPlaylistSummary(playlist), ids }, 180);
  }
  return entry;
}

function loadCachedPlaylistMeta(playlistID) {
  const local = playlistMetaCache.get(playlistID);
  if (local) return local;
  const shared = sessionCacheGetJSON(`plmeta:${playlistID}`);
  if (shared && shared.playlist && Array.isArray(shared.ids)) {
    const entry = { playlist: shared.playlist, ids: shared.ids, initialMap: new Map() };
    playlistMetaCache.set(playlistID, entry);
    return entry;
  }
  return null;
}

export async function fetchPlaylistTrackIDSet(playlistID, authOpts = {}) {
  const id = positiveID(playlistID);
  if (!id) return new Set();
  const cached = loadCachedPlaylistMeta(id);
  if (cached && cached.ids.length > 0) {
    return new Set(cached.ids);
  }
  try {
    const body = await eapiRequest(
      "/api/v6/playlist/detail",
      { id: Number(id), n: 0, s: 0 },
      authOpts
    );
    if (body?.playlist) {
      const meta = rememberPlaylistMeta(id, body.playlist);
      return new Set(meta.ids);
    }
  } catch (_) {}
  return new Set();
}

export async function fetchPlaylistTracksPage(playlistID, offset = 0, limit = 40, authOpts = {}) {
  let meta = offset > 0 ? loadCachedPlaylistMeta(playlistID) : null;
  if (!meta) {
    const body = await eapiRequest(
      "/api/v6/playlist/detail",
      {
        id: Number(playlistID),
        n: Math.min(limit, 60),
        s: 0,
      },
      authOpts
    );
    const pl = body?.playlist;
    if (!pl) throw { code: "expired" };
    meta = rememberPlaylistMeta(playlistID, pl);
  }
  const total = meta.ids.length || (Array.isArray(meta.playlist?.tracks) ? meta.playlist.tracks.length : 0);
  if (meta.ids.length === 0) {
    const fallback = Array.isArray(meta.playlist?.tracks) ? meta.playlist.tracks.slice(offset, offset + limit) : [];
    return { playlist: meta.playlist, tracks: fallback, total, hasMore: offset + fallback.length < total };
  }
  const pageIDs = meta.ids.slice(offset, offset + limit);
  const missing = pageIDs.filter((id) => !meta.initialMap.has(id));
  if (missing.length > 0) {
    const hydrated = await fetchSongsByIDs(missing, authOpts).catch(() => []);
    for (let i = 0; i < hydrated.length; i++) {
      const sid = positiveID(hydrated[i]?.id);
      if (sid) meta.initialMap.set(sid, hydrated[i]);
    }
  }
  const tracks = pageIDs.map((id) => meta.initialMap.get(id)).filter(Boolean);
  return {
    playlist: meta.playlist,
    tracks,
    total,
    hasMore: offset + limit < meta.ids.length,
  };
}

export async function fetchPlaylistTracks(playlistID, limit = 60, authOpts = {}) {
  const { playlist, tracks } = await fetchPlaylistTracksPage(playlistID, 0, limit, authOpts);
  return { playlist, tracks };
}

export async function fetchSongsByIDs(ids, authOpts = {}) {
  const clean = [];
  for (let i = 0; i < ids.length; i++) {
    const id = positiveID(ids[i]);
    if (id) clean.push(id);
  }
  if (clean.length === 0) return [];
  const out = [];
  for (let i = 0; i < clean.length; i += 100) {
    const slice = clean.slice(i, i + 100);
    const body = await eapiRequest(
      "/api/v3/song/detail",
      {
        c: JSON.stringify(slice.map((id) => ({ id: Number(id) }))),
      },
      authOpts
    );
    const privs = Array.isArray(body?.privileges) ? body.privileges : [];
    for (let j = 0; j < privs.length; j++) {
      const pid = positiveID(privs[j]?.id);
      if (pid) rememberPrivilege(pid, privs[j]);
    }
    if (Array.isArray(body?.songs)) {
      for (let j = 0; j < body.songs.length; j++) out.push(body.songs[j]);
    }
  }
  return out;
}

function pushUnique(target, seen, items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !it.ref?.id) continue;
    const key = `${it.ref.kind}:${it.ref.id}`;
    if (seen[key]) continue;
    seen[key] = true;
    target.push(it);
  }
}

async function browseRecommendations(cursor, signedIn, authOpts = {}) {
  const copy = t();
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  if (page > 1) {
    const offset = (page - 1) * 20;
    const plBody = await eapiRequest(
      "/api/playlist/list",
      {
        cat: "全部",
        order: "hot",
        limit: 20,
        offset,
        total: true,
      },
      authOpts
    );
    const items = (plBody?.playlists || []).map((pl) => mapPlaylistItem(pl, copy.playlistTag)).filter(Boolean);
    return {
      collections: items.length ? [{ id: "more-playlists", title: copy.recommendedPlaylists, items }] : [],
      nextCursor: plBody?.more && items.length > 0 ? String(page + 1) : "",
    };
  }

  const jobs = [
    eapiRequest("/api/personalized/newsong", { limit: 18, areaId: 0 }, authOpts).catch(() => null),
    fetchPlaylistTracks("3778678", 24, authOpts).catch(() => null),
    eapiRequest("/api/personalized/playlist", { limit: 16 }, authOpts).catch(() => null),
  ];
  if (signedIn) {
    jobs.push(eapiRequest("/api/v3/discovery/recommend/songs", {}, authOpts).catch(() => null));
  }
  const [newSongsRes, hotRes, playlistsRes, dailyRes] = await Promise.all(jobs);

  const featuredSongs = [];
  const seen = {};
  if (Array.isArray(dailyRes?.data?.dailySongs)) {
    pushUnique(
      featuredSongs,
      seen,
      dailyRes.data.dailySongs.map((s) => mapSongItem(s)).filter(Boolean)
    );
  }
  if (Array.isArray(newSongsRes?.result)) {
    pushUnique(
      featuredSongs,
      seen,
      newSongsRes.result.map((row) => mapSongItem(row?.song || row, { coverURL: row?.picUrl })).filter(Boolean)
    );
  }
  if (Array.isArray(hotRes?.tracks)) {
    pushUnique(
      featuredSongs,
      seen,
      hotRes.tracks.map((s) => mapSongItem(s)).filter(Boolean)
    );
  }

  await hydrateItemsArtistAvatars(featuredSongs);

  const playlists = (playlistsRes?.result || [])
    .map((pl) => mapPlaylistItem(pl, copy.playlistTag))
    .filter(Boolean);

  const shelves = [];
  if (playlists.length > 0) {
    shelves.push({ id: "recommended-playlists", title: copy.recommendedPlaylists, items: playlists });
  }
  return {
    collections: featuredSongs.length ? [{ id: "recommendations", title: copy.recommendations, items: featuredSongs }] : [],
    shelves,
    nextCursor: "2",
  };
}

async function browseChart(collection, filter, cursor = "", authOpts = {}) {
  const copy = t();
  const filters = chartFilters();
  const chartID = CHARTS.some((c) => c.id === filter) ? filter : CHARTS[0].id;
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const pageSize = 40;
  const { tracks, hasMore } = await fetchPlaylistTracksPage(chartID, (page - 1) * pageSize, pageSize, authOpts);
  const items = tracks.map((s) => mapSongItem(s)).filter(Boolean);
  await hydrateItemsArtistAvatars(items);
  return {
    collections: items.length ? [{ id: collection, title: copy[collection] || copy.ranking, items }] : [],
    filters,
    nextCursor: hasMore && items.length > 0 ? String(page + 1) : "",
  };
}

async function browseGenres(filter, cursor, authOpts = {}) {
  const copy = t();
  const filters = genreFilters();
  const cat = GENRES.some((g) => g.id === filter) ? filter : "全部";
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const limit = 24;
  const body = await eapiRequest(
    "/api/playlist/list",
    {
      cat,
      order: "hot",
      limit,
      offset: (page - 1) * limit,
      total: true,
    },
    authOpts
  );
  const items = (body?.playlists || []).map((pl) => mapPlaylistItem(pl, cat === "全部" ? copy.playlistTag : cat)).filter(Boolean);
  return {
    collections: items.length ? [{ id: "regions", title: copy.regions, items }] : [],
    filters,
    nextCursor: body?.more && items.length > 0 ? String(page + 1) : "",
  };
}

export async function browse({ collection = "", filter = "", cursor = "", signedIn = false, secret } = {}) {
  const authOpts = { csrf: text(secret?.csrf), musicU: text(secret?.musicU) };
  switch (collection) {
    case "":
    case "recommendations":
      return browseRecommendations(cursor, signedIn, authOpts);
    case "popular":
      return browseChart("popular", filter || "19723756", cursor, authOpts);
    case "ranking":
      return browseChart("ranking", filter || "3778678", cursor, authOpts);
    case "regions":
      return browseGenres(filter, cursor, authOpts);
    default:
      throw { code: "unsupported" };
  }
}

function mapComment(row) {
  const id = positiveID(row?.commentId);
  const body = text(row?.content);
  if (!id || !body) return undefined;
  const user = row?.user || {};
  const tsMs = Number(row?.time || 0);
  const replied = Array.isArray(row?.beReplied) && row.beReplied.length > 0 ? row.beReplied[0] : null;
  const replyToAuthor = text(replied?.user?.nickname) || undefined;
  const replyCount = count(row?.showFloorComment?.replyCount);
  return {
    id,
    body,
    author: text(user.nickname) || "Listener",
    replyToAuthor,
    avatarURL: avatarCover(user.avatarUrl, 96),
    publishedAt: tsMs > 0 ? Math.floor(tsMs / 1000) : undefined,
    location: text(row?.ipLocation?.location) || undefined,
    likes: count(row?.likedCount),
    replyCount,
    liked: row?.liked === true,
  };
}

function commentThreadForRef(ref) {
  const kind = text(ref?.kind);
  const rawID = text(ref?.id);
  if (kind === "video") {
    const id = positiveID(rawID);
    return id ? { thread: `R_SO_4_${id}`, type: 0, id } : null;
  }
  if (kind === "series") {
    const [prefix, id] = rawID.split(":");
    if (prefix === "pl" && positiveID(id)) return { thread: `A_PL_0_${id}`, type: 2, id };
    if (prefix === "al" && positiveID(id)) return { thread: `R_AL_3_${id}`, type: 3, id };
  }
  return null;
}

async function fetchSongDetail(songID, signedIn, secret) {
  const csrf = text(secret?.csrf);
  const musicU = text(secret?.musicU);
  const authOpts = { csrf, musicU };
  const songWithAvatarJob = fetchSongsByIDs([songID], authOpts).then(async (songs) => {
    const song = songs[0];
    if (!song) return { song: null, avatarURL: undefined };
    const firstArtist = Array.isArray(song?.ar) ? song.ar[0] : Array.isArray(song?.artists) ? song.artists[0] : null;
    const aid = positiveID(firstArtist?.id);
    let avatarURL = artistAvatar(firstArtist, 256);
    if (!avatarURL && aid) {
      avatarURL = await fetchArtistAvatar(aid);
    }
    return { song, avatarURL };
  });
  const cachedLiked = signedIn ? getCachedSongLiked(songID) : undefined;
  const [{ song, avatarURL }, commentRes, simiRes, likedSet, followedSet] = await Promise.all([
    songWithAvatarJob,
    eapiRequest(`/api/v1/resource/comments/R_SO_4_${songID}`, { limit: 15, offset: 0 }, authOpts).catch(() => null),
    eapiRequest("/api/v1/discovery/simiSong", { songid: Number(songID), limit: 12, offset: 0 }, authOpts).catch(() => null),
    signedIn && cachedLiked === undefined && positiveID(secret?.uid)
      ? readLikedSongSet(secret.uid, csrf, musicU)
      : Promise.resolve(null),
    signedIn ? readFollowedArtistSet(csrf, musicU) : Promise.resolve(null),
  ]);
  if (!song) throw { code: "expired" };
  const base = mapSongItem(song);
  if (!base) throw { code: "expired" };
  if (base.creator) {
    if (!base.creator.avatarURL && avatarURL) {
      base.creator.avatarURL = avatarURL;
    }
    if (base.creator.id) {
      const override = getCachedArtistFollowed(base.creator.id);
      if (override !== undefined) {
        base.creator.following = override;
      } else if (followedSet && followedSet.has(base.creator.id)) {
        base.creator.following = true;
      }
    }
  }

  const isLiked = cachedLiked !== undefined ? cachedLiked : Boolean(likedSet && likedSet.has(songID));
  const hotComments = (commentRes?.hotComments || []).map(mapComment).filter(Boolean);
  const recentComments = (commentRes?.comments || []).map(mapComment).filter(Boolean);
  const comments = hotComments.length > 0 ? hotComments : recentComments;
  let related = (simiRes?.songs || []).map((s) => mapSongItem(s)).filter(Boolean);
  if (related.length === 0 && base.creator?.id && positiveID(base.creator.id)) {
    const artistSongs = await eapiRequest(
      "/api/v1/artist/songs",
      {
        id: Number(base.creator.id),
        order: "hot",
        limit: 12,
        offset: 0,
      },
      authOpts
    ).catch(() => null);
    related = (artistSongs?.songs || [])
      .map((s) => mapSongItem(s))
      .filter((it) => it && it.ref.id !== songID);
  }
  await hydrateItemsArtistAvatars(related);

  const descParts = [];
  if (base.creator?.name) descParts.push(base.creator.name);
  if (base.category) descParts.push(base.category);
  if (Array.isArray(song.alia) && song.alia.length > 0) descParts.push(song.alia.join(" / "));

  return Object.assign(base, {
    subtitle: descParts.join(" · ") || base.subtitle,
    videoDetails: {
      access: "granted",
      publishedAt: song.publishTime > 0 ? Math.floor(song.publishTime / 1000) : undefined,
      engagement: { liked: isLiked },
      comments: count(commentRes?.total),
      discussion: comments,
      related,
    },
  });
}

async function fetchCollectionDetail(kindPrefix, id, secret) {
  const copy = t();
  const authOpts = { csrf: text(secret?.csrf), musicU: text(secret?.musicU) };
  if (kindPrefix === "pl") {
    const [{ playlist, tracks }, commentRes] = await Promise.all([
      fetchPlaylistTracks(id, 300, authOpts),
      eapiRequest(`/api/v1/resource/comments/A_PL_0_${id}`, { limit: 15, offset: 0 }, authOpts).catch(() => null),
    ]);
    const segments = tracks
      .map((s) => {
        const sid = positiveID(s?.id);
        const title = text(s?.name);
        if (!sid || !title) return undefined;
        const ar = (s?.ar || []).map((a) => text(a?.name)).filter(Boolean).join(" / ");
        const seg = {
          title: ar ? `${title} · ${ar}` : title,
          partID: sid,
          ref: { kind: "video", id: sid },
        };
        if (s.dt > 0) seg.durationSeconds = Math.max(1, Math.round(s.dt / 1000));
        return seg;
      })
      .filter(Boolean);
    const creator = positiveID(playlist.creator?.userId)
      ? {
          id: String(playlist.creator.userId),
          name: text(playlist.creator.nickname) || copy.playlistTag,
          avatarURL: avatarCover(playlist.creator.avatarUrl, 96),
        }
      : undefined;
    const hotComments = (commentRes?.hotComments || []).map(mapComment).filter(Boolean);
    const recentComments = (commentRes?.comments || []).map(mapComment).filter(Boolean);
    return {
      ref: { kind: "series", id: `pl:${id}` },
      title: text(playlist.name) || copy.playlistTag,
      subtitle: text(playlist.description) || copy.trackCount(segments.length),
      creator,
      coverURL: squareCover(playlist.coverImgUrl, 1024),
      backdropURL: squareCover(playlist.coverImgUrl, 2048),
      views: count(playlist.playCount),
      category: copy.playlistTag,
      videoDetails: {
        access: "granted",
        segmentKind: "parts",
        segments,
        comments: count(commentRes?.total),
        discussion: hotComments.length > 0 ? hotComments : recentComments,
      },
    };
  }
  if (kindPrefix === "al") {
    const [body, commentRes] = await Promise.all([
      eapiRequest(`/api/v1/album/${id}`, {}, authOpts),
      eapiRequest(`/api/v1/resource/comments/R_AL_3_${id}`, { limit: 15, offset: 0 }, authOpts).catch(() => null),
    ]);
    const album = body?.album;
    if (!album) throw { code: "expired" };
    const songs = Array.isArray(body?.songs) ? body.songs : [];
    const segments = songs
      .map((s) => {
        const sid = positiveID(s?.id);
        const title = text(s?.name);
        if (!sid || !title) return undefined;
        const seg = {
          title,
          partID: sid,
          ref: { kind: "video", id: sid },
        };
        if (s.dt > 0) seg.durationSeconds = Math.max(1, Math.round(s.dt / 1000));
        return seg;
      })
      .filter(Boolean);
    const base = mapAlbumItem(album, copy.albumTag);
    if (!base) throw { code: "expired" };
    if (base.creator && !base.creator.avatarURL && base.creator.id) {
      base.creator.avatarURL = await fetchArtistAvatar(base.creator.id);
    }
    const hotComments = (commentRes?.hotComments || []).map(mapComment).filter(Boolean);
    const recentComments = (commentRes?.comments || []).map(mapComment).filter(Boolean);
    return Object.assign(base, {
      subtitle: text(album.description) || base.subtitle || copy.trackCount(segments.length),
      videoDetails: {
        access: "granted",
        publishedAt: album.publishTime > 0 ? Math.floor(album.publishTime / 1000) : undefined,
        segmentKind: "parts",
        segments,
        comments: count(commentRes?.total),
        discussion: hotComments.length > 0 ? hotComments : recentComments,
      },
    });
  }
  throw { code: "unsupported" };
}

export async function getItem(input) {
  const ref = input?.ref || input;
  const kind = text(ref?.kind);
  const rawID = text(ref?.id);
  if (kind === "video") {
    const songID = positiveID(rawID);
    if (!songID) throw { code: "permission" };
    return fetchSongDetail(songID, Boolean(input?.signedIn), input?.secret);
  }
  if (kind === "series") {
    const [prefix, id] = rawID.split(":");
    if ((prefix === "pl" || prefix === "al") && positiveID(id)) {
      return fetchCollectionDetail(prefix, id, input?.secret);
    }
  }
  throw { code: "unsupported" };
}

export async function videoComments({ ref, order = "hot", threadID = "", page = 0, secret } = {}) {
  const target = commentThreadForRef(ref);
  if (!target) return { comments: [] };
  const limit = 20;
  const authOpts = { csrf: text(secret?.csrf), musicU: text(secret?.musicU) };

  if (threadID) {
    const parentID = positiveID(threadID);
    if (!parentID) return { comments: [] };
    if (Number(page) > 1) return { comments: [] };
    const body = await eapiRequest(
      "/api/comment/floor/get",
      {
        parentCommentId: Number(parentID),
        threadId: target.thread,
        type: target.type,
        limit,
        time: -1,
      },
      authOpts
    ).catch(() => null);
    const rows = Array.isArray(body?.data?.comments) ? body.data.comments : [];
    return {
      comments: rows.map(mapComment).filter(Boolean),
    };
  }

  const pageIdx = Math.max(0, Number(page) || 0);
  const offset = pageIdx * limit;
  if (order === "hot") {
    const hotBody = await eapiRequest(
      `/api/v1/resource/hotcomments/${target.thread}`,
      {
        limit,
        offset,
      },
      authOpts
    ).catch(() => null);
    if (hotBody && Array.isArray(hotBody.hotComments) && hotBody.hotComments.length > 0) {
      const comments = hotBody.hotComments.map(mapComment).filter(Boolean);
      return {
        comments,
        nextPage: hotBody.hasMore && comments.length > 0 ? pageIdx + 1 : undefined,
      };
    }
    if (pageIdx > 0) {
      return { comments: [] };
    }
  }

  const body = await eapiRequest(
    `/api/v1/resource/comments/${target.thread}`,
    {
      limit,
      offset,
    },
    authOpts
  );
  const list =
    order === "hot" && pageIdx === 0 && Array.isArray(body?.hotComments) && body.hotComments.length > 0
      ? body.hotComments
      : body?.comments || [];
  const comments = list.map(mapComment).filter(Boolean);
  const total = count(body?.total) ?? 0;
  return {
    comments,
    nextPage: body?.more && offset + limit < total && comments.length > 0 ? pageIdx + 1 : undefined,
  };
}

export async function editVideo({ ref, interaction, enabled, replyID, owner, secret } = {}) {
  const uid = positiveID(owner || secret?.uid);
  if (!uid) throw { code: "signIn" };
  const target = commentThreadForRef(ref);
  if (!target) throw { code: "permission" };
  const csrf = text(secret?.csrf);
  const musicU = text(secret?.musicU);
  if (interaction === "like") {
    if (target.type !== 0) throw { code: "unsupported" };
    const payload = {
      trackId: Number(target.id),
      like: Boolean(enabled),
      alg: "itembased",
      time: 3,
    };
    try {
      await eapiRequest("/api/radio/like", payload, { csrf, musicU });
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      await weapiRequest("/weapi/radio/like", payload, { csrf });
    }
    invalidateLikedSongs(target.id, Boolean(enabled));
    return { liked: Boolean(enabled) };
  }
  if (interaction === "follow") {
    if (target.type !== 0) throw { code: "unsupported" };
    const songs = await fetchSongsByIDs([target.id], { csrf, musicU });
    const song = songs[0];
    const firstArtist = Array.isArray(song?.ar) ? song.ar[0] : Array.isArray(song?.artists) ? song.artists[0] : null;
    const aid = positiveID(firstArtist?.id);
    if (!aid) throw { code: "expired" };
    return followArtistByID(aid, Boolean(enabled), secret);
  }
  if (interaction === "replyLike") {
    const cid = positiveID(replyID);
    if (!cid) throw { code: "permission" };
    const payload = {
      cid: Number(cid),
      threadId: target.thread,
    };
    const apiPath = enabled ? "/api/v1/comment/like" : "/api/v1/comment/unlike";
    const weapiPath = enabled ? "/weapi/v1/comment/like" : "/weapi/v1/comment/unlike";
    try {
      await eapiRequest(apiPath, payload, { csrf, musicU });
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      await weapiRequest(weapiPath, payload, { csrf });
    }
    return { liked: Boolean(enabled) };
  }
  throw { code: "unsupported" };
}
