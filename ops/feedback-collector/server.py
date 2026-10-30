#!/usr/bin/env python3
"""DSH Remote 公网反馈与中央公告服务，零第三方依赖。"""

import datetime
import hashlib
import ipaddress
import json
import math
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOST, PORT = '100.84.128.29', 8890
TRUSTED_PROXIES = {HOST, '127.0.0.1', '::1'}
DATA_DIR = '/home/ubuntu/feedback-collector/data'
DATA_FILE = os.path.join(DATA_DIR, 'feedback.jsonl')
ANNOUNCEMENTS_FILE = os.path.join(DATA_DIR, 'announcements.json')
MAX_MSG = 20000
MAX_POLL_MSG = 2000
# Match JavaScript String.trim exactly; Python strip also removes NEL and some
# controls that the client keeps, which would silently change the saved report.
JS_TRIM_CHARS = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
MAX_ANNOUNCEMENTS_BYTES = 512 * 1024
TYPES = {'bug', 'suggestion', 'other', 'poll'}
RATE_LIMIT_SEC = 60
MAX_BODY_BYTES = 256 * 1024
with open(os.path.join(os.path.dirname(__file__), 'diagnostic-schema.json'), encoding='utf-8') as _schema_file:
    DIAGNOSTIC_SCHEMA = json.load(_schema_file)

_lock = threading.Lock()
_last = {}


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec='seconds')


def sanitize(obj):
    allowed = {
        'type', 'message', 'contact', 'appVersion', 'gatewayVersion', 'serverInfo',
        'announcementId', 'pollId', 'optionId', 'optionLabel',
    }
    result = {key: str(value)[:500] for key, value in obj.items() if key in allowed}
    if obj.get('includeDiagnostics') is True:
        client = sanitize_client_report(obj.get('clientDiagnostics'))
        if client:
            result['clientDiagnostics'] = client
        gateway = sanitize_gateway_report(obj.get('diagnostics'))
        if gateway:
            result['diagnostics'] = gateway
    return result


def number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def hex_value(value, length):
    return value if isinstance(value, str) and re.fullmatch('[a-f0-9]{%d}' % length, value) else None


def diagnostic_facts(value):
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, allowed in DIAGNOSTIC_SCHEMA['enums'].items():
        if value.get(key) in allowed:
            result[key] = value[key]
    for key in DIAGNOSTIC_SCHEMA['numbers']:
        if number(value.get(key)):
            result[key] = min(value[key], 9007199254740991)
    for key in DIAGNOSTIC_SCHEMA['booleans']:
        if type(value.get(key)) is bool:
            result[key] = value[key]
    if value.get('method') in DIAGNOSTIC_SCHEMA['methods']:
        result['method'] = value['method']
    for key in ('sessionRef', 'serverRef', 'announcementRef', 'traceId'):
        checked = hex_value(value.get(key), 24 if key == 'traceId' else 16)
        if checked:
            result[key] = checked
    if isinstance(value.get('frames'), list):
        files = {'app.js', 'desktop.js', 'history.js', 'activity.js', 'turn-results.js', 'network.js', 'operations.js', 'diagnostics.js'}
        result['frames'] = [dict(file=row['file'], line=row['line'], column=row['column'])
                            for row in value['frames'][:3] if isinstance(row, dict) and isinstance(row.get('file'), str) and row.get('file') in files
                            and all(type(row.get(key)) is int and 0 < row[key] <= 9007199254740991 for key in ('line', 'column'))]
    return result


def sanitize_client_report(value):
    if not isinstance(value, dict) or type(value.get('schema')) is bool or value.get('schema') != 1 or not isinstance(value.get('events'), list):
        return None
    client = value.get('client') if isinstance(value.get('client'), dict) else {}
    version = client.get('version')
    valid_version = isinstance(version, str) and re.fullmatch(r'\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]{1,30})?', version)
    report = {
        'schema': 1, 'reportId': hex_value(value.get('reportId'), 24) or '0' * 24,
        'capturedAt': value.get('capturedAt') if number(value.get('capturedAt')) else 0,
        'client': {'version': version if valid_version else 'unknown', 'buildId': hex_value(client.get('buildId'), 64) or 'unknown',
                   'surface': client.get('surface') if client.get('surface') in ('mobile', 'desktop') else 'mobile'},
        'snapshot': diagnostic_facts(value.get('snapshot')), 'events': []
    }
    critical = lambda row: row.get('kind') == 'client.error' or row.get('phase') == 'failed'
    events = [dict(at=row['at'], kind=row['kind'], **diagnostic_facts(row)) for row in value['events']
              if isinstance(row, dict) and row.get('kind') in DIAGNOSTIC_SCHEMA['kinds'] and number(row.get('at'))]
    errors = [i for i, row in enumerate(events) if critical(row)][-DIAGNOSTIC_SCHEMA['MAX_CRITICAL']:]
    keep = set(errors + list(range(max(0, len(events) - (DIAGNOSTIC_SCHEMA['MAX_EVENTS'] - len(errors))), len(events))))
    report['events'] = [row for i, row in enumerate(events) if i in keep]
    if isinstance(value.get('persistence'), dict):
        report['persistence'] = {key: status for key, status in value['persistence'].items()
                                 if key in ('local', 'session', 'indexeddb') and status in ('unknown', 'saved', 'failed', 'unavailable', 'pending')}
    while report['events'] and len(json.dumps(report, separators=(',', ':'), ensure_ascii=False)) > DIAGNOSTIC_SCHEMA['MAX_BYTES']:
        index = next((i for i, row in enumerate(report['events']) if not critical(row)), 0)
        report['events'].pop(index)
    return report


