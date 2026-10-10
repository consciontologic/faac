#!/usr/bin/env python3
"""Translate exported Make variables to subprocess arguments without shell evaluation."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]

def main():
    command = sys.argv[1]
    if command == 'gitflow':
        args = [sys.executable, 'xops/agent/gitflow.py', os.environ.get('KIND','feature'), os.environ.get('NAME',''), '--agent', os.environ.get('AGENT','codex')]
        if os.environ.get('APPLY') == '1': args += ['--apply']
    elif command in ('ai-plan','ai-submit'):
        args = [sys.executable, 'xops/agent/copilot_task.py', os.environ.get('KIND','feature'), '--prompt-file', os.environ.get('PROMPT_FILE','')]
        for variable, flag in [('RELEASE_VERSION','--release-version'),('HEAD_REF','--head-ref')]:
            if os.environ.get(variable): args += [flag, os.environ[variable]]
        if command == 'ai-submit':
            receipt = os.environ.get('RECEIPT','')
            if not receipt: raise SystemExit('RECEIPT must name a new file; inspect uncertain outcomes before retrying.')
            args += ['--submit','--receipt',receipt]
    elif command == 'track':
        args = ['bash', 'xops/agent/tracking_append.sh']
        for variable, name in [('ACTION','action'),('STATUS','status'),('SCOPE','scope'),('AGENT','agent'),('SUMMARY','summary'),('REFS','refs'),('RUN_ID','run-id')]:
            if os.environ.get(variable): args += ['--' + name + '=' + os.environ[variable]]
    else: raise SystemExit('Unknown local command')
    raise SystemExit(subprocess.run(args, cwd=ROOT).returncode)

if __name__ == '__main__': main()
