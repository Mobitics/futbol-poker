#!/usr/bin/env python3
"""Stamp every local JS import (and the script tag) with one version so
browsers never mix cached old modules with new ones after a deploy.
Run before pushing: python3 scripts/bump-version.py"""
import re, time, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
v = time.strftime('%Y%m%d%H%M%S')
files = list((root / 'js').rglob('*.js')) + [root / 'index.html']
pat = re.compile(r"""((?:from\s+|import\(\s*|src=|href=)['"](?:\.{1,2}/|js/|css/)[^'"?]+\.(?:js|css))(?:\?v=\w+)?(['"])""")
for f in files:
    s = f.read_text()
    n = pat.sub(lambda m: f"{m.group(1)}?v={v}{m.group(2)}", s)
    if n != s:
        f.write_text(n)
print('version', v)
