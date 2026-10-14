/**
 * Thanawica adapter — chemistry + math catalog & stream decrypt
 * Keeps Coursatk paths intact; only used when subject is chem/math.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://thanawica.com";
const UA =
  "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/153.0.0.0 Mobile Safari/537.36";

const LOGIN_ACTION = "40c2de9a49b9eba30762cac2299b44fa8c06d885db";

/** ملف بسيط جنب السيرفر: thanawica_code.txt — سطر واحد فيه الكود */
function loadCodeFromFile() {
  const candidates = [
    path.join(__dirname, "thanawica_code.txt"),
    path.join(process.cwd(), "thanawica_code.txt"),
    path.join(__dirname, "data", "thanawica_code.txt")
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const raw = fs.readFileSync(f, "utf8").trim();
      // أول سطر أرقام فقط (تجاهل التعليقات)
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.startsWith("//")) continue;
        const digits = t.replace(/\D/g, "");
        if (digits.length >= 7) return digits;
      }
    } catch {}
  }
  return "";
}

function resolveThanawicaCode(explicit) {
  const fromArg = String(explicit || "").replace(/\D/g, "");
  if (fromArg.length >= 7) return fromArg;
  const fromEnv = String(process.env.THANAWICA_CODE || "").replace(/\D/g, "");
  if (fromEnv.length >= 7) return fromEnv;
  return loadCodeFromFile();
}


/** Year on Thanawica → subject ids for chem + math (scientific tracks) */
const YEAR_SUBJECTS = {
  // year key on thanawica URL /years/27 or /years/26
  27: { chemistry: 154, math: 160, physics: 156, arabic: 150, english: 152 },
  26: { chemistry: 111, math: 128, physics: 114, arabic: 101, english: 104 }
};

const NAME_CHEM = /كيمياء|chemistry/i;
const NAME_MATH = /رياض|math|جبر|تفاضل|إحصاء|استاتيكا|ديناميكا/i;

let session = {
  cookies: "",
  code: "",
  exp: 0
};

