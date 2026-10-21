'use strict';

const $ = (id) => document.getElementById(id);
const VOWELS = new Set('aeiouàèéìòù');
const LETTER = /^[a-zàèéìòù]$/;
const PRAISE = ['Bravo!', 'Bravissimo!', 'Perfetto!', 'Ottimo!', 'Grande!'];

let words = [];
let mode = 'type';

// ── Utilità ──
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  window.scrollTo(0, 0);
}

async function api(method, url, body, rawType) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = rawType || 'application/json';
    opts.body = rawType ? body : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    // risposta senza corpo
  }
  if (res.status === 401 && url !== '/api/login') {
    showScreen('login');
    throw new Error('Accesso richiesto');
  }
  if (!res.ok) throw new Error(data.error || 'Errore');
  return data;
}

function pictureNode(word) {
  if (word.imageId) {
    const img = el('img');
    img.src = `/img/${word.imageId}`;
    img.alt = '';
    return img;
  }
  return document.createTextNode(word.emoji);
}

function confetti() {
  const box = $('confetti');
  const colors = ['#FF6584', '#48BB78', '#FFD166', '#6C63FF', '#4FC3F7', '#fff'];
  for (let i = 0; i < 60; i++) {
    const p = el('div', 'confetti-piece');
    p.style.left = `${Math.random() * 100}vw`;
    p.style.width = `${6 + Math.random() * 8}px`;
    p.style.height = `${8 + Math.random() * 10}px`;
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
    p.style.animationDelay = `${Math.random() * 0.5}s`;
    box.append(p);
  }
  setTimeout(() => box.replaceChildren(), 3800);
}

// ── Accesso ──
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/api/login', { pin: $('pin').value });
    $('pin').value = '';
    await enterHome();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
    $('pin').select();
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  showScreen('login');
  $('pin').focus();
});

async function enterHome() {
  const state = await api('GET', '/api/state');
  words = state.words;
  mode = state.mode;
  renderHome();
  showScreen('home');
}

// ── Menu ──
function renderHome() {
  document.querySelectorAll('.mode-card').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
  const empty = words.length === 0;
  $('home-empty').classList.toggle('hidden', !empty);
  $('start-btn').disabled = empty;
}

document.querySelectorAll('.mode-card').forEach((b) => {
  b.addEventListener('click', async () => {
    const previous = mode;
    mode = b.dataset.mode;
    renderHome();
    try {
      await api('PUT', '/api/settings', { mode });
    } catch {
      mode = previous;
      renderHome();
    }
  });
});

$('pin-btn').addEventListener('click', () => {
  $('pin-msg').textContent = '';
  $('pin-form').classList.remove('hidden');
  $('pin-old').focus();
});
$('pin-cancel').addEventListener('click', () => $('pin-form').classList.add('hidden'));
$('pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/pin', { oldPin: $('pin-old').value, newPin: $('pin-new').value });
    $('pin-form').reset();
    $('pin-form').classList.add('hidden');
  } catch (ex) {
    $('pin-msg').textContent = ex.message;
  }
});

// ── Elenco parole ──
$('manage-btn').addEventListener('click', () => {
  renderList();
  showEditor(false);
  showScreen('manage');
});
$('manage-back').addEventListener('click', () => {
  renderHome();
  showScreen('home');
});

function renderList() {
  const list = $('word-list');
  list.replaceChildren();
  if (words.length === 0) {
    list.append(el('li', '', 'Nessuna parola: aggiungine una.'));
  }
  for (const w of words) {
    const li = el('li');
    const thumb = el('div', 'thumb');
    thumb.append(pictureNode(w));
    const info = el('div', 'word-info');
    info.append(el('strong', '', w.text));
    info.append(el('span', '', w.distractors ? `Distrattori: ${w.distractors.split('').join(' ')}` : 'Nessun distrattore'));
    const actions = el('div', 'word-actions');
    const edit = el('button', 'small-btn', 'Modifica');
    edit.type = 'button';
    edit.addEventListener('click', () => openEditor(w));
    const del = el('button', 'small-btn danger', 'Elimina');
    del.type = 'button';
    del.addEventListener('click', () => removeWord(w));
    actions.append(edit, del);
    li.append(thumb, info, actions);
    list.append(li);
  }
}

async function saveWords(next) {
  const data = await api('PUT', '/api/words', { words: next });
  words = data.words;
  renderList();
}

async function removeWord(w) {
  if (!confirm(`Eliminare "${w.text}"?`)) return;
  try {
    await saveWords(words.filter((x) => x.id !== w.id));
  } catch (ex) {
    alert(ex.message);
  }
}