def sanitize_gateway_report(value):
    if not isinstance(value, dict) or value.get('schema') != 1:
        return None
    result = {'schema': 1}
    gateway = value.get('gateway')
    if isinstance(gateway, dict):
        result['gateway'] = {key: item for key, item in gateway.items() if key in ('version', 'protocol', 'platform', 'node')
                             and isinstance(item, (str, int)) and re.fullmatch(r'[a-zA-Z0-9._-]{1,60}', str(item))}
    result['events'] = {}
    for channel, facts in (value.get('events') or {}).items() if isinstance(value.get('events'), dict) else []:
        if channel in ('mux', 'host') and isinstance(facts, dict):
            result['events'][channel] = {key: item for key, item in facts.items()
                                         if key == 'connected' and type(item) is bool
                                         or key in ('reconnects', 'lastCloseCode') and number(item)
                                         or key == 'lastError' and item in ('', 'timeout', 'authentication', 'method-unavailable', 'transport', 'upstream-error')}
    if isinstance(value.get('upstream'), dict):
        result['upstream'] = {key: item for key, item in value['upstream'].items() if key in ('apiFlavor', 'collectorFlavor')
                              and item in ('', 'unknown', 'modern', 'legacy', 'remote', 'slash')}
    kinds = {'protocol-switch', 'protocol-probe-failed', 'generated-rpc-error', 'legacy-rpc-error', 'legacy-404-fallback', 'modern-legacy-fallback', 'collector-mode', 'operation-result'}
    result['recent'] = []
    for row in value.get('recent', [])[-20:] if isinstance(value.get('recent'), list) else []:
        if isinstance(row, dict) and isinstance(row.get('kind'), str) and row.get('kind') in kinds:
            item = {'kind': row['kind'], **diagnostic_facts(row)}
            if number(row.get('status')):
                item['status'] = row['status']
            result['recent'].append(item)
    return result


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
            if length <= 0 or length > MAX_BODY_BYTES:
                self.close_connection = True
                self._send(400, {'ok': False, 'error': 'bad body size'})
                return
            data = json.loads(self.rfile.read(length).decode('utf-8', 'replace'))
            if not isinstance(data, dict):
                raise ValueError('expected an object')
        except Exception:
            self._send(400, {'ok': False, 'error': 'invalid json'})
            return

        message = str(data.get('message', '')).strip(JS_TRIM_CHARS)
        feedback_type = str(data.get('type', 'other'))
        limit = MAX_POLL_MSG if feedback_type == 'poll' else MAX_MSG
        if not message or len(message.encode('utf-16-le', 'surrogatepass')) // 2 > limit:
            self._send(400, {'ok': False, 'error': 'message required or too long', 'max': limit})
            return
        if feedback_type not in TYPES:
            feedback_type = 'other'

        ip = self._client_ip()
        now = time.time()
        record = {
            'ts': now_iso(),
            'ip': mask_ip(ip),
            **sanitize(data),
            'message': message,
            'type': feedback_type,
        }
        with _lock:
            if now - _last.get(ip, 0) < RATE_LIMIT_SEC:
                self._send(429, {'ok': False, 'error': 'rate limited'})
                return
            try:
                os.makedirs(DATA_DIR, exist_ok=True)
                with open(DATA_FILE, 'a', encoding='utf-8') as handle:
                    handle.write(json.dumps(record, ensure_ascii=False) + '\n')
                    handle.flush()
                    os.fsync(handle.fileno())
                _last[ip] = now
            except Exception:
                self._send(500, {'ok': False, 'error': 'write failed'})
                return
        reply = {'ok': True, 'messageSha256': hashlib.sha256(message.encode('utf-8')).hexdigest()}
        if record.get('clientDiagnostics'):
            reply['clientDiagnosticsReceived'] = record['clientDiagnostics']['reportId']
        self._send(200, reply)


if __name__ == '__main__':
    os.makedirs(DATA_DIR, exist_ok=True)
    print(f'feedback-collector listening on {HOST}:{PORT}')
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
