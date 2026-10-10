#!/usr/bin/env python3
"""Read-only exact-tree PR evidence, adapted from wfform release_delivery.py.

Copyright (c) 2026 Serhat Akbak. MIT; see LICENSE and THIRD_PARTY_NOTICES.md.
No task submission, merging, release dispatch or other mutation occurs here.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
REPO = 'consciontologic/faac'
PREFIX = 'repos/' + REPO
SHA = re.compile(r'[a-f0-9]{40}')
CHECK_WORKFLOWS = {'Quality': '.github/workflows/ci.yml', 'Package': '.github/workflows/ci.yml',
                   'Container': '.github/workflows/container.yml', 'Security': '.github/workflows/security.yml',
                   'GitFlow': '.github/workflows/gitflow.yml'}


def pages(api, path, key=None):
    """Bound API collections; incomplete metadata never counts as evidence."""
    result = []
    for number in range(1, 21):
        data = api.request(path + ('&' if '?' in path else '?') + f'per_page=100&page={number}')
        rows = data.get(key) if key and isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise ValueError('Incomplete GitHub evidence collection')
        result.extend(rows)
        if len(rows) < 100:
            return result
    raise ValueError('Evidence exceeds the bounded GitHub history audit')


def git_tree(api, sha):
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise ValueError('Evidence requires an immutable commit SHA')
    commit = api.request(f'{PREFIX}/git/commits/{sha}')
    tree = commit.get('tree', {}).get('sha')
    if commit.get('sha') != sha or not isinstance(tree, str) or not SHA.fullmatch(tree):
        raise ValueError('Cannot verify immutable Git tree')
    return tree


def ordered_times(values):
    try:
        times = [datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc) for value in values]
        return times == sorted(times)
    except (TypeError, ValueError):
        return False


def historical_run(api, pr, run, cache):
    """GitHub can clear run.pull_requests after merging; verify that case strictly."""
    head = pr.get('head', {})
    if (pr.get('merged') is not True or pr.get('state') != 'closed' or pr.get('draft')
            or any(pr.get(side, {}).get('repo', {}).get('full_name') != REPO for side in ('head', 'base'))
            or run.get('head_branch') != head.get('ref')
            or not ordered_times([pr.get('created_at'), run.get('created_at'), run.get('run_started_at'),
                                  run.get('updated_at'), pr.get('merged_at')])):
        return False
    if not cache:
        branch = quote(REPO.split('/')[0] + ':' + head['ref'], safe='')
        history = pages(api, f'{PREFIX}/pulls?state=all&head={branch}')
        if len(history) != 1:
            raise ValueError('Missing run association requires a branch used by exactly one PR')
        source = history[0]
        if (source.get('number') != pr.get('number') or source.get('state') != 'closed'
                or source.get('draft') or source.get('merged_at') != pr.get('merged_at')
                or source.get('merge_commit_sha') != pr.get('merge_commit_sha')
                or any(source.get(side, {}).get('ref') != pr.get(side, {}).get('ref')
                       or source.get(side, {}).get('repo', {}).get('full_name') != REPO for side in ('head', 'base'))
                or source.get('head', {}).get('sha') != head.get('sha')):
            raise ValueError('Merged PR identity changed during evidence validation')
        events = pages(api, f'{PREFIX}/issues/{pr["number"]}/events')
        if any(not isinstance(event, dict) or event.get('event') in {
                'base_ref_changed', 'automatic_base_change_succeeded'} for event in events):
            raise ValueError('Retargeted PR cannot supply evidence without its run association')
        commit = api.request(f'{PREFIX}/git/commits/{pr["merge_commit_sha"]}')
        parents = commit.get('parents')
        if (commit.get('sha') != pr['merge_commit_sha'] or not isinstance(parents, list)
                or len(parents) != 2 or parents[1].get('sha') != head['sha']
                or commit.get('tree', {}).get('sha') != git_tree(api, head['sha'])):
            raise ValueError('Merged PR must preserve its tested head and identical tree')
        cache['verified'] = True
    return cache['verified']


def verify_quality(api, pr):
    from gitflow import quality_pr
    if pr.get('base', {}).get('repo', {}).get('full_name') != REPO or not quality_pr(pr):
        raise ValueError('Quality evidence must come from a develop PR or main hotfix PR')
    policy = json.loads((ROOT / '.github/gitflow.json').read_text())
    if (policy.get('check_workflows') != CHECK_WORKFLOWS or policy.get('checks_app_id') != 15368
            or set(policy.get('required_checks', [])) != set(CHECK_WORKFLOWS)):
        raise ValueError('Evidence requires the reviewed five-check workflow policy')
    if not isinstance(pr.get('head', {}).get('repo', {}).get('full_name'), str):
        raise ValueError('Source repository identity is missing')
    checks = pages(api, f'{PREFIX}/commits/{pr["head"]["sha"]}/check-runs?filter=all', 'check_runs')
    run_cache, history_cache = {}, {}
    run_ids = set()
    for name, workflow in policy['check_workflows'].items():
        eligible = []
        for check in checks:
            if check.get('name') != name:
                continue
            match = re.fullmatch(r'https://github\.com/' + re.escape(REPO)
                                 + r'/actions/runs/([0-9]+)/job/([0-9]+)', check.get('details_url') or '')
            if not match:
                continue
            run_id, job_id = map(int, match.groups())
            if run_id not in run_cache:
                run_cache[run_id] = api.request(f'{PREFIX}/actions/runs/{run_id}')
            run = run_cache[run_id]
            head = pr.get('head', {})
            if (run.get('id') != run_id or run.get('event') != 'pull_request'
                    or run.get('head_sha') != head.get('sha')
                    or run.get('path', '').split('@')[0] != workflow
                    or run.get('repository', {}).get('full_name') != REPO
                    or run.get('head_repository', {}).get('full_name') != head.get('repo', {}).get('full_name')):
                continue
            associations = run.get('pull_requests')
            if not isinstance(associations, list):
                raise ValueError('Missing workflow PR association metadata')
            associated = any(isinstance(item, dict) and item.get('number') == pr.get('number')
                and item.get('head', {}).get('sha') == head.get('sha')
                and item.get('base', {}).get('ref') == pr.get('base', {}).get('ref') for item in associations)
            if associations and not associated and not any(
                    isinstance(item, dict) and item.get('number') == pr.get('number') for item in associations):
                continue  # A promotion's skipped checks at the same SHA are a different PR.
            if not associations and run.get('head_branch') != head.get('ref'):
                continue
            proved = associated or (not associations and historical_run(api, pr, run, history_cache))
            # A newer ambiguous/failing run for this source cannot rescue an old success.
            eligible.append((check, run, job_id, proved))
        check, run, job_id, proved = max(eligible, key=lambda item: item[0].get('id', 0), default=({}, {}, None, False))
        if (not proved or check.get('head_sha') != pr['head']['sha']
                or check.get('app', {}).get('id') != policy['checks_app_id']
                or not isinstance(run.get('check_suite_id'), int)
                or check.get('check_suite', {}).get('id') != run.get('check_suite_id')
                or check.get('status') != 'completed' or check.get('conclusion') != 'success'
                or run.get('status') != 'completed' or run.get('conclusion') != 'success'):
            raise ValueError('Required check lacks successful PR provenance: ' + name)
        job = api.request(f'{PREFIX}/actions/jobs/{job_id}')
        if (job.get('id') != job_id or job.get('run_id') != run.get('id')
                or not isinstance(run.get('run_attempt'), int) or not isinstance(job.get('run_attempt'), int)
                or not 1 <= job['run_attempt'] <= run['run_attempt']
                or job.get('head_sha') != pr['head']['sha'] or job.get('name') != name
                or job.get('check_run_url') != f'https://api.github.com/{PREFIX}/check-runs/{check.get("id")}'
                or job.get('status') != 'completed' or job.get('conclusion') != 'success'):
            raise ValueError('Required check does not match its actual workflow job: ' + name)
        if run.get('pull_requests') == [] and not ordered_times([
                run.get('created_at'), job.get('started_at'), check.get('started_at'), check.get('completed_at'),
                job.get('completed_at'), run.get('updated_at'), pr.get('merged_at')]):
            raise ValueError('Historical check must complete before its PR merge: ' + name)
        run_ids.add(run['id'])
    return sorted(run_ids)


def verify_promotion(api, pr):
    if (pr.get('base', {}).get('ref') != 'main' or pr.get('head', {}).get('ref') != 'develop'
            or pr.get('draft') or any(pr.get(side, {}).get('repo', {}).get('full_name') != REPO for side in ('head', 'base'))):
        raise ValueError('Expected same-repository develop to main promotion')
    if not pr.get('merged') and (pr.get('state') != 'open' or pr.get('mergeable') is not True):
        raise ValueError('Wait for GitHub to confirm promotion mergeability')
    tree = git_tree(api, pr['head']['sha'])
    if git_tree(api, pr.get('merge_commit_sha')) != tree:
        raise ValueError('Promotion merge tree contains untested content')
    for candidate in pages(api, f'{PREFIX}/pulls?state=closed&base=develop&sort=updated&direction=desc'):
        if not candidate.get('merged_at'):
            continue
        source = api.request(f'{PREFIX}/pulls/{candidate["number"]}')
        if (source.get('merged') is not True or source.get('state') != 'closed'
                or source.get('base', {}).get('ref') != 'develop'
                or source.get('base', {}).get('repo', {}).get('full_name') != REPO):
            continue
        if (git_tree(api, source.get('head', {}).get('sha')) != tree
                or git_tree(api, source.get('merge_commit_sha')) != tree):
            continue
        runs = verify_quality(api, source)
        return {'tree_sha': tree, 'source_pr': source['number'], 'source_head_sha': source['head']['sha'],
                'run_ids': runs, 'promotion_pr': pr['number']}
    raise ValueError('No merged develop PR proves successful quality for this exact source tree')


def verify_release(api, sha):
    from gitflow import hotfix_pr
    if not SHA.fullmatch(sha or ''):
        raise ValueError('A full release SHA is required')
    ref = api.request(f'{PREFIX}/git/ref/heads/main')
    if ref.get('object', {}).get('type') != 'commit' or ref.get('object', {}).get('sha') != sha:
        raise ValueError('Release SHA is not current main')
    for candidate in pages(api, f'{PREFIX}/commits/{sha}/pulls'):
        pr = api.request(f'{PREFIX}/pulls/{candidate["number"]}')
        if (pr.get('merged') is not True or pr.get('state') != 'closed' or pr.get('draft')
                or pr.get('merge_commit_sha') != sha or pr.get('base', {}).get('ref') != 'main'
                or pr.get('base', {}).get('repo', {}).get('full_name') != REPO):
            continue
        if hotfix_pr(pr):
            tree = git_tree(api, sha)
            if git_tree(api, pr['head']['sha']) != tree:
                raise ValueError('Hotfix merge tree differs from its tested head')
            evidence = {'tree_sha': tree, 'source_pr': pr['number'], 'source_head_sha': pr['head']['sha'],
                        'run_ids': verify_quality(api, pr), 'promotion_pr': pr['number']}
        else:
            evidence = verify_promotion(api, pr)
        return {'release_sha': sha, **evidence}
    raise ValueError('Current main has no merged promotion or hotfix PR evidence')


def main():
    from copilot_task import GitHub
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if os.environ.get('GITHUB_REPOSITORY', REPO) != REPO:
        raise ValueError('Repository mismatch')
    evidence = verify_release(GitHub(os.environ.get('GH_TOKEN', '')), args.sha)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
