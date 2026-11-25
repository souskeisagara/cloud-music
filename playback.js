// Audio & MV stream resolution (with VIP quality locks, MediaKind switching),
// bilingual LRC lyrics with preview-offset alignment, and cloud playback scrobbling.

import { eapiRequest, mapSongItem, mediaHeaders, normalizeHTTPS, positiveID, text, weapiRequest } from "./api.js";
import { cachedSongPrivilege, fetchPlaylistTracks, fetchSongsByIDs } from "./catalog.js";
import { t } from "./i18n.js";

const CLIENTLOG_HOST = "https://clientlog.music.163.com";
const SONG_SOURCE_KEY = "ncm_song_source";
const STARTPLAY_LAST_KEY = "ncm_startplay_last";

const AUDIO_LEVELS = [
  { id: "hires", labelKey: "qualityHires", rank: 4 },
  { id: "lossless", labelKey: "qualityLossless", rank: 3 },
  { id: "exhigh", labelKey: "qualityExhigh", rank: 2 },
  { id: "standard", labelKey: "qualityStandard", rank: 1 },
];

const songMetaCache = new Map();
const songSourceCache = new Map();
const mvDetailCache = new Map();

function saveSongSource(songID, sourceID, sourceType) {
  if (!songID || !sourceID) return;
  const entry = { sourceID, sourceType: sourceType || "list" };
  cacheSet(songSourceCache, songID, entry, 64);
  try {
    if (typeof host === "undefined" || !host.storage || typeof host.storage.set !== "function") return;
    let map = {};
    try {
      const raw = typeof host.storage.get === "function" ? host.storage.get(SONG_SOURCE_KEY) : "";
      if (raw) map = JSON.parse(raw) || {};
    } catch (_) {
      map = {};
    }
    delete map[songID];
    map[songID] = entry;
    const keys = Object.keys(map);
    while (keys.length > 16) {
      delete map[keys.shift()];
    }
    host.storage.set(SONG_SOURCE_KEY, JSON.stringify(map));
  } catch (_) {}
}

