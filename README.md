# parole

App per bambini: viene mostrata un'immagine e, sotto, tanti riquadri quante sono le lettere della parola. L'adulto sceglie quale esercizio far fare:

- **Scrivi**: il bambino compila i riquadri con la tastiera.
- **Rimetti in ordine**: il bambino ordina le lettere della parola.
- **Con distrattori**: come sopra, ma tra le lettere ce ne sono di extra, scelte dall'adulto per ogni parola. Le consonanti stanno a sinistra, le vocali a destra e in viola.

L'adulto gestisce l'elenco delle parole (aggiungere, modificare, togliere), con un'emoji o una foto caricata dal dispositivo. All'apertura serve un codice (predefinito `7777`, cambiabile dal menu).

## Come funziona

Un piccolo server Node senza dipendenze (`server.js`) serve la pagina (`public/`) e salva i dati nella cartella `/data` del container, montata su un volume Docker: elenco parole, foto, codice e esercizio scelto. Così sono gli stessi da qualunque dispositivo e indirizzo.

Il codice è verificato dal server (non dal browser): senza accesso le parole e le foto non si possono leggere né modificare. Dopo 5 tentativi sbagliati l'accesso si blocca per un minuto. L'accesso dura finché non chiudi il browser (massimo 24 ore). È un blocco pensato per tenere fuori un bambino curioso: scegli un codice che non usi altrove.

## Deploy sul Raspberry Pi

```bash
cd ~
git clone -b <branch> https://github.com/Vito-Pepe/parole.git
cd parole
docker compose up --build -d
curl -I http://127.0.0.1:8082
```

Pubblicazione su Tailscale (porta HTTPS 10000):

```bash
sudo tailscale serve --bg --https=10000 localhost:8082
```

Aggiornamento automatico ogni 5 minuti (senza sudo):

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * cd $HOME/parole && ./update.sh >> $HOME/parole/update.log 2>&1") | crontab -
```

## Porte

| App | LAN (http) | Tailscale (https) |
|---|---|---|
| homepage | 8081 | 443 |
| sillabe | 8080 | 8443 |
| parole | 8082 | 10000 |

## Dati e backup

I dati stanno nel volume Docker `parole_parole-data`. Gli aggiornamenti non li toccano, ma `docker compose down -v` li cancella. Backup:

```bash
docker run --rm -v parole_parole-data:/data -v "$PWD":/backup alpine tar czf /backup/parole-backup.tgz -C /data .
```

Se dimentichi il codice, sul Pi cancella `settings.json` dal volume: al riavvio torna `7777` (le parole restano).

```bash
docker run --rm -v parole_parole-data:/data alpine rm /data/settings.json
docker compose restart
```

## Sviluppo in locale

```bash
DATA_DIR=./data PORT=3000 node server.js
```
