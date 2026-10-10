"""Exercise delivery with deterministic API boundaries, no live GitHub mutations."""
import base64
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'xops/agent'))
import delivery
from copilot_task import ApiError


class Fake:
    def __init__(self): self.calls=[]; self.data={}; self.comments=[]
    def request(self, path, method='GET', body=None):
        self.calls.append((path,method,body))
        value = self.data.get((path,method), self.data.get(path, {}))
        if isinstance(value, Exception): raise value
        if callable(value): return value()
        if path.endswith('/comments') and method == 'POST':
            self.comments.append(body['body']); return {'id':len(self.comments)}
        return copy.deepcopy(value)
    def writes(self): return [call for call in self.calls if call[1] != 'GET']


def pull():
    return {'number':7,'state':'open','draft':False,'labels':[],
            'head':{'sha':'new','ref':'copilot/fix','repo':{'full_name':delivery.REPO}},
            'base':{'sha':'base','ref':'develop'},'merge_commit_sha':'merge',
            'mergeable':True,'mergeable_state':'clean'}


class ControllerTests(unittest.TestCase):
    def controller(self, fake):
        c = delivery.Controller(fake)
        c.autonomous = True
        c.receipts = lambda number:[{'action':'manage','state':'authorized'}]
        c.threads_clear = lambda number:True
        c.protection_valid = lambda branch:True
        return c

    def ready(self):
        fake=Fake(); pr=pull(); c=self.controller(fake)
        fake.data[f'{delivery.PREFIX}/pulls/7'] = pr
        fake.data[f'{delivery.PREFIX}/pulls/7/reviews?per_page=100'] = [
            {'user':{'login':delivery.REVIEWER},'commit_id':'new','state':'COMMENTED','body':'Copilot reviewed 1 out of 1 changed files in this pull request and generated no new comments.'}]
        fake.data[f'{delivery.PREFIX}/pulls/7/merge','PUT']={'merged':True}
        c.checks=lambda pr:[{'name':name,'status':'completed','conclusion':'success',
                            'app':{'slug':'github-actions'},'_faac_event':'push'} for name in delivery.REQUIRED_CHECKS]
        return fake,c,pr

    def test_merge_uses_compared_head_sha(self):
        fake,c,pr=self.ready(); c.pr(pr)
        merge=[call for call in fake.calls if call[0].endswith('/merge')]
        self.assertEqual(merge, [(f'{delivery.PREFIX}/pulls/7/merge','PUT',{'sha':'new','merge_method':'merge'})])

    def test_head_or_base_change_after_validation_prevents_merge(self):
        for field in ('head','base'):
            fake,c,pr=self.ready(); changed=copy.deepcopy(pr);changed[field]['sha']='changed'
            replies=iter([pr,changed]);fake.data[f'{delivery.PREFIX}/pulls/7']=lambda:next(replies)
            c.pr(pr)
            self.assertFalse(fake.writes())

    def test_missing_checks_unresolved_threads_draft_and_fork_cannot_merge(self):
        for reason in ('checks','threads','draft','fork'):
            fake,c,pr=self.ready()
            if reason=='checks':c.checks=lambda pr:[]
            if reason=='threads':c.threads_clear=lambda number:False
            if reason=='draft':pr['draft']=True
            if reason=='fork':pr['head']['repo']['full_name']='someone/else'
            fake.data[f'{delivery.PREFIX}/pulls/7']=pr
            c.pr(pr)
            self.assertFalse(any(call[0].endswith('/merge') for call in fake.calls), reason)

    def test_quota_review_never_spends_on_rereview_or_repair(self):
        fake,c,pr=self.ready();tasks=Fake();c.tasks=tasks
        fake.data[f'{delivery.PREFIX}/pulls/7/reviews?per_page=100']=[{
            'user':{'login':delivery.REVIEWER},'commit_id':'new','state':'COMMENTED',
            'body':'Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.'}]
        c.checks=lambda pr:[{'name':'Quality','status':'completed','conclusion':'failure'}]
        c.threads_clear=lambda number:False
        c.pr(pr)
        self.assertFalse(fake.writes())
        self.assertFalse(tasks.calls)
        self.assertEqual(c.budget,delivery.LIMITS['max_new_paid_actions_per_run'])

    def check_source(self, merge_checks=None, merge_statuses=None, event='push'):
        fake=Fake();c=delivery.Controller(fake);pr=pull()
        for sha, checks in (('merge', merge_checks or []), ('new', [])):
            fake.data[f'{delivery.PREFIX}/commits/{sha}/check-runs?per_page=100&filter=latest']={
                'total_count':len(checks), 'check_runs':checks}
            fake.data[f'{delivery.PREFIX}/commits/{sha}/status?per_page=100']={
                'total_count':len(merge_statuses or []) if sha=='merge' else 0,
                'statuses':merge_statuses or [] if sha=='merge' else []}
        checks=[]
        for i,name in enumerate(delivery.REQUIRED_CHECKS,1):
            checks.append({'id':i,'name':name,'head_sha':'new','status':'completed','conclusion':'success',
                           'app':{'slug':'github-actions'},'check_suite':{'id':90},
                           'details_url':f'https://github.com/{delivery.REPO}/actions/runs/80/job/{i}'})
        fake.data[f'{delivery.PREFIX}/commits/new/check-runs?per_page=100&filter=latest']={
            'total_count':len(checks),'check_runs':checks}
        fake.data[f'{delivery.PREFIX}/actions/runs/80']={'id':80,'event':event,'head_sha':'new',
            'check_suite_id':90,'repository':{'full_name':delivery.REPO}}
        return fake,c,pr

    def test_empty_test_merge_uses_eligible_head_checks(self):
        fake,c,pr=self.check_source()
        self.assertTrue(delivery.checks_green(c.checks(pr)))
        self.assertEqual(sum(call[0].endswith('/actions/runs/80') for call in fake.calls),1)

    def test_populated_test_merge_uses_its_eligible_checks_not_head(self):
        fake,c,pr=self.check_source(event='pull_request')
        checks=fake.data[f'{delivery.PREFIX}/commits/new/check-runs?per_page=100&filter=latest']['check_runs']
        for check in checks:check['head_sha']='merge'
        fake.data[f'{delivery.PREFIX}/commits/merge/check-runs?per_page=100&filter=latest']={
            'total_count':len(checks),'check_runs':checks}
        fake.data[f'{delivery.PREFIX}/actions/runs/80']['head_sha']='merge'
        self.assertTrue(delivery.checks_green(c.checks(pr)))
        self.assertFalse(any('/commits/new/' in call[0] for call in fake.calls))

    def test_pr_merge_check_can_link_to_its_current_head_workflow_run(self):
        # GitHub's checkout SHA and run head SHA are distinct concepts. Keep
        # the exact check-suite link and both current PR SHAs as the boundary.
        fake,c,pr=self.check_source(event='pull_request')
        checks=fake.data[f'{delivery.PREFIX}/commits/new/check-runs?per_page=100&filter=latest']['check_runs']
        for check in checks:check['head_sha']='merge'
        fake.data[f'{delivery.PREFIX}/commits/merge/check-runs?per_page=100&filter=latest']={
            'total_count':len(checks),'check_runs':checks}
        self.assertTrue(delivery.checks_green(c.checks(pr)))
        fake.data[f'{delivery.PREFIX}/actions/runs/80']['event']='push'
        self.assertFalse(delivery.checks_green(c.checks(pr)))
        fake.data[f'{delivery.PREFIX}/actions/runs/80']['event']='pull_request'
        fake.data[f'{delivery.PREFIX}/actions/runs/80']['head_sha']='old-head'
        self.assertFalse(delivery.checks_green(c.checks(pr)))

    def test_dispatch_or_unknown_event_never_authorizes_merge(self):
        for event in ('workflow_dispatch','schedule','unknown',None):
            fake,c,pr=self.check_source(event=event)
            self.assertFalse(delivery.checks_green(c.checks(pr)),event)

    def test_existing_merge_check_or_status_prevents_head_fallback(self):
        for checks,statuses in (([{'name':'unrelated'}],[]),([],[{'context':'other','state':'pending'}])):
            fake,c,pr=self.check_source(merge_checks=checks,merge_statuses=statuses)
            self.assertFalse(delivery.checks_green(c.checks(pr)))
            self.assertFalse(any('/commits/new/' in call[0] for call in fake.calls))

    def test_workflow_run_must_match_commit_suite_and_repository(self):
        for key,value in (('head_sha','old'),('check_suite_id',999),('repository',{'full_name':'other/repo'})):
            fake,c,pr=self.check_source()
            fake.data[f'{delivery.PREFIX}/actions/runs/80'][key]=value
            self.assertFalse(delivery.checks_green(c.checks(pr)),key)

    def test_unknown_merge_status_schema_does_not_fall_back_to_head(self):
        fake,c,pr=self.check_source()
        fake.data[f'{delivery.PREFIX}/commits/merge/status?per_page=100']={}
        with self.assertRaises(ValueError):c.checks(pr)
        self.assertFalse(any('/commits/new/' in call[0] for call in fake.calls))

    def test_absent_protection_does_not_use_admin_bypass(self):
        fake,c,pr=self.ready();c.protection_valid=lambda branch:False
        with self.assertRaisesRegex(ValueError,'protections'):c.pr(pr)
        self.assertFalse(fake.writes())

    def test_issue_dispatch_requires_actual_write_permission(self):
        fake=Fake();c=delivery.Controller(fake)
        fake.data[f'{delivery.PREFIX}/collaborators/outsider/permission']={'permission':'read'}
        c.authorize_event('issues',{'action':'labeled','label':{'name':'ai:task'},
                                  'issue':{'number':1},'sender':{'login':'outsider'}})
        self.assertFalse(fake.writes())

    def test_issue_change_and_prior_uncertain_intent_prevent_submission(self):
        fake=Fake();tasks=Fake();c=delivery.Controller(fake,tasks)
        issue={'number':1,'title':'Add tests','body':'A','labels':[]}
        c.receipts=lambda number:[{'action':'authorize','digest':'wrong'}]
        c.issue(issue);self.assertFalse(tasks.calls)
        c.receipts=lambda number:[{'action':'authorize','digest':delivery.issue_digest(issue)},
                                 {'action':'initial','state':'uncertain'}]
        c.issue(issue);self.assertFalse(tasks.calls)

    def test_task_error_has_no_retry_or_expensive_fallback(self):
        fake=Fake();tasks=Fake();c=delivery.Controller(fake,tasks)
        tasks.data['agents/repos/'+delivery.REPO+'/tasks']=ApiError('rejected',422)
        with self.assertRaises(ApiError):c.task(1,'initial',{'model':'mai-code-1.1-flash','base_ref':'develop'})
        self.assertEqual(len(tasks.calls),1)
        receipt=delivery.parse_receipt(fake.comments[0])
        self.assertEqual(receipt['state'],'intent')
        self.assertEqual(receipt['model'],'mai-code-1.1-flash')
        self.assertTrue(any(call[1]=='PATCH' and 'rejected' in call[2]['body'] for call in fake.calls))

    def test_receipt_failure_prevents_task_submission(self):
        fake=Fake();tasks=Fake();c=delivery.Controller(fake,tasks)
        fake.data[f'{delivery.PREFIX}/issues/1/comments','POST']=ApiError('uncertain',500)
        with self.assertRaises(ApiError):c.task(1,'initial',{'model':'mai-code-1.1-flash','base_ref':'develop'})
        self.assertFalse(tasks.calls)

    def release(self):
        fake=Fake();c=self.controller(fake)
        pr={'number':4,'head':{'sha':'authhead'},'merged_at':'now','merge_commit_sha':'mainsha'}
        fake.data[f'{delivery.PREFIX}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=30']=[pr]
        fake.data[f'{delivery.PREFIX}/git/ref/heads/main']={'object':{'sha':'mainsha'}}
        fake.data[f'{delivery.PREFIX}/contents/package.json?ref=mainsha']={
            'encoding':'base64','content':base64.b64encode(b'{"version":"0.2.0"}').decode()}
        c.receipts=lambda n:[{'action':'authorize_release:authhead','state':'authorized'}]
        return fake,c,pr

    def test_release_promotion_keeps_version_without_v_or_package_prefix(self):
        fake=Fake();c=self.controller(fake)
        fake.data[f'{delivery.PREFIX}/pulls?state=closed&base=develop&sort=updated&direction=desc&per_page=30']=[
            {'number':4,'merged_at':'now'}]
        fake.data[f'{delivery.PREFIX}/pulls?state=open&base=main&head=consciontologic:develop']=[]
        fake.data[delivery.PREFIX+'/pulls','POST']={'number':8}
        c.receipts=lambda number:[{'action':'manage','state':'authorized','release_version':'0.1.0'}]
        c.promote()
        created=next(body for path,method,body in fake.calls if path==delivery.PREFIX+'/pulls' and method=='POST')
        self.assertEqual(created['title'],'release: 0.1.0')
        self.assertEqual(delivery.parse_receipt(fake.comments[0])['version'],'0.1.0')

    def test_release_authorization_reads_exact_main_then_dispatches(self):
        fake,c,pr=self.release();c.publish_authorized()
        dispatch=[call for call in fake.calls if call[0].endswith('/dispatches')]
        self.assertEqual(dispatch,[(delivery.PREFIX+'/actions/workflows/release.yml/dispatches','POST',
                                  {'ref':'main','inputs':{'version':'0.2.0'}})])
        self.assertEqual(delivery.parse_receipt(fake.comments[0])['source'],'mainsha')

    def test_release_stale_authorization_or_already_attempted_never_dispatches(self):
        for reason in ('head','main','intent'):
            fake,c,pr=self.release()
            if reason=='head':c.receipts=lambda n:[{'action':'authorize_release:oldhead','state':'authorized'}]
            if reason=='main':fake.data[f'{delivery.PREFIX}/git/ref/heads/main']={'object':{'sha':'newmain'}}
            if reason=='intent':c.receipts=lambda n:[{'action':'authorize_release:authhead','state':'authorized'},
                                                   {'action':'publish:mainsha','state':'uncertain'}]
            c.publish_authorized();self.assertFalse(fake.writes(),reason)

    def test_backmerge_uses_real_compare_schema_and_immutable_trusted_main(self):
        fake=Fake();c=self.controller(fake)
        c.receipts=lambda number:[]
        sha='a'*40
        fake.data[delivery.PREFIX+'/git/ref/heads/main']={'ref':'refs/heads/main','object':{'type':'commit','sha':sha}}
        fake.data[delivery.PREFIX+'/compare/develop...'+sha]={'ahead_by':1,'base_commit':{},'merge_base_commit':{},'commits':[]}
        fake.data[delivery.PREFIX+'/pulls?state=open&base=develop&head=consciontologic:main']=[]
        fake.data[delivery.PREFIX+'/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=30']=[
            {'number':4,'merged_at':'now','merge_commit_sha':sha}]
        fake.data[delivery.PREFIX+'/pulls','POST']={'number':8}
        c.backmerge()
        self.assertEqual(delivery.parse_receipt(fake.comments[0])['action'],'backmerge:'+sha)
        self.assertTrue(any(call[0]==delivery.PREFIX+'/pulls' and call[1]=='POST' for call in fake.calls))
        fake.calls.clear()
        fake.data[delivery.PREFIX+'/git/ref/heads/main']['ref']='refs/heads/other'
        with self.assertRaisesRegex(ValueError, 'main'):c.backmerge()
        self.assertFalse(fake.writes())

    def test_dismissed_review_is_not_merge_evidence(self):
        reviews=[{'user':{'login':delivery.REVIEWER},'commit_id':'new','state':'COMMENTED'},
                 {'user':{'login':delivery.REVIEWER},'commit_id':'new','state':'DISMISSED'}]
        self.assertFalse(delivery.review_green(reviews,'new'))

if __name__=='__main__':unittest.main()
