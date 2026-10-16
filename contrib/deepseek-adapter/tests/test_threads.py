"""HTTP regression tests; no upstream requests or real credentials."""
import http.client
import importlib.machinery
import importlib.util
import json
import pathlib
import threading
import types
import unittest

loader = importlib.machinery.SourceFileLoader('adapter', str(pathlib.Path(__file__).resolve().parents[1] / 'deepseek-adapter'))
spec = importlib.util.spec_from_loader(loader.name, loader)
adapter = importlib.util.module_from_spec(spec)
loader.exec_module(adapter)


class TestThreads(unittest.TestCase):
    def setUp(self):
        self.forwarded = []
        forwarded = self.forwarded

        class Handler(adapter.Handler):
            config = types.SimpleNamespace(
                placeholder='test-placeholder', model_map={}, model_map_lower={},
                disable_thinking_for_lower=set(), force_no_thinking_for_lower=set(),
            )

            def log_message(self, *args):
                pass

            def _proxy(self, path, body, *, streaming):
                forwarded.append(json.loads(body))
                self._send_json(200, {'ok': True})

        self.server = adapter.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()

    def post(self, payload, key='test-placeholder'):
        conn = http.client.HTTPConnection(*self.server.server_address)
        conn.request('POST', '/v1/messages', json.dumps(payload), {
            'Content-Type': 'application/json', 'x-api-key': key,
        })
        response = conn.getresponse()
        status, data = response.status, json.loads(response.read())
        conn.close()
        return status, data

    def test_create_and_continue_require_stateless_retry(self):
        threads = ({'type': 'create'}, {'type': 'continue', 'previous_message_id': 'msg_test'})
        for model in ('deepseek-v4-pro', 'deepseek-v4-flash'):
            for stream in (False, True):
                for thread in threads:
                    with self.subTest(model=model, stream=stream, thread=thread):
                        status, data = self.post({'model': model, 'stream': stream, 'thread': thread})
                        self.assertEqual(status, 400)
                        self.assertEqual(data['error']['type'], 'invalid_request_error')
                        self.assertEqual(data['error']['details']['error_code'], 'thread_unsupported_request')
        self.assertEqual(self.forwarded, [])

    def test_thread_requests_still_require_the_placeholder_credential(self):
        for thread in ({'type': 'create'},):
            with self.subTest(thread=thread):
                status, data = self.post({'model': 'deepseek-v4-pro', 'thread': thread}, key='wrong')
                self.assertIn(status, (401, 403))
                self.assertNotEqual(data['error'].get('details', {}).get('error_code'), 'thread_unsupported_request')
        self.assertEqual(self.forwarded, [])

    def test_full_retry_preserves_tools_system_and_messages(self):
        payload = {
            'model': 'deepseek-v4-pro', 'system': 'Use the supplied tools.',
            'messages': [{'role': 'user', 'content': 'Check the working directory.'}],
            'tools': [{'name': 'Bash', 'input_schema': {'type': 'object'}}],
            'stream': True,
        }
        self.assertEqual(self.post(payload)[0], 200)
        self.assertEqual(self.forwarded, [payload])

    def test_stateless_text_requests_still_work(self):
        payload = {'model': 'deepseek-v4-flash', 'messages': [{'role': 'user', 'content': 'Hello'}]}
        self.assertEqual(self.post(payload)[0], 200)
        self.assertEqual(self.forwarded[0]['model'], 'deepseek-flash')


if __name__ == '__main__':
    unittest.main()
