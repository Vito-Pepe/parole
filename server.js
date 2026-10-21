'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMG_DIR = path.join(DATA_DIR, 'images');
const WORDS_FILE = path.join(DATA_DIR, 'words.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret');

const DEFAULT_PIN = '7777';
const MODES = ['type', 'order', 'distractors'];
const LETTERS = /^[a-zàèéìòù]+$/;
const IMG_NAME = /^[a-f0-9]{16}\.(jpg|png|webp)$/;
const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_WORDS = 500;

fs.mkdirSync(IMG_DIR, { recursive: true });

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── Segreto per firmare le sessioni ──
let secret;
try {
  secret = fs.readFileSync(SECRET_FILE);
} catch {
  secret = crypto.randomBytes(32);
  writeAtomic(SECRET_FILE, secret);
}

// ── Codice di accesso ──
function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

function newPinRecord(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPin(pin, salt) };
}

function pinMatches(pin) {
  const given = Buffer.from(hashPin(String(pin), settings.pin.salt), 'hex');
  const stored = Buffer.from(settings.pin.hash, 'hex');
  return crypto.timingSafeEqual(given, stored);
}

let settings = readJson(SETTINGS_FILE, null);
if (!settings || !settings.pin || !MODES.includes(settings.mode)) {
  settings = { mode: 'type', pin: newPinRecord(DEFAULT_PIN) };
  writeAtomic(SETTINGS_FILE, JSON.stringify(settings));
}

function saveSettings() {
  writeAtomic(SETTINGS_FILE, JSON.stringify(settings));
}

// ── Parole ──
const SEED_WORDS = [
  { text: 'casa', emoji: '🏠', distractors: 'ot' },
  { text: 'sole', emoji: '☀️', distractors: 'ai' },
  { text: 'luna', emoji: '🌙', distractors: 'er' },
  { text: 'gatto', emoji: '🐱', distractors: 'ci' },
  { text: 'cane', emoji: '🐶', distractors: 'lo' },
  { text: 'pane', emoji: '🍞', distractors: 'mi' },
];

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function cleanWord(w) {
  if (!w || typeof w !== 'object') throw httpError(400, 'Parola non valida');
  const text = String(w.text || '').trim().toLowerCase();
  if (!LETTERS.test(text) || text.length > 20) {
    throw httpError(400, `"${text}" non è valida: usa solo lettere, massimo 20`);
  }
  const distractors = String(w.distractors || '')
    .toLowerCase()
    .replace(/[^a-zàèéìòù]/g, '')
    .slice(0, 12);
  const emoji = Array.from(String(w.emoji || '').trim()).slice(0, 8).join('');
  const imageId = IMG_NAME.test(String(w.imageId || '')) ? String(w.imageId) : '';
  if (!emoji && !imageId) throw httpError(400, `"${text}": serve una foto o un'emoji`);
  const id = /^[a-f0-9]{16}$/.test(String(w.id || '')) ? String(w.id) : newId();
  return { id, text, emoji, imageId, distractors };
}

function loadWords() {
  const stored = readJson(WORDS_FILE, null);
  if (Array.isArray(stored)) return stored;
  const seeded = SEED_WORDS.map(cleanWord);
  writeAtomic(WORDS_FILE, JSON.stringify(seeded));
  return seeded;
}

let words = loadWords();

function removeOrphanImages() {
  const used = new Set(words.map((w) => w.imageId).filter(Boolean));
  const tooRecent = Date.now() - 10 * 60 * 1000;
  for (const name of fs.readdirSync(IMG_DIR)) {
    if (used.has(name) || !IMG_NAME.test(name)) continue;
    const file = path.join(IMG_DIR, name);
    if (fs.statSync(file).mtimeMs < tooRecent) fs.unlinkSync(file);
  }
}

// ── Sessioni ──
function sign(value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req.headers.cookie).s;
  if (!token) return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(exp), 'hex');
  const given = Buffer.from(mac, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function cookieHeader(req, value, clear) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const age = clear ? '; Max-Age=0' : '';
  return `s=${value}; Path=/; HttpOnly; SameSite=Strict${secure}${age}`;
}

