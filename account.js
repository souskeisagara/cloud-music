// User library: personal playlists (paginated) and instant recently-played history.

import {
  count,
  eapiRequest,
  mapSongItem,
  positiveID,
  squareCover,
  text,
} from "./api.js";
import { fetchPlaylistTracksPage, hydrateItemsArtistAvatars } from "./catalog.js";
import { readLocalHistory } from "./playback.js";
import { t } from "./i18n.js";

function songToAccountRow(song) {
  const mapped = mapSongItem(song);
  if (!mapped) return undefined;
  return {
    id: mapped.ref.id,
    title: mapped.title,
    subtitle: mapped.subtitle || "",
    coverURL: mapped.coverURL,
    creatorAvatarURL: mapped.creator?.avatarURL,
    durationSeconds: mapped.durationSeconds,
    ref: mapped.ref,
    item: mapped,
  };
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
        return {
          id,
          title,
          count: count(pl?.trackCount),
          coverURL: squareCover(pl?.coverImgUrl, 1024),
          private: Number(pl?.privacy || 0) === 10,
          canDelete: false,
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
  const rows = tracks.map(songToAccountRow).filter(Boolean);
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

  const merged = [];
  const seen = new Set();
  const pushRow = (row) => {
    if (!row || !row.id || seen.has(row.id)) return;
    seen.add(row.id);
    merged.push(row);
  };

  // 1. Local instant play records from this Apple TV first (zero cloud delay).
  const localRows = readLocalHistory();
  for (let i = 0; i < localRows.length; i++) {
    pushRow(localRows[i]);
  }

  // 2. Cloud chronological recent songs endpoint, falling back to play record rankings.
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

  for (let i = 0; i < cloudSongs.length && merged.length < 80; i++) {
    pushRow(songToAccountRow(cloudSongs[i]));
  }
  await hydrateAccountRowsAvatars(merged);
  return { rows: merged, total: merged.length, nextCursor: "" };
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