// ─── HTTP helpers ───────────────────────────────────────────
function parseSetCookies(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const list = raw.length ? raw : [];
  // fallback: single set-cookie
  if (!list.length) {
    const one = res.headers.get("set-cookie");
    if (one) list.push(one);
  }
  const map = new Map();
  // merge with existing
  for (const part of (session.cookies || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const line of list) {
    const pair = String(line).split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function thFetch(urlPath, { method = "GET", body, headers = {}, action } = {}) {
  const url = urlPath.startsWith("http") ? urlPath : BASE + urlPath;
  const h = {
    "User-Agent": UA,
    "Accept-Language": "ar-EG,ar;q=0.9,en;q=0.8",
    ...(session.cookies ? { Cookie: session.cookies } : {}),
    ...headers
  };
  if (action) {
    h["next-action"] = action;
    h["Content-Type"] = "text/plain;charset=UTF-8";
    h["Accept"] = "text/x-component";
    h["Origin"] = BASE;
  }
  const res = await fetch(url, {
    method,
    headers: h,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(25_000)
  });
  const sc = parseSetCookies(res);
  if (sc) session.cookies = sc;
  return res;
}

/** Extract Set-Cookie (Node 18+ getSetCookie; fallback single header) */
function collectSetCookies(res) {
  try {
    if (typeof res.headers.getSetCookie === "function") {
      const list = res.headers.getSetCookie();
      if (Array.isArray(list) && list.length) return list.map(String);
    }
  } catch (_) {}
  try {
    const one = res.headers.get("set-cookie");
    if (one) return [String(one)];
  } catch (_) {}
  return [];
}

function mergeCookiesFromSetCookie(setCookieLines, existing = "") {
  const map = new Map();
  for (const part of (existing || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const line of setCookieLines || []) {
    const pair = String(line).split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function thanawicaLogin(code) {
  const codeStr = resolveThanawicaCode(code);
  if (process.env.THANAWICA_COOKIES) {
    session.cookies = process.env.THANAWICA_COOKIES;
    session.code = codeStr || session.code || "env";
    session.exp = Date.now() + 6 * 3600_000;
    console.log("[thanawica] using THANAWICA_COOKIES from env");
    return session;
  }
  if (codeStr.length < 7) {
    throw new Error("حط كود ثناويكا في ملف thanawica_code.txt (جنب server.js)");
  }
  if (session.code === codeStr && session.cookies.includes("student_session=") && Date.now() < session.exp) {
    return session;
  }

  // Pure Node fetch — no curl (Railway/minimal images often lack curl → ENOENT)
  const loginHeaders = {
    "User-Agent": UA,
    "Content-Type": "text/plain;charset=UTF-8",
    Accept: "text/x-component",
    Origin: BASE,
    Referer: `${BASE}/login`,
    "next-action": LOGIN_ACTION
  };

  let res;
  try {
    res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: loginHeaders,
      body: JSON.stringify([codeStr]),
      redirect: "manual",
      signal: AbortSignal.timeout(25_000)
    });
  } catch (e) {
    throw new Error("فشل الاتصال بثناويكا: " + (e.message || e));
  }

  session.cookies = mergeCookiesFromSetCookie(collectSetCookies(res), session.cookies);

  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {}

  // Retry once with any bootstrap cookies (some Next deployments need a prior cookie)
  if (!session.cookies.includes("student_session=")) {
    try {
      const res2 = await fetch(`${BASE}/login`, {
        method: "POST",
        headers: {
          ...loginHeaders,
          ...(session.cookies ? { Cookie: session.cookies } : {})
        },
        body: JSON.stringify([codeStr]),
        redirect: "manual",
        signal: AbortSignal.timeout(25_000)
      });
      session.cookies = mergeCookiesFromSetCookie(collectSetCookies(res2), session.cookies);
      try {
        bodyText = await res2.text();
      } catch {}
    } catch {}
  }

  if (!session.cookies.includes("student_session=")) {
    let msg = "فشل تسجيل الدخول على ثناويكا";
    const m = bodyText && bodyText.match(/"message":"([^"]+)"/);
    if (m) msg = m[1];
    else if (bodyText && /invalid|wrong|غير|خاطئ|منتهي/i.test(bodyText)) {
      msg = "كود ثناويكا غير صالح أو منتهي";
    }
    throw new Error(msg);
  }

  session.code = codeStr;
  session.exp = Date.now() + 6 * 3600_000;
  console.log("[thanawica] logged in as", codeStr);
  return session;
}

async function ensureLogin(code) {
  return thanawicaLogin(code || session.code || resolveThanawicaCode());
}

function extractFlight(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,(.*?)\]\)/gs;
  let m;
  while ((m = re.exec(html))) {
    let s = m[1].trim();
    if (s.startsWith('"')) {
      try {
        s = JSON.parse(s);
      } catch {
        continue;
      }
    }
    parts.push(s);
  }
  return parts.join("\n");
}

function mapYearKey(yearId) {
  // Coursatk yearId 4/5 → 2027 → thanawica /years/27
  // Coursatk yearId 3 → 2026 → /years/26
  const n = Number(yearId);
  if (n === 3 || n === 26 || n === 2026) return 26;
  return 27;
}

export function isChemOrMathName(name) {
  const s = String(name || "");
  return NAME_CHEM.test(s) || NAME_MATH.test(s);
}

export function chemMathKind(name) {
  const s = String(name || "");
  if (NAME_CHEM.test(s)) return "chemistry";
  if (NAME_MATH.test(s)) return "math";
  return null;
}

/** Encode Thanawica numeric id so it never collides with Coursatk ids */
export function encodeThId(n) {
  return Number(n) + 9_000_000;
}
export function decodeThId(id) {
  const n = Number(id);
  if (n >= 9_000_000 && n < 10_000_000) return n - 9_000_000;
  return null;
}
export function isThId(id) {
  return decodeThId(id) != null;
}

const cache = new Map();
function cget(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) {
    cache.delete(k);
    return null;
  }
  return e.v;
}
function cset(k, v, ms = 120_000) {
  cache.set(k, { v, exp: Date.now() + ms });
}

async function getHtml(urlPath) {
  await ensureLogin();
  const res = await thFetch(urlPath, { headers: { Accept: "text/html", Referer: BASE + "/" } });
  if (res.status >= 400) throw new Error(`Thanawica HTTP ${res.status} ${urlPath}`);
  return await res.text();
}

