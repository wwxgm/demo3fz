# 启动本机 PWA 服务，供 iPhone Safari 访问
# 用法: python server.py

import http.server
import socket
import socketserver
import os

PORT = 8787
DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    os.chdir(DIR)
    with ThreadedHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        ip = lan_ip()
        print("=" * 50, flush=True)
        print("PWA 已启动（多线程）", flush=True)
        print(f"本机: http://127.0.0.1:{PORT}/", flush=True)
        print(f"手机请用 Safari 打开: http://{ip}:{PORT}/", flush=True)
        print("然后: 分享 -> 添加到主屏幕", flush=True)
        print("=" * 50, flush=True)
        httpd.serve_forever()
