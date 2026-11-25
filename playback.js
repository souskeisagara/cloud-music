// Audio & MV stream resolution (with MediaKind switching) and bilingual LRC lyrics.

import { eapiRequest, mediaHeaders, normalizeHTTPS, positiveID, text } from "./api.js";
import { fetchPlaylistTracks, fetchSongsByIDs } from "./catalog.js";
import { t } from "./i18n.js";

const AUDIO_LEVELS = [
  { id: "hires", labelKey: "qualityHires", limit: "membership" },
  { id: "lossless", labelKey: "qualityLossless", limit: "membership" },
  { id: "exhigh", labelKey: "qualityExhigh", limit: "" },
  { id: "standard", labelKey: "qualityStandard", limit: "" },
];

function audioContentType(typeRaw, url) {
  const lower = text(typeRaw).toLowerCase();
  if (lower === "flac" || /\.flac(?:[?#]|$)/i.test(url)) return "audio/flac";
  if (lower === "m4a" || /\.m4a(?:[?#]|$)/i.test(url)) return "audio/mp4";
  if (lower === "aac" || /\.aac(?:[?#]|$)/i.test(url)) return "audio/aac";
  if (lower === "wav" || /\.wav(?:[?#]|$)/i.test(url)) return "audio/wav";
  return "audio/mpeg";
}

function buildAudioQualities(signedIn) {
  const copy = t();
  return AUDIO_LEVELS.map((q) => ({
    id: q.id,
    label: copy[q.labelKey] || q.id,
    limit: !signedIn && q.limit ? q.limit : undefined,
  }));
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
      const { tracks } = await fetchPlaylistTracks(id, 100);
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
  const detailRes = await eapiRequest("/api/v1/mv/detail", { id: Number(mvid) }).catch(() => null);
  const brs = Array.isArray(detailRes?.data?.brs) ? detailRes.data.brs : [];
  const availableRes = brs
    .map((b) => Number(b?.br))
    .filter((n) => n >= 240)
    .sort((a, b) => b - a);
  const resList = availableRes.length > 0 ? availableRes : [1080, 720, 480];
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
  const durationMs = Number(detailRes?.data?.duration || 0);
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
  const songs = await fetchSongsByIDs([songID]).catch(() => []);
  const song = songs[0];
  const mvid = positiveID(song?.mv ?? song?.mvid);
  const availableKinds = mvid ? ["audio", "video"] : undefined;

  if (mediaKind === "video" && mvid) {
    return resolveMVPlan(mvid, songID, target.partID, target.episodes, quality);
  }

  const validLevel = AUDIO_LEVELS.some((q) => q.id === quality)
    ? quality
    : signedIn
      ? "lossless"
      : "exhigh";

  let urlRes = await eapiRequest("/api/song/enhance/player/url/v1", {
    ids: `[${songID}]`,
    level: validLevel,
    encodeType: "mp3",
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
      : Number(song?.dt || 0) > 0
        ? Number(song.dt) / 1000
        : 0;

  if (!streamURL) {
    const fee = Number(song?.fee ?? entry?.fee ?? 0);
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

  const actualLevel = text(entry?.level).toLowerCase();
  const selectedQuality = AUDIO_LEVELS.some((q) => q.id === actualLevel) ? actualLevel : validLevel;
  const isTrial = Boolean(entry?.freeTrialInfo);
  const contentType = audioContentType(entry?.type, streamURL);
  const plan = {
    itemID: songID,
    partID: target.partID,
    duration: durationSec,
    quality: selectedQuality,
    qualities: buildAudioQualities(signedIn),
    availableKinds,
    access: isTrial ? "preview" : "granted",
    previewRestriction: isTrial ? "membership" : undefined,
    episodes: target.episodes,
    subtitles: [
      {
        id: `lrc:${songID}`,
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
  return plan;
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
  const trackID = text(track?.id);
  if (trackID.startsWith("lrc:")) {
    songID = positiveID(trackID.slice(4));
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

  // Deduplicate identical start timestamps in primary first.
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

  // One-to-one alignment: assign each translation line to its single closest primary line
  // within ±0.25s, preferring non-credit lyric lines when timestamps are tightly spaced.
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
    const start = Math.max(0, dedup[i].start);
    const nextStart = i + 1 < dedup.length ? dedup[i + 1].start : start + 6;
    const end = nextStart > start + 0.05 ? nextStart : start + 2;
    const label = (dedup[i].trans ? `${dedup[i].text}\n${dedup[i].trans}` : dedup[i].text).trim();
    if (!label) continue;
    cues.push({ start, end, text: label });
  }
  return { cues };
}
