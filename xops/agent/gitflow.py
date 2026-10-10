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


def hotfix_pr(pr, repository='consciontologic/faac'):
    head = pr.get('head', {})
    branch = head.get('ref', '')
    prefixes = ('hotfix/', 'codex/hotfix/', 'claude/hotfix/')
    return (any(branch.startswith(prefix) for prefix in prefixes)
            or (branch.startswith('copilot/')
                and head.get('repo', {}).get('full_name') == repository
                and 'work:hotfix' in {label.get('name') for label in pr.get('labels', [])}))


def quality_pr(pr, repository='consciontologic/faac'):
    base = pr.get('base', {}).get('ref')
    return base == 'develop' or (base == 'main' and hotfix_pr(pr, repository))


def valid_lane(head, base):
    # Branch planning suggests conventions; intake intentionally accepts ANY
    # source branch into develop, including forks and platform-owned branches.
    return bool(head) and (base == 'develop' or (base == 'main' and (
        head == 'develop' or any(head.startswith(prefix) for prefix in
                                ('hotfix/', 'codex/hotfix/', 'claude/hotfix/')))))


def check_event(event, event_name, repository, client=None):
    if event_name != 'pull_request':
        raise ValueError('GitFlow checks run only for pull_request events')
    pr = event.get('pull_request') or {}
    if pr.get('base', {}).get('repo', {}).get('full_name') != repository:
        raise ValueError('PR target repository differs from the workflow repository')
    head, base = pr.get('head', {}).get('ref', ''), pr.get('base', {}).get('ref', '')
    if quality_pr(pr, repository):
        return f'GitFlow: {head} -> {base}; quality checks run on this PR.'
    if base != 'main' or head != 'develop' or pr.get('head', {}).get('repo', {}).get('full_name') != repository:
        raise ValueError('Main accepts a hotfix PR or a same-repository develop promotion')
    from release_evidence import verify_promotion
    if client is None:
        from copilot_task import GitHub
        client = GitHub(os.environ.get('GH_TOKEN', ''))
    number = pr.get('number', event.get('number'))
    if not isinstance(number, int) or number < 1:
        raise ValueError('Expected a positive PR number')
    fresh = client.request(f'repos/{repository}/pulls/{number}')
    if (fresh.get('head', {}).get('sha') != pr.get('head', {}).get('sha')
            or fresh.get('base', {}).get('sha') != pr.get('base', {}).get('sha')):
        raise ValueError('PR head or base moved; use a fresh pull_request run')
    evidence = verify_promotion(client, fresh)
    return (f'GitFlow: reuse prior checks; no scans/builds/tests run. '
            f'Develop PR #{evidence["source_pr"]} proved tree {evidence["tree_sha"]}.')


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
        from copilot_task import REPO
        if os.environ.get('GITHUB_REPOSITORY') != REPO:
            raise SystemExit('Repository mismatch')
        message = check_event(event, os.environ.get('GITHUB_EVENT_NAME'), REPO)
        print(message)
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write(message + '\n')
        return
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