function loadSongSource(songID) {
  if (!songID) return null;
  const cached = songSourceCache.get(songID);
  if (cached) return cached;
  try {
    if (typeof host === "undefined" || !host.storage || typeof host.storage.get !== "function") return null;
    const raw = host.storage.get(SONG_SOURCE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    if (map && map[songID] && map[songID].sourceID) {
      return map[songID];
    }
  } catch (_) {}
  return null;
}

function hasRecentStartPlay(songID, now) {
  try {
    if (typeof host === "undefined" || !host.storage || typeof host.storage.get !== "function") return false;
    const raw = text(host.storage.get(STARTPLAY_LAST_KEY));
    if (!raw) return false;
    const [lastID, lastAtStr] = raw.split(":");
    const lastAt = Number(lastAtStr || 0);
    return lastID === songID && Number.isFinite(lastAt) && now - lastAt < 120_000;
  } catch (_) {
    return false;
  }
}

function markStartPlay(songID, now) {
  try {
    if (typeof host !== "undefined" && host.storage && typeof host.storage.set === "function") {
      host.storage.set(STARTPLAY_LAST_KEY, `${songID}:${now}`);
    }
  } catch (_) {}
}

function cacheSet(map, key, value, limit) {
  if (map.size >= limit && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function levelRank(raw) {
  switch (text(raw).toLowerCase()) {
    case "jymaster":
    case "sky":
    case "jyeffect":
    case "hires":
      return 4;
    case "lossless":
      return 3;
    case "exhigh":
      return 2;
    case "higher":
    case "standard":
      return 1;
    default:
      return 0;
  }
}

function normalizeAudioLevel(raw) {
  const rank = levelRank(raw);
  if (rank === 4) return "hires";
  if (rank === 3) return "lossless";
  if (rank === 2) return "exhigh";
  if (rank === 1) return "standard";
  return "";
}

async function getSongMeta(songID) {
  const cached = songMetaCache.get(songID);
  if (cached && cached.priv) {
    return cached;
  }
  const songs = await fetchSongsByIDs([songID]).catch(() => []);
  const song = songs[0] || null;
  const priv = cachedSongPrivilege(songID);
  if (song) {
    const mapped = mapSongItem(song);
    const meta = {
      mvid: positiveID(song?.mv ?? song?.mvid),
      albumID: positiveID(song?.al?.id ?? song?.album?.id),
      dt: Number(song?.dt || 0),
      fee: Number(song?.fee ?? priv?.fee ?? 0),
      priv,
      mapped,
    };
    cacheSet(songMetaCache, songID, meta, 256);
    return meta;
  }
  return cached || { mvid: "", albumID: "", dt: 0, fee: 0, priv, mapped: null };
}

function audioContentType(typeRaw, url) {
  const lower = text(typeRaw).toLowerCase();
  if (lower === "flac" || /\.flac(?:[?#]|$)/i.test(url)) return "audio/flac";
  if (lower === "m4a" || /\.m4a(?:[?#]|$)/i.test(url)) return "audio/mp4";
  if (lower === "aac" || /\.aac(?:[?#]|$)/i.test(url)) return "audio/aac";
  if (lower === "wav" || /\.wav(?:[?#]|$)/i.test(url)) return "audio/wav";
  return "audio/mpeg";
}

function buildAudioQualities(priv, actualLevel, signedIn) {
  const copy = t();
  const actualRank = levelRank(actualLevel);
  const declaredMaxRank = levelRank(priv?.playMaxBrLevel || priv?.maxBrLevel);
  const maxRank = declaredMaxRank > 0 ? Math.max(declaredMaxRank, actualRank) : Math.max(actualRank, 3);
  const playRank = Math.max(levelRank(priv?.plLevel), actualRank);

  const out = [];
  for (let i = 0; i < AUDIO_LEVELS.length; i++) {
    const q = AUDIO_LEVELS[i];
    if (q.rank > maxRank) {
      continue;
    }
    let limit;
    if (q.rank > playRank) {
      if (!signedIn && q.rank <= 2) {
        limit = "login";
      } else {
        limit = "membership";
      }
    }
    out.push({
      id: q.id,
      label: copy[q.labelKey] || q.id,
      limit,
    });
  }
  return { qualities: out, maxRank, playRank };
}

export async function reportPlayback({ data, secret } = {}) {
  const ref = data?.ref;
  const partID = text(data?.partID);
  const rawSeconds = Math.max(0, Math.round(Number(data?.seconds || 0)));
  const finished = Boolean(data?.finished);
  const songID = positiveID(partID) || (text(ref?.kind) === "video" ? positiveID(ref?.id) : "") || positiveID(data?.itemID);
  if (!songID) return {};

  const csrf = text(secret?.csrf);
  const meta = songMetaCache.get(songID) || (await getSongMeta(songID).catch(() => null));
  const durationSec = meta?.dt > 0 ? Math.max(1, Math.round(meta.dt / 1000)) : 0;
  // When a track finishes naturally, the host resets seconds=0 with finished=true;
  // NetEase ignores playend logs with time=0, so always report the real track duration.
  const playedSec = finished ? durationSec || Math.max(rawSeconds, 180) : rawSeconds;

  let sourceID = "";
  let sourceType = "";
  if (text(ref?.kind) === "series") {
    const [prefix, sid] = text(ref?.id).split(":");
    if (prefix === "pl" && positiveID(sid)) {
      sourceID = positiveID(sid);
      sourceType = "list";
    } else if (prefix === "al" && positiveID(sid)) {
      sourceID = positiveID(sid);
      sourceType = "album";
    }
  }
  if (!sourceID) {
    const cachedSrc = loadSongSource(songID);
    if (cachedSrc?.sourceID) {
      sourceID = cachedSrc.sourceID;
      sourceType = cachedSrc.sourceType || "list";
    } else if (meta?.albumID) {
      sourceID = meta.albumID;
      sourceType = "album";
    }
  }

  const now = Date.now();
  const entries = [];
  // NetEase updates /api/play-record/song/list ("Recently Played") on startplay,
  // and updates listening counts/rankings on play (end: "playend").
  if (!hasRecentStartPlay(songID, now)) {
    const startEntry = {
      action: "startplay",
      json: {
        download: 0,
        id: Number(songID),
        sourceId: sourceID,
        type: "song",
        wifi: 0,
        mainsite: "1",
      },
    };
    if (sourceType) startEntry.json.source = sourceType;
    if (sourceID) startEntry.json.content = `id=${sourceID}`;
    entries.push(startEntry);
    markStartPlay(songID, now);
  }

  if (finished || playedSec >= 5) {
    const completed = finished || (durationSec > 0 && playedSec >= Math.round(durationSec * 0.8));
    const playEntry = {
      action: "play",
      json: {
        download: 0,
        end: completed ? "playend" : "ui",
        id: Number(songID),
        sourceId: sourceID,
        time: playedSec,
        type: "song",
        wifi: 0,
        mainsite: 1,
      },
    };
    if (sourceType) playEntry.json.source = sourceType;
    if (sourceID) playEntry.json.content = `id=${sourceID}`;
    entries.push(playEntry);
  }

  if (entries.length === 0) return {};
  const logs = JSON.stringify(entries);

  try {
    await eapiRequest("/api/feedback/weblog", { logs }, { host: CLIENTLOG_HOST, csrf });
    return {};
  } catch (_) {}

  try {
    await eapiRequest("/api/feedback/weblog", { logs }, { csrf });
    return {};
  } catch (_) {}

  await weapiRequest("/weapi/feedback/weblog", { logs }, { csrf }).catch(() => null);
  return {};
}

async function resolveSongTarget(ref, partID) {
  const kind = text(ref?.kind);
  const rawID = text(ref?.id);
  if (kind === "video") {
    const id = positiveID(rawID);
    if (!id) throw { code: "permission" };
    return { songID: id, partID: partID || "", episodes: undefined };
  }
  if (kind === "series") {
    const [prefix, id] = rawID.split(":");
    if (prefix === "pl" && positiveID(id)) {
      const { tracks } = await fetchPlaylistTracks(id, 300);
      const episodes = tracks
        .map((s) => {
          const sid = positiveID(s?.id);
          if (!sid) return undefined;
          const ar = (s?.ar || []).map((a) => text(a?.name)).filter(Boolean).join(" / ");
          return {
            title: ar ? `${text(s.name)} · ${ar}` : text(s.name),
            partID: sid,
            ref: { kind: "video", id: sid },
            durationSeconds: s.dt > 0 ? Math.max(1, Math.round(s.dt / 1000)) : undefined,
          };
        })
        .filter(Boolean);
      const chosen = positiveID(partID) || episodes[0]?.partID;
      if (!chosen) throw { code: "expired" };
      saveSongSource(chosen, id, "list");
      return { songID: chosen, partID: chosen, episodes };
    }
    if (prefix === "al" && positiveID(id)) {
      const body = await eapiRequest(`/api/v1/album/${id}`, {});
      const songs = Array.isArray(body?.songs) ? body.songs : [];
      const episodes = songs
        .map((s) => {
          const sid = positiveID(s?.id);
          if (!sid) return undefined;
          return {
            title: text(s.name),
            partID: sid,
            ref: { kind: "video", id: sid },
            durationSeconds: s.dt > 0 ? Math.max(1, Math.round(s.dt / 1000)) : undefined,
          };
        })
        .filter(Boolean);
      const chosen = positiveID(partID) || episodes[0]?.partID;
      if (!chosen) throw { code: "expired" };
      saveSongSource(chosen, id, "album");
      return { songID: chosen, partID: chosen, episodes };
    }
  }
  throw { code: "unsupported" };
}

async function resolveMVPlan(mvid, songID, partID, episodes, requestedQuality) {
  let cached = mvDetailCache.get(mvid);
  if (!cached) {
    const detailRes = await eapiRequest("/api/v1/mv/detail", { id: Number(mvid) }).catch(() => null);
    const brs = Array.isArray(detailRes?.data?.brs) ? detailRes.data.brs : [];
    const availableRes = brs
      .map((b) => Number(b?.br))
      .filter((n) => n >= 240)
      .sort((a, b) => b - a);
    cached = {
      resList: availableRes.length > 0 ? availableRes : [1080, 720, 480],
      durationMs: Number(detailRes?.data?.duration || 0),
    };
    cacheSet(mvDetailCache, mvid, cached, 128);
  }
  const resList = cached.resList;
  const wanted = Number(requestedQuality) || resList[0] || 1080;
  const chosenRes = resList.includes(wanted) ? wanted : resList[0];

  const mvRes = await eapiRequest("/api/song/enhance/play/mv/url", {
    id: Number(mvid),
    r: chosenRes,
  });
  const rawURL = normalizeHTTPS(mvRes?.data?.url);
  if (!rawURL) {
    throw { code: "expired", message: "MV stream unavailable." };
  }
  const qualities = resList.map((r) => ({ id: String(r), label: `${r}P` }));
  const durationMs = cached.durationMs;
  return {
    itemID: songID,
    partID,
    duration: durationMs > 0 ? durationMs / 1000 : 0,
    quality: String(chosenRes),
    qualities,
    availableKinds: ["audio", "video"],
    access: "granted",
    episodes,
    streams: [
      {
        format: "direct",
        video: {
          contentType: "video/mp4",
          resource: { urls: [rawURL], headers: mediaHeaders() },
        },
      },
    ],
  };
}

export async function resolvePlayback({
  ref,
  partID = "",
  quality = "",
  mediaKind = "",
  signedIn = false,
} = {}) {
  const copy = t();
  const target = await resolveSongTarget(ref, partID);
  const songID = target.songID;
  const meta = await getSongMeta(songID);
  const mvid = meta.mvid;
  const availableKinds = mvid ? ["audio", "video"] : ["audio"];

  if (mediaKind === "video" && mvid) {
    return resolveMVPlan(mvid, songID, target.partID, target.episodes, quality);
  }

  const priv = meta.priv;
  const explicitQuality = AUDIO_LEVELS.some((q) => q.id === quality) ? quality : "";
  const autoLevel = (() => {
    const plRank = levelRank(priv?.plLevel);
    if (plRank >= 4) return "hires";
    if (plRank >= 3) return "lossless";
    return "exhigh";
  })();
  const validLevel = explicitQuality || autoLevel;
  const encodeType = validLevel === "hires" || validLevel === "lossless" ? "flac" : "mp3";

  let urlRes = await eapiRequest("/api/song/enhance/player/url/v1", {
    ids: `[${songID}]`,
    level: validLevel,
    encodeType,
  });
  let entry = Array.isArray(urlRes?.data) ? urlRes.data[0] : null;
  let streamURL = normalizeHTTPS(entry?.url);
  if (!streamURL && validLevel !== "standard") {
    const fallbackRes = await eapiRequest("/api/song/enhance/player/url/v1", {
      ids: `[${songID}]`,
      level: "standard",
      encodeType: "mp3",
    }).catch(() => null);
    const fbEntry = Array.isArray(fallbackRes?.data) ? fallbackRes.data[0] : null;
    if (normalizeHTTPS(fbEntry?.url)) {
      urlRes = fallbackRes;
      entry = fbEntry;
      streamURL = normalizeHTTPS(fbEntry.url);
    }
  }
  const durationSec =
    Number(entry?.time || 0) > 0
      ? Number(entry.time) / 1000
      : meta.dt > 0
        ? meta.dt / 1000
        : 0;

  if (!streamURL) {
    const fee = Number(meta.fee || entry?.fee || 0);
    const restriction = fee === 4 ? "purchase" : fee === 1 ? "membership" : "source";
    return {
      itemID: songID,
      partID: target.partID,
      duration: durationSec,
      availableKinds,
      access: "restricted",
      restriction,
      episodes: target.episodes,
    };
  }

  const actualLevel = normalizeAudioLevel(entry?.level);
  const selectedQuality = actualLevel || (AUDIO_LEVELS.some((q) => q.id === validLevel) ? validLevel : "standard");
  const { qualities, maxRank } = buildAudioQualities(priv, selectedQuality, signedIn);

  let restriction;
  if (explicitQuality) {
    const reqRank = levelRank(explicitQuality);
    const gotRank = levelRank(selectedQuality);
    const listed = qualities.find((q) => q.id === explicitQuality);
    if (listed?.limit) {
      restriction = listed.limit;
    } else if (reqRank > maxRank) {
      restriction = "source";
    } else if (gotRank > 0 && gotRank < reqRank) {
      restriction = signedIn || reqRank >= 3 ? "membership" : "login";
    }
  }

  const trialInfo = entry?.freeTrialInfo;
  const isTrial = Boolean(trialInfo);
  const trialStartMs = isTrial && Number(trialInfo?.start) > 0 ? Math.round(Number(trialInfo.start) * 1000) : 0;
  const lrcID = trialStartMs > 0 ? `lrc:${songID}:${trialStartMs}` : `lrc:${songID}`;
  const contentType = audioContentType(entry?.type, streamURL);
  return {
    itemID: songID,
    partID: target.partID,
    duration: durationSec,
    quality: selectedQuality,
    qualities,
    availableKinds: mvid ? ["audio", "video"] : undefined,
    access: isTrial ? "preview" : "granted",
    restriction,
    previewRestriction: isTrial ? "membership" : undefined,
    episodes: target.episodes,
    subtitles: [
      {
        id: lrcID,
        label: copy.bilingualLyricsLabel,
        language: "zh",
        default: true,
      },
    ],
    streams: [
      {
        format: "direct",
        audio: {
          contentType,
          resource: { urls: [streamURL], headers: mediaHeaders() },
        },
      },
    ],
  };
}

function parseLRCLines(raw) {
  const out = [];
  if (!raw || typeof raw !== "string") return out;
  const lines = raw.split(/\r?\n/);
  const tagRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    tagRe.lastIndex = 0;
    const times = [];
    let match;
    let lastEnd = 0;
    while ((match = tagRe.exec(line)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const fracStr = match[3] || "0";
      const frac = fracStr.length === 1 ? parseInt(fracStr, 10) / 10 : fracStr.length === 2 ? parseInt(fracStr, 10) / 100 : parseInt(fracStr, 10) / 1000;
      const start = min * 60 + sec + frac;
      if (Number.isFinite(start) && start >= 0) {
        times.push(start);
      }
      lastEnd = match.index + match[0].length;
    }
    const content = line.slice(lastEnd).trim();
    if (!content || times.length === 0) continue;
    for (let j = 0; j < times.length; j++) {
      out.push({ start: times[j], text: content });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export async function readSubtitles({ ref, track } = {}) {
  let songID = "";
  let offsetSec = 0;
  const trackID = text(track?.id);
  if (trackID.startsWith("lrc:")) {
    const parts = trackID.split(":");
    songID = positiveID(parts[1]);
    if (parts[2]) {
      const ms = Number(parts[2]);
      if (Number.isFinite(ms) && ms > 0) offsetSec = ms / 1000;
    }
  }
  if (!songID) {
    songID = positiveID(ref?.id);
  }
  if (!songID) return { cues: [] };

  const body = await eapiRequest("/api/song/lyric", {
    id: Number(songID),
    lv: -1,
    tv: -1,
    rv: -1,
  });
  const primary = parseLRCLines(body?.lrc?.lyric || "");
  if (primary.length === 0) return { cues: [] };
  const trans = parseLRCLines(body?.tlyric?.lyric || "");

  const dedup = [];
  for (let i = 0; i < primary.length; i++) {
    const cur = primary[i];
    if (dedup.length > 0 && Math.abs(cur.start - dedup[dedup.length - 1].start) < 0.02) {
      if (!dedup[dedup.length - 1].text.includes(cur.text)) {
        dedup[dedup.length - 1].text += "\n" + cur.text;
      }
      continue;
    }
    dedup.push({ start: cur.start, text: cur.text, trans: "" });
  }

  const creditRe = /^(?:作词|作曲|编曲|制作人|演唱|词|曲|混音|母带|和声|吉他|贝斯|鼓|键盘|录音|监制|出品)\s*[:：]/;
  for (let j = 0; j < trans.length; j++) {
    const tr = trans[j];
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let i = 0; i < dedup.length; i++) {
      if (dedup[i].trans) continue;
      const dist = Math.abs(dedup[i].start - tr.start);
      if (dist > 0.25) continue;
      const penalty = creditRe.test(dedup[i].text) ? 0.20 : 0;
      const score = dist + penalty;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && tr.text !== dedup[bestIdx].text) {
      dedup[bestIdx].trans = tr.text;
    }
  }

  const cues = [];
  for (let i = 0; i < dedup.length; i++) {
    const rawStart = dedup[i].start - offsetSec;
    const rawNext = (i + 1 < dedup.length ? dedup[i + 1].start : dedup[i].start + 6) - offsetSec;
    if (offsetSec > 0 && rawNext <= 0) {
      continue;
    }
    const start = Math.max(0, rawStart);
    const end = rawNext > start + 0.05 ? rawNext : start + 2;
    const label = (dedup[i].trans ? `${dedup[i].text}\n${dedup[i].trans}` : dedup[i].text).trim();
    if (!label) continue;
    cues.push({ start, end, text: label });
  }
  return { cues };
}
