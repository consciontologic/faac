"""Deterministic policy tests. No GitHub requests or billable tasks."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
import os
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'xops/agent'))
import copilot_task
import gitflow

class Policies(unittest.TestCase):
    def test_compare_route_allows_git_three_dot_but_rejects_traversal(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self, limit): return b'{"ahead_by": 0}'
        class Opener:
            def __init__(self): self.urls=[]
            def open(self, request, timeout): self.urls.append(request.full_url); return Response()
        client=copilot_task.GitHub('fake-token')
        client.opener=Opener()
        route='repos/consciontologic/faac/compare/develop...main'
        self.assertEqual(client.request(route), {'ahead_by':0})
        self.assertEqual(client.opener.urls, ['https://api.github.com/'+route])
        for bad in ('repos/../user','repos/./user','repos/%2e%2e/user','/user','https://elsewhere/user'):
            with self.assertRaises(ValueError): client.request(bad)

    def test_gitflow_lanes(self):
        self.assertEqual(gitflow.plan('feature', 'safe-tools'), ('feature/safe-tools', 'origin/develop'))
        self.assertEqual(gitflow.plan('hotfix', 'crash'), ('hotfix/crash', 'origin/main'))
        self.assertTrue(gitflow.valid_lane('develop', 'main'))
        self.assertTrue(gitflow.valid_lane('main', 'develop'))
        self.assertTrue(gitflow.valid_lane('codex/feature/safe-tools', 'develop'))
        self.assertFalse(gitflow.valid_lane('feature/unsafe', 'main'))
        with self.assertRaises(ValueError): gitflow.plan('release', '1.2')
        with self.assertRaises(ValueError): gitflow.plan('feature', '../bad')

    def test_explicit_single_model(self):
        self.assertEqual(copilot_task.model_order(), ['mai-code-1.1-flash'])
        body = copilot_task.payload('feature', 'Add tests')
        self.assertEqual(body['model'], 'mai-code-1.1-flash')
        self.assertEqual(body['base_ref'], 'develop')
        self.assertNotIn('head_ref', body)
        self.assertEqual(copilot_task.payload('hotfix', 'Fix crash')['base_ref'], 'main')
        with self.assertRaises(ValueError): copilot_task.payload('release', 'Bump', release_version='next')
        self.assertEqual(copilot_task.payload('release', 'Bump', release_version='0.2.0')['base_ref'], 'develop')

    def test_release_commands_require_unprefixed_semver(self):
        for version in ('v0.1.0', 'faac-0.1.0', 'release-0.1.0'):
            with self.subTest(version=version):
                with self.assertRaises(ValueError):gitflow.plan('release',version)
                with self.assertRaises(ValueError):copilot_task.payload('release','Prepare release',release_version=version)
        branch,base=gitflow.plan('release','0.1.0')
        self.assertEqual((branch,base),('release/0.1.0','origin/develop'))
        self.assertIn('Prepare version 0.1.0',copilot_task.payload('release','Prepare release',release_version='0.1.0')['prompt'])


    def test_local_submission_persists_intent_and_never_reuses_receipt(self):
        for result in ('accepted', 'uncertain', 'crash', 'malformed'):
            with self.subTest(result=result), tempfile.TemporaryDirectory() as directory:
                prompt=Path(directory)/'prompt.txt';prompt.write_text('Add a test')
                receipt=Path(directory)/'receipt.json';calls=[]
                class Client:
                    def __init__(self, token): pass
                    def request(self,path,method,body):
                        calls.append((path,method,body))
                        self_intent=json.loads(receipt.read_text())
                        assert self_intent['state']=='intent'
                        assert self_intent['model']=='mai-code-1.1-flash'
                        if result=='crash':raise KeyboardInterrupt()
                        if result=='uncertain':raise copilot_task.ApiError('uncertain',0)
                        if result=='malformed':return {'id':'task'}
                        return {'id':'task','state':'queued','html_url':'https://github.com/'+copilot_task.REPO+'/tasks/task'}
                argv=['copilot_task.py','feature','--prompt-file',str(prompt),'--submit','--receipt',str(receipt)]
                with patch.object(sys,'argv',argv),patch.object(copilot_task,'GitHub',Client),patch('builtins.print'):
                    try:copilot_task.main()
                    except (SystemExit,KeyboardInterrupt):pass
                    state=json.loads(receipt.read_text())['state']
                    self.assertEqual(state,{'accepted':'queued','uncertain':'uncertain','crash':'intent','malformed':'uncertain'}[result])
                    with self.assertRaises(FileExistsError):copilot_task.main()
                self.assertEqual(len(calls),1)
                self.assertEqual(calls[0][2]['model'],'mai-code-1.1-flash')

    def test_copilot_hotfix_prompt_explains_required_label(self):
        self.assertIn('work:hotfix',copilot_task.payload('hotfix','Fix crash')['prompt'])

if __name__ == '__main__': unittest.main()
