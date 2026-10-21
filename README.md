# parole

App per bambini: viene mostrata un'immagine e, sotto, tanti riquadri quante sono le lettere della parola. L'adulto sceglie quale esercizio far fare:

- **Scrivi**: il bambino compila i riquadri con la tastiera.
- **Rimetti in ordine**: il bambino ordina le lettere della parola.
- **Con distrattori**: come sopra, ma tra le lettere ce ne sono di extra, scelte dall'adulto per ogni parola. Le consonanti stanno a sinistra, le vocali a destra e in viola.

L'adulto gestisce l'elenco delle parole (aggiungere, modificare, togliere), con un'emoji o una foto caricata dal dispositivo. All'apertura serve un codice (predefinito `7777`, cambiabile dal menu).

## Esercizi da condividere

Dal menu, "Esercizi da condividere" permette di preparare un esercizio (nome interno, modalità, parole scelte dall'elenco) e ottenere un link da mandare alla famiglia di un paziente. Chi apre il link vede solo quell'esercizio: niente codice, niente menu, nessuna modifica possibile.

- Il nome dell'esercizio lo vede solo chi gestisce l'app: **non scriverci il nome del paziente**.
- "Nuovo link" sostituisce il link: quello vecchio smette subito di funzionare. "Elimina" lo disattiva per sempre.
- Le foto usate negli esercizi condivisi devono essere immagini generiche (una casa, un gatto), mai foto di persone.
- L'app non registra nulla di chi gioca: nessun nome, nessun risultato.

## Come funziona

Un piccolo server Node senza dipendenze (`server.js`) ascolta su **due porte**:

| Porta nel container | Sul Pi | Cosa offre | Chi la raggiunge |
|---|---|---|---|
| 3000 | 8082 | App completa: codice, gestione parole, esercizi | LAN e tailnet, mai Internet |
| 3001 | 8083 | Solo gli esercizi condivisi, letti tramite link | Internet, con `tailscale funnel` |

La porta pubblica non ha login, non accetta scritture e non elenca nulla: risponde solo a un link valido (codice casuale da 128 bit, non indovinabile) e serve solo le foto delle parole di quell'esercizio. Il resto restituisce 404.

I dati stanno nella cartella `/data` del container, montata su un volume Docker: parole, foto, esercizi, codice ed esercizio scelto.

Il codice dell'app privata è verificato dal server (non dal browser). Dopo 5 tentativi sbagliati l'accesso si blocca per un minuto. L'accesso dura finché non chiudi il browser (massimo 24 ore).

Il container gira come utente non privilegiato, con filesystem in sola lettura tranne `/data`, senza capability Linux e con limite di memoria.

## Deploy sul Raspberry Pi

```bash
cd ~
git clone -b <branch> https://github.com/Vito-Pepe/parole.git
cd parole
# Indirizzo pubblico per comporre i link (il nome tailnet lo vedi con "tailscale status")
echo "PUBLIC_URL=https://vito.<tailnet>.ts.net:10000" > .env
docker compose up --build -d
curl -I http://127.0.0.1:8082
```

Pubblicazione degli esercizi su Internet (porta HTTPS 10000). Funnel va abilitato una volta nel pannello Tailscale: se non lo è, il comando stampa il link per farlo.

```bash
sudo tailscale funnel --bg --https=10000 localhost:8083
tailscale funnel status
```

L'app privata non passa da `tailscale serve`: si apre su `http://IP-DEL-PI:8082` da casa e su `http://vito.<tailnet>.ts.net:8082` dalla tailnet (il traffico Tailscale è comunque cifrato).

Aggiornamento automatico ogni 5 minuti, e ricostruzione settimanale dell'immagine per ricevere le patch di sicurezza di Node e Alpine (senza sudo):

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * cd $HOME/parole && ./update.sh >> $HOME/parole/update.log 2>&1") | crontab -
(crontab -l 2>/dev/null; echo "30 4 * * 1 cd $HOME/parole && docker compose build --pull -q && docker compose up -d >> $HOME/parole/update.log 2>&1") | crontab -
```

Per spegnere la parte pubblica in qualsiasi momento:

```bash
sudo tailscale funnel --https=10000 off
```

## Isolamento dalla rete di casa

Parole non ha bisogno di aprire connessioni verso nessuno. Le regole in `firewall/` bloccano ogni connessione nuova che parte dal suo bridge (`br-parole`) verso LAN, tailnet, Internet e verso il Pi stesso. Le risposte alle richieste in arrivo restano permesse. Così, anche se qualcuno sfruttasse un difetto della parte pubblica, dal container non potrebbe raggiungere gli altri dispositivi di casa.

Installazione (una volta sola; lo script viene copiato in una cartella di root, così gli aggiornamenti automatici della repo non possono cambiarlo):

```bash
cd ~/parole
sudo install -m 755 firewall/parole-firewall.sh /usr/local/sbin/parole-firewall.sh
sudo install -m 644 firewall/parole-firewall.service /etc/systemd/system/parole-firewall.service
sudo systemctl daemon-reload
sudo systemctl enable --now parole-firewall.service
sudo parole-firewall.sh status
```

Verifica: prima di attivare le regole il comando deve rispondere `RAGGIUNTO` (altrimenti il test non dice nulla: prova un altro indirizzo della LAN), dopo deve rispondere `BLOCCATO`.

```bash
docker compose exec parole wget -q -T 3 -O /dev/null http://192.168.1.1 && echo RAGGIUNTO || echo BLOCCATO
```

Tentativi bloccati: `sudo journalctl -k | grep parole-bloccato`. Per togliere le regole: `sudo systemctl disable --now parole-firewall.service`.

Limite noto: il container può ancora fare richieste DNS tramite il resolver interno di Docker.

## Porte

| App | LAN (http) | Tailnet | Internet |
|---|---|---|---|
| homepage | 8081 | https :443 | no |
| sillabe | 8080 | https :8443 | no |
| parole (app) | 8082 | http :8082 | no |
| parole (esercizi) | 8083 | — | https :10000 (funnel) |

## Dati e backup

I dati stanno nel volume Docker `parole_parole-data`. Gli aggiornamenti non li toccano, ma `docker compose down -v` li cancella. Backup:

```bash
docker run --rm -v parole_parole-data:/data -v "$PWD":/backup alpine tar czf /backup/parole-backup.tgz -C /data .
```

Se dimentichi il codice, sul Pi cancella `settings.json` dal volume: al riavvio torna `7777` (parole ed esercizi restano).

```bash
docker run --rm -v parole_parole-data:/data alpine rm /data/settings.json
docker compose restart
```

## Sviluppo in locale

```bash
DATA_DIR=./data PORT=3000 PUBLIC_PORT=3001 PUBLIC_URL=http://localhost:3001 node server.js
```