/** Subjects for chem+math only (for a given year) */
export async function thSubjectsForYear(yearId) {
  const yk = mapYearKey(yearId);
  const ck = `subj:${yk}`;
  const hit = cget(ck);
  if (hit) return hit;
  const html = await getHtml(`/years/${yk}`);
  const flight = extractFlight(html);
  const out = [];
  // article","154" ... alt":"كيمياء"
  const re = /article","(\d+)"[\s\S]{0,1500}?alt":"([^"]+)"/g;
  let m;
  while ((m = re.exec(flight))) {
    const id = Number(m[1]);
    const name = m[2];
    const kind = chemMathKind(name);
    if (!kind) continue;
    out.push({
      id: encodeThId(id),
      name,
      image_url: null,
      year_id: yearId,
      is_published: true,
      _source: "thanawica",
      _kind: kind,
      _thId: id
    });
  }
  // fallback fixed map
  if (!out.length) {
    const map = YEAR_SUBJECTS[yk] || YEAR_SUBJECTS[27];
    out.push(
      {
        id: encodeThId(map.chemistry),
        name: "كيمياء",
        year_id: yearId,
        is_published: true,
        _source: "thanawica",
        _kind: "chemistry",
        _thId: map.chemistry
      },
      {
        id: encodeThId(map.math),
        name: "الرياضيات",
        year_id: yearId,
        is_published: true,
        _source: "thanawica",
        _kind: "math",
        _thId: map.math
      }
    );
  }
  cset(ck, out, 5 * 60_000);
  return out;
}

