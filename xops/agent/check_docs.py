#!/usr/bin/env python3
"""Validate published documentation links and completed scaffold documents."""
from pathlib import Path
import re
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
required = ['docs/code/API.md','docs/code/ARCHITECTURE.md','docs/code/MODULE.md',
            'docs/project/CHARTER.md','docs/project/DECISION_LOG.md','docs/project/GLOSSARY.md',
            'docs/design/DESIGN.md','docs/planning/ROADMAP.md','docs/guides/USAGE.md',
            'docs/reports/VERIFICATION.md']
errors = [f'Missing completed document: {name}' for name in required if not (ROOT/name).is_file()]
errors += [f'Unfilled scaffold template: {p.relative_to(ROOT)}' for p in (ROOT/'docs').rglob('*.template.md')]
if not list((ROOT/'docs/design').glob('ADR-*.md')): errors.append('Missing filled architecture decision')
files = list(ROOT.glob('*.md')) + list((ROOT/'docs').rglob('*.md'))
for file in files:
    source = file.read_text()
    # Code examples can deliberately contain hypothetical Markdown paths.
    source = re.sub(r'^```.*?^```[^\n]*$', '', source, flags=re.M|re.S)
    for match in re.finditer(r'(?<!!)\[[^\]]+\]\(([^)]+)\)',source):
        target = match.group(1).split(' "',1)[0].strip('<>')
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:',target) or target.startswith('#'): continue
        target = unquote(target.split('#',1)[0])
        if not target: continue
        resolved = (ROOT/target.lstrip('/')) if target.startswith('/') else (file.parent/target)
        if not resolved.exists(): errors.append(f'{file.relative_to(ROOT)}: broken link {target}')
    if re.search(r'\b(?:TODO|TBD|YOUR_PROJECT|PROJECT_NAME)\b', source):
        errors.append(f'{file.relative_to(ROOT)}: unresolved placeholder')
if errors:
    print('\n'.join(errors),file=sys.stderr); raise SystemExit(1)
print(f'Documentation checks passed: {len(files)} documents; scaffold templates filled and removed.')
