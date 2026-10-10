"""Deterministic policy tests. No GitHub requests or billable tasks."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'xops/agent'))
import copilot_task
import delivery
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

    def test_receipts_fail_closed(self):
        receipt = {'action':'initial', 'state':'intent', 'model':'mai-code-1.1-flash'}
        text = delivery.receipt_body(receipt)
        self.assertEqual(delivery.parse_receipt(text), receipt)
        self.assertIsNone(delivery.parse_receipt('not a receipt'))
        self.assertIsNone(delivery.parse_receipt('<!-- faac-delivery:v1 -->\n```json\n{}'))
        self.assertTrue(delivery.already_attempted([receipt], 'initial'))
        self.assertTrue(delivery.already_attempted([dict(receipt, state='uncertain')], 'initial'))
        self.assertTrue(delivery.already_attempted([dict(receipt, state='rejected')], 'initial'))

    def test_checks_require_fresh_success_and_expected_application(self):
        checks = [{'name':name, 'status':'completed', 'conclusion':'success', 'app':{'slug':'github-actions'}}
                  for name in delivery.REQUIRED_CHECKS]
        self.assertTrue(delivery.checks_green(checks))
        self.assertFalse(delivery.checks_green(checks[:-1]))
        checks[0]['conclusion'] = 'skipped'
        self.assertFalse(delivery.checks_green(checks))
        checks[0]['conclusion'] = 'success'
        checks[0]['app']['slug'] = 'unknown'
        self.assertFalse(delivery.checks_green(checks))

    def test_review_must_match_head_and_no_change_request(self):
        reviews = [{'user':{'login':delivery.REVIEWER}, 'commit_id':'new', 'state':'COMMENTED'}]
        self.assertTrue(delivery.review_green(reviews, 'new'))
        self.assertFalse(delivery.review_green(reviews, 'old'))
        reviews.append({'user':{'login':'maintainer'}, 'commit_id':'new', 'state':'CHANGES_REQUESTED'})
        self.assertFalse(delivery.review_green(reviews, 'new'))

    def test_issue_snapshot_changes_invalidate_authorization(self):
        issue = {'title':'Fix this','body':'Requirements','labels':[{'name':'kind:bugfix'}]}
        first = delivery.issue_digest(issue)
        issue['body'] += ' different requirements'
        self.assertNotEqual(first, delivery.issue_digest(issue))

    def test_unknown_post_result_never_resubmitted(self):
        class Fake:
            def __init__(self): self.comments=[]; self.posts=0
            def request(self, path, method='GET', body=None):
                if path.endswith('/comments') and method == 'POST':
                    self.comments.append(body['body']); return {'id':len(self.comments)}
                if method == 'PATCH': return {}
                self.posts += 1
                raise copilot_task.ApiError('uncertain', 0)
        fake=Fake()
        with self.assertRaises(copilot_task.ApiError):
            delivery.recorded_action(fake, 'repos/test/repo/issues/1', 'initial', {'model':'mai-code-1.1-flash'},
                lambda: fake.request('agents/repos/test/repo/tasks', 'POST', {}))
        self.assertEqual(fake.posts, 1)
        self.assertTrue(delivery.already_attempted([delivery.parse_receipt(fake.comments[0])], 'initial'))

if __name__ == '__main__': unittest.main()
