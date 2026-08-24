#!/bin/bash
# Litestream memory-vs-database-count measurement. Disposable instance.
# BACKSTOP FIRST, before anything that can fail: combined with
# --instance-initiated-shutdown-behavior terminate, this instance cannot
# outlive 150 minutes even if every line below hangs.
shutdown -h +150 &

set -x
exec > >(tee /var/log/loadtest.log) 2>&1

BUCKET="p-c3fb06fc-5723-4d74-a6a5-7d-replicabucketb570b599-y0opmtqgtut7"
OUT="s3://${BUCKET}/_loadtest/$(date +%Y%m%dT%H%M%S)"
LS_VER="v0.5.14"

# Leading hypothesis for litestream dying at 10000 databases on 2026-08-24:
# file-descriptor exhaustion (it was NOT memory — 31 GB were free). Raise the
# limit so the run measures litestream rather than the shell's default, and
# record the value so the result can be interpreted either way.
ulimit -n 200000 || ulimit -n 65535 || true
echo "ULIMIT_N=$(ulimit -n)"

cd /root
curl -fsSL -o ls.tgz "https://github.com/benbjohnson/litestream/releases/download/${LS_VER}/litestream-0.5.14-linux-arm64.tar.gz"
tar xzf ls.tgz && install -m 0755 litestream /usr/local/bin/litestream
litestream version

# Writes a 0.5.x config with the cadence we actually ship in production, so the
# timers under measurement are the real ones.
mkconf() {  # $1 = count, $2 = replica base url
  local n="$1" base="$2"
  { echo "l0-retention: 3h"
    echo "l0-retention-check-interval: 30m"
    echo "levels:"; echo "  - interval: 30m"; echo "  - interval: 2h"; echo "  - interval: 6h"
    echo "snapshot:"; echo "  interval: 6h"; echo "  retention: 72h"
    echo "dbs:"
    for i in $(seq 1 "$n"); do
      echo "  - path: /data/db${i}/app.db"
      echo "    replica:"
      echo "      url: ${base}/db${i}/app.db"
      echo "      sync-interval: 1000ms"
    done
  } > /root/litestream.yml
}

# N real WAL-mode SQLite databases. Empty, which is the shape of the fleet:
# 60 of 61 production databases hold almost nothing.
mkdbs() {
  local n="$1"
  rm -rf /data; mkdir -p /data
  python3 - "$n" <<'PYEOF'
import sqlite3, sys, os
n = int(sys.argv[1])
for i in range(1, n + 1):
    d = f"/data/db{i}"
    os.makedirs(d, exist_ok=True)
    c = sqlite3.connect(f"{d}/app.db")
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE IF NOT EXISTS t(x)")
    c.execute("INSERT INTO t VALUES (1)")
    c.commit(); c.close()
PYEOF
}

rss_kb() { awk '/^VmRSS:/{print $2}' /proc/$1/status 2>/dev/null; }

run_tier() {  # $1 = count, $2 = replica base, $3 = label
  local n="$1" base="$2" label="$3"
  echo "=== TIER ${label} n=${n}"
  mkdbs "$n"
  mkconf "$n" "$base"
  local t0=$(date +%s)
  litestream replicate -config /root/litestream.yml > /root/ls-${label}-${n}.log 2>&1 &
  local pid=$!
  # Settle to the PLATEAU, not the boot spike. S3 needs far longer than a file
  # backend: the 2026-08-24 run sampled s3/2500 while it was still uploading and
  # got 2.2 GB falling to 0.8 GB across 75s — a slope, not a level, and useless.
  # Scale the wait with N as well, since the upload is per database.
  local settle=120
  [ "$label" = "s3" ] && settle=$(( 300 + n / 5 ))
  sleep "$settle"
  local alive=1; kill -0 $pid 2>/dev/null || alive=0
  local fds=0; [ "$alive" = "1" ] && fds=$(ls /proc/$pid/fd 2>/dev/null | wc -l)
  local samples=""
  for k in 1 2 3 4 5; do samples="${samples} $(rss_kb $pid)"; sleep 15; done
  local t1=$(date +%s)
  local dbs_open=$(grep -c "opened database\|init db\|monitoring" /root/ls-${label}-${n}.log 2>/dev/null || echo 0)
  [ "$alive" = "1" ] || echo "!!! ${label} ${n}: litestream WAS NOT RUNNING at sample time — see ls-${label}-${n}.log"
  echo "RESULT ${label} ${n} rss_kb_samples:${samples} alive:${alive} fds:${fds} elapsed:$((t1-t0)) dbs_log:${dbs_open} mem_avail_kb:$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
  echo "{\"label\":\"${label}\",\"n\":${n},\"rss_kb_samples\":\"${samples}\",\"alive\":${alive},\"open_fds\":${fds},\"ulimit_n\":$(ulimit -n),\"mem_avail_kb\":$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)}" >> /root/results.jsonl
  kill $pid 2>/dev/null; sleep 8; kill -9 $pid 2>/dev/null
  # Ship litestream's OWN log for this tier. The 2026-08-24 run lost the reason
  # litestream died at 10000 databases because only the shell trace was
  # uploaded, and the instance then destroyed itself with the evidence on it.
  # A test that cannot explain its own most important result is half a test.
  aws s3 cp "/root/ls-${label}-${n}.log" "${OUT}/ls-${label}-${n}.log" --region eu-west-1 || true
  aws s3 cp /root/results.jsonl "${OUT}/results.jsonl" --region eu-west-1 || true
  aws s3 cp /var/log/loadtest.log "${OUT}/loadtest.log" --region eu-west-1 || true
}

# Curve on file:// replicas — isolates litestream's own per-database memory
# from any network variance.
for n in 500 1000 2500 5000 10000; do run_tier "$n" "file:///replicas" "file"; done

# The open reserve: does the S3 client hold per-database state the file backend
# does not? Same counts, only the backend differs — so the comparison is clean.
for n in 500 2500; do run_tier "$n" "s3://${BUCKET}/_loadtest_replicas" "s3"; done

aws s3 cp /root/results.jsonl "${OUT}/results.jsonl" --region eu-west-1 || true
aws s3 cp /var/log/loadtest.log "${OUT}/loadtest.log" --region eu-west-1 || true
echo "DONE ${OUT}"
shutdown -h now
