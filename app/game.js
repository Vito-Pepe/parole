'use strict';

// Logica di gioco condivisa tra l'app (index.html) e la pagina pubblica (gioca.html).
// Richiede nella pagina gli elementi delle schermate "play" e "done".
window.Game = (() => {
  const $ = (id) => document.getElementById(id);
  const VOWELS = new Set('aeiouàèéìòù');
  const LETTER = /^[a-zàèéìòù]$/;
  const PRAISE = ['Bravo!', 'Bravissimo!', 'Perfetto!', 'Ottimo!', 'Grande!'];

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

  function pictureNode(word, imageUrl) {
    if (word.imageId) {
      const img = el('img');
      img.src = imageUrl(word);
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

  // cfg: { words, mode, imageUrl(word), show(name), onExit(), onFinish()? }
  let cfg = null;
  let queue = [];
  let qi = 0;
  let cur = null;
  let answer = [];
  let tiles = [];
  let locked = false;

  function start(config) {
    if (!config.words.length) return;
    cfg = config;
    queue = shuffle(cfg.words);
    qi = 0;
    cfg.show('play');
    loadWord();
  }

  function loadWord() {
    cur = queue[qi];
    locked = false;
    $('progress').textContent = `${qi + 1} / ${queue.length}`;
    $('picture').replaceChildren(pictureNode(cur, cfg.imageUrl));
    $('win').classList.add('hidden');
    $('next-btn').classList.add('hidden');

    const letters = Array.from(cur.text);
    answer = new Array(letters.length).fill(null);

    if (cfg.mode === 'type') {
      tiles = [];
    } else {
      const pool = cfg.mode === 'distractors' ? [...letters, ...Array.from(cur.distractors)] : letters;
      let order = shuffle(pool);
      for (let tries = 0; cfg.mode === 'order' && tries < 10 && order.join('') === cur.text && letters.length > 1; tries++) {
        order = shuffle(pool);
      }
      tiles = order.map((ch, id) => ({ id, ch, used: false }));
    }

    $('back-key').classList.toggle('hidden', cfg.mode !== 'type');
    render();
    if (cfg.mode === 'type') $('kb').focus();
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
      if (ch && cfg.mode === 'distractors' && VOWELS.has(ch)) b.classList.add('vowel');
      if (i === next && !locked) b.classList.add('active');
      b.addEventListener('click', () => onBoxClick(i));
      boxes.append(b);
    });
  }

  function tileButton(tile) {
    const b = el('button', 'tile', tile.ch);
    b.type = 'button';
    if (cfg.mode === 'distractors' && VOWELS.has(tile.ch)) b.classList.add('vowel');
    b.disabled = tile.used || locked;
    b.addEventListener('click', () => onTileClick(tile));
    return b;
  }

  function renderTiles() {
    const box = $('tiles');
    box.replaceChildren();
    box.classList.toggle('split', cfg.mode === 'distractors');
    if (cfg.mode === 'type') return;

    if (cfg.mode === 'order') {
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
    if (cfg.mode === 'type') {
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
      if (cfg.mode === 'type') $('kb').focus();
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
      cfg.show('done');
      confetti();
      if (cfg.onFinish) cfg.onFinish();
      return;
    }
    loadWord();
  });
  $('play-back').addEventListener('click', () => cfg.onExit());
  $('done-menu').addEventListener('click', () => cfg.onExit());
  $('again-btn').addEventListener('click', () => start(cfg));

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
    if (!cfg || !$('screen-play').classList.contains('active') || cfg.mode !== 'type' || locked) return;
    if (e.key === 'Backspace') {
      e.preventDefault();
      removeChar();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
               && document.activeElement !== $('kb') && LETTER.test(e.key.toLowerCase())) {
      addChar(e.key.toLowerCase());
    }
  });

  return { start, el, pictureNode };
})();
