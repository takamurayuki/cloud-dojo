# N5「TCP接続」ラボのノードイメージ（client / server 共通）。
# ラボは internal ネットワークで動き外部へ出られないため、必要な道具はビルド時に入れておく。
FROM alpine:3.20
RUN apk add --no-cache curl iproute2 tcpdump iptables python3 procps
COPY server.py /lab/server.py
COPY client-run.sh /lab/client-run.sh
CMD ["sleep", "infinity"]
