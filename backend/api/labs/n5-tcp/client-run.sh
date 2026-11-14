#!/bin/sh
# N5 ラボの client 側証拠収集。引数：--connect-timeout 秒数（整数）。
# tcpdump を張った状態で curl を実行し、開始約1秒後に ss を取り、区切り付きで全出力を返す。
T="$1"
case "$T" in ''|*[!0-9]*) echo "invalid timeout" >&2; exit 2 ;; esac
tcpdump -nn -tt -l -i eth0 'tcp port 8080' > /tmp/cap.txt 2> /tmp/cap.err &
TP=$!
sleep 1
( curl -sS -o /dev/null -w 'time_total=%{time_total} http_code=%{http_code}\n' \
    --connect-timeout "$T" --max-time 20 http://server:8080/ > /tmp/curl.txt 2>&1
  echo "exit=$?" >> /tmp/curl.txt ) &
CP=$!
sleep 1
ss -tan > /tmp/ss.txt
wait "$CP"
sleep 0.5
kill -INT "$TP"
wait "$TP" 2>/dev/null
echo '=====tcpdump'
cat /tmp/cap.txt
grep 'packets captured' /tmp/cap.err
echo '=====ss-client'
cat /tmp/ss.txt
echo '=====curl'
cat /tmp/curl.txt
