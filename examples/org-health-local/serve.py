#!/usr/bin/env python3
"""Serve the static diagnostic site on IPv4 loopback only."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

class LocalOnlyHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        if self.headers.get('Host') not in ('127.0.0.1:8765', 'localhost:8765'):
            self.send_error(403)
            return None
        if self.path.split('?', 1)[0] not in ('/', '/index.html', '/app.js', '/styles.css', '/data/diagnosis.json'):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, format, *args):
        # Keep requests local and avoid writing request details to a log.
        pass

if __name__ == '__main__':
    address = ('127.0.0.1', 8765)
    print(f'组织健康诊断网站: http://{address[0]}:{address[1]}')
    ThreadingHTTPServer(address, LocalOnlyHandler).serve_forever()
