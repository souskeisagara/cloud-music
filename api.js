// EAPI / WeAPI transport built on MikuTV's native host.crypto primitives.

export const MUSIC_ORIGIN = "https://music.163.com";
export const MUSIC_REFERER = "https://music.163.com/";
export const EAPI_HOST = "https://interface.music.163.com";
export const CLIENTLOG_HOST = "https://clientlog.music.163.com";
export const APP_VER = "3.1.17.204416";
export const OSX_APP_VER = "3.1.10.5100";
export const OSX_OS_VER = "15.5";
export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117";
export const OSX_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const PLACEHOLDER_ARTIST_PIC_RE = /\/5639395138885805\.(?:jpg|png|webp)$/i;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_RE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const DEVICE_ID_KEY = "ncm_device_id";
let cachedDeviceID = "";

function getDeviceID() {
  if (cachedDeviceID) {
    return cachedDeviceID;
  }
  try {
    if (typeof host !== "undefined" && host.storage && typeof host.storage.get === "function") {
      const stored = text(host.storage.get(DEVICE_ID_KEY));
      if (stored && /^[0-9a-f]{32}$/i.test(stored)) {
        cachedDeviceID = stored;
        return cachedDeviceID;
      }
    }
  } catch (_) {}
  cachedDeviceID = host.crypto.randomBytes(16, "hex");
  try {
    if (typeof host !== "undefined" && host.storage && typeof host.storage.set === "function") {
      host.storage.set(DEVICE_ID_KEY, cachedDeviceID);
    }
  } catch (_) {}
  return cachedDeviceID;
}

const EAPI_KEY = "e82ckenh8dichen8";
const WEAPI_PRESET_KEY = "0CoJUm6Qyw8W8jud";
const WEAPI_IV = "0102030405060708";
const WEAPI_MODULUS =
  "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
const WEAPI_EXPONENT = "010001";
const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function positiveID(value) {
  const s = String(value ?? "").trim();
  return /^[1-9]\d*$/.test(s) ? s : "";
}

export function count(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export function normalizeHTTPS(raw) {
  const s = text(raw);
  if (!s) return "";
  if (s.startsWith("https://")) return s;
  if (s.startsWith("http://")) return "https://" + s.slice(7);
  if (s.startsWith("//")) return "https:" + s;
  return "";
}

export function squareCover(raw, size = 1024) {
  const u = normalizeHTTPS(raw);
  if (!u) return undefined;
  const clean = u.split("?")[0];
  return `${clean}?imageView&thumbnail=${size}y${size}&quality=88&type=jpg`;
}

export function isPlaceholderArtistPic(raw) {
  const u = normalizeHTTPS(raw);
  if (!u) return true;
  const clean = u.split("?")[0];
  return PLACEHOLDER_ARTIST_PIC_RE.test(clean);
}

export function avatarCover(raw, size = 256) {
  return squareCover(raw, size);
}

export function artistAvatar(artist, size = 256) {
  if (!artist || typeof artist !== "object") return undefined;
  const candidates = [artist.avatar, artist.img1v1Url, artist.picUrl, artist.cover];
  for (let i = 0; i < candidates.length; i++) {
    const raw = candidates[i];
    if (!isPlaceholderArtistPic(raw)) {
      return avatarCover(raw, size);
    }
  }
  return undefined;
}

export function mediaHeaders() {
  return {
    Referer: MUSIC_REFERER,
    "User-Agent": WEB_UA,
  };
}

export function sessionCacheGet(key) {
  try {
    if (typeof host !== "undefined" && host.cache && typeof host.cache.get === "function") {
      return host.cache.get(key);
    }
  } catch (_) {}
  return undefined;
}

export function sessionCacheSet(key, value, ttlSec = 0) {
  try {
    if (typeof host !== "undefined" && host.cache && typeof host.cache.set === "function") {
      host.cache.set(key, String(value), ttlSec);
    }
  } catch (_) {}
}

export function sessionCacheDelete(key) {
  try {
    if (typeof host !== "undefined" && host.cache && typeof host.cache.delete === "function") {
      host.cache.delete(key);
    }
  } catch (_) {}
}

export function sessionCacheGetJSON(key) {
  const raw = sessionCacheGet(key);
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return undefined;
  }
}

export function sessionCacheSetJSON(key, value, ttlSec = 0) {
  try {
    sessionCacheSet(key, JSON.stringify(value), ttlSec);
  } catch (_) {}
}

export function encryptEAPI(apiPath, payload) {
  const body = Object.assign({ e_r: false }, payload || {});
  return encryptEAPIRaw(apiPath, body);
}

