// Artist / creator profile, paginated songs & albums, follow/unfollow, and Following feed.

import {
  artistAvatar,
  count,
  eapiRequest,
  linuxapiRequest,
  mapAlbumItem,
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
import { t } from "./i18n.js";

const SUPPORTED_TABS = ["videos", "collections", "about"];
const FOLLOWED_CACHE_KEY = "followed:artists";
const FOLLOWED_FAIL_KEY = "followed:artists:fail";
const FOLLOWING_UPDATES_KEY = "following:updates";

let followedCache = { at: 0, ids: new Set() };

export function invalidateFollowedArtists(artistID = "", enabled = null) {
  followedCache = { at: 0, ids: new Set() };
  sessionCacheDelete(FOLLOWED_CACHE_KEY);
  sessionCacheDelete(FOLLOWED_FAIL_KEY);
  sessionCacheDelete(FOLLOWING_UPDATES_KEY);
  for (let p = 1; p <= 5; p++) {
    sessionCacheDelete(`following:creators:p:${p}`);
  }
  const aid = positiveID(artistID);
  if (aid && typeof enabled === "boolean") {
    sessionCacheSet(`followed:artist:${aid}`, enabled ? "1" : "0", 180);
  }
}

export function getCachedArtistFollowed(artistID) {
  const aid = positiveID(artistID);
  if (!aid) return undefined;
  const override = sessionCacheGet(`followed:artist:${aid}`);
  if (override === "1") return true;
  if (override === "0") return false;
  if (followedCache.at > 0 && Date.now() - followedCache.at < 180_000) {
    return followedCache.ids.has(aid);
  }
  const shared = sessionCacheGetJSON(FOLLOWED_CACHE_KEY);
  if (Array.isArray(shared)) {
    const ids = new Set(shared);
    followedCache = { at: Date.now(), ids };
    return ids.has(aid);
  }
  return undefined;
}

function mapArtistRecord(ar) {
  if (!ar || typeof ar !== "object") return undefined;
  const base = ar.artistVo || ar.artist || ar.userProfile || ar;
  const id = positiveID(base?.artistId ?? ar?.artistId ?? base?.id ?? ar?.id);
  const name = text(base?.name || base?.nickname || ar?.name || ar?.nickname);
  if (!id || !name) return undefined;
  const avatarURL = artistAvatar(base, 256) || artistAvatar(ar, 256);
  const alias = Array.isArray(base?.alias) && base.alias.length > 0 ? text(base.alias[0]) : "";
  const bio = text(base?.info || ar?.info || base?.signature || ar?.signature) || alias || undefined;
  return {
    creator: {
      id,
      name,
      avatarURL,
      following: true,
    },
    bio,
  };
}

async function fetchSubbedArtistsMixed(limit, mixedCursor = 0, csrf = "", musicU = "") {
  const payload = {
    authority: "false",
    page: JSON.stringify({ size: limit, cursor: mixedCursor }),
    scene: 1,
    size: limit,
    sortType: "0",
  };
  const body = await eapiRequest("/api/user/follow/users/mixed/get/v2", payload, { csrf, musicU });
  const records = Array.isArray(body?.data?.records)
    ? body.data.records
    : Array.isArray(body?.records)
      ? body.records
      : [];
  const creators = records.map(mapArtistRecord).filter(Boolean);
  const pageInfo = body?.data?.page || body?.page || {};
  const more = Boolean(pageInfo?.more ?? body?.data?.more ?? body?.more);
  const nextCur = text(String(pageInfo?.cursor ?? body?.data?.cursor ?? body?.cursor ?? ""));
  return {
    creators,
    creatorsCursor: more && nextCur && nextCur !== "0" && creators.length > 0 ? `m:${nextCur}` : "",
  };
}

async function fetchSubbedArtistsRaw(limit, offset, csrf = "", musicU = "") {
  const payload = { limit, offset, total: true };
  let lastErr = null;
  const attempts = [
    () => weapiRequest("/weapi/artist/sublist", payload, { csrf }),
    () => eapiRequest("/api/artist/sublist", payload, { csrf, musicU }),
    () => linuxapiRequest("/api/artist/sublist", payload),
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await attempts[i]();
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      lastErr = err;
    }
  }
  throw lastErr || { code: "plugin", message: "Failed to load followed artists" };
}

