// Official QR-code sign-in, session restoration, and sign-out.

import {
  APP_VER,
  MUSIC_ORIGIN,
  avatarCover,
  collectSetCookies,
  eapiRequest,
  extractCookieValue,
  positiveID,
  text,
  weapiRequest,
} from "./api.js";
import { t } from "./i18n.js";

function buildAccount(profile, accountInfo, fallback) {
  const copy = t();
  const fb = fallback || {};
  const uid = positiveID(profile?.userId ?? accountInfo?.id ?? fb.uid);
  const name = text(profile?.nickname || accountInfo?.userName || fb.name) || copy.sourceName;
  const avatarURL = avatarCover(profile?.avatarUrl || fb.avatarURL, 256);
  const vipType = Number(profile?.vipType ?? accountInfo?.vipType ?? 0);
  const isVIP = vipType > 0;

  const account = {
    id: uid || "cloud-music-user",
    name,
    badge: { text: isVIP ? copy.vipBadge : copy.normalBadge, icon: isVIP ? "sparkles" : "user" },
    card: {
      title: copy.sourceName,
      description: copy.sourceDesc,
      icon: isVIP ? "sparkles" : "play",
      status: isVIP ? copy.vipBadge : copy.connected,
      highlight: isVIP,
      benefits: [
        copy.benefitPlaylists,
        copy.benefitLossless,
        copy.benefitLyrics,
        copy.benefitBackground,
      ],
    },
  };
  if (avatarURL) account.avatarURL = avatarURL;
  return account;
}

async function fetchUserAccount(cookieMap, csrf = "") {
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
        { withResponse: true, allowCodes: [200] }
      ),
    () =>
      eapiRequest(
        "/api/nuser/account/get",
        {},
        { withResponse: true, allowCodes: [200] }
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
  const finalHeaders = Object.keys(cookieMap).map((k) => cookieMap[k]);
  if (!cookieMap.os) {
    finalHeaders.push("os=pc; Domain=.music.163.com; Path=/; Secure");
  }
  if (!cookieMap.appver) {
    finalHeaders.push(`appver=${APP_VER}; Domain=.music.163.com; Path=/; Secure`);
  }
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
  let profile = null;
  let accountInfo = null;
  try {
    const res = await fetchUserAccount(cookieMap, csrf);
    profile = res.profile;
    accountInfo = res.accountInfo;
  } catch (err) {
    // If MUSIC_U was already granted on 803, allow sign-in to complete with
    // fallback identity rather than discarding a valid session on a transient check.
    if (!cookieMap.MUSIC_U) {
      throw err;
    }
  }
  const finalHeaders = finalizeCookieHeaders(cookieMap);
  const fallback = cookieMap.MUSIC_U
    ? { uid: host.crypto.md5(extractCookieValue(cookieMap, "MUSIC_U")).slice(0, 12) }
    : null;
  const account = buildAccount(profile, accountInfo, fallback);
  return {
    status: "approved",
    account,
    secret: {
      uid: account.id,
      name: account.name,
      avatarURL: account.avatarURL || "",
      csrf: extractCookieValue(cookieMap, "__csrf") || csrf,
    },
    cookies: [{ url: MUSIC_ORIGIN, headers: finalHeaders }],
  };
}

export async function restoreAccount(secret) {
  const cookieMap = {};
  const { profile, accountInfo } = await fetchUserAccount(cookieMap, text(secret?.csrf));
  const account = buildAccount(profile, accountInfo, secret);
  const csrf = extractCookieValue(cookieMap, "__csrf") || text(secret?.csrf);
  const out = {
    account,
    secret: {
      uid: account.id,
      name: account.name,
      avatarURL: account.avatarURL || "",
      csrf,
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
