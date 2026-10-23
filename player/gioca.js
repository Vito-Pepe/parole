'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const { el } = Game;
  const INTRO = {
    type: 'Guarda l\'immagine e scrivi la parola',
    order: 'Guarda l\'immagine e rimetti in ordine le lettere',
    distractors: 'Guarda l\'immagine e scegli le lettere giuste',
  };
  const MODE_NAMES = { type: 'Scrivi', order: 'Rimetti in ordine', distractors: 'Con distrattori' };
  const MODE_ICONS = { type: '⌨️', order: '🔀', distractors: '🧩' };
  const token = location.pathname.split('/')[2] || '';
  const imageUrl = (w) => `/img/${encodeURIComponent(token)}/${w.imageId}`;

  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    window.scrollTo(0, 0);
  }

  async function load(path) {
    try {
      const res = await fetch(path, { credentials: 'omit' });
      if (!res.ok) throw new Error();
      return await res.json();
    } catch {
      return null;
    }
  }

  // Esercizi completati: salvati solo in questo browser, il server non ne sa nulla.
  const DONE_KEY = `parole-fatti:${token}`;
  function doneSet() {
    try {
      return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }
  function markDone(key) {
    try {
      const done = doneSet();
      done.add(key);
      localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
    } catch {
      // archiviazione non disponibile: niente spunta, il gioco funziona comunque
    }
  }

  // ── Link a un singolo esercizio ──
  function single(ex) {
    const config = { words: ex.words, mode: ex.mode, imageUrl, show, onExit: () => show('intro') };
    $('intro-text').textContent = INTRO[ex.mode];
    $('intro-start').addEventListener('click', () => Game.start(config));
    show('intro');
  }

  // ── Link a un gruppo: pagina di scelta ──
  function renderChoices(choices) {
    const done = doneSet();
    const list = $('choices');
    list.replaceChildren();
    choices.forEach((c, i) => {
      const li = el('li');
      li.style.animationDelay = `${i * 0.06}s`;
      const card = el('button', `choice-card tone-${i % 4}`);
      card.type = 'button';

      const icon = el('span', 'choice-icon', MODE_ICONS[c.mode]);
      const title = el('strong', 'choice-title', c.title || MODE_NAMES[c.mode]);
      const meta = el('span', 'choice-meta',
        `${c.title ? `${MODE_NAMES[c.mode]} · ` : ''}${c.count} ${c.count === 1 ? 'parola' : 'parole'}`);
      const preview = el('span', 'choice-preview');
      for (const p of c.preview) {
        const t = el('span', 'choice-thumb');
        t.append(Game.pictureNode(p, imageUrl));
        preview.append(t);
      }
      card.append(icon, title, meta, preview);
      if (done.has(c.key)) {
        card.classList.add('done');
        card.append(el('span', 'choice-done', '✓ Fatto'));
      }
      card.addEventListener('click', () => play(c, choices));
      li.append(card);
      list.append(li);
    });
  }

  async function play(choice, choices) {
    setBusy(true);
    const ex = await load(`/api/e/${encodeURIComponent(token)}/${choice.key}`);
    setBusy(false);
    if (!ex) {
      show('missing');
      return;
    }
    const back = () => {
      renderChoices(choices);
      show('choose');
    };
    Game.start({
      words: ex.words,
      mode: ex.mode,
      imageUrl,
      show,
      onExit: back,
      onFinish: () => markDone(choice.key),
    });
  }

  function setBusy(busy) {
    document.querySelectorAll('.choice-card').forEach((b) => (b.disabled = busy));
  }

  (async () => {
    const data = await load(`/api/e/${encodeURIComponent(token)}`);
    if (!data) {
      show('missing');
      return;
    }
    if (!data.choices) {
      single(data);
      return;
    }
    $('done-menu').textContent = 'Scegli un altro esercizio';
    renderChoices(data.choices);
    show('choose');
  })();
})();