export async function readFollowedArtistSet(csrf = "", musicU = "") {
  const now = Date.now();
  if (followedCache.at > 0 && now - followedCache.at < 180_000) {
    return followedCache.ids;
  }
  const shared = sessionCacheGetJSON(FOLLOWED_CACHE_KEY);
  if (Array.isArray(shared)) {
    const ids = new Set(shared);
    followedCache = { at: now, ids };
    return ids;
  }
  if (sessionCacheGet(FOLLOWED_FAIL_KEY) === "1") {
    return followedCache.ids;
  }
  try {
    const next = new Set();
    try {
      const body = await fetchSubbedArtistsRaw(100, 0, csrf, musicU);
      const rows = Array.isArray(body?.data) ? body.data : [];
      for (let i = 0; i < rows.length; i++) {
        const id = positiveID(rows[i]?.id);
        if (id) next.add(id);
      }
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      const mixed = await fetchSubbedArtistsMixed(100, 0, csrf, musicU);
      for (let i = 0; i < mixed.creators.length; i++) {
        const id = positiveID(mixed.creators[i]?.creator?.id);
        if (id) next.add(id);
      }
    }
    followedCache = { at: now, ids: next };
    sessionCacheSetJSON(FOLLOWED_CACHE_KEY, Array.from(next), 180);
    return next;
  } catch (_) {
    sessionCacheSet(FOLLOWED_FAIL_KEY, "1", 180);
    return followedCache.ids;
  }
}

export async function followArtistByID(artistID, enabled, secret) {
  const id = positiveID(artistID);
  if (!id) throw { code: "permission" };
  const apiPath = enabled ? "/api/artist/sub" : "/api/artist/unsub";
  const weapiPath = enabled ? "/weapi/artist/sub" : "/weapi/artist/unsub";
  const payload = { artistId: Number(id), artistIds: `[${id}]` };
  const csrf = text(secret?.csrf);
  const musicU = text(secret?.musicU);
  try {
    await weapiRequest(weapiPath, payload, { csrf });
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    await eapiRequest(apiPath, payload, { csrf, musicU });
  }
  invalidateFollowedArtists(id, Boolean(enabled));
  return { following: Boolean(enabled) };
}

export async function followCreator({ creatorID, enabled = false, owner, secret } = {}) {
  const uid = positiveID(owner || secret?.uid);
  if (!uid) throw { code: "signIn" };
  return followArtistByID(creatorID, Boolean(enabled), secret);
}

export async function readCreator({ creatorID, tab = "videos", cursor = "", includeProfile = true, signedIn = false, secret } = {}) {
  const copy = t();
  const artistID = positiveID(creatorID);
  if (!artistID) throw { code: "permission" };

  const authOpts = { csrf: text(secret?.csrf), musicU: text(secret?.musicU) };
  const activeTab = tab || "videos";
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const songPageSize = 30;

  const [artistBody, songsBody, albumsBody] = await Promise.all([
    includeProfile
      ? eapiRequest(`/api/v1/artist/${artistID}`, {}, authOpts)
      : activeTab === "about" || (activeTab === "videos" && page === 1)
        ? eapiRequest(`/api/v1/artist/${artistID}`, {}, authOpts).catch(() => null)
        : Promise.resolve(null),
    activeTab === "videos"
      ? eapiRequest(
          "/api/v1/artist/songs",
          {
            id: Number(artistID),
            private_cloud: "true",
            work_type: 1,
            order: "hot",
            limit: songPageSize,
            offset: (page - 1) * songPageSize,
          },
          authOpts
        ).catch(() => null)
      : Promise.resolve(null),
    activeTab === "collections"
      ? eapiRequest(
          `/api/artist/albums/${artistID}`,
          {
            limit: 20,
            offset: (page - 1) * 20,
            total: true,
          },
          authOpts
        )
      : Promise.resolve(null),
  ]);

  const artist = artistBody?.artist;
  const resolvedAvatar = artistAvatar(artist, 256);

  const out = {};
  if (includeProfile) {
    const name = text(artist?.name);
    if (!name) throw { code: "expired" };
    const cachedFollow = signedIn ? getCachedArtistFollowed(artistID) : undefined;
    const following = cachedFollow !== undefined ? cachedFollow : Boolean(artist?.followed);
    out.profile = {
      creator: {
        id: artistID,
        name,
        avatarURL: resolvedAvatar,
        following,
      },
      backdropURL: squareCover(artist?.picUrl || artist?.img1v1Url, 2048),
      bio: text(artist?.briefDesc) || copy.artistBioEmpty,
      works: count(artist?.musicSize),
      tabs: SUPPORTED_TABS,
    };
  }

  if (activeTab === "collections") {
    const rawAlbums = Array.isArray(albumsBody?.hotAlbums) ? albumsBody.hotAlbums : [];
    out.collections = rawAlbums
      .map((al) => {
        const mapped = mapAlbumItem(al, copy.albumTag);
        if (!mapped) return undefined;
        if (mapped.creator && !mapped.creator.avatarURL && resolvedAvatar) {
          mapped.creator.avatarURL = resolvedAvatar;
        }
        return {
          id: mapped.ref.id,
          title: mapped.title,
          description: text(al?.subType || al?.company) || undefined,
          count: count(al?.size),
          items: [mapped],
        };
      })
      .filter(Boolean);
    out.nextCursor = albumsBody?.more && rawAlbums.length > 0 ? String(page + 1) : "";
    return out;
  }

  if (activeTab === "videos") {
    const pagedSongs = Array.isArray(songsBody?.songs) ? songsBody.songs : [];
    const rawSongs = pagedSongs.length > 0 ? pagedSongs : page === 1 && Array.isArray(artistBody?.hotSongs) ? artistBody.hotSongs : [];
    out.items = rawSongs
      .map((s) => {
        const item = mapSongItem(s);
        if (item?.creator && item.creator.id === artistID && !item.creator.avatarURL && resolvedAvatar) {
          item.creator.avatarURL = resolvedAvatar;
        }
        return item;
      })
      .filter(Boolean);
    out.nextCursor = songsBody?.more && pagedSongs.length > 0 ? String(page + 1) : "";
  }
  return out;
}

