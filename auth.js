// Official QR-code sign-in, session restoration, and sign-out.

import {
  MUSIC_ORIGIN,
  OSX_APP_VER,
  OSX_OS_VER,
  avatarCover,
  collectSetCookies,
  eapiRequest,
  extractCookieValue,
  positiveID,
  text,
  weapiRequest,
} from "./api.js";
import { t } from "./i18n.js";

function hasActiveRight(pkg, now) {
  if (!pkg || typeof pkg !== "object") return false;
  if (pkg.rights !== true) return false;
  const exp = Number(pkg.expireTime ?? 0);
  return exp <= 0 || exp > now;
}

function resolveActiveVIP(vipData, profile, accountInfo) {
  const now = Date.now();
  if (vipData && typeof vipData === "object" && (vipData.associator || vipData.redplus || vipData.musicPackage)) {
    return (
      hasActiveRight(vipData.associator, now) ||
      hasActiveRight(vipData.redplus, now) ||
      hasActiveRight(vipData.musicPackage, now)
    );
  }
  const rights = profile?.vipRights || accountInfo?.vipRights;
  if (rights && typeof rights === "object") {
    return (
      hasActiveRight(rights.associator, now) ||
      hasActiveRight(rights.redplus, now) ||
      hasActiveRight(rights.musicPackage, now)
    );
  }
  return false;
}

async function fetchVIPInfo(csrf = "", musicU = "") {
  const attempts = [
    () =>
      eapiRequest(
        "/api/music-vip-membership/client/vip/info",
        {},
        { csrf, musicU, allowCodes: [200] }
      ),
    () =>
      weapiRequest(
        "/weapi/music-vip-membership/front/vip/info",
        {},
        { csrf, allowCodes: [200] }
      ),
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const body = await attempts[i]();
      if (body?.data && typeof body.data === "object") {
        return body.data;
      }
    } catch (_) {}
  }
  return null;
}

function buildAccount(profile, accountInfo, vipData, fallback) {
  const copy = t();
  const fb = fallback || {};
  const uid = positiveID(profile?.userId ?? accountInfo?.id ?? fb.uid);
  const name = text(profile?.nickname || accountInfo?.userName || fb.name) || copy.sourceName;
  const avatarURL = avatarCover(profile?.avatarUrl || fb.avatarURL, 256);
  const isVIP = resolveActiveVIP(vipData, profile, accountInfo);

  const account = {
    id: uid || "cloud-music-user",
    name,
    badge: { text: isVIP ? copy.vipBadge : copy.normalBadge, icon: isVIP ? "sparkles" : "user" },
    card: {
      title: copy.vipBadge,
      description: copy.vipCardDesc,
      icon: isVIP ? "sparkles" : undefined,
      status: isVIP ? copy.vipActive : copy.vipInactive,
      highlight: isVIP,
      benefits: [
        copy.benefitLossless,
        copy.benefitCatalog,
        copy.benefitLyrics,
      ],
      actionLabel: copy.vipActionLabel,
      details: {
        title: copy.vipDetailTitle,
        kicker: copy.vipDetailKicker,
        body: copy.vipDetailBody,
        phoneAction: copy.vipPhoneAction,
        phoneBody: copy.vipPhoneBody,
        officialLabel: copy.vipOfficialLabel,
        refreshAction: copy.vipRefreshAction,
        dismissAction: copy.vipDismissAction,
      },
    },
  };
  if (avatarURL) account.avatarURL = avatarURL;
  return account;
}