export function encryptEAPIRaw(apiPath, bodyObj) {
  const payloadStr = JSON.stringify(bodyObj || {});
  const digest = host.crypto.md5(`nobody${apiPath}use${payloadStr}md5forencrypt`);
  const message = `${apiPath}-36cd479b6b5-${payloadStr}-36cd479b6b5-${digest}`;
  const params = host.crypto
    .aesEncrypt({
      mode: "ecb",
      key: EAPI_KEY,
      data: message,
      outputEncoding: "hex",
    })
    .toUpperCase();
  return { params };
}

export function encryptWeAPI(payload) {
  const plain = JSON.stringify(payload || {});
  const rndHex = host.crypto.randomBytes(16, "hex");
  let secretKey = "";
  for (let i = 0; i < 16; i++) {
    const byte = parseInt(rndHex.slice(i * 2, i * 2 + 2), 16);
    secretKey += BASE62[byte % BASE62.length];
  }
  const pass1 = host.crypto.aesEncrypt({
    mode: "cbc",
    key: WEAPI_PRESET_KEY,
    iv: WEAPI_IV,
    data: plain,
    outputEncoding: "base64",
  });
  const params = host.crypto.aesEncrypt({
    mode: "cbc",
    key: secretKey,
    iv: WEAPI_IV,
    data: pass1,
    outputEncoding: "base64",
  });
  const reversed = secretKey.split("").reverse().join("");
  const encSecKey = host.crypto.rsaEncrypt({
    mode: "raw",
    modulusHex: WEAPI_MODULUS,
    exponentHex: WEAPI_EXPONENT,
    data: reversed,
    outputEncoding: "hex",
  });
  return { params, encSecKey };
}

function formEncode(obj) {
  const pairs = [];
  for (const k of Object.keys(obj)) {
    pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k] ?? "")));
  }
  return pairs.join("&");
}

function checkAPIResponse(resp, body, allowCodes) {
  if (resp.status === 429) throw { code: "rateLimited" };
  if (resp.status === 401 || resp.status === 403) throw { code: "signIn" };
  if (!resp.ok) throw { code: "network", message: `HTTP ${resp.status}` };
  if (!body || typeof body !== "object") throw { code: "plugin", message: "Invalid JSON response" };
  const code = Number(body.code ?? 200);
  if (allowCodes && allowCodes.includes(code)) return body;
  if (code === 200) return body;
  if (code === 301 || code === 302 || code === -2) throw { code: "signIn", message: text(body.message || body.msg) || "Sign-in required" };
  if (code === 405 || code === 406 || code === 460 || code === -460 || code === -462) {
    throw { code: "rateLimited", message: text(body.message || body.msg) || "Rate limited" };
  }
  if (code === 404) throw { code: "expired", message: text(body.message || body.msg) || "Not found" };
  throw { code: "plugin", message: text(body.message || body.msg) || `API error ${code}` };
}

