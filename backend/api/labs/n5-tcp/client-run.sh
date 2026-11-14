#!/bin/sh
# N5 ラボの client 側証拠収集。引数：--connect-timeout 秒数（整数）。
# 実行環境（SYN 再送を決める sysctl）を記録し、tcpdump を張った状態で curl を実行し、
# 開始約1秒後に ss を取り、区切り付きで全出力を返す。
# sysctl はコンテナ作成時に HostConfig.Sysctls で設定する（src/pilot/lab/runner.ts の CLIENT_SYSCTLS）。
# ここでは設定を変えず、実際に効いている値を読むだけ（/proc/sys は読み取り専用でマウントされる）。
T="$1"
case "$T" in ''|*[!0-9]*) echo "invalid timeout" >&2; exit 2 ;; esac
rm -f /tmp/cap.txt /tmp/cap.err /tmp/curl.txt /tmp/ss.txt
echo '=====lab-env'
for k in net.ipv4.tcp_syn_linear_timeouts net.ipv4.tcp_syn_retries; do
  f="/proc/sys/$(echo "$k" | tr . /)"
  if [ -r "$f" ]; then echo "$k=$(cat "$f")"; else echo "$k=absent"; fi
done
echo "kernel.osrelease=$(uname -r)"
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
