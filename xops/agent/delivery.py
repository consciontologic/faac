#!/usr/bin/env python3
"""Bounded GitHub delivery controller. Always run trusted main; never execute PR code."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import quote
from copilot_task import ApiError, GitHub, REPO, ROOT, payload, validate_receipt
from gitflow import SEMVER, valid_lane

POLICY = json.loads((ROOT / '.github/gitflow.json').read_text())
REQUIRED_CHECKS = POLICY['required_checks']
LIMITS = POLICY['automation']
REVIEWER = 'copilot-pull-request-reviewer[bot]'
MARKER = '<!-- faac-delivery:v1 -->'
PREFIX = 'repos/' + REPO


def receipt_body(data):
    return MARKER + '\n```json\n' + json.dumps(data, sort_keys=True) + '\n```'


def parse_receipt(body):
    match = re.fullmatch(re.escape(MARKER) + r'\n```json\n(.+)\n```', body or '', re.S)
    if not match: return None
    try:
        result = json.loads(match[1])
        return result if isinstance(result, dict) and isinstance(result.get('action'), str) else None
    except (ValueError, TypeError): return None


def already_attempted(receipts, action):
    # intent/rejected/uncertain all count. Only a new, explicit work item resets a budget.
    return any(item.get('action') == action for item in receipts)


def issue_digest(issue):
    labels = sorted(label['name'] for label in issue.get('labels', [])
                    if label['name'].startswith(('kind:', 'version:')))
    raw = json.dumps([issue['title'], issue.get('body') or '', labels], sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def checks_green(checks):
    latest = {}
    for check in sorted(checks, key=lambda item:item.get('id', 0)):
        if check.get('app', {}).get('slug') == 'github-actions': latest[check['name']] = check
    return all(latest.get(name, {}).get('status') == 'completed'
               and latest[name].get('conclusion') == 'success' for name in REQUIRED_CHECKS)


def review_green(reviews, sha):
    latest = {}
    for review in reviews:
        if review.get('state') != 'PENDING': latest[review['user']['login']] = review
    return (latest.get(REVIEWER, {}).get('commit_id') == sha
            and latest.get(REVIEWER, {}).get('state') in {'COMMENTED','APPROVED'}
            and not any(r.get('state') == 'CHANGES_REQUESTED' for r in latest.values()))


def recorded_action(client, item_path, action, metadata, operation):
    data = dict(metadata, action=action, state='intent')
    # This receipt must succeed BEFORE an external side effect is attempted.
    comment = client.request(item_path + '/comments', 'POST', {'body':receipt_body(data)})
    try:
        result = operation()
    except ApiError as error:
        client.request(PREFIX + '/issues/comments/' + str(comment['id']), 'PATCH',
            {'body':receipt_body(dict(data, state=error.state, status=error.status))})
        raise
    client.request(PREFIX + '/issues/comments/' + str(comment['id']), 'PATCH',
        {'body':receipt_body(dict(data, state='accepted', result=
            {key:result[key] for key in ('id','number','state','html_url') if key in result} if isinstance(result, dict) else None))})
    return result


class Controller:
    def __init__(self, api, tasks=None, autonomous=False):
        self.api, self.tasks, self.autonomous = api, tasks, autonomous
        self.budget = LIMITS['max_new_paid_actions_per_run']
        self.actor = None
        self.allowed_authors = {'github-actions[bot]'}
        # GITHUB_TOKEN /user is unsupported. Its known GitHub Actions identity
        # is enough; a configured user token also adds its authenticated login.
        if autonomous:
            self.actor = api.request('user')['login']
            self.allowed_authors.add(self.actor)

    def receipts(self, number):
        items = self.api.request(f'{PREFIX}/issues/{number}/comments?per_page=100')
        if len(items) >= 100: raise ValueError('Over 100 comments: manual reconciliation required')
        return [parsed for item in items if item.get('user', {}).get('login') in self.allowed_authors
                and (parsed := parse_receipt(item.get('body')))]

    def trusted(self, login):
        if not re.fullmatch(r'[A-Za-z0-9-]+', login or ''): return False
        result = self.api.request(f'{PREFIX}/collaborators/{login}/permission')
        return result.get('permission') in {'admin','maintain','write'}

    def receipt(self, number, action, **metadata):
        self.api.request(f'{PREFIX}/issues/{number}/comments', 'POST',
                         {'body':receipt_body(dict(metadata, action=action, state='authorized'))})

    def authorize_event(self, event_name, event):
        actor = event.get('sender', {}).get('login') or os.environ.get('GITHUB_ACTOR')
        number = None
        if event_name == 'workflow_dispatch' and event.get('inputs', {}).get('issue_number'):
            number = int(event['inputs']['issue_number'])
        elif event.get('action') == 'labeled' and event.get('label', {}).get('name') in {'ai:task','ai:merge','ai:release'}:
            number = (event.get('issue') or event.get('pull_request') or {}).get('number')
        if not number or not self.trusted(actor): return
        issue = self.api.request(f'{PREFIX}/issues/{number}')
        receipts = self.receipts(number)
        action = 'manage' if issue.get('pull_request') else 'authorize'
        if event.get('label', {}).get('name') == 'ai:release':
            if not issue.get('pull_request'): raise ValueError('ai:release only applies to a main promotion PR')
            pr = self.api.request(f'{PREFIX}/pulls/{number}')
            if pr['base']['ref'] != 'main': raise ValueError('ai:release requires a PR targeting main')
            action = 'authorize_release:' + pr['head']['sha']
        if not already_attempted(receipts, action):
            self.receipt(number, action, actor=actor, digest=issue_digest(issue))
            print(f'Authorized {action} for #{number}.')

    def task(self, number, action, body):
        if not self.tasks:
            print(f'#{number}: FAAC_COPILOT_TOKEN missing; no Copilot task submitted.'); return
        if self.budget <= 0: return
        self.budget -= 1
        result = recorded_action(self.api, f'{PREFIX}/issues/{number}', action,
            {'model':body['model'], 'base':body['base_ref']},
            lambda:validate_receipt(self.tasks.request('agents/repos/' + REPO + '/tasks', 'POST', body)))
        print(f'#{number}: {action} accepted: {result["html_url"]}')

    def issue(self, issue):
        number = issue['number']
        labels = {label['name'] for label in issue['labels']}
        if 'ai:pause' in labels: return
        receipts = self.receipts(number)
        accepted = next((r for r in receipts if r['action'] == 'initial' and r['state'] == 'accepted'), None)
        if accepted and self.tasks:
            task_id = quote(accepted['result']['id'], safe='')
            task = self.tasks.request('agents/repos/' + REPO + '/tasks/' + task_id)
            for artifact in task.get('artifacts', []):
                pr_number = artifact.get('data', {}).get('id')
                if artifact.get('type') == 'pull' and isinstance(pr_number, int):
                    pr = self.api.request(f'{PREFIX}/pulls/{pr_number}')
                    if pr['head']['repo']['full_name'] != REPO or not pr['head']['ref'].startswith('copilot/'):
                        raise ValueError('Unexpected task PR ownership; manual inspection required')
                    if not already_attempted(self.receipts(pr_number), 'manage'):
                        versions = [label.split(':', 1)[1] for label in labels if label.startswith('version:')]
                        release = versions[0] if 'kind:release' in labels and len(versions) == 1 else None
                        self.receipt(pr_number, 'manage', issue=number, task=task_id, release_version=release)
                        self.api.request(f'{PREFIX}/issues/{pr_number}/labels', 'POST', {'labels':['ai:merge']})
                    if task.get('state') == 'completed' and pr['draft']:
                        result = self.api.request('graphql', 'POST', {'query':
                            'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}',
                            'variables':{'id':pr['node_id']}})
                        if result.get('errors'): raise ValueError('GitHub did not allow making the completed task ready for review')
            return
        authorization = next((r for r in receipts if r['action'] == 'authorize'), None)
        if not authorization or already_attempted(receipts, 'initial'): return
        if authorization.get('digest') != issue_digest(issue):
            print(f'#{number}: issue changed after authorization; create a new task issue.'); return
        kinds = labels.intersection({'kind:feature','kind:bugfix','kind:hotfix','kind:release'})
        if len(kinds) > 1: raise ValueError('Use exactly one kind label')
        kind = next(iter(kinds), 'kind:feature').split(':')[1]
        versions = [label.split(':',1)[1] for label in labels if label.startswith('version:')]
        text = f'Issue #{number}: {issue["title"]}\n\n' + (issue.get('body') or '')
        self.task(number, 'initial', payload(kind, text, versions[0] if len(versions) == 1 else None))

    def threads_clear(self, number):
        owner, name = REPO.split('/')
        result = self.api.request('graphql', 'POST', {'query':
            'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){'
            'pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}',
            'variables':{'owner':owner,'name':name,'number':number}})
        if result.get('errors'): raise ValueError('Cannot establish review thread state')
        threads = result['data']['repository']['pullRequest']['reviewThreads']
        return not threads['pageInfo']['hasNextPage'] and all(t['isResolved'] for t in threads['nodes'])

    def checks(self, pr):
        # pull_request jobs run against GitHub's test merge commit, not necessarily head.
        sha = pr.get('merge_commit_sha') or pr['head']['sha']
        result = self.api.request(f'{PREFIX}/commits/{sha}/check-runs?per_page=100&filter=latest')
        if result.get('total_count', 0) > 100: raise ValueError('Too many checks to validate safely')
        return result.get('check_runs', [])

    def protection_valid(self, branch):
        protection = self.api.request(f'{PREFIX}/branches/{quote(branch, safe="")}/protection')
        statuses = protection.get('required_status_checks') or {}
        contexts = set(statuses.get('contexts', [])) | {c['context'] for c in statuses.get('checks', [])}
        return (protection.get('enforce_admins', {}).get('enabled') is True
            and protection.get('required_conversation_resolution', {}).get('enabled') is True
            and protection.get('required_pull_request_reviews') is not None
            and statuses.get('strict') is True and set(REQUIRED_CHECKS) <= contexts)

    def pr(self, summary):
        number = summary['number']
        pr = self.api.request(f'{PREFIX}/pulls/{number}')
        labels = {label['name'] for label in pr['labels']}
        if 'ai:pause' in labels or pr['state'] != 'open': return
        receipts = self.receipts(number)
        if not already_attempted(receipts, 'manage'): return
        if not pr['head'].get('repo') or pr['head']['repo']['full_name'] != REPO: return
        if not valid_lane(pr['head']['ref'], pr['base']['ref']): raise ValueError('Disallowed PR lane')
        sha = pr['head']['sha']
        reviews = self.api.request(f'{PREFIX}/pulls/{number}/reviews?per_page=100')
        if len(reviews) >= 100: raise ValueError('Too many reviews to validate safely')
        if not review_green(reviews, sha):
            review_action = 'review:' + sha
            count = sum(r['action'].startswith('review:') for r in receipts)
            if (self.budget > 0 and count < LIMITS['max_reviews_per_pull_request']
                    and not already_attempted(receipts, review_action)):
                self.budget -= 1
                recorded_action(self.api, f'{PREFIX}/issues/{number}', review_action, {'head':sha},
                    lambda:self.api.request(f'{PREFIX}/pulls/{number}/requested_reviewers', 'POST', {'reviewers':[REVIEWER]}))
                print(f'#{number}: native Copilot review requested for {sha[:12]}.')
        checks = self.checks(pr)
        threads_clear = self.threads_clear(number)
        failed = any(c.get('name') in REQUIRED_CHECKS and c.get('status') == 'completed'
                     and c.get('conclusion') in {'failure','timed_out','cancelled','action_required'} for c in checks)
        reviewed = any(r.get('commit_id') == sha and r['user']['login'] == REVIEWER for r in reviews)
        if (failed or (reviewed and not threads_clear)) and not already_attempted(receipts, 'repair'):
            # The tasks API can edit a work branch, never protected main/develop.
            if pr['head']['ref'] in {'main','develop'}:
                print(f'#{number}: promotion/back-merge needs a separate fix branch.'); return
            kind = 'hotfix' if pr['base']['ref'] == 'main' else 'bugfix'
            self.task(number, 'repair', payload(kind,
                f'Repair PR #{number} at {sha}. Inspect failing checks and unresolved review threads. '
                'Fix supported findings and run make verify. Resolve addressed review threads with evidence. '
                'Do not dismiss valid reviews or weaken checks. Keep changes scoped to this PR.',
                head_ref=pr['head']['ref']))
            return
        if pr['draft'] or not (checks_green(checks) and review_green(reviews, sha) and threads_clear): return
        if not self.autonomous:
            print(f'#{number}: FAAC_AUTOMATION_TOKEN missing; merge left for maintainer.'); return
        if not self.protection_valid(pr['base']['ref']):
            raise ValueError('Required branch protections are missing; controller will not bypass them')
        current = self.api.request(f'{PREFIX}/pulls/{number}')
        if current['head']['sha'] != sha or current['base']['sha'] != pr['base']['sha']: return
        if current.get('mergeable') is not True or current.get('mergeable_state') != 'clean': return
        # GitHub atomically compares sha and enforces all native branch protections.
        result = self.api.request(f'{PREFIX}/pulls/{number}/merge', 'PUT', {'sha':sha, 'merge_method':'merge'})
        if not result.get('merged'): raise ValueError('GitHub did not confirm merge')
        print(f'#{number}: merged tested and reviewed head {sha[:12]}.')

    def promote(self):
        if not self.autonomous: return
        # Only a completed, explicitly authorized release task can automatically
        # promote develop. Ordinary feature merges do not create releases.
        closed = self.api.request(f'{PREFIX}/pulls?state=closed&base=develop&sort=updated&direction=desc&per_page=30')
        for pr in closed:
            if not pr.get('merged_at'): continue
            receipts = self.receipts(pr['number'])
            managed = next((r for r in receipts if r['action'] == 'manage' and r.get('release_version')), None)
            if not managed: continue
            action = 'promote:' + managed['release_version']
            if already_attempted(receipts, action): continue
            existing = self.api.request(f'{PREFIX}/pulls?state=open&base=main&head=consciontologic:develop')
            if existing: return
            result = recorded_action(self.api, f'{PREFIX}/issues/{pr["number"]}', action,
                {'version':managed['release_version']},
                lambda:self.api.request(PREFIX + '/pulls', 'POST', {
                    'title':'release: v' + managed['release_version'], 'head':'develop', 'base':'main',
                    'body':'Promote release preparation PR #' + str(pr['number']) + '. Required CI and Copilot review must pass.'}))
            self.receipt(result['number'], 'manage', source=pr['number'], release_version=managed['release_version'])
            self.api.request(f'{PREFIX}/issues/{result["number"]}/labels', 'POST', {'labels':['ai:merge']})
            print(f'Opened release promotion PR #{result["number"]}.')
            return

    def publish_authorized(self):
        if not self.autonomous: return
        closed = self.api.request(f'{PREFIX}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=30')
        main = self.api.request(PREFIX + '/git/ref/heads/main')['object']['sha']
        for pr in closed:
            if not pr.get('merged_at') or pr.get('merge_commit_sha') != main: continue
            receipts = self.receipts(pr['number'])
            authorization = 'authorize_release:' + pr['head']['sha']
            if not already_attempted(receipts, authorization): continue
            action = 'publish:' + main
            if already_attempted(receipts, action): return
            manifest = self.api.request(PREFIX + '/contents/package.json?ref=' + main)
            if manifest.get('encoding') != 'base64': raise ValueError('Unexpected package manifest encoding')
            package = json.loads(base64.b64decode(manifest['content'], validate=False))
            version = package.get('version')
            if not isinstance(version, str) or not re.fullmatch(SEMVER, version):
                raise ValueError('Release requires plain MAJOR.MINOR.PATCH')
            recorded_action(self.api, f'{PREFIX}/issues/{pr["number"]}', action, {'version':version, 'source':main},
                lambda:self.api.request(PREFIX + '/actions/workflows/release.yml/dispatches', 'POST',
                                       {'ref':'main', 'inputs':{'version':version}}))
            print(f'Dispatched authorized release v{version}; publication still depends on the release workflow checks.')
            return

    def backmerge(self):
        if not self.autonomous: return
        main_ref = self.api.request(PREFIX + '/git/ref/heads/main')
        main = main_ref.get('object', {}).get('sha')
        if (main_ref.get('ref') != 'refs/heads/main'
                or main_ref.get('object', {}).get('type') != 'commit'
                or not isinstance(main, str) or not re.fullmatch(r'[0-9a-f]{40}', main)):
            raise ValueError('Cannot validate trusted main commit for back-merge')
        comparison = self.api.request(f'{PREFIX}/compare/develop...{main}')
        if comparison.get('ahead_by', 0) == 0: return
        existing = self.api.request(f'{PREFIX}/pulls?state=open&base=develop&head=consciontologic:main')
        if existing: return
        # Durable intent is written on the last merged main PR. Unknown creation
        # is reconciled by listing PRs on the next sweep, never blindly repeated.
        closed = self.api.request(f'{PREFIX}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=30')
        source = next((pr for pr in closed if pr.get('merged_at') and pr.get('merge_commit_sha') == main), None)
        if not source: return
        number = source['number']
        action = 'backmerge:' + main
        if already_attempted(self.receipts(number), action): return
        # Do not associate a newly advanced main with the prior comparison.
        if self.api.request(PREFIX + '/git/ref/heads/main')['object']['sha'] != main: return
        result = recorded_action(self.api, f'{PREFIX}/issues/{number}', action, {},
            lambda:self.api.request(PREFIX + '/pulls', 'POST', {'title':'chore: back-merge main into develop',
                'head':'main', 'base':'develop', 'body':'Carry released/hotfix changes into develop. CI and Copilot review are required.'}))
        self.receipt(result['number'], 'manage', source=number)
        self.api.request(f'{PREFIX}/issues/{result["number"]}/labels', 'POST', {'labels':['ai:merge']})
        print(f'Opened back-merge PR #{result["number"]}.')

    def run(self, event_name, event):
        self.authorize_event(event_name, event)
        # One bounded scan, no loops waiting for a hosted task. Hourly/event runs resume.
        issues = self.api.request(PREFIX + '/issues?state=open&per_page=30&sort=updated')
        for issue in issues:
            try:
                if 'pull_request' in issue: self.pr(issue)
                else: self.issue(issue)
            except (ApiError, ValueError, KeyError, TypeError) as error:
                print(f'#{issue["number"]}: stopped: {error if isinstance(error, (ApiError,ValueError)) else "unexpected API schema"}')
        self.promote()
        self.publish_authorized()
        self.backmerge()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['run','status'], default='status', nargs='?')
    args = parser.parse_args()
    if args.command == 'status':
        print(json.dumps({'repository':REPO, 'policy':LIMITS,
            'copilot_token_configured':bool(os.environ.get('FAAC_COPILOT_TOKEN')),
            'automation_token_configured':bool(os.environ.get('FAAC_AUTOMATION_TOKEN'))}, indent=2)); return
    token = os.environ.get('FAAC_AUTOMATION_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if not token: raise SystemExit('Set FAAC_AUTOMATION_TOKEN or GITHUB_TOKEN; no action taken.')
    if os.environ.get('GITHUB_REPOSITORY', REPO) != REPO: raise SystemExit('Repository mismatch')
    task_token = os.environ.get('FAAC_COPILOT_TOKEN')
    if not task_token: print('FAAC_COPILOT_TOKEN missing: cloud authoring/repair unavailable.')
    if not os.environ.get('FAAC_AUTOMATION_TOKEN'): print('FAAC_AUTOMATION_TOKEN missing: autonomous merges/back-merges unavailable.')
    event_path = os.environ.get('GITHUB_EVENT_PATH')
    event = json.loads(Path(event_path).read_text()) if event_path else {}
    controller = Controller(GitHub(token), GitHub(task_token) if task_token else None,
                            bool(os.environ.get('FAAC_AUTOMATION_TOKEN')))
    try: controller.run(os.environ.get('GITHUB_EVENT_NAME', ''), event)
    except (ApiError, ValueError) as error: raise SystemExit(str(error)) from None

if __name__ == '__main__': main()
