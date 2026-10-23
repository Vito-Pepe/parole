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

### Gruppi di esercizi

Un gruppo raccoglie più esercizi, anche di tipo diverso, sotto un unico link. Chi apre il link vede una pagina con un riquadro per esercizio (icona della modalità, titolo, anteprima delle immagini) e il bambino sceglie da lì. A fine esercizio torna alla scelta, e gli esercizi completati restano segnati con una spunta. La spunta è salvata solo nel browser della famiglia: il server non registra nulla. Un gruppo con un solo esercizio porta dritto all'esercizio.

- Ogni esercizio può avere un **titolo per il bambino** (facoltativo), mostrato sul riquadro. Senza titolo compare il nome della modalità. Il nome interno non compare mai.
- Lo stesso esercizio può stare in più gruppi e continuare ad avere anche il suo link singolo. "Nuovo link" su un esercizio non rompe i gruppi che lo contengono.
- Eliminando un esercizio, viene tolto anche dai gruppi. Eliminando un gruppo, gli esercizi restano.

I gruppi sono salvati in un file separato (`groups.json`). Se si torna a una versione senza gruppi, i link dei singoli esercizi continuano a funzionare, solo i link dei gruppi smettono, e i gruppi riappaiono intatti tornando a questa versione.

## Come funziona

Un piccolo server Node senza dipendenze (`server.js`) ascolta su **due porte**:

| Porta nel container | Sul Pi | Cosa offre | Chi la raggiunge |
|---|---|---|---|
| 3000 | 8082 | App completa: codice, gestione parole, esercizi | LAN e tailnet, mai Internet |
| 3001 | 8083 | Solo gli esercizi condivisi, letti tramite link | Internet, tramite il servizio `tailscale-public` |

La porta pubblica non ha login, non accetta scritture e non elenca nulla: risponde solo a un link valido (codice casuale da 128 bit, non indovinabile) e serve solo le foto delle parole di quell'esercizio. Il resto restituisce 404.

I dati stanno nella cartella `/data` del container, montata su un volume Docker: parole, foto, esercizi, codice ed esercizio scelto.

Il codice dell'app privata è verificato dal server (non dal browser). Dopo 5 tentativi sbagliati l'accesso si blocca per un minuto. L'accesso dura finché non chiudi il browser (massimo 24 ore).

Il container gira come utente non privilegiato, con filesystem in sola lettura tranne `/data`, senza capability Linux e con limite di memoria.

## Deploy sul Raspberry Pi

```bash
cd ~
git clone -b <branch> https://github.com/Vito-Pepe/parole.git
cd parole
docker compose up --build -d
curl -I http://127.0.0.1:8082
```

L'app privata si apre su `http://IP-DEL-PI:8082` da casa e su `http://vito.<tailnet>.ts.net:8082` dalla tailnet (il traffico Tailscale è comunque cifrato).

### Pubblicazione degli esercizi su Internet

Gli esercizi escono su Internet da un **dispositivo Tailscale separato**, `parole-esercizi`, che gira in un container accanto a Parole (servizio `tailscale-public`). Riceve le richieste con il funnel di Tailscale e le passa alla porta pubblica di Parole (8083). Il nome del Pi (`vito.<tailnet>.ts.net`) resta così solo privato: niente conflitti con il Relay privato di iCloud sull'iPhone, e la parte esposta ha un'identità tutta sua.

I link diventano `https://parole-esercizi.<tailnet>.ts.net/e/<codice>`.

1. Nel pannello Tailscale (Settings > Keys) genera una **auth key** monouso, non "ephemeral". Funnel deve essere permesso ai tuoi dispositivi (lo è se lo usavi già su `vito`).
2. Sul Pi, nella cartella di Parole, aggiungi al file `.env` l'attivazione del servizio, la chiave (senza che finisca nella cronologia della shell) e il nuovo indirizzo dei link:

   ```bash
   cd ~/parole
   echo "COMPOSE_PROFILES=public" >> .env
   read -rsp "Incolla la auth key: " K && echo "TS_AUTHKEY=$K" >> .env && unset K && echo
   sed -i '/^PUBLIC_URL=/d' .env && echo "PUBLIC_URL=https://parole-esercizi.<tailnet>.ts.net" >> .env
   docker compose up -d
   docker compose logs --tail 30 tailscale-public
   docker compose exec tailscale-public tailscale --socket=/tmp/tailscaled.sock funnel status
   ```

3. Prova un link dal telefono con i dati mobili e Tailscale spento.
4. Nel pannello Tailscale, sul dispositivo `parole-esercizi`: **Disable key expiry**. Poi togli la chiave dal `.env`, che non serve più (l'identità resta salvata nel volume `parole_tailscale-public-state`):

   ```bash
   sed -i '/^TS_AUTHKEY=/d' .env
   ```

Per spegnere la parte pubblica in qualsiasi momento: `docker compose stop tailscale-public`. Per riaccenderla: `docker compose start tailscale-public`.

### Aggiornamenti automatici

Ogni 5 minuti (codice) e ogni settimana (immagini di Node, Alpine e Tailscale con le patch di sicurezza), senza sudo:

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * cd $HOME/parole && ./update.sh >> $HOME/parole/update.log 2>&1") | crontab -
(crontab -l 2>/dev/null; echo "30 4 * * 1 cd $HOME/parole && docker compose pull -q --ignore-buildable && docker compose build --pull -q && docker compose up -d >> $HOME/parole/update.log 2>&1") | crontab -
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
| parole (esercizi) | 8083 | — | https `parole-esercizi.<tailnet>.ts.net` (funnel, dispositivo separato) |

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
