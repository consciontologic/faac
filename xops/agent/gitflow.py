#!/usr/bin/env python3
"""Plan/create isolated GitFlow branches; validate PR lanes without running PR code."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SEMVER = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'


def plan(kind, name):
    pattern = SEMVER if kind == 'release' else r'[a-z0-9]+(?:-[a-z0-9]+)*'
    if kind not in {'feature', 'bugfix', 'hotfix', 'release'} or len(name) > 80 or not re.fullmatch(pattern, name):
        raise ValueError('Use feature/bugfix/hotfix plus a lowercase slug, or release plus MAJOR.MINOR.PATCH.')
    return f'{kind}/{name}', 'origin/main' if kind == 'hotfix' else 'origin/develop'


def valid_lane(head, base):
    if head == 'develop' and base == 'main': return True
    if head == 'main' and base == 'develop': return True
    for prefix in ('codex/', 'claude/'):
        if head.startswith(prefix): head = head[len(prefix):]
    if head.startswith('copilot/') or head.startswith('dependabot/'):
        return base in {'develop', 'main'} if head.startswith('copilot/') else base == 'develop'
    kind, _, name = head.partition('/')
    try: plan(kind, name)
    except ValueError: return False
    return base == ('main' if kind == 'hotfix' else 'develop')


def validate_dispatch_pull(pr, repository, sha):
    if pr.get('head', {}).get('repo', {}).get('full_name') != repository:
        raise ValueError('Manual GitFlow requires a PR from this repository')
    if pr.get('state') != 'open' or pr.get('head', {}).get('sha') != sha:
        raise ValueError('Manual GitFlow must run at the current open PR head SHA')
    if not valid_lane(pr['head']['ref'], pr['base']['ref']):
        raise ValueError('Invalid GitFlow lane')


def validate_push_pulls(prs, repository, branch, sha):
    if not isinstance(prs, list) or not prs or len(prs) >= 100:
        raise ValueError('Work-branch push requires an open same-repository PR')
    for pr in prs:
        validate_dispatch_pull(pr, repository, sha)
        if pr['head']['ref'] != branch:
            raise ValueError('Open PR does not match the pushed branch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', nargs='?', choices=['feature', 'bugfix', 'hotfix', 'release'])
    parser.add_argument('name', nargs='?')
    parser.add_argument('--agent', choices=['codex', 'claude'])
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--check-event', action='store_true')
    args = parser.parse_args()
    if args.check_event:
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        pr = event.get('pull_request')
        if os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch':
            number = (event.get('inputs') or {}).get('pull_request_number', '').strip()
            if number:
                if not re.fullmatch(r'[1-9][0-9]*', number): raise SystemExit('Enter a positive PR number')
                from copilot_task import GitHub, REPO
                if os.environ.get('GITHUB_REPOSITORY') != REPO: raise SystemExit('Repository mismatch')
                pr = GitHub(os.environ.get('GITHUB_TOKEN', '')).request(f'repos/{REPO}/pulls/{number}')
                validate_dispatch_pull(pr, REPO, os.environ.get('GITHUB_SHA'))
            elif os.environ.get('GITHUB_REF') not in {'refs/heads/main', 'refs/heads/develop'}:
                raise SystemExit('Work-branch dispatch requires pull_request_number for exact-head validation')
        if os.environ.get('GITHUB_EVENT_NAME') == 'push':
            ref = os.environ.get('GITHUB_REF', '')
            if ref not in {'refs/heads/main', 'refs/heads/develop'}:
                from copilot_task import GitHub, REPO
                from urllib.parse import quote
                if os.environ.get('GITHUB_REPOSITORY') != REPO or not ref.startswith('refs/heads/'):
                    raise SystemExit('Repository or branch mismatch')
                branch = ref[len('refs/heads/'):]
                head = quote(REPO.split('/')[0] + ':' + branch, safe='')
                prs = GitHub(os.environ.get('GITHUB_TOKEN', '')).request(
                    f'repos/{REPO}/pulls?state=open&head={head}&per_page=100')
                validate_push_pulls(prs, REPO, branch, os.environ.get('GITHUB_SHA'))
                print(f'GitFlow: validated {len(prs)} open PR lane(s) at the pushed head')
                return
        if not pr: print('GitFlow: not a pull request.'); return
        head, base = pr['head']['ref'], pr['base']['ref']
        if not valid_lane(head, base): raise SystemExit(f'Invalid GitFlow lane: {head} -> {base}')
        print(f'GitFlow: {head} -> {base}'); return
    if not args.kind or not args.name: parser.error('kind and name are required')
    branch, base = plan(args.kind, args.name)
    if args.agent: branch = args.agent + '/' + branch
    target = ROOT / '.local/worktrees' / branch.replace('/', '-')
    print(f'{branch} <- {base}\n{target}')
    if args.apply:
        subprocess.run(['git', 'fetch', 'origin'], cwd=ROOT, check=True)
        subprocess.run(['git', 'rev-parse', '--verify', base + '^{commit}'], cwd=ROOT, check=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'worktree', 'add', '-b', branch, str(target), base], cwd=ROOT, check=True)

if __name__ == '__main__': main()