export async function thTeachers(subjectId) {
  const th = decodeThId(subjectId);
  if (th == null) throw new Error("not thanawica subject");
  const ck = `teachers:${th}`;
  const hit = cget(ck);
  if (hit) return hit;
  const html = await getHtml(`/subjects/${th}`);
  const flight = extractFlight(html) + "\n" + html;
  const teachers = [];
  const seen = new Set();

  // Prefer real teacher ids (skip noise like 1,4 and huge junk)
  let ids = [...flight.matchAll(/href":"\/teachers\/(\d+)"/g)].map((m) => Number(m[1]));
  if (!ids.length) ids = [...html.matchAll(/href="\/teachers\/(\d+)"/g)].map((m) => Number(m[1]));
  ids = ids.filter((id) => id >= 10 && id < 1_000_000);
  ids = [...new Set(ids)];

  // Map id -> name from alt / children near teacher links
  const nameById = new Map();
  for (const m of flight.matchAll(/\/teachers\/(\d+)[\s\S]{0,600}?alt":"([^"]{2,80})"/g)) {
    const id = Number(m[1]);
    if (id >= 10) nameById.set(id, m[2]);
  }
  for (const m of flight.matchAll(/alt":"([^"]{2,80})"[\s\S]{0,400}?\/teachers\/(\d+)/g)) {
    const id = Number(m[2]);
    if (id >= 10 && !nameById.has(id)) nameById.set(id, m[1]);
  }
  // Fallback ordered names (أ. ...)
  const orderedNames = [];
  for (const m of flight.matchAll(/(?:alt|children)":"(أ\.\s?[^"]{2,60})"/g)) {
    orderedNames.push(m[1]);
  }

  let nameIdx = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    let name = nameById.get(id) || orderedNames[nameIdx] || `مدرس ${id}`;
    if (!nameById.has(id) && orderedNames[nameIdx]) nameIdx++;
    teachers.push({
      id: encodeThId(id),
      name,
      image_url: null,
      subject_id: encodeThId(th),
      _source: "thanawica",
      _thId: id
    });
  }
  cset(ck, teachers, 5 * 60_000);
  return teachers;
}

export async function thChapters(teacherId) {
  const th = decodeThId(teacherId);
  if (th == null) throw new Error("not thanawica teacher");
  const ck = `chapters:${th}`;
  const hit = cget(ck);
  if (hit) return hit;
  const html = await getHtml(`/teachers/${th}`);
  const flight = extractFlight(html) + "\n" + html;
  const chapters = [];
  const seen = new Set();
  for (const m of flight.matchAll(/\/chapters\/(\d+)/g)) {
    const id = Number(m[1]);
    if (id < 10 || seen.has(id)) continue;
    seen.add(id);
    chapters.push({
      id: encodeThId(id),
      name: `وحدة ${id}`,
      teacher_id: encodeThId(th),
      _source: "thanawica",
      _thId: id
    });
  }
  const junk = /مشاهدة|رجوع|اختر|عدد|جار|\$L|المحاضرات|المدرسين/;
  const titles = new Map();
  for (const m of flight.matchAll(/\/chapters\/(\d+)[\s\S]{0,800}?children":"([^"]{2,100})"/g)) {
    const id = Number(m[1]);
    const title = m[2].trim();
    if (!junk.test(title) && title.length >= 2) titles.set(id, title);
  }
  for (const m of flight.matchAll(/article","(\d+)"[\s\S]{0,800}?children":"([^"]{2,100})"/g)) {
    const id = Number(m[1]);
    const title = m[2].trim();
    if (titles.has(id) || junk.test(title)) continue;
    if (seen.has(id) && title.length >= 2) titles.set(id, title);
  }
  for (const ch of chapters) {
    if (titles.has(ch._thId)) ch.name = titles.get(ch._thId);
  }
  cset(ck, chapters, 5 * 60_000);
  return chapters;
}

export async function thLectures(chapterId) {
  const th = decodeThId(chapterId);
  if (th == null) throw new Error("not thanawica chapter");
  const ck = `lectures:${th}`;
  const hit = cget(ck);
  if (hit) return hit;
  const html = await getHtml(`/chapters/${th}`);
  const flight = extractFlight(html) + "\n" + html;
  const lectures = [];
  const seen = new Set();
  for (const m of flight.matchAll(/\/lectures\/(\d+)/g)) {
    const id = Number(m[1]);
    if (id < 10 || seen.has(id)) continue;
    seen.add(id);
    lectures.push({
      id: encodeThId(id),
      name: `محاضرة ${id}`,
      chapter_id: encodeThId(th),
      _source: "thanawica",
      _thId: id
    });
  }
  const junk = /مشاهدة|رجوع|اختر|عدد|جار|\$L/;
  for (const m of flight.matchAll(/\/lectures\/(\d+)[\s\S]{0,700}?children":"([^"]{3,120})"/g)) {
    const id = Number(m[1]);
    const title = m[2].trim();
    if (junk.test(title)) continue;
    const lec = lectures.find((l) => l._thId === id);
    if (lec) lec.name = title;
  }
  cset(ck, lectures, 3 * 60_000);
  return lectures;
}

/** Resolve playlist hash for a Thanawica video page id */
export async function thResolvePlaylistHash(lectureId, videoPageId) {
  const lec = Number(lectureId);
  const vid = String(videoPageId);
  const ck = `phash:${lec}:${vid}`;
  const hit = cget(ck);
  if (hit) return hit;
  await ensureLogin();
  const vhtml = await getHtml(`/lectures/${lec}/videos/${vid}`);
  const vf = extractFlight(vhtml) + "\n" + vhtml;
  const pm = vf.match(/\/api\/stream\/playlist\/([a-f0-9]{16,})/i);
  if (!pm) throw new Error("مفيش playlist للفيديو ده على ثناويكا");
  cset(ck, pm[1], 10 * 60_000);
  return pm[1];
}

export async function thLectureContent(lectureId) {
  const th = decodeThId(lectureId);
  if (th == null) throw new Error("not thanawica lecture");
  const html = await getHtml(`/lectures/${th}`);
  const flight = extractFlight(html) + "\n" + html;

  // lecture title
  let lecName = `محاضرة ${th}`;
  const junk = /مشاهدة|رجوع|اختر|عدد|جار|\$L|تسجيل/;
  for (const m of flight.matchAll(/children":"([^"]{5,120})"/g)) {
    const t = m[1].trim();
    if (!junk.test(t) && /[\u0600-\u06FF]/.test(t) && t.length > 4) {
      lecName = t;
      break;
    }
  }

  const videos = [];
  const seen = new Set();
  for (const m of flight.matchAll(/\/lectures\/\d+\/videos\/(\d+)/g)) {
    const vid = m[1];
    if (seen.has(vid)) continue;
    seen.add(vid);
    videos.push({
      id: `thv_${vid}`,
      name: `فيديو ${vid}`,
      type: "video",
      _source: "thanawica",
      _videoPageId: vid,
      _lectureId: th
    });
  }

  // hashes already on lecture page (usually only first / shared)
  const pageHashes = [...flight.matchAll(/\/api\/stream\/playlist\/([a-f0-9]{16,})/gi)].map((m) => m[1]);
  if (pageHashes.length && videos.length === 1) {
    videos[0]._playlistHash = pageHashes[0];
  } else if (pageHashes.length && videos.length && !videos[0]._playlistHash) {
    videos[0]._playlistHash = pageHashes[0];
  }

  // Resolve missing hashes for every video (critical for play)
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (v._playlistHash) continue;
    try {
      v._playlistHash = await thResolvePlaylistHash(th, v._videoPageId);
    } catch (e) {
      console.warn("[thanawica] hash resolve", v._videoPageId, e.message);
    }
  }

  // Prefer playable id = thp_<hash> so /api/play works without extra resolve
  for (const v of videos) {
    if (v._playlistHash) {
      v.id = `thp_${v._playlistHash}`;
      v.name = v.name && !/^فيديو \d+$/.test(v.name) ? v.name : `فيديو`;
    }
  }

  // If no video links but a bare playlist hash exists
  if (!videos.length && pageHashes.length) {
    videos.push({
      id: `thp_${pageHashes[0]}`,
      name: "فيديو",
      type: "video",
      _source: "thanawica",
      _playlistHash: pageHashes[0],
      _lectureId: th
    });
  }

  return {
    success: true,
    data: {
      id: encodeThId(th),
      name: lecName,
      videos,
      files: [],
      _source: "thanawica"
    }
  };
}

// ─── Stream: playlist + WASM decrypt ─────────────────────────
let wasmApi = null;

async function loadWasm() {
  if (wasmApi) return wasmApi;
  const wasmPath = [
    path.join(__dirname, "thanawica_decrypt.wasm"),
    path.join(__dirname, "decrypt.wasm"),
    path.join(process.cwd(), "thanawica_decrypt.wasm")
  ].find((p) => fs.existsSync(p));
  if (!wasmPath) throw new Error("thanawica_decrypt.wasm missing");
  const bytes = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  let cachedU8 = null;
  let cachedDV = null;
  let VEC_LEN = 0;
  const memU8 = () => {
    if (!cachedU8 || cachedU8.buffer !== wasm.memory.buffer) cachedU8 = new Uint8Array(wasm.memory.buffer);
    return cachedU8;
  };
  const memDV = () => {
    if (!cachedDV || cachedDV.buffer !== wasm.memory.buffer) cachedDV = new DataView(wasm.memory.buffer);
    return cachedDV;
  };
  const pass = (arr) => {
    const ptr = wasm.__wbindgen_export(arr.length, 1) >>> 0;
    memU8().set(arr, ptr);
    VEC_LEN = arr.length;
    return ptr;
  };
  wasmApi = {
    storeKey(slot, mapKey, sessionKey) {
      const p0 = pass(mapKey);
      const l0 = VEC_LEN;
      const p1 = pass(sessionKey);
      const l1 = VEC_LEN;
      return wasm.r(slot, p0, l0, p1, l1) >>> 0;
    },
    decrypt(slot, cipher, iv) {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      try {
        const p0 = pass(cipher);
        const l0 = VEC_LEN;
        const p1 = pass(iv);
        const l1 = VEC_LEN;
        wasm.d(retptr, slot, p0, l0, p1, l1);
        const r0 = memDV().getInt32(retptr, true);
        const r1 = memDV().getInt32(retptr + 4, true);
        const out = memU8().subarray(r0, r0 + r1).slice();
        try {
          wasm.__wbindgen_export2(r0, r1, 1);
        } catch {}
        return out;
      } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
      }
    }
  };
  return wasmApi;
}

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function stripPkcs7(buf) {
  if (!buf.length) return buf;
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 16 || pad > buf.length) return buf;
  for (let i = buf.length - pad; i < buf.length; i++) if (buf[i] !== pad) return buf;
  return buf.subarray(0, buf.length - pad);
}

function fixTS(buf) {
  buf = stripPkcs7(buf);
  if (buf.length >= 376 && buf[0] === 0x47 && buf[188] === 0x47) return Buffer.from(buf);
  const limit = Math.min(buf.length - 376, 4512);
  for (let r = 1; r <= limit; r++) {
    if (buf[r] === 0x47 && buf[r + 188] === 0x47) {
      const i = r + 376;
      if (!(i < buf.length) || buf[i] === 0x47) return Buffer.from(buf.subarray(r));
    }
  }
  return Buffer.from(buf);
}

/**
 * Build decrypted HLS source for a Thanawica playlist hash.
 * Returns { mode, videoId, playlist, plainKey: null, segs, thMeta }
 * Playlist uses SID_TOKEN placeholders for segment URLs via our proxy.
 */
export async function thGetVideoSource(playlistHash, { sidToken = "__SID__" } = {}) {
  await ensureLogin();
  const api = await loadWasm();

  // master
  const masterRes = await thFetch(`/api/stream/playlist/${playlistHash}`, {
    headers: { Accept: "*/*", Referer: BASE + "/" }
  });
  if (!masterRes.ok) throw new Error(`playlist master HTTP ${masterRes.status}`);
  const masterText = await masterRes.text();
  // pick first variant
  const varMatch = masterText.match(/\/api\/stream\/playlist\/[a-f0-9]+\/(\w+)/);
  const quality = varMatch ? varMatch[1] : "480";
  const mediaRes = await thFetch(`/api/stream/playlist/${playlistHash}/${quality}`, {
    headers: { Accept: "*/*", Referer: BASE + "/" }
  });
  if (!mediaRes.ok) throw new Error(`playlist media HTTP ${mediaRes.status}`);
  const xkm = mediaRes.headers.get("x-km");
  const xks = mediaRes.headers.get("x-ks");
  const xkv = mediaRes.headers.get("x-kv");
  if (!xkm || !xks) throw new Error("Thanawica playlist missing x-km/x-ks");
  const km = JSON.parse(Buffer.from(xkm, "base64").toString("utf8"));
  const sessionKey = hexToBytes(xks);
  // use first key entry
  const keyName = Object.keys(km)[0];
  const mapKey = hexToBytes(km[keyName]);
  api.storeKey(0, mapKey, sessionKey);

  const mediaText = await mediaRes.text();
  const lines = mediaText.split(/\r?\n/);
  const outLines = [];
  const segs = [];
  let curIv = null;
  let seq = 0;
  const mediaSeqLine = lines.find((l) => l.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  if (mediaSeqLine) seq = parseInt(mediaSeqLine.split(":")[1], 10) || 0;
  let mediaSeq = seq;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("#EXT-X-KEY:")) {
      const ivm = t.match(/IV=0x([0-9A-Fa-f]+)/i);
      curIv = ivm ? ivm[1] : null;
      // strip key line — we decrypt server-side
      continue;
    }
    if (t && !t.startsWith("#")) {
      const iv = curIv || null;
      const meta = {
        u: t.startsWith("http") ? t : BASE + t.split("?")[0],
        iv,
        s: seq,
        q: quality,
        h: playlistHash,
        v: xkv
      };
      segs.push(meta);
      const enc = Buffer.from(JSON.stringify(meta)).toString("base64url");
      outLines.push(`/api/stream/segment/${sidToken}/${enc}`);
      seq++;
      continue;
    }
    outLines.push(line);
  }

  return {
    mode: "thanawica",
    videoId: playlistHash,
    playlist: outLines.join("\n"),
    plainKey: Buffer.from("thanawica"), // marker — real key inside wasm slot 0
    defaultIv: null,
    segs,
    mediaSeq,
    thMeta: { playlistHash, quality, xkv, keyName },
    _thWasmSlot: 0,
    _thDecrypt: async (cipherBuf, ivHex) => {
      const padded = new Uint8Array(210 + cipherBuf.length);
      padded.set(cipherBuf instanceof Uint8Array ? cipherBuf : new Uint8Array(cipherBuf), 210);
      const iv = hexToBytes(ivHex || "0".repeat(32));
      const plain = api.decrypt(0, padded, iv);
      return fixTS(plain);
    }
  };
}

export async function thMintAndFetchSegment(meta) {
  await ensureLogin();
  // path like /api/c/{hash}/{quality}/seg_N.dat
  const u = new URL(meta.u, BASE);
  const parts = u.pathname.split("/");
  // /api/c/HASH/QUALITY/seg_X.dat
  const segName = parts[parts.length - 1];
  const hash = parts[3];
  const mintRes = await thFetch("/api/stream/mint", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: BASE,
      Referer: BASE + "/"
    },
    body: JSON.stringify({ videoId: hash, segName })
  });
  if (!mintRes.ok) throw new Error(`mint HTTP ${mintRes.status}`);
  const mint = await mintRes.json();
  u.searchParams.set("v", meta.v || "");
  u.searchParams.set("iat", String(mint.iat));
  u.searchParams.set("tok", mint.tok);
  const segRes = await thFetch(u.toString(), {
    headers: { Accept: "*/*", Referer: BASE + "/" }
  });
  if (!segRes.ok) throw new Error(`segment HTTP ${segRes.status}`);
  return Buffer.from(await segRes.arrayBuffer());
}

export function getThanawicaSessionInfo() {
  return { code: session.code, hasCookie: !!session.cookies, exp: session.exp };
}
