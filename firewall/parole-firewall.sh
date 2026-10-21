#!/usr/bin/env bash
# Isola il container di Parole: blocca ogni connessione NUOVA che parte dal suo bridge
# (br-parole) verso LAN, tailnet, Internet e verso il Pi stesso. Le risposte alle
# richieste in arrivo sulle porte 8082/8083 restano permesse, quindi l'app funziona.
#
# Uso: sudo parole-firewall.sh [apply|remove|status]

set -euo pipefail

BRIDGE=br-parole
ACTION=${1:-apply}

DROP_RULE=(-i "$BRIDGE" -m conntrack --ctstate NEW -j DROP)
LOG_RULE=(-i "$BRIDGE" -m conntrack --ctstate NEW -m limit --limit 6/min -j LOG --log-prefix "parole-bloccato: ")
# DOCKER-USER: traffico instradato (verso LAN, tailnet, Internet, altri container).
# INPUT: traffico diretto al Pi stesso (SSH, altre app, Tailscale del Pi).
CHAINS=(DOCKER-USER INPUT)

if [ "$(id -u)" -ne 0 ]; then
    echo "Va eseguito con sudo." >&2
    exit 1
fi
if ! command -v iptables >/dev/null; then
    echo "iptables non trovato." >&2
    exit 1
fi
if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
    echo "Catena DOCKER-USER assente: Docker non è avviato o non usa iptables." >&2
    exit 1
fi

add_rule() {
    local chain=$1; shift
    iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" "$@"
}

del_rule() {
    local chain=$1; shift
    while iptables -C "$chain" "$@" 2>/dev/null; do
        iptables -D "$chain" "$@"
    done
}

case "$ACTION" in
    apply)
        for chain in "${CHAINS[@]}"; do
            # Prima il DROP, poi il LOG inserito sopra: ogni blocco viene prima registrato.
            add_rule "$chain" "${DROP_RULE[@]}"
            add_rule "$chain" "${LOG_RULE[@]}"
        done
        echo "Regole di isolamento di Parole attive."
        ;;
    remove)
        for chain in "${CHAINS[@]}"; do
            del_rule "$chain" "${LOG_RULE[@]}"
            del_rule "$chain" "${DROP_RULE[@]}"
        done
        echo "Regole di isolamento di Parole rimosse."
        ;;
    status)
        for chain in "${CHAINS[@]}"; do
            echo "== $chain"
            iptables -L "$chain" -v -n | grep -E "^ *[0-9].*$BRIDGE" || echo "   (nessuna regola per $BRIDGE)"
        done
        ;;
    *)
        echo "Uso: $0 [apply|remove|status]" >&2
        exit 2
        ;;
esac
