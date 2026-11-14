"""CLI safety guards run before any production API call."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('conference_import', Path(__file__).resolve().parents[1] / 'tools/import_conference_collections.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConferenceImportGuards(unittest.TestCase):
    def reject(self, manifest, ledger, message):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'manifest.json'
            raw = json.dumps(manifest).encode()
            path.write_bytes(raw)
            state = Path(tmp) / 'ledger.json'
            if ledger is not None:
                ledger = {**ledger, 'manifest_sha256': ledger.get('manifest_sha256', hashlib.sha256(raw).hexdigest())}
                state.write_text(json.dumps(ledger))
            with patch('sys.argv', ['import', '--manifest', str(path), '--ledger', str(state), '--apply']), patch('urllib.request.urlopen') as network:
                with self.assertRaisesRegex(AssertionError, message):
                    module.main()
                network.assert_not_called()

    def test_rejects_over_budget_and_duplicate_inputs_before_network(self):
        self.reject({'collections': [{'videos': [{}] * 201}]}, None, '')
        self.reject({'collections': [{'videos': [{'id': 'duplicate'}, {'id': 'duplicate'}]}]}, None, 'globally deduplicated')

    def test_rejects_an_unrelated_or_ambiguous_ledger_before_network(self):
        manifest = {'collections': [{'slug': 'conference', 'playlist_id': 'public', 'source_url': 'https://www.youtube.com/playlist?list=public', 'videos': [{'id': 'abcdefghijk', 'url': 'https://www.youtube.com/watch?v=abcdefghijk', 'title': 'A useful talk', 'author': 'Conference', 'duration_s': 600, 'view_count': 5000}]}]}
        self.reject(manifest, {'manifest_sha256': 'wrong', 'dispatch': {}}, 'different manifest')
        self.reject(manifest, {'dispatch': {'pending': {'status': 'dispatching'}}}, 'ambiguous queue')


if __name__ == '__main__':
    unittest.main()
