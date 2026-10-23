'use strict';

const $ = (id) => document.getElementById(id);
const { el } = Game;
const MODE_NAMES = { type: 'Scrivi', order: 'Rimetti in ordine', distractors: 'Con distrattori' };
const MODE_ICONS = { type: '⌨️', order: '🔀', distractors: '🧩' };
const privateImage = (w) => `/img/${w.imageId}`;

let words = [];
let mode = 'type';
let exercises = [];
let publicUrl = '';
let groups = [];
let loginDisabled = false;

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

const pictureNode = (word) => Game.pictureNode(word, privateImage);

function goHome() {
  renderHome();
  showScreen('home');
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
  exercises = state.exercises;
  groups = state.groups || [];
  publicUrl = state.publicUrl;
  goHome();
}

// ── Menu ──
function renderHome() {
  document.querySelectorAll('#modes .mode-card').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
  const empty = words.length === 0;
  $('home-empty').classList.toggle('hidden', !empty);
  $('start-btn').disabled = empty;
  $('logout-btn').classList.toggle('hidden', loginDisabled);
  $('pin-btn').classList.toggle('hidden', loginDisabled);
}

document.querySelectorAll('#modes .mode-card').forEach((b) => {
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

$('start-btn').addEventListener('click', () => {
  Game.start({ words, mode, imageUrl: privateImage, show: showScreen, onExit: goHome });
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
$('manage-back').addEventListener('click', goHome);

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
  exercises = data.exercises;
  renderList();
}

async function removeWord(w) {
  const used = exercises.filter((x) => x.wordIds.includes(w.id)).length;
  const note = used ? `\nÈ usata in ${used} esercizi condivisi: verrà tolta anche da lì.` : '';
  if (!confirm(`Eliminare "${w.text}"?${note}`)) return;
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

// ── Esercizi da condividere ──
let exEditing = null;
let exMode = 'type';

function linkFor(token) {
  return publicUrl ? `${publicUrl}/e/${token}` : `/e/${token}`;
}

function exerciseWords(ex) {
  return ex.wordIds.map((id) => words.find((w) => w.id === id)).filter(Boolean);
}

$('share-btn').addEventListener('click', () => {
  renderShare();
  showShareView('list');
  showScreen('share');
});
$('share-back').addEventListener('click', goHome);

// view: 'list' (elenchi), 'ex' (modifica esercizio), 'group' (modifica gruppo)
function showShareView(view) {
  $('ex-view').classList.toggle('hidden', view !== 'list');
  $('ex-form').classList.toggle('hidden', view !== 'ex');
  $('group-form').classList.toggle('hidden', view !== 'group');
}

function renderShare() {
  renderExercises();
  renderGroups();
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fuori da HTTPS il browser non dà accesso agli appunti: si copia dalla casella
    input.select();
    return document.execCommand('copy');
  }
}

function linkInput(token) {
  const link = el('input', 'ex-link');
  link.type = 'text';
  link.readOnly = true;
  link.value = linkFor(token);
  link.setAttribute('aria-label', 'Link da condividere');
  return link;
}

function shareButtons(link) {
  const copy = el('button', 'small-btn green', 'Copia link');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    copy.textContent = (await copyText(link.value, link)) ? 'Copiato!' : 'Copia a mano';
    setTimeout(() => (copy.textContent = 'Copia link'), 1800);
  });
  const out = [copy];
  if (navigator.share && publicUrl) {
    const share = el('button', 'small-btn', 'Condividi');
    share.type = 'button';
    share.addEventListener('click', () => navigator.share({ title: 'Esercizio', url: link.value }).catch(() => {}));
    out.push(share);
  }
  return out;
}

function renderExercises() {
  $('share-warning').classList.toggle('hidden', Boolean(publicUrl));
  const list = $('ex-list');
  list.replaceChildren();
  if (exercises.length === 0) {
    list.append(el('li', 'ex-empty', 'Nessun esercizio: creane uno.'));
  }
  for (const ex of exercises) {
    const ws = exerciseWords(ex);
    const li = el('li', 'ex-item');
    const head = el('div', 'word-info');
    head.append(el('strong', 'ex-label', ex.label || 'Senza nome'));
    const inGroups = groups.filter((g) => g.exerciseIds.includes(ex.id)).length;
    let meta = `${MODE_NAMES[ex.mode]} · ${ws.length} ${ws.length === 1 ? 'parola' : 'parole'}`;
    if (ex.title) meta += ` · titolo "${ex.title}"`;
    if (inGroups) meta += ` · in ${inGroups} ${inGroups === 1 ? 'gruppo' : 'gruppi'}`;
    head.append(el('span', '', meta));

    const link = linkInput(ex.token);
    const actions = el('div', 'word-actions wrap');
    actions.append(...shareButtons(link));
    const tryBtn = el('button', 'small-btn', 'Prova');
    tryBtn.type = 'button';
    tryBtn.disabled = ws.length === 0;
    tryBtn.addEventListener('click', () => {
      Game.start({ words: ws, mode: ex.mode, imageUrl: privateImage, show: showScreen, onExit: () => showScreen('share') });
    });
    const edit = el('button', 'small-btn', 'Modifica');
    edit.type = 'button';
    edit.addEventListener('click', () => openExEditor(ex));
    const del = el('button', 'small-btn danger', 'Elimina');
    del.type = 'button';
    del.addEventListener('click', () => removeExercise(ex));
    actions.append(tryBtn, edit, del);

    li.append(head, link, actions);
    list.append(li);
  }
}

function renderExModes() {
  document.querySelectorAll('#ex-modes .mode-card').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === exMode));
  });
}
document.querySelectorAll('#ex-modes .mode-card').forEach((b) => {
  b.addEventListener('click', () => {
    exMode = b.dataset.mode;
    renderExModes();
  });
});

