// Home browse, charts, genres, item details, song comments, and like interaction.

import {
  avatarCover,
  count,
  eapiRequest,
  mapAlbumItem,
  mapPlaylistItem,
  mapSongItem,
  positiveID,
  squareCover,
  text,
} from "./api.js";
import { t } from "./i18n.js";

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

export async function fetchPlaylistTracks(playlistID, limit = 60) {
  const body = await eapiRequest("/api/v6/playlist/detail", {
    id: Number(playlistID),
    n: limit,
    s: 0,
  });
  const pl = body?.playlist;
  if (!pl) throw { code: "expired" };
  let tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
  const trackIds = Array.isArray(pl.trackIds) ? pl.trackIds : [];
  if (tracks.length < Math.min(limit, trackIds.length)) {
    const missingIds = trackIds
      .slice(tracks.length, limit)
      .map((x) => positiveID(x?.id))
      .filter(Boolean);
    if (missingIds.length > 0) {
      const hydrated = await fetchSongsByIDs(missingIds).catch(() => []);
      tracks = tracks.concat(hydrated);
    }
  }
  return { playlist: pl, tracks: tracks.slice(0, limit) };
}

export async function fetchSongsByIDs(ids) {
  const clean = [];
  for (let i = 0; i < ids.length; i++) {
    const id = positiveID(ids[i]);
    if (id) clean.push(id);
  }
  if (clean.length === 0) return [];
  const out = [];
  for (let i = 0; i < clean.length; i += 50) {
    const slice = clean.slice(i, i + 50);
    const body = await eapiRequest("/api/v3/song/detail", {
      c: JSON.stringify(slice.map((id) => ({ id: Number(id) }))),
    });
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

async function browseRecommendations(cursor, signedIn) {
  const copy = t();
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  if (page > 1) {
    const offset = (page - 1) * 20;
    const plBody = await eapiRequest("/api/playlist/list", {
      cat: "全部",
      order: "hot",
      limit: 20,
      offset,
      total: true,
    });
    const items = (plBody?.playlists || []).map((pl) => mapPlaylistItem(pl, copy.playlistTag)).filter(Boolean);
    return {
      collections: items.length ? [{ id: "more-playlists", title: copy.recommendedPlaylists, items }] : [],
      nextCursor: plBody?.more && items.length > 0 ? String(page + 1) : "",
    };
  }

  const jobs = [
    eapiRequest("/api/personalized/newsong", { limit: 18, areaId: 0 }).catch(() => null),
    fetchPlaylistTracks("3778678", 24).catch(() => null),
    eapiRequest("/api/personalized/playlist", { limit: 16 }).catch(() => null),
  ];
  if (signedIn) {
    jobs.push(eapiRequest("/api/v3/discovery/recommend/songs", {}).catch(() => null));
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

async function browseChart(collection, filter) {
  const copy = t();
  const filters = chartFilters();
  const chartID = CHARTS.some((c) => c.id === filter) ? filter : CHARTS[0].id;
  const { tracks } = await fetchPlaylistTracks(chartID, 50);
  const items = tracks.map((s) => mapSongItem(s)).filter(Boolean);
  return {
    collections: items.length ? [{ id: collection, title: copy[collection] || copy.ranking, items }] : [],
    filters,
    nextCursor: "",
  };
}

async function browseGenres(filter, cursor) {
  const copy = t();
  const filters = genreFilters();
  const cat = GENRES.some((g) => g.id === filter) ? filter : "全部";
  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const limit = 24;
  const body = await eapiRequest("/api/playlist/list", {
    cat,
    order: "hot",
    limit,
    offset: (page - 1) * limit,
    total: true,
  });
  const items = (body?.playlists || []).map((pl) => mapPlaylistItem(pl, cat === "全部" ? copy.playlistTag : cat)).filter(Boolean);
  return {
    collections: items.length ? [{ id: "regions", title: copy.regions, items }] : [],
    filters,
    nextCursor: body?.more && items.length > 0 ? String(page + 1) : "",
  };
}

export async function browse({ collection = "", filter = "", cursor = "", signedIn = false } = {}) {
  switch (collection) {
    case "":
    case "recommendations":
      return browseRecommendations(cursor, signedIn);
    case "popular":
      return browseChart("popular", filter || "19723756");
    case "ranking":
      return browseChart("ranking", filter || "3778678");
    case "regions":
      return browseGenres(filter, cursor);
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
  return {
    id,
    body,
    author: text(user.nickname) || "Listener",
    avatarURL: avatarCover(user.avatarUrl, 96),
    publishedAt: tsMs > 0 ? Math.floor(tsMs / 1000) : undefined,
    location: text(row?.ipLocation?.location) || undefined,
    likes: count(row?.likedCount),
    liked: row?.liked === true,
  };
}

async function fetchSongDetail(songID, signedIn, secret) {
  const [songs, commentRes, simiRes, likeRes] = await Promise.all([
    fetchSongsByIDs([songID]),
    eapiRequest(`/api/v1/resource/comments/R_SO_4_${songID}`, { limit: 15, offset: 0 }).catch(() => null),
    eapiRequest("/api/v1/discovery/simiSong", { songid: Number(songID), limit: 12, offset: 0 }).catch(() => null),
    signedIn && positiveID(secret?.uid)
      ? eapiRequest("/api/song/like/get", { uid: Number(secret.uid) }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const song = songs[0];
  if (!song) throw { code: "expired" };
  const base = mapSongItem(song);
  if (!base) throw { code: "expired" };

  const likedIDs = Array.isArray(likeRes?.ids) ? likeRes.ids : [];
  const isLiked = likedIDs.some((id) => String(id) === songID);
  const hotComments = (commentRes?.hotComments || []).map(mapComment).filter(Boolean);
  const recentComments = (commentRes?.comments || []).map(mapComment).filter(Boolean);
  const comments = hotComments.length > 0 ? hotComments : recentComments;
  const related = (simiRes?.songs || []).map((s) => mapSongItem(s)).filter(Boolean);

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

async function fetchCollectionDetail(kindPrefix, id) {
  const copy = t();
  if (kindPrefix === "pl") {
    const { playlist, tracks } = await fetchPlaylistTracks(id, 100);
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
    return {
      ref: { kind: "series", id: `pl:${id}` },
      title: text(playlist.name) || copy.playlistTag,
      subtitle: text(playlist.description) || copy.trackCount(segments.length),
      creator,
      coverURL: squareCover(playlist.coverImgUrl, 800),
      backdropURL: squareCover(playlist.coverImgUrl, 1080),
      views: count(playlist.playCount),
      category: copy.playlistTag,
      videoDetails: {
        access: "granted",
        segmentKind: "collection",
        segments,
      },
    };
  }
  if (kindPrefix === "al") {
    const body = await eapiRequest(`/api/v1/album/${id}`, {});
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
    return Object.assign(base, {
      subtitle: text(album.description) || base.subtitle || copy.trackCount(segments.length),
      videoDetails: {
        access: "granted",
        publishedAt: album.publishTime > 0 ? Math.floor(album.publishTime / 1000) : undefined,
        segmentKind: "collection",
        segments,
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
      return fetchCollectionDetail(prefix, id);
    }
  }
  throw { code: "unsupported" };
}

export async function videoComments({ ref, order = "hot", page = 0 } = {}) {
  const songID = positiveID(ref?.id);
  if (!songID) throw { code: "permission" };
  const limit = 20;
  const pageIdx = Math.max(0, Number(page) || 0);
  const offset = pageIdx * limit;
  const body = await eapiRequest(`/api/v1/resource/comments/R_SO_4_${songID}`, {
    limit,
    offset,
  });
  const list =
    order === "hot" && pageIdx === 0 && Array.isArray(body?.hotComments) && body.hotComments.length > 0
      ? body.hotComments
      : body?.comments || [];
  const comments = list.map(mapComment).filter(Boolean);
  const total = count(body?.total) ?? 0;
  return {
    comments,
    nextPage: body?.more && offset + limit < total ? pageIdx + 1 : undefined,
  };
}

export async function editVideo({ ref, action, enabled, signedIn } = {}) {
  if (!signedIn) throw { code: "signIn" };
  const songID = positiveID(ref?.id);
  if (!songID) throw { code: "permission" };
  if (action === "like") {
    await eapiRequest("/api/radio/like", {
      trackId: Number(songID),
      like: Boolean(enabled),
      alg: "itembased",
      time: 3,
    });
    return { liked: Boolean(enabled) };
  }
  throw { code: "unsupported" };
}
