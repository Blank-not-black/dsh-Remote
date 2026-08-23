#!/usr/bin/env python3
"""DSH Remote 公网反馈与中央公告服务，零第三方依赖。"""

import datetime
import hashlib
import ipaddress
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOST, PORT = '100.84.128.29', 8890
TRUSTED_PROXIES = {HOST, '127.0.0.1', '::1'}
DATA_DIR = '/home/ubuntu/feedback-collector/data'
DATA_FILE = os.path.join(DATA_DIR, 'feedback.jsonl')
ANNOUNCEMENTS_FILE = os.path.join(DATA_DIR, 'announcements.json')
MAX_MSG = 2000
MAX_ANNOUNCEMENTS_BYTES = 512 * 1024
TYPES = {'bug', 'suggestion', 'other', 'poll'}
RATE_LIMIT_SEC = 60

_lock = threading.Lock()
_last = {}


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec='seconds')


def sanitize(obj):
    allowed = {
        'type', 'message', 'contact', 'appVersion', 'gatewayVersion', 'serverInfo',
        'announcementId', 'pollId', 'optionId', 'optionLabel',
    }
    return {key: str(value)[:500] for key, value in obj.items() if key in allowed}


def mask_ip(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return 'unknown'
    if address.version == 4:
        parts = str(address).split('.')
        return '.'.join(parts[:3]) + '.x'
    network = ipaddress.ip_network(f'{address}/64', strict=False)
    return f'{network.network_address.compressed}/64'


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def version_string(self):
        return 'DSHFeedback'

    def log_message(self, fmt, *args):
        pass

    def _security_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
        self.send_header('Strict-Transport-Security', 'max-age=31536000')

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self._security_headers()
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _send_announcements(self):
        try:
            with open(ANNOUNCEMENTS_FILE, 'rb') as handle:
                body = handle.read(MAX_ANNOUNCEMENTS_BYTES + 1)
            if len(body) > MAX_ANNOUNCEMENTS_BYTES:
                raise ValueError('announcements too large')
            parsed = json.loads(body.decode('utf-8'))
            items = parsed if isinstance(parsed, list) else parsed.get('items')
            if not isinstance(items, list) or len(items) > 200:
                raise ValueError('invalid announcements payload')
        except FileNotFoundError:
            self._send(404, {'ok': False, 'error': 'announcements unavailable'})
            return
        except Exception:
            self._send(500, {'ok': False, 'error': 'invalid announcements config'})
            return

        etag = '"' + hashlib.sha256(body).hexdigest() + '"'
        not_modified = self.headers.get('If-None-Match', '').strip() == etag
        self.send_response(304 if not_modified else 200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', '0' if not_modified else str(len(body)))
        self.send_header('Cache-Control', 'public, max-age=15, must-revalidate')
        self.send_header('ETag', etag)
        self.send_header('Access-Control-Allow-Origin', '*')
        self._security_headers()
        self.end_headers()
        if not not_modified and self.command != 'HEAD':
            self.wfile.write(body)

    def _client_ip(self):
        peer = self.client_address[0]
        if peer in TRUSTED_PROXIES:
            forwarded = self.headers.get('X-Forwarded-For', '')
            for candidate in reversed([part.strip() for part in forwarded.split(',') if part.strip()]):
                try:
                    return str(ipaddress.ip_address(candidate))
                except ValueError:
                    continue
        return peer

    def do_HEAD(self):
        self.do_GET()

    def do_OPTIONS(self):
        if urlsplit(self.path).path != '/announcements.json':
            self._send(404, {'ok': False, 'error': 'not found'})
            return
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self._security_headers()
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/health':
            self._send(200, {'ok': True, 'ts': now_iso()})
        elif path == '/announcements.json':
            self._send_announcements()
        else:
            self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if urlsplit(self.path).path != '/submit':
            self._send(404, {'ok': False, 'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length <= 0 or length > 16384:
                self._send(400, {'ok': False, 'error': 'bad body size'})
                return
            data = json.loads(self.rfile.read(length).decode('utf-8', 'replace'))
        except Exception:
            self._send(400, {'ok': False, 'error': 'invalid json'})
            return

        message = str(data.get('message', '')).strip()
        feedback_type = str(data.get('type', 'other'))
        if not message or len(message) > MAX_MSG:
            self._send(400, {'ok': False, 'error': 'message required, <=2000 chars'})
            return
        if feedback_type not in TYPES:
            feedback_type = 'other'

        ip = self._client_ip()
        now = time.time()
        with _lock:
            last = _last.get(ip, 0)
            if now - last < RATE_LIMIT_SEC:
                self._send(429, {'ok': False, 'error': 'rate limited'})
                return
            _last[ip] = now

        record = {
            'ts': now_iso(),
            'ip': mask_ip(ip),
            **sanitize(data),
            'message': message,
            'type': feedback_type,
        }
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(DATA_FILE, 'a', encoding='utf-8') as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + '\n')
        except Exception as error:
            self._send(500, {'ok': False, 'error': f'write failed: {error}'})
            return
        self._send(200, {'ok': True})


if __name__ == '__main__':
    os.makedirs(DATA_DIR, exist_ok=True)
    print(f'feedback-collector listening on {HOST}:{PORT}')
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
