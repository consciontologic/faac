"""Transport regression: immutable PR evidence and Copilot use separate contracts."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'xops/agent'))
import copilot_task
import release_evidence


class Response:
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *args): return None
    def read(self, limit): return json.dumps(self.data).encode()


class Opener:
    def __init__(self): self.requests = []
    def open(self, request, timeout):
        self.requests.append(request)
        # GitHub's documented breaking change: the new API omits this field.
        data = {'merged': True}
        if request.get_header('X-github-api-version') == '2022-11-28':
            data['merge_commit_sha'] = 'a' * 40
        return Response(data)


class ApiContracts(unittest.TestCase):
    def test_release_transport_pins_merge_contract_and_task_default_stays_current(self):
        opener = Opener()
        with patch.object(copilot_task.urllib.request, 'build_opener', return_value=opener):
            evidence = release_evidence.release_client('fake-token')
            result = evidence.request('repos/consciontologic/faac/pulls/1')
            task_client = copilot_task.GitHub('fake-token')
            task_client.request('agents/repos/consciontologic/faac/tasks', 'POST', {'model': 'mai-code-1.1-flash'})
        self.assertEqual(result['merge_commit_sha'], 'a' * 40)
        self.assertEqual([request.get_header('X-github-api-version') for request in opener.requests],
                         ['2022-11-28', '2026-03-10'])
        self.assertEqual([request.get_method() for request in opener.requests], ['GET', 'POST'])
        self.assertEqual(json.loads(opener.requests[1].data)['model'], 'mai-code-1.1-flash')

    def test_invalid_or_unreviewed_version_fails_before_transport(self):
        for version in ('', 'latest', '2026-03-11', '2022-11-28\r\nOther: injected', None, []):
            with self.subTest(version=version), patch.object(copilot_task.urllib.request, 'build_opener') as opener:
                with self.assertRaisesRegex(ValueError, 'Unsupported GitHub API version'):
                    copilot_task.GitHub('fake-token', api_version=version)
                opener.assert_not_called()


if __name__ == '__main__': unittest.main()
