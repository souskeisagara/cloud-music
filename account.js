// User library: personal playlists (paginated + full CRUD), song-to-playlist saving,
// and pure-cloud recently-played history.

import {
  count,
  eapiRequest,
  mapSongItem,
  positiveID,
  squareCover,
  text,
  weapiRequest,
} from "./api.js";
import { fetchPlaylistTracksPage, hydrateItemsArtistAvatars } from "./catalog.js";
import { t } from "./i18n.js";

function songToAccountRow(song, removable = false) {
  const mapped = mapSongItem(song);
  if (!mapped) return undefined;
  const row = {
    id: mapped.ref.id,
    title: mapped.title,
    subtitle: mapped.subtitle || "",
    coverURL: mapped.coverURL,
    creatorAvatarURL: mapped.creator?.avatarURL,
    durationSeconds: mapped.durationSeconds,
    ref: mapped.ref,
    item: mapped,
  };
  if (removable) {
    row.removalID = mapped.ref.id;
  }
  return row;
}

async function hydrateAccountRowsAvatars(rows) {
  const items = rows.map((r) => r?.item).filter(Boolean);
  await hydrateItemsArtistAvatars(items);
  for (let i = 0; i < rows.length; i++) {
    const av = rows[i]?.item?.creator?.avatarURL;
    if (av && !rows[i].creatorAvatarURL) {
      rows[i].creatorAvatarURL = av;
    }
  }
  return rows;
}

async function readFavorites({ owner, folder = "", cursor = "", secret }) {
  const uid = positiveID(owner || secret?.uid);
  if (!uid) throw { code: "signIn", message: t().signInRequired };

  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  if (!folder) {
    const limit = 30;
    const offset = (page - 1) * limit;
    const body = await eapiRequest("/api/user/playlist", {
      uid: Number(uid),
      limit,
      offset,
      includeVideo: false,
    });
    const list = Array.isArray(body?.playlist) ? body.playlist : [];
    const rows = list
      .map((pl) => {
        const id = positiveID(pl?.id);
        const title = text(pl?.name);
        if (!id || !title) return undefined;
        const owned = positiveID(pl?.userId ?? pl?.creator?.userId) === uid;
        const isDefaultLiked = Number(pl?.specialType || 0) === 5;
        return {
          id,
          title,
          count: count(pl?.trackCount),
          coverURL: squareCover(pl?.coverImgUrl, 1024),
          private: Number(pl?.privacy || 0) === 10,
          canDelete: owned && !isDefaultLiked,
          ref: { kind: "collection", id },
        };
      })
      .filter(Boolean);
    const hasMore = Boolean(body?.more) && rows.length > 0;
    const out = {
      rows,
      nextCursor: hasMore ? String(page + 1) : "",
    };
    if (!hasMore && page === 1) {
      out.total = rows.length;
    }
    return out;
  }

  const playlistID = positiveID(folder);
  if (!playlistID) throw { code: "permission" };
  const pageSize = 40;
  const offset = (page - 1) * pageSize;
  const { playlist, tracks, total, hasMore } = await fetchPlaylistTracksPage(playlistID, offset, pageSize);
  const owned = positiveID(playlist?.userId ?? playlist?.creator?.userId) === uid;
  const rows = tracks.map((s) => songToAccountRow(s, owned)).filter(Boolean);
  await hydrateAccountRowsAvatars(rows);
  return {
    rows,
    total: count(playlist?.trackCount) ?? total ?? rows.length,
    nextCursor: hasMore && rows.length > 0 ? String(page + 1) : "",
  };
}

async function readHistory({ owner, secret }) {
  const uid = positiveID(owner || secret?.uid);
  if (!uid) throw { code: "signIn", message: t().signInRequired };

  try {
    if (typeof host !== "undefined" && host.storage && typeof host.storage.delete === "function") {
      host.storage.delete("cloud_music_history_v1");
    }
  } catch (_) {}

  const rows = [];
  const seen = new Set();
  const pushRow = (row) => {
    if (!row || !row.id || seen.has(row.id)) return;
    seen.add(row.id);
    rows.push(row);
  };

  let cloudSongs = [];
  try {
    const recentRes = await eapiRequest("/api/record/recent/song", { limit: 60 });
    const list = Array.isArray(recentRes?.data?.list) ? recentRes.data.list : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.data) cloudSongs.push(list[i].data);
    }
  } catch (_) {}

  if (cloudSongs.length === 0) {
    try {
      const body = await eapiRequest("/api/v1/play/record", { uid: Number(uid), type: 1 });
      const week = Array.isArray(body?.weekData) ? body.weekData : [];
      for (let i = 0; i < week.length; i++) cloudSongs.push(week[i]?.song || week[i]);
    } catch (_) {}
  }
  if (cloudSongs.length === 0) {
    try {
      const body = await eapiRequest("/api/v1/play/record", { uid: Number(uid), type: 0 });
      const all = Array.isArray(body?.allData) ? body.allData : [];
      for (let i = 0; i < all.length; i++) cloudSongs.push(all[i]?.song || all[i]);
    } catch (_) {}
  }

  for (let i = 0; i < cloudSongs.length && rows.length < 80; i++) {
    pushRow(songToAccountRow(cloudSongs[i], false));
  }
  await hydrateAccountRowsAvatars(rows);
  return { rows, total: rows.length, nextCursor: "" };
}

export async function readAccount(input = {}) {
  switch (input.section) {
    case "favorites":
      return readFavorites(input);
    case "history":
      return readHistory(input);
    default:
      throw { code: "unsupported" };
  }
}

