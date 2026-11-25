// User library: personal playlists (favorites folders with Play All) and play history.

import {
  count,
  eapiRequest,
  mapSongItem,
  positiveID,
  squareCover,
  text,
} from "./api.js";
import { fetchPlaylistTracks } from "./catalog.js";
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
          coverURL: squareCover(pl?.coverImgUrl, 800),
          private: Number(pl?.privacy || 0) === 10,
          canDelete: false,
          ref: { kind: "collection", id },
        };
      })
      .filter(Boolean);
    return {
      rows,
      total: rows.length,
      nextCursor: body?.more && rows.length > 0 ? String(page + 1) : "",
    };
  }

  const playlistID = positiveID(folder);
  if (!playlistID) throw { code: "permission" };
  const { playlist, tracks } = await fetchPlaylistTracks(playlistID, 100);
  const rows = tracks.map(songToAccountRow).filter(Boolean);
  return {
    rows,
    total: count(playlist?.trackCount) ?? rows.length,
    nextCursor: "",
  };
}

async function readHistory({ owner, secret }) {
  const uid = positiveID(owner || secret?.uid);
  if (!uid) throw { code: "signIn", message: t().signInRequired };

  let records = [];
  try {
    const body = await eapiRequest("/api/v1/play/record", { uid: Number(uid), type: 1 });
    records = Array.isArray(body?.weekData) ? body.weekData : [];
  } catch (_) {}
  if (records.length === 0) {
    try {
      const body = await eapiRequest("/api/v1/play/record", { uid: Number(uid), type: 0 });
      records = Array.isArray(body?.allData) ? body.allData : [];
    } catch (_) {}
  }
  const rows = records
    .slice(0, 50)
    .map((entry) => songToAccountRow(entry?.song || entry))
    .filter(Boolean);
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