// ── Modifica parola ──
let editing = null;
let photoId = '';
let photoUrl = '';

function showEditor(on) {
  $('edit-form').classList.toggle('hidden', !on);
  $('list-view').classList.toggle('hidden', on);
}

function openEditor(word) {
  editing = word || null;
  $('edit-title').textContent = word ? 'Modifica parola' : 'Nuova parola';
  $('f-text').value = word ? word.text : '';
  $('f-emoji').value = word ? word.emoji : '';
  $('f-distractors').value = word ? word.distractors : '';
  $('f-photo').value = '';
  photoId = word ? word.imageId : '';
  photoUrl = photoId ? `/img/${photoId}` : '';
  $('edit-error').classList.add('hidden');
  renderPreview();
  showEditor(true);
  $('f-text').focus();
}

function renderPreview() {
  const p = $('f-preview');
  p.replaceChildren();
  if (photoUrl) {
    const img = el('img');
    img.src = photoUrl;
    img.alt = 'Anteprima';
    p.append(img);
  } else {
    p.textContent = $('f-emoji').value.trim() || '🖼️';
  }
  $('f-photo-clear').classList.toggle('hidden', !photoUrl);
}

$('add-btn').addEventListener('click', () => openEditor(null));
$('edit-cancel').addEventListener('click', () => showEditor(false));
$('f-emoji').addEventListener('input', renderPreview);
$('f-photo-clear').addEventListener('click', () => {
  photoId = '';
  photoUrl = '';
  $('f-photo').value = '';
  renderPreview();
});

async function resizeToJpeg(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }
  const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Immagine non leggibile'))), 'image/jpeg', 0.85);
  });
}