async function fetchUserAccount(cookieMap, csrf = "", musicU = "") {
  const attempts = [
    () =>
      weapiRequest(
        "/weapi/w/nuser/account/get",
        {},
        { csrf, withResponse: true, allowCodes: [200] }
      ),
    () =>
      weapiRequest(
        "/weapi/nuser/account/get",
        {},
        { csrf, withResponse: true, allowCodes: [200] }
      ),
    () =>
      eapiRequest(
        "/api/w/nuser/account/get",
        {},
        { csrf, musicU, withResponse: true, allowCodes: [200] }
      ),
    () =>
      eapiRequest(
        "/api/nuser/account/get",
        {},
        { csrf, musicU, withResponse: true, allowCodes: [200] }
      ),
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const { body, response } = await attempts[i]();
      if (cookieMap) collectSetCookies(cookieMap, response);
      const profile = body?.profile || null;
      const accountInfo = body?.account || null;
      const uid = positiveID(profile?.userId ?? accountInfo?.id);
      if (uid) {
        return { profile, accountInfo };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && lastErr.code === "network") {
    throw lastErr;
  }
  throw { code: "signIn", message: t().signInRequired };
}

function finalizeCookieHeaders(cookieMap) {
  const reserved = new Set(["os", "appver", "osver", "channel"]);
  const finalHeaders = Object.keys(cookieMap)
    .filter((k) => !reserved.has(k))
    .map((k) => cookieMap[k]);
  finalHeaders.push("os=osx; Domain=.music.163.com; Path=/; Secure");
  finalHeaders.push(`appver=${OSX_APP_VER}; Domain=.music.163.com; Path=/; Secure`);
  finalHeaders.push(`osver=${OSX_OS_VER}; Domain=.music.163.com; Path=/; Secure`);
  finalHeaders.push("channel=netease; Domain=.music.163.com; Path=/; Secure");
  return finalHeaders;
}

export async function beginSignIn() {
  const body = await eapiRequest("/api/login/qrcode/unikey", { type: 3 });
  const key = text(body?.unikey);
  if (!key) {
    throw { code: "plugin", message: "Failed to create QR login key." };
  }
  return {
    url: `${MUSIC_ORIGIN}/login?codekey=${encodeURIComponent(key)}`,
    key,
    expiresAt: Date.now() + 180_000,
  };
}

export async function pollSignIn(req) {
  const key = text(req?.key);
  if (!key) throw { code: "plugin", message: "Missing QR login key." };

  const cookieMap = {};
  const { body, response } = await eapiRequest(
    "/api/login/qrcode/client/login",
    { key, type: 3 },
    { withResponse: true, allowCodes: [800, 801, 802, 803] }
  );
  collectSetCookies(cookieMap, response);
  const code = Number(body?.code ?? 0);

  if (code === 800) return { status: "expired" };
  if (code === 801) return { status: "waiting" };
  if (code === 802) return { status: "scanned" };
  if (code !== 803) return { status: "waiting" };

  if (!cookieMap.MUSIC_U && Object.keys(cookieMap).length === 0) {
    throw { code: "signIn", message: "No session cookies returned." };
  }
  const csrf = extractCookieValue(cookieMap, "__csrf");
  const initialMusicU = extractCookieValue(cookieMap, "MUSIC_U");
  const { profile, accountInfo } = await fetchUserAccount(cookieMap, csrf, initialMusicU);
  const resolvedCSRF = extractCookieValue(cookieMap, "__csrf") || csrf;
  const musicU = extractCookieValue(cookieMap, "MUSIC_U") || initialMusicU;
  const vipData = await fetchVIPInfo(resolvedCSRF, musicU);
  const finalHeaders = finalizeCookieHeaders(cookieMap);
  const account = buildAccount(profile, accountInfo, vipData, null);
  return {
    status: "approved",
    account,
    secret: {
      uid: account.id,
      name: account.name,
      avatarURL: account.avatarURL || "",
      csrf: resolvedCSRF,
      musicU,
    },
    cookies: [{ url: MUSIC_ORIGIN, headers: finalHeaders }],
  };
}

export async function restoreAccount(secret) {
  const cookieMap = {};
  const { profile, accountInfo } = await fetchUserAccount(cookieMap, text(secret?.csrf), text(secret?.musicU));
  const csrf = extractCookieValue(cookieMap, "__csrf") || text(secret?.csrf);
  const musicU = extractCookieValue(cookieMap, "MUSIC_U") || text(secret?.musicU);
  const vipData = await fetchVIPInfo(csrf, musicU);
  const account = buildAccount(profile, accountInfo, vipData, secret);
  const out = {
    account,
    secret: {
      uid: account.id,
      name: account.name,
      avatarURL: account.avatarURL || "",
      csrf,
      musicU,
    },
  };
  if (cookieMap.MUSIC_U) {
    out.cookies = [{ url: MUSIC_ORIGIN, headers: finalizeCookieHeaders(cookieMap) }];
  }
  return out;
}

export async function signOut() {
  try {
    await eapiRequest("/api/logout", {}, { allowCodes: [200, 301] });
  } catch (_) {}
  return {};
}
