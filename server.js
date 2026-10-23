'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Porta privata: app completa (codice, gestione parole ed esercizi). Solo LAN e tailnet.
const PORT = Number(process.env.PORT) || 3000;
// Porta pubblica: solo gli esercizi condivisi via link. Pensata per tailscale funnel.
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT) || 3001;
// Indirizzo con cui i pazienti raggiungono la porta pubblica, per comporre i link.
const PUBLIC_URL = /^https?:\/\/[^\s/?#]+$/.test(String(process.env.PUBLIC_URL || '').replace(/\/+$/, ''))
  ? String(process.env.PUBLIC_URL).replace(/\/+$/, '')
  : '';
// Interruttore temporaneo: con DISABLE_LOGIN=1 l'app privata non chiede il codice.
// Non tocca la porta pubblica, che non ha mai login.
const LOGIN_DISABLED = process.env.DISABLE_LOGIN === '1';

const DATA_DIR = process.env.DATA_DIR || '/data';
const APP_DIR = path.join(__dirname, 'app');
const PLAYER_DIR = path.join(__dirname, 'player');
const IMG_DIR = path.join(DATA_DIR, 'images');
const WORDS_FILE = path.join(DATA_DIR, 'words.json');
const EXERCISES_FILE = path.join(DATA_DIR, 'exercises.json');
// File separato: la versione senza gruppi lo ignora, quindi si può tornare indietro.
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret');

const DEFAULT_PIN = '7777';
const MODES = ['type', 'order', 'distractors'];
const LETTERS = /^[a-zàèéìòù]+$/;
const IMG_NAME = /^[a-f0-9]{16}\.(jpg|png|webp)$/;
const WORD_ID = /^[a-f0-9]{16}$/;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const SESSION_MS = 24 * 60 * 60 * 1000;
const MAX_WORDS = 500;
const MAX_EXERCISES = 300;
const MAX_GROUPS = 300;
const MAX_GROUP_ITEMS = 20;
const MAX_IMAGES = 1000;

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

function newToken() {
  return crypto.randomBytes(16).toString('base64url');
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
  const id = WORD_ID.test(String(w.id || '')) ? String(w.id) : newId();
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

// ── Esercizi condivisi ──
let exercises = readJson(EXERCISES_FILE, []);
if (!Array.isArray(exercises)) exercises = [];
// Id interno stabile per i gruppi (il token cambia con "Nuovo link"). Gli esercizi creati
// prima dei gruppi, o da una versione senza gruppi, lo ricevono qui.
if (exercises.some((ex) => !WORD_ID.test(String(ex.id || '')))) {
  exercises.forEach((ex) => {
    if (!WORD_ID.test(String(ex.id || ''))) ex.id = newId();
  });
  writeAtomic(EXERCISES_FILE, JSON.stringify(exercises));
}

function saveExercises() {
  writeAtomic(EXERCISES_FILE, JSON.stringify(exercises));
}

function cleanExercise(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Esercizio non valido');
  const label = String(body.label || '').trim().slice(0, 60);
  // Titolo visibile alla famiglia nella pagina di scelta di un gruppo (facoltativo)
  const title = String(body.title || '').trim().slice(0, 40);
  if (!MODES.includes(body.mode)) throw httpError(400, 'Scegli il tipo di esercizio');
  const known = new Set(words.map((w) => w.id));
  const wordIds = [...new Set(Array.isArray(body.wordIds) ? body.wordIds.map(String) : [])]
    .filter((id) => known.has(id))
    .slice(0, MAX_WORDS);
  if (wordIds.length === 0) throw httpError(400, 'Scegli almeno una parola');
  return { label, title, mode: body.mode, wordIds };
}

function findExercise(token) {
  return TOKEN.test(token) ? exercises.find((x) => x.token === token) : undefined;
}

function wordsOf(ex) {
  return ex.wordIds.map((id) => words.find((w) => w.id === id)).filter(Boolean);
}

// Tiene gli esercizi allineati quando una parola viene eliminata.
function pruneExercises() {
  const known = new Set(words.map((w) => w.id));
  let changed = false;
  for (const ex of exercises) {
    const kept = ex.wordIds.filter((id) => known.has(id));
    if (kept.length !== ex.wordIds.length) {
      ex.wordIds = kept;
      changed = true;
    }
  }
  if (changed) saveExercises();
}

// ── Gruppi: un solo link per più esercizi ──
let groups = readJson(GROUPS_FILE, []);
if (!Array.isArray(groups)) groups = [];

function saveGroups() {
  writeAtomic(GROUPS_FILE, JSON.stringify(groups));
}

function cleanGroup(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Gruppo non valido');
  const label = String(body.label || '').trim().slice(0, 60);
  const known = new Set(exercises.map((x) => x.id));
  const exerciseIds = [...new Set(Array.isArray(body.exerciseIds) ? body.exerciseIds.map(String) : [])]
    .filter((id) => known.has(id))
    .slice(0, MAX_GROUP_ITEMS);
  if (exerciseIds.length === 0) throw httpError(400, 'Scegli almeno un esercizio');
  return { label, exerciseIds };
}

function findGroup(token) {
  return TOKEN.test(token) ? groups.find((g) => g.token === token) : undefined;
}

// Chiave pubblica di un esercizio dentro un gruppo: stabile, ma non rivela il token dell'esercizio.
function itemKey(group, ex) {
  return crypto.createHash('sha256').update(`${group.token}:${ex.id}`).digest('base64url').slice(0, 12);
}

// Esercizi del gruppo che hanno ancora almeno una parola, nell'ordine scelto.
function itemsOf(group) {
  return group.exerciseIds
    .map((id) => exercises.find((x) => x.id === id))
    .filter((ex) => ex && wordsOf(ex).length > 0);
}

function pruneGroups() {
  const known = new Set(exercises.map((x) => x.id));
  let changed = false;
  for (const g of groups) {
    const kept = g.exerciseIds.filter((id) => known.has(id));
    if (kept.length !== g.exerciseIds.length) {
      g.exerciseIds = kept;
      changed = true;
    }
  }
  if (changed) saveGroups();
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
  if (LOGIN_DISABLED) return true;
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
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
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

const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function sendImage(res, name) {
  let data;
  try {
    data = fs.readFileSync(path.join(IMG_DIR, name));
  } catch {
    throw httpError(404, 'Non trovato');
  }
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': IMG_TYPES[name.split('.')[1]],
    'Cache-Control': 'private, max-age=86400',
  });
  res.end(data);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; "
  + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function sendFile(req, res, file, extraHeaders = {}) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw httpError(404, 'Non trovato');
  }
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP,
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function exerciseList() {
  return exercises.map(({ id, token, label, title, mode, wordIds }) => ({ id, token, label, title: title || '', mode, wordIds }));
}

function groupList() {
  return groups.map(({ token, label, exerciseIds }) => ({ token, label, exerciseIds }));
}

// ── API privata ──
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
    return sendJson(res, 200, { auth: isAuthed(req), loginDisabled: LOGIN_DISABLED });
  }

  if (!isAuthed(req)) throw httpError(401, 'Accesso richiesto');

  if (route === 'GET /api/state') {
    return sendJson(res, 200, {
      words, mode: settings.mode, exercises: exerciseList(), groups: groupList(), publicUrl: PUBLIC_URL,
    });
  }

  if (route === 'PUT /api/words') {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.words) || body.words.length > MAX_WORDS) {
      throw httpError(400, 'Elenco parole non valido');
    }
    words = body.words.map(cleanWord);
    writeAtomic(WORDS_FILE, JSON.stringify(words));
    pruneExercises();
    removeOrphanImages();
    return sendJson(res, 200, { words, exercises: exerciseList() });
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
    if (fs.readdirSync(IMG_DIR).length >= MAX_IMAGES) {
      throw httpError(507, 'Spazio per le foto esaurito: elimina qualche parola con foto');
    }
    const buf = await readBody(req, 4 * 1024 * 1024);
    const ext = imageExt(buf);
    if (!ext) throw httpError(400, 'Formato immagine non supportato');
    const imageId = `${newId()}.${ext}`;
    writeAtomic(path.join(IMG_DIR, imageId), buf);
    return sendJson(res, 201, { imageId });
  }

  if (route === 'POST /api/exercises') {
    if (exercises.length >= MAX_EXERCISES) throw httpError(400, 'Troppi esercizi: eliminane qualcuno');
    const ex = { id: newId(), token: newToken(), ...cleanExercise(await readJsonBody(req, 64 * 1024)) };
    exercises.push(ex);
    saveExercises();
    return sendJson(res, 201, { exercises: exerciseList() });
  }

  const m = url.pathname.match(/^\/api\/exercises\/([^/]+)(\/rotate)?$/);
  if (m) {
    const ex = findExercise(m[1]);
    if (!ex) throw httpError(404, 'Esercizio non trovato');
    if (req.method === 'PUT' && !m[2]) {
      Object.assign(ex, cleanExercise(await readJsonBody(req, 64 * 1024)));
    } else if (req.method === 'DELETE' && !m[2]) {
      exercises = exercises.filter((x) => x !== ex);
      pruneGroups();
    } else if (req.method === 'POST' && m[2]) {
      ex.token = newToken();
    } else {
      throw httpError(405, 'Metodo non consentito');
    }
    saveExercises();
    return sendJson(res, 200, { exercises: exerciseList(), groups: groupList() });
  }

  if (route === 'POST /api/groups') {
    if (groups.length >= MAX_GROUPS) throw httpError(400, 'Troppi gruppi: eliminane qualcuno');
    groups.push({ token: newToken(), ...cleanGroup(await readJsonBody(req, 64 * 1024)) });
    saveGroups();
    return sendJson(res, 201, { groups: groupList() });
  }

  const g = url.pathname.match(/^\/api\/groups\/([^/]+)(\/rotate)?$/);
  if (g) {
    const group = findGroup(g[1]);
    if (!group) throw httpError(404, 'Gruppo non trovato');
    if (req.method === 'PUT' && !g[2]) {
      Object.assign(group, cleanGroup(await readJsonBody(req, 64 * 1024)));
    } else if (req.method === 'DELETE' && !g[2]) {
      groups = groups.filter((x) => x !== group);
    } else if (req.method === 'POST' && g[2]) {
      group.token = newToken();
    } else {
      throw httpError(405, 'Metodo non consentito');
    }
    saveGroups();
    return sendJson(res, 200, { groups: groupList() });
  }

  throw httpError(404, 'Non trovato');
}