$('f-photo').addEventListener('change', async () => {
  const file = $('f-photo').files[0];
  if (!file) return;
  const err = $('edit-error');
  err.classList.add('hidden');
  try {
    const blob = await resizeToJpeg(file);
    const data = await api('POST', '/api/images', blob, 'image/jpeg');
    photoId = data.imageId;
    photoUrl = URL.createObjectURL(blob);
    renderPreview();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const word = {
    id: editing ? editing.id : '',
    text: $('f-text').value,
    emoji: $('f-emoji').value,
    imageId: photoId,
    distractors: $('f-distractors').value,
  };
  const next = editing ? words.map((w) => (w.id === editing.id ? word : w)) : [...words, word];
  try {
    await saveWords(next);
    showEditor(false);
  } catch (ex) {
    $('edit-error').textContent = ex.message;
    $('edit-error').classList.remove('hidden');
  }
});

// ── Esercizio ──
let queue = [];
let qi = 0;
let cur = null;
let answer = [];
let tiles = [];
let locked = false;

$('start-btn').addEventListener('click', startGame);
$('again-btn').addEventListener('click', startGame);
$('done-menu').addEventListener('click', () => {
  renderHome();
  showScreen('home');
});
$('play-back').addEventListener('click', () => {
  renderHome();
  showScreen('home');
});

function startGame() {
  if (words.length === 0) return;
  queue = shuffle(words);
  qi = 0;
  showScreen('play');
  loadWord();
}

function loadWord() {
  cur = queue[qi];
  locked = false;
  $('progress').textContent = `${qi + 1} / ${queue.length}`;
  $('picture').replaceChildren(pictureNode(cur));
  $('win').classList.add('hidden');
  $('next-btn').classList.add('hidden');

  const letters = Array.from(cur.text);
  answer = new Array(letters.length).fill(null);

  if (mode === 'type') {
    tiles = [];
  } else {
    const pool = mode === 'distractors' ? [...letters, ...Array.from(cur.distractors)] : letters;
    let order = shuffle(pool);
    for (let tries = 0; mode === 'order' && tries < 10 && order.join('') === cur.text && letters.length > 1; tries++) {
      order = shuffle(pool);
    }
    tiles = order.map((ch, id) => ({ id, ch, used: false }));
  }

  $('back-key').classList.toggle('hidden', mode !== 'type');
  render();
  if (mode === 'type') $('kb').focus();
}

function render() {
  renderBoxes();
  renderTiles();
}

function renderBoxes() {
  const boxes = $('boxes');
  boxes.replaceChildren();
  const next = answer.indexOf(null);
  answer.forEach((slot, i) => {
    const ch = slot === null ? '' : typeof slot === 'string' ? slot : slot.ch;
    const b = el('button', 'box', ch);
    b.type = 'button';
    if (ch) b.classList.add('filled');
    if (ch && mode === 'distractors' && VOWELS.has(ch)) b.classList.add('vowel');
    if (i === next && !locked) b.classList.add('active');
    b.addEventListener('click', () => onBoxClick(i));
    boxes.append(b);
  });
}

function tileButton(tile) {
  const b = el('button', 'tile', tile.ch);
  b.type = 'button';
  if (mode === 'distractors' && VOWELS.has(tile.ch)) b.classList.add('vowel');
  b.disabled = tile.used || locked;
  b.addEventListener('click', () => onTileClick(tile));
  return b;
}

function renderTiles() {
  const box = $('tiles');
  box.replaceChildren();
  box.classList.toggle('split', mode === 'distractors');
  if (mode === 'type') return;

  if (mode === 'order') {
    tiles.forEach((t) => box.append(tileButton(t)));
    return;
  }

  const byLetter = (a, b) => a.ch.localeCompare(b.ch, 'it') || a.id - b.id;
  const left = el('div', 'tile-col left');
  const right = el('div', 'tile-col right');
  tiles.filter((t) => !VOWELS.has(t.ch)).sort(byLetter).forEach((t) => left.append(tileButton(t)));
  tiles.filter((t) => VOWELS.has(t.ch)).sort(byLetter).forEach((t) => right.append(tileButton(t)));
  box.append(left, right);
}

function onTileClick(tile) {
  if (locked || tile.used) return;
  const i = answer.indexOf(null);
  if (i === -1) return;
  tile.used = true;
  answer[i] = tile;
  render();
  checkAnswer();
}

function onBoxClick(i) {
  if (locked) return;
  if (mode === 'type') {
    $('kb').focus();
    return;
  }
  const tile = answer[i];
  if (!tile) return;
  tile.used = false;
  answer[i] = null;
  render();
}

function addChar(ch) {
  if (locked) return;
  const i = answer.indexOf(null);
  if (i === -1) return;
  answer[i] = ch;
  render();
  checkAnswer();
}

function removeChar() {
  if (locked) return;
  for (let i = answer.length - 1; i >= 0; i--) {
    if (answer[i] !== null) {
      answer[i] = null;
      render();
      return;
    }
  }
}

function checkAnswer() {
  if (answer.includes(null)) return;
  const guess = answer.map((a) => (typeof a === 'string' ? a : a.ch)).join('');
  locked = true;
  if (guess === cur.text) {
    celebrate();
    return;
  }
  renderTiles();
  document.querySelectorAll('.box').forEach((b) => b.classList.add('wrong'));
  setTimeout(() => {
    answer.fill(null);
    tiles.forEach((t) => (t.used = false));
    locked = false;
    render();
    if (mode === 'type') $('kb').focus();
  }, 650);
}

function celebrate() {
  render();
  document.querySelectorAll('.box').forEach((b) => {
    b.classList.remove('filled', 'vowel', 'active');
    b.classList.add('right');
  });
  $('kb').blur();
  $('win').textContent = PRAISE[Math.floor(Math.random() * PRAISE.length)];
  $('win').classList.remove('hidden');
  $('next-btn').textContent = qi === queue.length - 1 ? 'Fine' : 'Avanti';
  $('next-btn').classList.remove('hidden');
  confetti();
}

$('next-btn').addEventListener('click', () => {
  qi += 1;
  if (qi >= queue.length) {
    showScreen('done');
    confetti();
    return;
  }
  loadWord();
});

// Tastiera (modalità "Scrivi")
$('kb').addEventListener('input', () => {
  const v = $('kb').value.toLowerCase();
  $('kb').value = '';
  for (const ch of v) if (LETTER.test(ch)) addChar(ch);
});
$('back-key').addEventListener('click', () => {
  removeChar();
  $('kb').focus();
});
document.addEventListener('keydown', (e) => {
  if (!$('screen-play').classList.contains('active') || mode !== 'type' || locked) return;
  if (e.key === 'Backspace') {
    e.preventDefault();
    removeChar();
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
             && document.activeElement !== $('kb') && LETTER.test(e.key.toLowerCase())) {
    addChar(e.key.toLowerCase());
  }
});

// ── Avvio ──
(async () => {
  try {
    const s = await api('GET', '/api/session');
    if (s.auth) {
      await enterHome();
      return;
    }
  } catch {
    // resta sulla schermata di accesso
  }
  showScreen('login');
  $('pin').focus();
})();