function openExEditor(ex) {
  exEditing = ex || null;
  exMode = ex ? ex.mode : mode;
  $('ex-title').textContent = ex ? 'Modifica esercizio' : 'Nuovo esercizio';
  $('ex-label').value = ex ? ex.label : '';
  $('ex-public-title').value = ex ? ex.title : '';
  $('ex-rotate').classList.toggle('hidden', !ex);
  $('ex-error').classList.add('hidden');
  renderExModes();

  const box = $('ex-words');
  box.replaceChildren();
  const selected = new Set(ex ? ex.wordIds : []);
  for (const w of words) {
    const label = el('label', 'ex-word');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = w.id;
    cb.checked = selected.has(w.id);
    const thumb = el('span', 'thumb small');
    thumb.append(pictureNode(w));
    label.append(cb, thumb, el('span', 'ex-word-text', w.text));
    box.append(label);
  }
  if (words.length === 0) box.append(el('p', 'hint', 'L\'elenco parole è vuoto.'));
  showShareView('ex');
  $('ex-label').focus();
}

$('ex-add').addEventListener('click', () => openExEditor(null));
$('ex-cancel').addEventListener('click', () => showShareView('list'));

function exError(msg) {
  $('ex-error').textContent = msg;
  $('ex-error').classList.remove('hidden');
}

$('ex-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    label: $('ex-label').value,
    title: $('ex-public-title').value,
    mode: exMode,
    wordIds: [...document.querySelectorAll('#ex-words input:checked')].map((c) => c.value),
  };
  try {
    const data = exEditing
      ? await api('PUT', `/api/exercises/${exEditing.token}`, body)
      : await api('POST', '/api/exercises', body);
    exercises = data.exercises;
    if (data.groups) groups = data.groups;
    renderShare();
    showShareView('list');
  } catch (ex) {
    exError(ex.message);
  }
});

$('ex-rotate').addEventListener('click', async () => {
  if (!exEditing) return;
  if (!confirm('Creare un nuovo link? Quello vecchio smetterà subito di funzionare.')) return;
  try {
    const data = await api('POST', `/api/exercises/${exEditing.token}/rotate`, {});
    exercises = data.exercises;
    if (data.groups) groups = data.groups;
    renderShare();
    showShareView('list');
  } catch (ex) {
    exError(ex.message);
  }
});

async function removeExercise(ex) {
  const inGroups = groups.filter((g) => g.exerciseIds.includes(ex.id)).length;
  const note = inGroups ? `\nÈ in ${inGroups} ${inGroups === 1 ? 'gruppo' : 'gruppi'}: verrà tolto anche da lì.` : '';
  if (!confirm(`Eliminare l'esercizio "${ex.label || 'Senza nome'}"? Il suo link smetterà di funzionare.${note}`)) return;
  try {
    const data = await api('DELETE', `/api/exercises/${ex.token}`);
    exercises = data.exercises;
    if (data.groups) groups = data.groups;
    renderShare();
  } catch (e) {
    alert(e.message);
  }
}