function handlePrivate(req, res, url) {
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  if (url.pathname.startsWith('/img/')) {
    if (!isAuthed(req)) throw httpError(401, 'Accesso richiesto');
    const name = url.pathname.slice('/img/'.length);
    if (!IMG_NAME.test(name)) throw httpError(404, 'Non trovato');
    return sendImage(res, name);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Metodo non consentito');
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR + path.sep)) throw httpError(404, 'Non trovato');
  return sendFile(req, res, file);
}

// ── Lato pubblico: solo gli esercizi condivisi ──
// Nessun cookie, nessuna scrittura, nessun elenco: chi non ha un link valido non vede nulla.
const PUBLIC_FILES = {
  '/parole.css': path.join(APP_DIR, 'parole.css'),
  '/game.js': path.join(APP_DIR, 'game.js'),
  '/gioca.js': path.join(PLAYER_DIR, 'gioca.js'),
};

function publicHeaders(req) {
  const h = { 'X-Robots-Tag': 'noindex, nofollow' };
  // HSTS vale per l'intero nome host, porte comprese: attivarlo qui costringerebbe il browser
  // ad aprire in https anche le altre app sullo stesso host (che usano http). Con max-age=0
  // i browser che l'avevano già memorizzato la dimenticano alla prossima visita.
  if (req.headers['x-forwarded-proto'] === 'https') {
    h['Strict-Transport-Security'] = 'max-age=0';
  }
  return h;
}