export async function editFavoriteFolder({
  action,
  folder,
  title,
  private: isPrivate = false,
  resources,
  owner,
  secret,
} = {}) {
  const uid = positiveID(owner || secret?.uid);
  if (!uid) throw { code: "signIn" };
  const csrf = text(secret?.csrf);

  if (action === "create") {
    const name = text(title);
    if (!name) throw { code: "permission" };
    const payload = { name, privacy: isPrivate ? 10 : 0, type: "NORMAL" };
    try {
      await eapiRequest("/api/playlist/create", payload);
    } catch (_) {
      await weapiRequest("/weapi/playlist/create", payload, { csrf });
    }
    return {};
  }

  const pid = positiveID(folder);
  if (!pid) throw { code: "permission" };

  switch (action) {
    case "update": {
      const name = text(title);
      if (!name) throw { code: "permission" };
      try {
        await eapiRequest("/api/playlist/update/name", { id: Number(pid), name });
      } catch (_) {
        await weapiRequest("/weapi/playlist/update/name", { id: Number(pid), name }, { csrf });
      }
      if (!isPrivate) {
        await eapiRequest("/api/playlist/update/privacy", { id: Number(pid), privacy: 0 }).catch(() => null);
      }
      return {};
    }
    case "delete": {
      const payload = { ids: `[${pid}]` };
      try {
        await eapiRequest("/api/playlist/remove", payload);
      } catch (_) {
        await weapiRequest("/weapi/playlist/remove", payload, { csrf });
      }
      return {};
    }
    case "remove": {
      const ids = (Array.isArray(resources) ? resources : []).map(positiveID).filter(Boolean);
      if (ids.length === 0) throw { code: "permission" };
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const payload = {
          op: "del",
          pid: Number(pid),
          trackIds: JSON.stringify(chunk.map(Number)),
          imme: "true",
        };
        try {
          await eapiRequest("/api/playlist/manipulate/tracks", payload);
        } catch (_) {
          await weapiRequest("/weapi/playlist/manipulate/tracks", payload, { csrf });
        }
      }
      return {};
    }
    default:
      throw { code: "unsupported" };
  }
}

async function playlistContainsSong(playlistID, songID) {
  try {
    const body = await eapiRequest("/api/v6/playlist/detail", {
      id: Number(playlistID),
      n: 0,
      s: 0,
    });
    const tids = Array.isArray(body?.playlist?.trackIds) ? body.playlist.trackIds : [];
    for (let i = 0; i < tids.length; i++) {
      if (String(tids[i]?.id ?? tids[i]) === songID) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

export async function videoFavoriteFolders({ ref, owner } = {}) {
  const uid = positiveID(owner);
  if (!uid) throw { code: "signIn" };
  if (text(ref?.kind) !== "video") throw { code: "unsupported" };
  const songID = positiveID(ref?.id);
  if (!songID) throw { code: "permission" };

  const [plBody, likeBody] = await Promise.all([
    eapiRequest("/api/user/playlist", { uid: Number(uid), limit: 100, offset: 0, includeVideo: false }),
    eapiRequest("/api/song/like/get", { uid: Number(uid) }).catch(() => null),
  ]);
  const likedSet = new Set((Array.isArray(likeBody?.ids) ? likeBody.ids : []).map((id) => String(id)));
  const owned = (Array.isArray(plBody?.playlist) ? plBody.playlist : []).filter(
    (pl) => positiveID(pl?.userId ?? pl?.creator?.userId) === uid && positiveID(pl?.id) && text(pl?.name)
  );

  const folders = owned.map((pl) => ({
    id: positiveID(pl.id),
    title: text(pl.name),
    count: count(pl.trackCount) ?? 0,
    private: Number(pl.privacy || 0) === 10,
    selected: Number(pl.specialType || 0) === 5 ? likedSet.has(songID) : false,
    _check: Number(pl.specialType || 0) !== 5,
  }));

  const toCheck = folders.filter((f) => f._check).slice(0, 16);
  const concurrency = Math.min(6, toCheck.length);
  let cursor = 0;
  async function worker() {
    while (cursor < toCheck.length) {
      const idx = cursor++;
      const entry = toCheck[idx];
      entry.selected = await playlistContainsSong(entry.id, songID);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    folders: folders.map(({ id, title, count: cnt, private: priv, selected }) => ({
      id,
      title,
      count: cnt,
      private: priv,
      selected,
    })),
  };
}

export async function editVideoFavoriteFolders({ data, secret } = {}) {
  const ref = data?.ref;
  const add = (Array.isArray(data?.add) ? data.add : []).map(positiveID).filter(Boolean);
  const remove = (Array.isArray(data?.remove) ? data.remove : []).map(positiveID).filter(Boolean);
  if (text(ref?.kind) !== "video") throw { code: "unsupported" };
  const songID = positiveID(ref?.id);
  if (!songID) throw { code: "permission" };
  const csrf = text(secret?.csrf);

  const mutate = async (op, pid) => {
    const payload = {
      op,
      pid: Number(pid),
      trackIds: `[${songID}]`,
      imme: "true",
    };
    try {
      await eapiRequest("/api/playlist/manipulate/tracks", payload);
    } catch (_) {
      await weapiRequest("/weapi/playlist/manipulate/tracks", payload, { csrf });
    }
  };

  for (let i = 0; i < add.length; i++) {
    await mutate("add", add[i]);
  }
  for (let i = 0; i < remove.length; i++) {
    await mutate("del", remove[i]);
  }
  return {};
}