export async function eapiRequest(apiPath, payload = {}, opts = {}) {
  const eapiPath = apiPath.startsWith("/api/") ? "/eapi/" + apiPath.slice(5) : apiPath;
  const hostBase = opts.host || EAPI_HOST;
  const url = hostBase + eapiPath;
  const nowMs = Date.now();
  const headerPayload = Object.assign(
    {
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: getDeviceID(),
      os: "pc",
      appver: APP_VER,
      versioncode: "140",
      mobilename: "",
      buildver: String(Math.floor(nowMs / 1000)),
      resolution: "1920x1080",
      __csrf: text(opts.csrf),
      channel: "netease",
      requestId: `${nowMs}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
    },
    opts.header || {}
  );
  const musicU = text(opts.musicU);
  if (musicU && !headerPayload.MUSIC_U) {
    headerPayload.MUSIC_U = musicU;
  }
  const bodyObj = Object.assign({ header: headerPayload }, payload);
  const { params } = encryptEAPI(apiPath, bodyObj);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, text/plain, */*",
        Origin: MUSIC_ORIGIN,
        Referer: MUSIC_REFERER,
        "User-Agent": DESKTOP_UA,
      },
      body: formEncode({ params }),
    });
  } catch (err) {
    throw { code: "network", message: String((err && err.message) || err || "Network error") };
  }

  let body;
  try {
    body = await resp.json();
  } catch (_) {
    throw { code: "plugin", message: "Failed to parse EAPI JSON" };
  }
  const checked = checkAPIResponse(resp, body, opts.allowCodes);
  return opts.withResponse ? { body: checked, response: resp } : checked;
}

// Client-log EAPI POST aligned to NetEase's macOS (os=osx) weblog contract:
// clientlog.music.163.com/eapi/feedback/weblog with os=osx, appver=3.1.10.5100,
// osver=15.5, header as a JSON object carrying MUSIC_U, Mac Chrome UA, and no Referer.
export async function eapiClientLog(apiPath, payload = {}, secret = null) {
  const eapiPath = apiPath.startsWith("/api/") ? "/eapi/" + apiPath.slice(5) : apiPath;
  const url = CLIENTLOG_HOST + eapiPath;
  const nowMs = Date.now();
  const header = {
    osver: OSX_OS_VER,
    deviceId: getDeviceID(),
    os: "osx",
    appver: OSX_APP_VER,
    versioncode: "140",
    mobilename: "",
    buildver: String(Math.floor(nowMs / 1000)),
    resolution: "1920x1080",
    __csrf: text(secret?.csrf),
    channel: "netease",
    requestId: `${nowMs}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
  };
  const musicU = text(secret?.musicU);
  if (musicU) {
    header.MUSIC_U = musicU;
  }
  const bodyObj = Object.assign({}, payload, { e_r: false, header });
  const { params } = encryptEAPIRaw(apiPath, bodyObj);

  let resp;
  try {
    const dynamicCookie = [
      `deviceId=${encodeURIComponent(header.deviceId)}`,
      `versioncode=${encodeURIComponent(header.versioncode)}`,
      `mobilename=`,
      `buildver=${encodeURIComponent(header.buildver)}`,
      `resolution=${encodeURIComponent(header.resolution)}`,
      `requestId=${encodeURIComponent(header.requestId)}`,
    ].join("; ");
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": OSX_UA,
        Cookie: dynamicCookie,
      },
      body: formEncode({ params }),
    });
  } catch (err) {
    throw { code: "network", message: String((err && err.message) || err || "Network error") };
  }

  let body;
  try {
    body = await resp.json();
  } catch (_) {
    throw { code: "plugin", message: "Failed to parse clientlog JSON" };
  }
  return checkAPIResponse(resp, body);
}