async function fetchSubbedArtistsPage(cursor, csrf = "", musicU = "") {
  const limit = 30;
  if (typeof cursor === "string" && cursor.startsWith("m:")) {
    return fetchSubbedArtistsMixed(limit, cursor.slice(2), csrf, musicU);
  }
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const cacheKey = `following:creators:p:${page}`;
  const cached = sessionCacheGetJSON(cacheKey);
  if (cached && Array.isArray(cached.creators)) {
    return cached;
  }

  const offset = (page - 1) * limit;
  let result = null;
  let sublistErr = null;
  try {
    const body = await fetchSubbedArtistsRaw(limit, offset, csrf, musicU);
    const list = Array.isArray(body?.data) ? body.data : [];
    const creators = list.map(mapArtistRecord).filter(Boolean);
    const hasMore = Boolean(body?.hasMore) && creators.length > 0;
    result = {
      creators,
      creatorsCursor: hasMore ? String(page + 1) : "",
    };
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    sublistErr = err;
  }

  if (!result && page === 1) {
    try {
      result = await fetchSubbedArtistsMixed(limit, 0, csrf, musicU);
    } catch (err) {
      if (err && err.code === "signIn") throw err;
      throw sublistErr || err;
    }
  }
  if (!result) {
    throw sublistErr || { code: "plugin", message: "Failed to load followed artists" };
  }

  sessionCacheSetJSON(cacheKey, result, 120);
  if (page === 1 && !result.creatorsCursor) {
    const ids = result.creators.map((c) => c.creator.id).filter(Boolean);
    followedCache = { at: Date.now(), ids: new Set(ids) };
    sessionCacheSetJSON(FOLLOWED_CACHE_KEY, ids, 180);
    sessionCacheDelete(FOLLOWED_FAIL_KEY);
  }
  return result;
}

function extractSongsFromNewWorks(body) {
  const out = [];
  const rawList = Array.isArray(body?.data?.songList)
    ? body.data.songList
    : Array.isArray(body?.data?.newWorks)
      ? body.data.newWorks
      : [];
  for (let i = 0; i < rawList.length; i++) {
    const entry = rawList[i];
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.songLists)) {
      for (let j = 0; j < entry.songLists.length; j++) out.push(entry.songLists[j]);
    } else if (Array.isArray(entry.songs)) {
      for (let j = 0; j < entry.songs.length; j++) out.push(entry.songs[j]);
    } else if (entry.song && typeof entry.song === "object") {
      out.push(entry.song);
    } else if (positiveID(entry.id) && text(entry.name)) {
      out.push(entry);
    }
  }
  return out;
}