// ── Gruppi di esercizi ──
let groupEditing = null;

function groupExercises(g) {
  return g.exerciseIds.map((id) => exercises.find((x) => x.id === id)).filter(Boolean);
}

function renderGroups() {
  const list = $('group-list');
  list.replaceChildren();
  if (groups.length === 0) {
    list.append(el('li', 'ex-empty', 'Nessun gruppo: creane uno.'));
  }
  for (const g of groups) {
    const items = groupExercises(g);
    const li = el('li', 'ex-item');
    const head = el('div', 'word-info');
    head.append(el('strong', 'ex-label', g.label || 'Senza nome'));
    const names = items.map((x) => x.label || 'Senza nome').join(', ');
    head.append(el('span', '', `${items.length} ${items.length === 1 ? 'esercizio' : 'esercizi'}${names ? `: ${names}` : ''}`));

    const link = linkInput(g.token);
    const actions = el('div', 'word-actions wrap');
    actions.append(...shareButtons(link));
    if (publicUrl) {
      const open = el('button', 'small-btn', 'Apri');
      open.type = 'button';
      open.addEventListener('click', () => window.open(link.value, '_blank', 'noopener'));
      actions.append(open);
    }
    const edit = el('button', 'small-btn', 'Modifica');
    edit.type = 'button';
    edit.addEventListener('click', () => openGroupEditor(g));
    const del = el('button', 'small-btn danger', 'Elimina');
    del.type = 'button';
    del.addEventListener('click', () => removeGroup(g));
    actions.append(edit, del);

    li.append(head, link, actions);
    list.append(li);
  }
}

function openGroupEditor(g) {
  groupEditing = g || null;
  $('group-title').textContent = g ? 'Modifica gruppo' : 'Nuovo gruppo';
  $('group-label').value = g ? g.label : '';
  $('group-rotate').classList.toggle('hidden', !g);
  $('group-error').classList.add('hidden');

  const box = $('group-items');
  box.replaceChildren();
  const selected = new Set(g ? g.exerciseIds : []);
  for (const ex of exercises) {
    const label = el('label', 'ex-word group-item');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = ex.id;
    cb.checked = selected.has(ex.id);
    const text = el('span', 'group-item-text');
    text.append(el('strong', '', ex.label || 'Senza nome'));
    text.append(el('span', '', MODE_NAMES[ex.mode] + (ex.title ? ` · "${ex.title}"` : '')));
    label.append(cb, el('span', 'group-item-icon', MODE_ICONS[ex.mode]), text);
    box.append(label);
  }
  if (exercises.length === 0) box.append(el('p', 'hint', 'Crea prima almeno un esercizio.'));
  showShareView('group');
  $('group-label').focus();
}

function groupError(msg) {
  $('group-error').textContent = msg;
  $('group-error').classList.remove('hidden');
}

$('group-add').addEventListener('click', () => openGroupEditor(null));
$('group-cancel').addEventListener('click', () => showShareView('list'));

$('group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    label: $('group-label').value,
    exerciseIds: [...document.querySelectorAll('#group-items input:checked')].map((c) => c.value),
  };
  try {
    const data = groupEditing
      ? await api('PUT', `/api/groups/${groupEditing.token}`, body)
      : await api('POST', '/api/groups', body);
    groups = data.groups;
    renderShare();
    showShareView('list');
  } catch (ex) {
    groupError(ex.message);
  }
});

$('group-rotate').addEventListener('click', async () => {
  if (!groupEditing) return;
  if (!confirm('Creare un nuovo link per il gruppo? Quello vecchio smetterà subito di funzionare.')) return;
  try {
    const data = await api('POST', `/api/groups/${groupEditing.token}/rotate`, {});
    groups = data.groups;
    renderShare();
    showShareView('list');
  } catch (ex) {
    groupError(ex.message);
  }
});

async function removeGroup(g) {
  if (!confirm(`Eliminare il gruppo "${g.label || 'Senza nome'}"? Il suo link smetterà di funzionare (gli esercizi restano).`)) return;
  try {
    const data = await api('DELETE', `/api/groups/${g.token}`);
    groups = data.groups;
    renderShare();
  } catch (e) {
    alert(e.message);
  }
}

// ── Avvio ──
(async () => {
  try {
    const s = await api('GET', '/api/session');
    loginDisabled = Boolean(s.loginDisabled);
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
