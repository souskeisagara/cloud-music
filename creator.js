// Artist / creator profile, paginated songs & albums, follow/unfollow, and Following feed.

import {
  artistAvatar,
  count,
  eapiRequest,
  mapAlbumItem,
  mapSongItem,
  positiveID,
  squareCover,
  text,
  weapiRequest,
} from "./api.js";
import { t } from "./i18n.js";

const SUPPORTED_TABS = ["videos", "collections", "about"];

let followedCache = { at: 0, ids: new Set() };

export function invalidateFollowedArtists() {
  followedCache = { at: 0, ids: new Set() };
}

export async function readFollowedArtistSet() {
  const now = Date.now();
  if (followedCache.at > 0 && now - followedCache.at < 60_000) {
    return followedCache.ids;
  }
  try {
    const body = await eapiRequest("/api/artist/sublist", { limit: 200, offset: 0, total: true });
    const rows = Array.isArray(body?.data) ? body.data : [];
    const next = new Set();
    for (let i = 0; i < rows.length; i++) {
      const id = positiveID(rows[i]?.id);
      if (id) next.add(id);
    }
    followedCache = { at: now, ids: next };
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
  if (followedCache.at > 0) {
    if (enabled) followedCache.ids.add(id);
    else followedCache.ids.delete(id);
  } else {
    invalidateFollowedArtists();
  }
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
    includeProfile || activeTab === "about" || (activeTab === "videos" && page === 1)
      ? eapiRequest(`/api/v1/artist/${artistID}`, {}).catch(() => null)
      : Promise.resolve(null),
    activeTab === "videos"
      ? eapiRequest("/api/v1/artist/songs", {
          id: Number(artistID),
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

async function fetchSubbedArtistsPage(cursor) {
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;
  const body = await eapiRequest("/api/artist/sublist", { limit, offset, total: true });
  const list = Array.isArray(body?.data) ? body.data : [];
  const creators = list
    .map((ar) => {
      const id = positiveID(ar?.id);
      const name = text(ar?.name);
      if (!id || !name) return undefined;
      const musicSize = count(ar?.musicSize);
      const albumSize = count(ar?.albumSize);
      const infoParts = [];
      if (musicSize !== undefined) infoParts.push(`${musicSize}`);
      if (albumSize !== undefined) infoParts.push(`${albumSize}`);
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
  const sample = creators.slice(0, 6);
  if (sample.length === 0) return [];
  const batches = await Promise.all(
    sample.map(async (entry) => {
      const id = entry.creator.id;
      const av = entry.creator.avatarURL;
      const body = await eapiRequest("/api/v1/artist/songs", {
        id: Number(id),
        order: "time",
        limit: 5,
        offset: 0,
      }).catch(() => null);
      const songs = Array.isArray(body?.songs) ? body.songs : [];
      return songs
        .map((s) => {
          const item = mapSongItem(s);
          if (item?.creator && item.creator.id === id && !item.creator.avatarURL && av) {
            item.creator.avatarURL = av;
          }
          return item;
        })
        .filter(Boolean);
    })
  );
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

export async function readFollowing({ section = "overview", cursor = "", owner } = {}) {
  const uid = positiveID(owner);
  if (!uid) throw { code: "signIn" };
  const target = section || "overview";
  if (target === "live") {
    return { liveRooms: [], liveCursor: "", supportsLive: false };
  }
  if (target === "creators") {
    const res = await fetchSubbedArtistsPage(cursor);
    return {
      creators: res.creators,
      creatorsCursor: res.creatorsCursor,
      supportsLive: false,
    };
  }
  const creatorsRes = await fetchSubbedArtistsPage("");
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
