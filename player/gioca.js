'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const INTRO = {
    type: 'Guarda l\'immagine e scrivi la parola',
    order: 'Guarda l\'immagine e rimetti in ordine le lettere',
    distractors: 'Guarda l\'immagine e scegli le lettere giuste',
  };
  const token = location.pathname.split('/')[2] || '';

  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    window.scrollTo(0, 0);
  }

  async function load() {
    try {
      const res = await fetch(`/api/e/${encodeURIComponent(token)}`, { credentials: 'omit' });
      if (!res.ok) throw new Error();
      return await res.json();
    } catch {
      return null;
    }
  }

  (async () => {
    const ex = await load();
    if (!ex) {
      show('missing');
      return;
    }
    const config = {
      words: ex.words,
      mode: ex.mode,
      imageUrl: (w) => `/img/${encodeURIComponent(token)}/${w.imageId}`,
      show,
      onExit: () => show('intro'),
    };
    $('intro-text').textContent = INTRO[ex.mode];
    $('intro-start').addEventListener('click', () => Game.start(config));
    show('intro');
  })();
})();
