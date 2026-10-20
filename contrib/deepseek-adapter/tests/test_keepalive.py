"""Exercise failures on a real reused inbound connection without provider calls."""
import http.client
import importlib.machinery
import importlib.util
import io
import json
import pathlib
import threading
import types
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('keepalive_adapter', str(pathlib.Path(__file__).resolve().parents[1] / 'deepseek-adapter'))
spec = importlib.util.spec_from_loader(loader.name, loader)
adapter = importlib.util.module_from_spec(spec)
loader.exec_module(adapter)


class TestKeepalive(unittest.TestCase):
    def setUp(self):
        class Handler(adapter.Handler):
            config = types.SimpleNamespace(
                placeholder='test-placeholder', model_map={}, model_map_lower={},
                disable_thinking_for_lower=set(), force_no_thinking_for_lower=set(),
                upstream_host='upstream.invalid', upstream_base='/anthropic',
                api_key='test-upstream-key', timeout=1,
            )

            def log_message(self, *args):
                pass

        self.server = adapter.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.conn = http.client.HTTPConnection(*self.server.server_address, timeout=2)

    def tearDown(self):
        self.conn.close()
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()

    def post(self, stream=False):
        self.conn.request('POST', '/v1/messages', json.dumps({
            'model': 'deepseek-v4-pro', 'messages': [{'role': 'user', 'content': 'hi'}],
            'stream': stream,
        }), {'Content-Type': 'application/json', 'x-api-key': 'test-placeholder'})
        return self.conn.getresponse()

    def test_failure_after_previous_success_returns_502_on_same_socket(self):
        response = types.SimpleNamespace(status=200, getheaders=lambda: [], read=io.BytesIO(b'{"ok":true}').read)
        first = types.SimpleNamespace(request=lambda *a, **kw: None, getresponse=lambda: response, close=lambda: None)
        def disconnected():
            raise http.client.RemoteDisconnected('synthetic upstream disconnect')
        second = types.SimpleNamespace(request=lambda *a, **kw: None, getresponse=disconnected, close=lambda: None)
        with patch.object(adapter.http.client, 'HTTPSConnection', side_effect=[first, second]):
            r = self.post()
            self.assertEqual(r.status, 200)
            self.assertEqual(json.loads(r.read()), {'ok': True})
            socket = self.conn.sock
            r = self.post()
            self.assertEqual(r.status, 502)
            self.assertEqual(r.getheader('Connection'), 'close')
            self.assertIn('RemoteDisconnected', json.loads(r.read())['error']['message'])
            self.assertIsNotNone(socket)

    def test_failure_after_stream_headers_does_not_inject_another_response(self):
        def broken_read(*args):
            raise http.client.RemoteDisconnected('synthetic stream disconnect')
        response = types.SimpleNamespace(status=200, getheaders=lambda: [], read=broken_read)
        upstream = types.SimpleNamespace(request=lambda *a, **kw: None, getresponse=lambda: response, close=lambda: None)
        with patch.object(adapter.http.client, 'HTTPSConnection', return_value=upstream):
            r = self.post(stream=True)
            self.assertEqual(r.status, 200)
            with self.assertRaises(http.client.IncompleteRead):
                r.read()


if __name__ == '__main__':
    unittest.main()
