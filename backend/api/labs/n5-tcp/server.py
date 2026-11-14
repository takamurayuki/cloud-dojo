# N5 ラボの server：8080 で待ち受け、1.5 秒の処理時間の後に HTTP/1.0 で応答して server 側から閉じる
# （server 側のソケットが TIME_WAIT に残る）。SERVER_DELAY_SEC は src/pilot/evidence/parse.ts と一致させる。
import http.server
import time

SERVER_DELAY_SEC = 1.5


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        time.sleep(SERVER_DELAY_SEC)
        body = b"ok\n"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
