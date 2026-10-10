"""Exercise actual workflow predicates and the read-only GitFlow PR gate."""
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'xops/agent'))
import gitflow

REPO = 'consciontologic/faac'


def pr(head='anything', base='develop', repo=REPO, labels=()):
    return {'number': 8, 'head': {'ref': head, 'sha': 'a'*40, 'repo': {'full_name': repo}},
            'base': {'ref': base, 'sha': 'b'*40, 'repo': {'full_name': REPO}},
            'labels': [{'name': label} for label in labels]}


def expression(source, values):
    """Small parser for the actual Actions condition; never eval workflow text."""
    tokens = re.findall(r"==|&&|\|\||[(),]|'[^']*'|[A-Za-z_][\w.*]*", source)
    position = 0
    def atom():
        nonlocal position
        token=tokens[position]; position+=1
        if token == '(':
            value=disjunction(); assert tokens[position]==')';position+=1;return value
        if token in ('startsWith','contains'):
            assert tokens[position]=='(';position+=1
            left=atom();assert tokens[position]==',';position+=1
            right=atom();assert tokens[position]==')';position+=1
            return left.startswith(right) if token=='startsWith' else right in left
        return token[1:-1] if token.startswith("'") else values[token]
    def equality():
        nonlocal position
        value=atom()
        if position<len(tokens) and tokens[position]=='==':position+=1;value=value==atom()
        return value
    def conjunction():
        nonlocal position
        value=equality()
        while position<len(tokens) and tokens[position]=='&&':position+=1;other=equality();value=value and other
        return value
    def disjunction():
        nonlocal position
        value=conjunction()
        while position<len(tokens) and tokens[position]=='||':position+=1;other=conjunction();value=value or other
        return value
    result=disjunction();assert position==len(tokens);return result


class PRPolicy(unittest.TestCase):
    def test_actual_quality_workflow_trigger_matrix(self):
        cases=[('anything','develop',REPO,(),True),('main','develop',REPO,(),True),
               ('user/arbitrary','develop','someone/fork',(),True),
               ('hotfix/fix','main',REPO,(),True),('codex/hotfix/fix','main',REPO,(),True),
               ('claude/hotfix/fix','main',REPO,(),True),
               ('copilot/fix','main',REPO,('work:hotfix',),True),
               ('copilot/fix','main','someone/fork',('work:hotfix',),False),
               ('copilot/fix','main',REPO,(),False),('develop','main',REPO,(),False),
               ('release/0.2.0','main',REPO,(),False),('feature/fix','main',REPO,(),False),
               ('anything','other',REPO,(),False)]
        for filename in ('ci','container','security','gitflow'):
            text=(ROOT/f'.github/workflows/{filename}.yml').read_text()
            predicates=re.findall(r'    if: >-\n((?:      .*\n)+)',text)
            self.assertEqual(len(predicates),2 if filename=='ci' else 1)
            for predicate in predicates:
                for head,base,repo,labels,expected in cases:
                    for event in ('pull_request','push','workflow_dispatch','schedule','pull_request_target'):
                        values={'github.event_name':event,'github.base_ref':base,'github.head_ref':head,
                                'github.event.pull_request.head.repo.full_name':repo,'github.repository':REPO,
                                'github.event.pull_request.labels.*.name':labels}
                        self.assertEqual(expression(predicate,values),expected and event=='pull_request',(filename,head,base,event))
                    self.assertEqual(gitflow.quality_pr(pr(head,base,repo,labels)),expected)

    def test_only_pr_events_and_required_names_are_preserved(self):
        expected={'ci':['Quality','Package'],'container':['Container'],'security':['Security'],'gitflow':['GitFlow']}
        for filename,jobs in expected.items():
            text=(ROOT/f'.github/workflows/{filename}.yml').read_text()
            events=text.split('on:\n',1)[1].split('permissions:',1)[0]
            self.assertEqual(re.findall(r'^  ([a-z_]+):',events,re.M),['pull_request'])
            for required in ('opened','synchronize','reopened','ready_for_review','edited','labeled','unlabeled'):
                self.assertIn(required,events)
            self.assertNotIn('closed',events)
            self.assertEqual(re.findall(r'^    name: (.+)$',text,re.M),jobs)
            self.assertIn('ref: ${{ github.event.pull_request.head.sha }}',text)
            self.assertEqual(text.count('if: always()'),len(jobs))
        self.assertFalse((ROOT/'.github/workflows/delivery.yml').exists())
        self.assertFalse((ROOT/'xops/agent/delivery.py').exists())
        self.assertNotIn('ai.status',(ROOT/'Makefile').read_text())
        policy=json.loads((ROOT/'.github/gitflow.json').read_text())
        self.assertFalse(policy['automation']['enabled'])
        self.assertIsNone(policy['automation']['workflow'])

    def test_gitflow_accepts_any_develop_source_and_rejects_non_pr_events(self):
        for head in ('odd_name','arbitrary/deep/path','main','copilot/feature'):
            pull=pr(head,repo='someone/fork')
            self.assertIn('quality checks run',gitflow.check_event({'pull_request':pull},'pull_request',REPO))
        for event in ('push','schedule','workflow_dispatch'):
            with self.assertRaisesRegex(ValueError,'only'):gitflow.check_event({'pull_request':pr()},event,REPO)
        with self.assertRaisesRegex(ValueError,'only for develop'):
            gitflow.check_event({'pull_request':pr('feature/not-release','main')},'pull_request',REPO)

    def test_off_lane_pr_rejects_without_promotion_evidence_or_network(self):
        with patch('release_evidence.verify_promotion') as verify:
            for head,base in [('develop','main'),('release/0.2.0','main'),('anything','other')]:
                with self.assertRaisesRegex(ValueError,'only for develop'):
                    gitflow.check_event({'pull_request':pr(head,base)},'pull_request',REPO)
            verify.assert_not_called()

if __name__=='__main__':unittest.main()
