// Artist / creator profile, paginated songs, and albums.

import {
  artistAvatar,
  count,
  eapiRequest,
  mapAlbumItem,
  mapSongItem,
  positiveID,
  squareCover,
  text,
} from "./api.js";
import { t } from "./i18n.js";

const SUPPORTED_TABS = ["videos", "collections", "about"];

export async function readCreator({ creatorID, tab = "videos", cursor = "", includeProfile = true } = {}) {
  const copy = t();
  const artistID = positiveID(creatorID);
  if (!artistID) throw { code: "permission" };

  const activeTab = tab || "videos";
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const songPageSize = 30;

  const [artistBody, songsBody, albumsBody] = await Promise.all([
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
  ]);

  const artist = artistBody?.artist;
  const resolvedAvatar = artistAvatar(artist, 256);

  const out = {};
  if (includeProfile) {
    const name = text(artist?.name);
    if (!name) throw { code: "expired" };
    out.profile = {
      creator: {
        id: artistID,
        name,
        avatarURL: resolvedAvatar,
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
