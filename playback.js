// Audio & MV stream resolution (with VIP quality locks, MediaKind switching),
// bilingual LRC lyrics with preview-offset alignment, and recent-play progress reporting.

import { eapiRequest, mapSongItem, mediaHeaders, normalizeHTTPS, positiveID, text } from "./api.js";
import { cachedSongPrivilege, fetchPlaylistTracks, fetchSongsByIDs } from "./catalog.js";
import { t } from "./i18n.js";

const AUDIO_LEVELS = [
  { id: "hires", labelKey: "qualityHires", rank: 4 },
  { id: "lossless", labelKey: "qualityLossless", rank: 3 },
  { id: "exhigh", labelKey: "qualityExhigh", rank: 2 },
  { id: "standard", labelKey: "qualityStandard", rank: 1 },
];

const HISTORY_STORAGE_KEY = "cloud_music_history_v1";
const HISTORY_MAX_ITEMS = 32;

const songMetaCache = new Map();
const mvDetailCache = new Map();

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
      dt: Number(song?.dt || 0),
      fee: Number(song?.fee ?? priv?.fee ?? 0),
      priv,
      mapped,
    };
    cacheSet(songMetaCache, songID, meta, 256);
    return meta;
  }
  return cached || { mvid: "", dt: 0, fee: 0, priv, mapped: null };
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

function readLocalHistoryRaw() {
  if (typeof host === "undefined" || !host.storage || typeof host.storage.get !== "function") {
    return [];
  }
  try {
    const raw = host.storage.get(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeLocalHistoryRaw(entries) {
  if (typeof host === "undefined" || !host.storage || typeof host.storage.set !== "function") {
    return;
  }
  try {
    let trimmed = entries.slice(0, HISTORY_MAX_ITEMS);
    let encoded = JSON.stringify(trimmed);
    while (encoded.length > 6800 && trimmed.length > 1) {
      trimmed = trimmed.slice(0, trimmed.length - 1);
      encoded = JSON.stringify(trimmed);
    }
    host.storage.set(HISTORY_STORAGE_KEY, encoded);
  } catch (_) {}
}

export function readLocalHistory() {
  return readLocalHistoryRaw()
    .map((e) => {
      const id = positiveID(e?.id);
      const title = text(e?.t);
      if (!id || !title) return undefined;
      const artistID = positiveID(e?.ai);
      const artistName = text(e?.a);
      const coverURL = normalizeHTTPS(e?.c) || undefined;
      const dur = Number(e?.d) > 0 ? Math.round(Number(e.d)) : undefined;
      const pos = Number(e?.p) > 0 ? Math.round(Number(e.p)) : undefined;
      const finished = e?.f === true;
      const item = {
        ref: { kind: "video", id },
        title,
        subtitle: artistName || undefined,
        creator: artistID && artistName ? { id: artistID, name: artistName } : undefined,
        coverURL,
        backdropURL: coverURL ? coverURL.replace("1024y1024", "2048y2048") : undefined,
        durationSeconds: dur,
      };
      return {
        id,
        title,
        subtitle: artistName || "",
        coverURL,
        durationSeconds: dur,
        progressSeconds: finished ? undefined : pos,
        finished,
        ref: { kind: "video", id },
        item,
      };
    })
    .filter(Boolean);
}

function recordLocalPlay(songID, mapped, positionSeconds, durationSeconds, finished) {
  if (!songID || !mapped?.title) return;
  const list = readLocalHistoryRaw().filter((e) => positiveID(e?.id) !== songID);
  const dur = Math.round(Number(durationSeconds || mapped.durationSeconds || 0));
  const pos = Math.round(Number(positionSeconds || 0));
  const done = Boolean(finished) || (dur > 0 && pos >= dur - 5);
  list.unshift({
    id: songID,
    t: mapped.title.slice(0, 64),
    a: text(mapped.creator?.name || mapped.subtitle).slice(0, 40),
    ai: positiveID(mapped.creator?.id) || "",
    c: mapped.coverURL || "",
    d: dur > 0 ? dur : 0,
    p: done ? 0 : Math.max(0, pos),
    f: done,
    ts: Math.floor(Date.now() / 1000),
  });
  writeLocalHistoryRaw(list);
}

export async function reportPlayback({ data } = {}) {
  const ref = data?.ref;
  const partID = text(data?.partID);
  const seconds = Math.max(0, Math.round(Number(data?.seconds || 0)));
  const finished = Boolean(data?.finished);
  const songID = positiveID(partID) || (text(ref?.kind) === "video" ? positiveID(ref?.id) : "") || positiveID(data?.itemID);
  if (!songID) return {};
  const meta = songMetaCache.get(songID) || (await getSongMeta(songID).catch(() => null));
  if (meta?.mapped) {
    recordLocalPlay(songID, meta.mapped, seconds, meta.mapped.durationSeconds || 0, finished);
  }
  if (finished || seconds >= 30) {
    await eapiRequest("/api/feedback/weblog", {
      logs: JSON.stringify([
        {
          action: "play",
          json: {
            download: 0,
            end: finished ? "playend" : "interrupt",
            id: Number(songID),
            sourceId: "",
            time: seconds,
            type: "song",
            wifi: 0,
          },
        },
      ]),
    }).catch(() => null);
  }
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

  // Record start in local recent history immediately so switching to Recently Played reflects it right away.
  if (meta.mapped && !restriction) {
    recordLocalPlay(songID, meta.mapped, 0, durationSec, false);
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