function sendExercise(res, ex, extra) {
  const payload = wordsOf(ex).map(({ text, emoji, imageId, distractors }) => ({ text, emoji, imageId, distractors }));
  return sendJson(res, 200, { mode: ex.mode, words: payload }, extra);
}

function handlePublic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Metodo non consentito');
  const p = url.pathname;
  const extra = publicHeaders(req);

  if (PUBLIC_FILES[p]) return sendFile(req, res, PUBLIC_FILES[p], extra);

  let m = p.match(/^\/e\/([^/]+)$/);
  if (m) return sendFile(req, res, path.join(PLAYER_DIR, 'gioca.html'), extra);

  m = p.match(/^\/api\/e\/([^/]+)(?:\/([A-Za-z0-9_-]{12}))?$/);
  if (m) {
    const ex = findExercise(m[1]);
    if (ex && !m[2]) return sendExercise(res, ex, extra);

    const group = findGroup(m[1]);
    const items = group ? itemsOf(group) : [];
    if (items.length === 0) throw httpError(404, 'Esercizio non trovato');
    if (m[2]) {
      const item = items.find((x) => itemKey(group, x) === m[2]);
      if (!item) throw httpError(404, 'Esercizio non trovato');
      return sendExercise(res, item, extra);
    }
    // Con un solo esercizio il gruppo si comporta come un link singolo
    if (items.length === 1) return sendExercise(res, items[0], extra);
    const choices = items.map((x) => ({
      key: itemKey(group, x),
      title: x.title || '',
      mode: x.mode,
      count: wordsOf(x).length,
      preview: wordsOf(x).slice(0, 3).map(({ emoji, imageId }) => ({ emoji, imageId })),
    }));
    return sendJson(res, 200, { choices }, extra);
  }

  m = p.match(/^\/img\/([^/]+)\/([^/]+)$/);
  if (m) {
    const ex = findExercise(m[1]);
    const group = ex ? null : findGroup(m[1]);
    const pool = ex ? wordsOf(ex) : group ? itemsOf(group).flatMap(wordsOf) : [];
    if (!IMG_NAME.test(m[2]) || !pool.some((w) => w.imageId === m[2])) {
      throw httpError(404, 'Non trovato');
    }
    return sendImage(res, m[2]);
  }

  throw httpError(404, 'Non trovato');
}

// ── Avvio dei due server ──
function makeServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      await handler(req, res, url);
    } catch (e) {
      const status = e.status || 500;
      if (!e.status) console.error(e);
      if (res.headersSent) return res.end();
      return sendJson(res, status, { error: e.status ? e.message : 'Errore interno' });
    }
  });
  // Chiude in fretta le connessioni lente o appese
  server.headersTimeout = 10 * 1000;
  server.requestTimeout = 30 * 1000;
  server.keepAliveTimeout = 5 * 1000;
  return server;
}

makeServer(handlePrivate).listen(PORT, () => {
  console.log(`Parole (privata) sulla porta ${PORT}`);
  if (LOGIN_DISABLED) console.log('ATTENZIONE: DISABLE_LOGIN=1, l\'app privata è aperta senza codice');
});
makeServer(handlePublic).listen(PUBLIC_PORT, () => {
  console.log(`Parole (esercizi pubblici) sulla porta ${PUBLIC_PORT}`);
  if (!PUBLIC_URL) console.log('PUBLIC_URL non impostato: i link degli esercizi mostrano solo il percorso');
});
