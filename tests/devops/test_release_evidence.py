"""Promotion/release proofs use immutable content and genuine successful PR jobs."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'xops/agent'))
import release_evidence as e

HEAD='a'*40
MERGE='b'*40
TREE='c'*40
MAIN='d'*40


class API:
    def __init__(self):self.data={};self.calls=[]
    def request(self,path,method='GET',body=None):
        if method!='GET':raise AssertionError('Evidence must be read-only')
        self.calls.append(path)
        key=path.replace('&per_page=100&page=1','').replace('?per_page=100&page=1','')
        if key not in self.data:raise AssertionError('Unexpected API read: '+key)
        return copy.deepcopy(self.data[key])


def source():
    return {'number':4,'state':'closed','merged':True,'draft':False,
            'created_at':'2026-10-10T01:00:00Z','merged_at':'2026-10-10T02:00:00Z',
            'merge_commit_sha':MERGE,'head':{'ref':'arbitrary/feature','sha':HEAD,'repo':{'full_name':e.REPO}},
            'base':{'ref':'develop','sha':'e'*40,'repo':{'full_name':e.REPO}}}


def fixture(cleared=False):
    api=API();pr=source();checks=[]
    policy=json.loads((e.ROOT/'.github/gitflow.json').read_text())
    for index,(name,path) in enumerate(policy['check_workflows'].items(),1):
        check_id=100+index;run_id=200+index;job_id=300+index
        associations=[] if cleared else [{'number':4,'head':{'sha':HEAD},'base':{'ref':'develop'}}]
        api.data[f'{e.PREFIX}/actions/runs/{run_id}']={
            'id':run_id,'event':'pull_request','head_sha':HEAD,'head_branch':'arbitrary/feature','path':path,
            'status':'completed','conclusion':'success','check_suite_id':400+index,'run_attempt':1,
            'repository':{'full_name':e.REPO},'head_repository':{'full_name':e.REPO},'pull_requests':associations,
            'created_at':'2026-10-10T01:10:00Z','run_started_at':'2026-10-10T01:11:00Z','updated_at':'2026-10-10T01:30:00Z'}
        checks.append({'id':check_id,'name':name,'head_sha':HEAD,'app':{'id':15368},'check_suite':{'id':400+index},
                       'status':'completed','conclusion':'success','started_at':'2026-10-10T01:12:00Z',
                       'completed_at':'2026-10-10T01:20:00Z',
                       'details_url':f'https://github.com/{e.REPO}/actions/runs/{run_id}/job/{job_id}'})
        api.data[f'{e.PREFIX}/actions/jobs/{job_id}']={
            'id':job_id,'name':name,'run_id':run_id,'run_attempt':1,'head_sha':HEAD,
            'status':'completed','conclusion':'success','started_at':'2026-10-10T01:12:00Z','completed_at':'2026-10-10T01:20:00Z',
            'check_run_url':f'https://api.github.com/{e.PREFIX}/check-runs/{check_id}'}
    api.data[f'{e.PREFIX}/commits/{HEAD}/check-runs?filter=all']={'check_runs':checks}
    for sha in (HEAD,MERGE,MAIN):
        api.data[f'{e.PREFIX}/git/commits/{sha}']={'sha':sha,'tree':{'sha':TREE},'parents':[{'sha':'e'*40},{'sha':HEAD}]}
    api.data[f'{e.PREFIX}/pulls?state=all&head=consciontologic%3Aarbitrary%2Ffeature']=[pr]
    api.data[f'{e.PREFIX}/issues/4/events']=[]
    api.data[f'{e.PREFIX}/pulls?state=closed&base=develop&sort=updated&direction=desc']=[pr]
    api.data[f'{e.PREFIX}/pulls/4']=pr
    return api,pr,checks


def promotion():
    return {'number':8,'state':'open','merged':False,'draft':False,'mergeable':True,'merge_commit_sha':MAIN,
            'head':{'sha':MERGE,'ref':'develop','repo':{'full_name':e.REPO}},
            'base':{'sha':'e'*40,'ref':'main','repo':{'full_name':e.REPO}}}


class EvidenceTests(unittest.TestCase):
    def test_exact_tree_promotion_and_release_reuse_pr_quality(self):
        api,pr,checks=fixture();result=e.verify_promotion(api,promotion())
        self.assertEqual(result['source_pr'],4);self.assertEqual(result['tree_sha'],TREE)
        self.assertEqual(result['run_ids'],[201,202,203,204,205])
        p=promotion();p.update(state='closed',merged=True)
        api.data[f'{e.PREFIX}/pulls/8']=p
        api.data[f'{e.PREFIX}/commits/{MAIN}/pulls']=[p]
        api.data[f'{e.PREFIX}/git/ref/heads/main']={'object':{'sha':MAIN,'type':'commit'}}
        self.assertEqual(e.verify_release(api,MAIN)['release_sha'],MAIN)

    def test_candidate_and_develop_merge_trees_must_equal_tested_head(self):
        for changed in (MAIN,MERGE,HEAD):
            api,pr,checks=fixture();api.data[f'{e.PREFIX}/git/commits/{changed}']['tree']['sha']='f'*40
            with self.assertRaises(ValueError):e.verify_promotion(api,promotion())

    def test_rejects_non_pr_wrong_lane_foreign_workflow_and_spoofed_check(self):
        mutations=[('run','event','push'),('run','path','.github/workflows/release.yml'),
                   ('run','head_sha','f'*40),('run','repository',{'full_name':'other/repo'}),
                   ('run','check_suite_id',999),('check','app',{'id':999}),
                   ('check','conclusion','skipped'),('run','conclusion','failure'),
                   ('job','check_run_url','https://api.github.com/other'),('job','head_sha','f'*40),
                   ('job','name','Spoofed'),('job','conclusion','failure'),('job','run_attempt',2)]
        for kind,key,value in mutations:
            with self.subTest(kind=kind,key=key):
                api,pr,checks=fixture()
                obj={'run':api.data[f'{e.PREFIX}/actions/runs/201'],'check':checks[0],
                     'job':api.data[f'{e.PREFIX}/actions/jobs/301']}[kind]
                obj[key]=value
                with self.assertRaises(ValueError):e.verify_quality(api,pr)
        api,pr,checks=fixture();pr['base']['ref']='main'
        with self.assertRaises(ValueError):e.verify_quality(api,pr)

    def test_same_sha_promotion_skips_do_not_mask_develop_evidence(self):
        api,pr,checks=fixture()
        copied=copy.deepcopy(checks[0]);copied.update(id=900,conclusion='skipped',details_url=f'https://github.com/{e.REPO}/actions/runs/800/job/700')
        checks.append(copied)
        run=copy.deepcopy(api.data[f'{e.PREFIX}/actions/runs/201'])
        run.update(id=800,head_branch='develop',pull_requests=[{'number':8,'head':{'sha':HEAD},'base':{'ref':'main'}}])
        api.data[f'{e.PREFIX}/actions/runs/800']=run
        self.assertEqual(len(e.verify_quality(api,pr)),5)
        run['pull_requests']=[]
        self.assertEqual(len(e.verify_quality(api,pr)),5)
        run['pull_requests']=[{'number':4,'head':{'sha':HEAD},'base':{'ref':'develop'}}]
        with self.assertRaises(ValueError):e.verify_quality(api,pr)

    def test_latest_failing_or_ambiguous_same_pr_check_never_rescues_old_success(self):
        for failure in ('failure','ambiguous'):
            api,pr,checks=fixture()
            copied=copy.deepcopy(checks[0]);copied['id']=900;copied['details_url']=f'https://github.com/{e.REPO}/actions/runs/800/job/700';checks.append(copied)
            run=copy.deepcopy(api.data[f'{e.PREFIX}/actions/runs/201']);run['id']=800
            if failure=='failure':copied['conclusion']='failure'
            else:run['pull_requests']=[];run['updated_at']='2026-10-10T03:00:00Z'
            api.data[f'{e.PREFIX}/actions/runs/800']=run
            with self.assertRaises(ValueError):e.verify_quality(api,pr)

    def test_cleared_merged_run_association_has_strict_recovery(self):
        api,pr,checks=fixture(cleared=True)
        self.assertEqual(len(e.verify_quality(api,pr)),5)
        for damage in ('retarget','reused_branch','changed_tree','after_merge','wrong_parent'):
            with self.subTest(damage=damage):
                api,pr,checks=fixture(cleared=True)
                if damage=='retarget':api.data[f'{e.PREFIX}/issues/4/events']=[{'event':'base_ref_changed'}]
                if damage=='reused_branch':api.data[f'{e.PREFIX}/pulls?state=all&head=consciontologic%3Aarbitrary%2Ffeature'].append(pr)
                if damage=='changed_tree':api.data[f'{e.PREFIX}/git/commits/{MERGE}']['tree']['sha']='f'*40
                if damage=='wrong_parent':api.data[f'{e.PREFIX}/git/commits/{MERGE}']['parents'][1]['sha']='f'*40
                if damage=='after_merge':api.data[f'{e.PREFIX}/actions/jobs/301']['completed_at']='2026-10-10T03:00:00Z'
                with self.assertRaises(ValueError):e.verify_quality(api,pr)

    def test_rerun_failed_jobs_retains_earlier_successful_job_attempt(self):
        api,pr,checks=fixture(cleared=True)
        for index in range(1,6):
            run=api.data[f'{e.PREFIX}/actions/runs/{200+index}'];run['run_attempt']=2;run['run_started_at']='2026-10-10T01:21:00Z'
        self.assertEqual(len(e.verify_quality(api,pr)),5)
        # A failed job rerun now succeeded in the current attempt; older successful
        # checks still belong to attempt 1 and stay valid.
        job=api.data[f'{e.PREFIX}/actions/jobs/302'];job['run_attempt']=2;job['started_at']='2026-10-10T01:22:00Z';job['completed_at']='2026-10-10T01:25:00Z'
        checks[1]['started_at']=job['started_at'];checks[1]['completed_at']=job['completed_at']
        self.assertEqual(len(e.verify_quality(api,pr)),5)
        job['conclusion']='failure'
        with self.assertRaises(ValueError):e.verify_quality(api,pr)

    def test_hotfix_release_uses_own_quality_and_exact_merge_content(self):
        api,pr,checks=fixture();pr['base']['ref']='main';pr['head']['ref']='hotfix/urgent'
        for index in range(1,6):
            run=api.data[f'{e.PREFIX}/actions/runs/{200+index}'];run['head_branch']='hotfix/urgent';run['pull_requests'][0]['base']['ref']='main'
        api.data[f'{e.PREFIX}/commits/{MERGE}/pulls']=[pr]
        api.data[f'{e.PREFIX}/git/ref/heads/main']={'object':{'sha':MERGE,'type':'commit'}}
        self.assertEqual(e.verify_release(api,MERGE)['source_pr'],4)
        api.data[f'{e.PREFIX}/git/commits/{MERGE}']['tree']['sha']='f'*40
        with self.assertRaises(ValueError):e.verify_release(api,MERGE)


    def test_missing_or_weakened_policy_cannot_authorize_evidence(self):
        api,pr,checks=fixture()
        policy=json.loads((e.ROOT/'.github/gitflow.json').read_text())
        policy['check_workflows']={}
        with patch.object(e.json,'loads',return_value=policy):
            with self.assertRaisesRegex(ValueError,'five-check'):e.verify_quality(api,pr)
        api,pr,checks=fixture()
        api.data[f'{e.PREFIX}/actions/runs/201'].pop('check_suite_id')
        checks[0].pop('check_suite')
        with self.assertRaises(ValueError):e.verify_quality(api,pr)

if __name__=='__main__':unittest.main()
