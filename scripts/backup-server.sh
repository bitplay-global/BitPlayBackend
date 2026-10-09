#!/usr/bin/env bash
# Full server backup into /home/pi/backups, as two archives:
#
#   bitplay-<UTC timestamp>.tar.gz       database export, config and keys, Bitcoin wallets
#   bitplay-logs-<UTC timestamp>.tar.gz  pm2 logs (large)
#
# Run as the user that owns the services and bitcoind:
#   sudo -u pi bash /home/pi/btc-mining-backend/scripts/backup-server.sh
#
# Reads only; the database export is read-only. The archives hold every
# secret on the server (.env files, keys, wallet files): they are created
# with mode 600 in a mode-700 folder. Keep the downloaded copies private.
set -euo pipefail
umask 077

BACKEND=/home/pi/btc-mining-backend
AUTH=/home/pi/bitcoin_mining_api
BTC_DIR=/home/pi/.bitcoin
PM2_DIR=/home/pi/.pm2
ROOT=/home/pi/backups
TS=$(date -u +%Y%m%d-%H%M)
NAME="bitplay-$TS"
DIR="$ROOT/$NAME"

mkdir -p "$DIR"/{database,config,wallets}
chmod 700 "$ROOT" "$DIR"
echo "backup folder: $DIR"

echo
echo "== 1/4 database =="
( cd "$BACKEND" && node scripts/backup-database.js --out "$DIR/database" )

echo
echo "== 2/4 config and keys =="
for f in "$BACKEND"/.env*; do [ -f "$f" ] && cp -p "$f" "$DIR/config/backend$(basename "$f" | sed 's/^\.env//')".env && echo "  backend $(basename "$f")"; done
for f in "$AUTH"/.env*; do [ -f "$f" ] && cp -p "$f" "$DIR/config/auth$(basename "$f" | sed 's/^\.env//')".env && echo "  auth $(basename "$f")"; done
for f in /home/pi/btc-original-key.env "$BTC_DIR/bitcoin.conf" "$PM2_DIR/dump.pm2"; do
  [ -f "$f" ] && cp -p "$f" "$DIR/config/" && echo "  $(basename "$f")"
done

echo
echo "== 3/4 Bitcoin wallets =="
# Loaded wallets are copied by the node itself (consistent while running);
# wallets that are not loaded are plain files and are archived as they are.
LOADED=$(bitcoin-cli listwallets | tr -d '[]", ' | sed '/^$/d')
for w in $LOADED; do
  bitcoin-cli -rpcwallet="$w" backupwallet "$DIR/wallets/$w.loaded-backup"
  echo "  $w (loaded, via backupwallet)"
done
EXCLUDES=()
for w in $LOADED; do EXCLUDES+=(--exclude="./$w"); done
tar -C "$BTC_DIR/wallets" "${EXCLUDES[@]}" -czf "$DIR/wallets/not-loaded-wallets.tar.gz" .
echo "  not-loaded wallets: $(tar -tzf "$DIR/wallets/not-loaded-wallets.tar.gz" | grep -c . ) entries"

( cd "$DIR" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + | sort -k2 > SHA256SUMS )

tar -C "$ROOT" -czf "$ROOT/$NAME.tar.gz" "$NAME"
chmod 600 "$ROOT/$NAME.tar.gz"
rm -rf "$DIR"

echo
echo "== 4/4 pm2 logs (large, takes a few minutes) =="
set +e
tar -C "$PM2_DIR" --warning=no-file-changed -czf "$ROOT/bitplay-logs-$TS.tar.gz" logs
rc=$?
set -e
[ $rc -le 1 ] || { echo "log archive failed (tar exit $rc)"; exit $rc; }
chmod 600 "$ROOT/bitplay-logs-$TS.tar.gz"

echo
echo "== done =="
ls -lh "$ROOT/$NAME.tar.gz" "$ROOT/bitplay-logs-$TS.tar.gz"
echo
echo "checksums (to verify the download):"
( cd "$ROOT" && sha256sum "$NAME.tar.gz" "bitplay-logs-$TS.tar.gz" )
echo
echo "timestamp: $TS"