// Blocco dopo troppi tentativi sbagliati (globale: dietro il proxy l'IP non è affidabile)
let failures = 0;
let lockedUntil = 0;

// ── Utilità HTTP ──
function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'Richiesta troppo grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit = 1024 * 1024) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw httpError(415, 'Serve application/json');
  }
  try {
    return JSON.parse((await readBody(req, limit)).toString('utf8'));
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, 'JSON non valido');
  }
}

function imageExt(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

// ── API ──
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/login') {
    if (Date.now() < lockedUntil) {
      throw httpError(429, 'Troppi tentativi, riprova tra un minuto');
    }
    const body = await readJsonBody(req, 1024);
    if (typeof body.pin === 'string' && body.pin.length <= 32 && pinMatches(body.pin)) {
      failures = 0;
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, makeToken()) });
    }
    failures += 1;
    if (failures >= 5) {
      failures = 0;
      lockedUntil = Date.now() + 60 * 1000;
    }
    throw httpError(401, 'Codice errato');
  }

  if (route === 'POST /api/logout') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', true) });
  }

  if (route === 'GET /api/session') {
    return sendJson(res, 200, { auth: isAuthed(req) });
  }

  if (!isAuthed(req)) throw httpError(401, 'Accesso richiesto');

  if (route === 'GET /api/state') {
    return sendJson(res, 200, { words, mode: settings.mode });
  }

  if (route === 'PUT /api/words') {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.words) || body.words.length > MAX_WORDS) {
      throw httpError(400, 'Elenco parole non valido');
    }
    words = body.words.map(cleanWord);
    writeAtomic(WORDS_FILE, JSON.stringify(words));
    removeOrphanImages();
    return sendJson(res, 200, { words });
  }

  if (route === 'PUT /api/settings') {
    const body = await readJsonBody(req, 1024);
    if (!MODES.includes(body.mode)) throw httpError(400, 'Esercizio non valido');
    settings.mode = body.mode;
    saveSettings();
    return sendJson(res, 200, { mode: settings.mode });
  }

  if (route === 'POST /api/pin') {
    const body = await readJsonBody(req, 1024);
    if (typeof body.oldPin !== 'string' || !pinMatches(body.oldPin)) {
      throw httpError(403, 'Il codice attuale non è corretto');
    }
    if (typeof body.newPin !== 'string' || !/^[0-9]{4,8}$/.test(body.newPin)) {
      throw httpError(400, 'Il nuovo codice deve avere da 4 a 8 cifre');
    }
    settings.pin = newPinRecord(body.newPin);
    saveSettings();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/images') {
    const buf = await readBody(req, 4 * 1024 * 1024);
    const ext = imageExt(buf);
    if (!ext) throw httpError(400, 'Formato immagine non supportato');
    const imageId = `${newId()}.${ext}`;
    writeAtomic(path.join(IMG_DIR, imageId), buf);
    return sendJson(res, 201, { imageId });
  }

  throw httpError(404, 'Non trovato');
}

const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function handleImage(req, res, url) {
  if (!isAuthed(req)) throw httpError(401, 'Accesso richiesto');
  const name = decodeURIComponent(url.pathname.slice('/img/'.length));
  if (!IMG_NAME.test(name)) throw httpError(404, 'Non trovato');
  let data;
  try {
    data = fs.readFileSync(path.join(IMG_DIR, name));
  } catch {
    throw httpError(404, 'Non trovato');
  }
  res.writeHead(200, {
    'Content-Type': IMG_TYPES[name.split('.')[1]],
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

// ── File statici ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Metodo non consentito');
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'Non trovato');
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw httpError(404, 'Non trovato');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; frame-ancestors 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/img/')) return handleImage(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (!e.status) console.error(e);
    if (res.headersSent) return res.end();
    return sendJson(res, status, { error: e.status ? e.message : 'Errore interno' });
  }
});

server.listen(PORT, () => console.log(`Parole in ascolto sulla porta ${PORT}`));
