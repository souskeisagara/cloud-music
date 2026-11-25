// Artist / creator profile, paginated songs & albums, follow/unfollow, and Following feed.

import {
  artistAvatar,
  count,
  eapiRequest,
  mapAlbumItem,
  mapSongItem,
  positiveID,
  sessionCacheDelete,
  sessionCacheGetJSON,
  sessionCacheSetJSON,
  squareCover,
  text,
  weapiRequest,
} from "./api.js";
import { t } from "./i18n.js";

const SUPPORTED_TABS = ["videos", "collections", "about"];
const FOLLOWED_CACHE_KEY = "followed:artists";

let followedCache = { at: 0, ids: new Set() };

export function invalidateFollowedArtists() {
  followedCache = { at: 0, ids: new Set() };
  sessionCacheDelete(FOLLOWED_CACHE_KEY);
}

async function fetchSubbedArtistsRaw(limit, offset, csrf = "", musicU = "") {
  const payload = { limit, offset, total: true };
  try {
    return await weapiRequest("/weapi/artist/sublist", payload, { csrf });
  } catch (err) {
    if (err && err.code === "signIn") throw err;
    return eapiRequest("/api/artist/sublist", payload, { csrf, musicU });
  }
}

export async function readFollowedArtistSet(csrf = "", musicU = "") {
  const now = Date.now();
  if (followedCache.at > 0 && now - followedCache.at < 60_000) {
    return followedCache.ids;
  }
  const shared = sessionCacheGetJSON(FOLLOWED_CACHE_KEY);
  if (Array.isArray(shared)) {
    const ids = new Set(shared);
    followedCache = { at: now, ids };
    return ids;
  }
  try {
    const body = await fetchSubbedArtistsRaw(200, 0, csrf, musicU);
    const rows = Array.isArray(body?.data) ? body.data : [];
    const next = new Set();
    for (let i = 0; i < rows.length; i++) {
      const id = positiveID(rows[i]?.id);
      if (id) next.add(id);
    }
    followedCache = { at: now, ids: next };
    sessionCacheSetJSON(FOLLOWED_CACHE_KEY, Array.from(next), 60);
    return next;
  } catch (_) {
    return followedCache.ids;
  }
}

export async function followArtistByID(artistID, enabled, secret) {
  const id = positiveID(artistID);
  if (!id) throw { code: "permission" };
  const apiPath = enabled ? "/api/artist/sub" : "/api/artist/unsub";
  const weapiPath = enabled ? "/weapi/artist/sub" : "/weapi/artist/unsub";
  const payload = { artistId: Number(id), artistIds: `[${id}]` };
  try {
    await eapiRequest(apiPath, payload);
  } catch (err) {
    await weapiRequest(weapiPath, payload, { csrf: text(secret?.csrf) });
  }
  invalidateFollowedArtists();
  return { following: Boolean(enabled) };
}

export async function followCreator({ creatorID, enabled = false, owner, secret } = {}) {
  const uid = positiveID(owner || secret?.uid);
  if (!uid) throw { code: "signIn" };
  return followArtistByID(creatorID, Boolean(enabled), secret);
}

export async function readCreator({ creatorID, tab = "videos", cursor = "", includeProfile = true, signedIn = false } = {}) {
  const copy = t();
  const artistID = positiveID(creatorID);
  if (!artistID) throw { code: "permission" };

  const activeTab = tab || "videos";
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const songPageSize = 30;

  const [artistBody, songsBody, albumsBody, followedSet] = await Promise.all([
    includeProfile
      ? eapiRequest(`/api/v1/artist/${artistID}`, {})
      : activeTab === "about" || (activeTab === "videos" && page === 1)
        ? eapiRequest(`/api/v1/artist/${artistID}`, {}).catch(() => null)
        : Promise.resolve(null),
    activeTab === "videos"
      ? eapiRequest("/api/v1/artist/songs", {
          id: Number(artistID),
          private_cloud: "true",
          work_type: 1,
          order: "hot",
          limit: songPageSize,
          offset: (page - 1) * songPageSize,
        }).catch(() => null)
      : Promise.resolve(null),
    activeTab === "collections"
      ? eapiRequest(`/api/artist/albums/${artistID}`, {
          limit: 20,
          offset: (page - 1) * 20,
          total: true,
        })
      : Promise.resolve(null),
    includeProfile && signedIn ? readFollowedArtistSet() : Promise.resolve(null),
  ]);

  const artist = artistBody?.artist;
  const resolvedAvatar = artistAvatar(artist, 256);

  const out = {};
  if (includeProfile) {
    const name = text(artist?.name);
    if (!name) throw { code: "expired" };
    const following = Boolean(artist?.followed) || Boolean(followedSet && followedSet.has(artistID));
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
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;
  const body = await fetchSubbedArtistsRaw(limit, offset, csrf, musicU);
  const list = Array.isArray(body?.data) ? body.data : [];
  const creators = list
    .map((ar) => {
      const id = positiveID(ar?.id);
      const name = text(ar?.name);
      if (!id || !name) return undefined;
      return {
        creator: {
          id,
          name,
          avatarURL: artistAvatar(ar, 256),
          following: true,
        },
        bio: text(ar?.info) || (Array.isArray(ar?.alias) && ar.alias.length > 0 ? text(ar.alias[0]) : undefined),
      };
    })
    .filter(Boolean);
  const hasMore = Boolean(body?.hasMore) && creators.length > 0;
  return {
    creators,
    creatorsCursor: hasMore ? String(page + 1) : "",
  };
}

async function fetchFollowedArtistsSongs(creators) {
  const sample = creators.slice(0, 4);
  if (sample.length === 0) return [];
  const batches = new Array(sample.length).fill(null).map(() => []);
  let cursor = 0;
  const concurrency = Math.min(2, sample.length);
  async function worker() {
    while (cursor < sample.length) {
      const idx = cursor++;
      const entry = sample[idx];
      const id = entry.creator.id;
      const av = entry.creator.avatarURL;
      const cacheKey = `artist:recent-songs:${id}`;
      let songs = sessionCacheGetJSON(cacheKey);
      if (!Array.isArray(songs)) {
        const body = await eapiRequest("/api/v1/artist/songs", {
          id: Number(id),
          private_cloud: "true",
          work_type: 1,
          order: "time",
          limit: 5,
          offset: 0,
        }).catch(() => null);
        songs = Array.isArray(body?.songs) ? body.songs : [];
        if (songs.length > 0) {
          sessionCacheSetJSON(cacheKey, songs, 300);
        }
      }
      batches[idx] = songs
        .map((s) => {
          const item = mapSongItem(s);
          if (item?.creator && item.creator.id === id && !item.creator.avatarURL && av) {
            item.creator.avatarURL = av;
          }
          return item;
        })
        .filter(Boolean);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
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
    const updates = await fetchFollowedArtistsSongs(creatorsRes.creators);
    return { updates, updatesCursor: "", supportsLive: false };
  }
  const updates = await fetchFollowedArtistsSongs(creatorsRes.creators);
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
