#!/bin/bash
# The repository's checks (CI runs the same script): every Python file compiles, every JavaScript module of the page
# parses, the README satellites table matches the data it is generated from, and no tracked file carries a
# home-directory path, a private network address, a token-shaped string or a keys file.
# Needs python3, node and git. Run from anywhere: bash scripts/check.sh [py|js|table|hygiene]   (no argument = all)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0; only="${1:-all}"
run() { [ "$only" = all ] || [ "$only" = "$1" ]; }
tmp=$(mktemp -d); trap 'rm -r "$tmp"' EXIT

if run py; then
echo "== python: py_compile"
n=0
while IFS= read -r f; do
  n=$((n + 1)); PYTHONPYCACHEPREFIX="$tmp/pyc" python3 -m py_compile "$f" || { echo "FAIL $f"; fail=1; }
done < <(git ls-files '*.py')
echo "$n files"
fi

if run js; then
echo "== page: node --check on every module in static/js and the inline script of static/index.html"
n=0
for f in static/js/*.js; do
  n=$((n + 1)); cp "$f" "$tmp/$(basename "$f" .js).mjs"   # .mjs: parse as an ES module on any Node version
  node --check "$tmp/$(basename "$f" .js).mjs" || { echo "FAIL $f"; fail=1; }
done
python3 - "$tmp" <<'PY' || fail=1
import pathlib, re, sys
page = pathlib.Path("static/index.html").read_text()
blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", page, re.S)
for i, b in enumerate(blocks): pathlib.Path(sys.argv[1], f"inline{i}.js").write_text(b)
print(f"{len(blocks)} inline block(s)")
PY
for f in "$tmp"/inline*.js; do [ -e "$f" ] && { node --check "$f" || { echo "FAIL $(basename "$f")"; fail=1; }; }; done
echo "$n modules"
fi

if run table; then
echo "== README: satellites table matches static/data/missions.json"
python3 scripts/gen_satellites_table.py --check || fail=1
fi

if run hygiene; then
echo "== hygiene: home paths, private addresses, token-shaped strings, keys files"
# vendored third-party code (static/vendor, unmodified) is checked for token-shaped strings only: minified libraries
# contain version-like numbers and placeholder home-directory paths (from Emscripten and ArcGIS URLs).
{ git grep -I -n -E 'hf_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}' -- .
  git grep -I -n -E '/home/[a-z]|/Users/[A-Za-z]|192\.168\.[0-9]|\b10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b|\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}\b' -- . ':!static/vendor'
  git ls-files | grep -E '(^|/)(keys\.env.*|satellite\.env|.*\.sqlite|.*\.db)$' | sed 's/^/tracked: /'
} | cut -c1-200 > "$tmp/hits"
hits=$(cat "$tmp/hits")
if [ -n "$hits" ]; then echo "$hits"; echo "FAIL: use \$HOME, ~ or a satellite.env setting instead; never commit addresses, tokens or keys files"; fail=1; else echo "clean"; fi
fi

[ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || echo "CHECKS FAILED"
exit "$fail"