export async function weapiRequest(weapiPath, payload = {}, opts = {}) {
  const csrf = text(opts.csrf);
  const path = weapiPath.startsWith("/weapi/") ? weapiPath : "/weapi/" + weapiPath.replace(/^\/+/, "");
  const url = MUSIC_ORIGIN + path + (csrf ? `?csrf_token=${encodeURIComponent(csrf)}` : "");
  const bodyObj = csrf ? Object.assign({ csrf_token: csrf }, payload) : payload;
  const { params, encSecKey } = encryptWeAPI(bodyObj);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, text/plain, */*",
        Origin: MUSIC_ORIGIN,
        Referer: MUSIC_REFERER,
        "User-Agent": WEB_UA,
      },
      body: formEncode({ params, encSecKey }),
    });
  } catch (err) {
    throw { code: "network", message: String((err && err.message) || err || "Network error") };
  }

  let body;
  try {
    body = await resp.json();
  } catch (_) {
    throw { code: "plugin", message: "Failed to parse WeAPI JSON" };
  }
  const checked = checkAPIResponse(resp, body, opts.allowCodes);
  return opts.withResponse ? { body: checked, response: resp } : checked;
}

export function collectSetCookies(cookieMap, response) {
  if (!response || !response.headers) {
    return;
  }
  let headers = [];
  if (typeof response.headers.getSetCookie === "function") {
    headers = response.headers.getSetCookie() || [];
  }
  if (headers.length === 0 && typeof response.headers.get === "function") {
    const single = response.headers.get("set-cookie");
    if (single) headers = [single];
  }
  for (let i = 0; i < headers.length; i++) {
    const raw = String(headers[i] || "").trim();
    if (!raw) continue;
    const parts = raw.split(";");
    const pair = parts[0] || "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (!name || !value || !COOKIE_NAME_RE.test(name) || !COOKIE_VALUE_RE.test(value)) continue;
    const attrs = ["Domain=.music.163.com", "Path=/", "Secure"];
    let deleted = false;
    for (let j = 1; j < parts.length; j++) {
      const seg = parts[j].trim();
      const lower = seg.toLowerCase();
      if (lower === "httponly") {
        attrs.push("HttpOnly");
      } else if (lower.startsWith("max-age=")) {
        const age = parseInt(seg.slice(8).trim(), 10);
        if (Number.isFinite(age) && age <= 0) {
          deleted = true;
          break;
        }
        if (Number.isFinite(age) && age > 0) {
          attrs.push(`Max-Age=${age}`);
        }
      }
    }
    if (deleted) {
      delete cookieMap[name];
      continue;
    }
    cookieMap[name] = `${name}=${value}; ${attrs.join("; ")}`;
  }
}

export function extractCookieValue(cookieMap, targetName) {
  const raw = cookieMap[targetName];
  if (!raw) return "";
  const pair = raw.split(";")[0] || "";
  const eq = pair.indexOf("=");
  return eq > 0 ? pair.slice(eq + 1).trim() : "";
}

export function artistsFromSong(song) {
  const list = Array.isArray(song?.ar)
    ? song.ar
    : Array.isArray(song?.artists)
      ? song.artists
      : [];
  const names = [];
  let primaryID = "";
  let primaryAvatar;
  for (let i = 0; i < list.length; i++) {
    const ar = list[i];
    const name = text(ar?.name);
    if (!name) continue;
    names.push(name);
    if (!primaryID) {
      primaryID = positiveID(ar?.id);
      primaryAvatar = artistAvatar(ar, 256);
    }
  }
  const joined = names.join(" / ");
  if (!joined) return undefined;
  return primaryID
    ? { id: primaryID, name: joined, avatarURL: primaryAvatar }
    : { id: "0", name: joined };
}

export function mapSongItem(song, extra = {}) {
  const id = positiveID(song?.id);
  const title = text(song?.name);
  if (!id || !title) return undefined;
  const album = song?.al || song?.album || {};
  const pic = album?.picUrl || song?.picUrl || extra.coverURL || "";
  const durMs = Number(song?.dt ?? song?.duration ?? 0);
  const durationSeconds = durMs > 0 ? Math.max(1, Math.round(durMs / 1000)) : undefined;
  const creator = artistsFromSong(song);
  const albumName = text(album?.name);
  const alias = Array.isArray(song?.alia) && song.alia.length > 0 ? text(song.alia[0]) : "";
  const mvid = positiveID(song?.mv ?? song?.mvid);
  const subtitleParts = [];
  if (creator?.name) subtitleParts.push(creator.name);
  if (albumName) subtitleParts.push(albumName);
  if (alias && subtitleParts.length < 2) subtitleParts.push(alias);

  const item = {
    ref: { kind: "video", id },
    title,
    subtitle: subtitleParts.join(" · ") || undefined,
    creator: creator && creator.id !== "0" ? creator : undefined,
    coverURL: squareCover(pic, 1024),
    backdropURL: squareCover(pic, 2048),
    durationSeconds,
    category: albumName || extra.category || undefined,
  };
  if (mvid) {
    item.quality = "MV";
  }
  if (extra.views !== undefined) {
    item.views = extra.views;
  }
  return item;
}

export function mapPlaylistItem(pl, tag) {
  const id = positiveID(pl?.id);
  const title = text(pl?.name);
  if (!id || !title) return undefined;
  const pic = pl?.coverImgUrl || pl?.picUrl || "";
  const playCount = count(pl?.playCount);
  const trackCount = count(pl?.trackCount);
  const creatorName = text(pl?.creator?.nickname);
  const parts = [];
  if (trackCount) parts.push(`${trackCount} tracks`);
  if (creatorName) parts.push(creatorName);
  return {
    ref: { kind: "series", id: `pl:${id}` },
    title,
    subtitle: text(pl?.copywriter || pl?.description) || parts.join(" · ") || undefined,
    coverURL: squareCover(pic, 1024),
    backdropURL: squareCover(pic, 2048),
    views: playCount,
    category: tag || undefined,
  };
}

export function mapAlbumItem(album, tag) {
  const id = positiveID(album?.id);
  const title = text(album?.name);
  if (!id || !title) return undefined;
  const pic = album?.picUrl || album?.blurPicUrl || "";
  const arName = text(album?.artist?.name) || (Array.isArray(album?.artists) ? album.artists.map((a) => text(a?.name)).filter(Boolean).join(" / ") : "");
  const arID = positiveID(album?.artist?.id || album?.artists?.[0]?.id);
  return {
    ref: { kind: "series", id: `al:${id}` },
    title,
    subtitle: arName || undefined,
    creator: arName && arID ? { id: arID, name: arName, avatarURL: artistAvatar(album?.artist, 256) } : undefined,
    coverURL: squareCover(pic, 1024),
    backdropURL: squareCover(pic, 2048),
    category: tag || undefined,
  };
}