async function fetchFollowedArtistsSongs(creators, csrf = "", musicU = "") {
  if (creators.length === 0) return [];
  const cachedUpdates = sessionCacheGetJSON(FOLLOWING_UPDATES_KEY);
  if (Array.isArray(cachedUpdates)) {
    return cachedUpdates;
  }

  const avatarByArtist = new Map();
  for (let i = 0; i < creators.length; i++) {
    const cr = creators[i]?.creator;
    if (cr?.id && cr.avatarURL) {
      avatarByArtist.set(cr.id, cr.avatarURL);
    }
  }

  let directSongs = [];
  const playAllBody = await eapiRequest("/api/sub/artist/new/works/song/playall", {}, { csrf, musicU }).catch(() => null);
  directSongs = extractSongsFromNewWorks(playAllBody);
  if (directSongs.length === 0) {
    const worksBody = await weapiRequest(
      "/weapi/sub/artist/new/works/song/list",
      { limit: 20, startTimestamp: Date.now() },
      { csrf }
    ).catch(() => null);
    directSongs = extractSongsFromNewWorks(worksBody);
  }
  if (directSongs.length > 0) {
    const updates = [];
    const seen = new Set();
    for (let i = 0; i < directSongs.length && updates.length < 30; i++) {
      const item = mapSongItem(directSongs[i]);
      if (!item || seen.has(item.ref.id)) continue;
      if (item.creator && !item.creator.avatarURL && avatarByArtist.has(item.creator.id)) {
        item.creator.avatarURL = avatarByArtist.get(item.creator.id);
      }
      seen.add(item.ref.id);
      updates.push(item);
    }
    if (updates.length > 0) {
      sessionCacheSetJSON(FOLLOWING_UPDATES_KEY, updates, 180);
      return updates;
    }
  }

  const sample = creators.slice(0, 4);
  const batches = [];
  for (let i = 0; i < sample.length; i++) {
    const entry = sample[i];
    const id = entry.creator.id;
    const av = entry.creator.avatarURL;
    const cacheKey = `artist:recent-songs:${id}`;
    let songs = sessionCacheGetJSON(cacheKey);
    if (!Array.isArray(songs)) {
      const body = await eapiRequest(
        "/api/v1/artist/songs",
        {
          id: Number(id),
          private_cloud: "true",
          work_type: 1,
          order: "time",
          limit: 5,
          offset: 0,
        },
        { csrf, musicU }
      ).catch(() => null);
      songs = Array.isArray(body?.songs) ? body.songs : [];
      if (songs.length > 0) {
        sessionCacheSetJSON(cacheKey, songs, 300);
      }
    }
    batches.push(
      songs
        .map((s) => {
          const item = mapSongItem(s);
          if (item?.creator && item.creator.id === id && !item.creator.avatarURL && av) {
            item.creator.avatarURL = av;
          }
          return item;
        })
        .filter(Boolean)
    );
  }
  const updates = [];
  const seen = new Set();
  for (let slot = 0; slot < 5; slot++) {
    for (let i = 0; i < batches.length; i++) {
      const item = batches[i][slot];
      if (!item || seen.has(item.ref.id)) continue;
      seen.add(item.ref.id);
      updates.push(item);
    }
  }
  if (updates.length > 0) {
    sessionCacheSetJSON(FOLLOWING_UPDATES_KEY, updates, 180);
  }
  return updates;
}

export async function readFollowing({ section = "overview", cursor = "", owner, secret } = {}) {
  const uid = positiveID(owner || secret?.uid);
  if (!uid) throw { code: "signIn" };
  const csrf = text(secret?.csrf);
  const musicU = text(secret?.musicU);
  const target = section || "overview";
  if (target === "live") {
    return { liveRooms: [], liveCursor: "", supportsLive: false };
  }
  if (target === "creators") {
    const res = await fetchSubbedArtistsPage(cursor, csrf, musicU);
    return {
      creators: res.creators,
      creatorsCursor: res.creatorsCursor,
      supportsLive: false,
    };
  }
  const creatorsRes = await fetchSubbedArtistsPage("", csrf, musicU);
  if (target === "updates") {
    if (cursor) {
      return { updates: [], updatesCursor: "", supportsLive: false };
    }
    const updates = await fetchFollowedArtistsSongs(creatorsRes.creators, csrf, musicU);
    return { updates, updatesCursor: "", supportsLive: false };
  }
  const updates = await fetchFollowedArtistsSongs(creatorsRes.creators, csrf, musicU);
  const updateSet = new Set(updates.map((u) => u.creator?.id).filter(Boolean));
  const creators = creatorsRes.creators.map((entry) =>
    Object.assign({}, entry, { hasUpdate: updateSet.has(entry.creator.id) })
  );
  return {
    creators,
    creatorsCursor: creatorsRes.creatorsCursor,
    updates,
    updatesCursor: "",
    supportsLive: false,
  };
}
