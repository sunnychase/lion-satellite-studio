# Contributing to Lion Satellite Studio

Thanks for helping. Bug reports, fixes, new data layers, documentation and focused features are all welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/sunnychase/lion-satellite-studio/issues) with the bug or feature form.
  Search first; one problem or idea per issue.
- **Security problems:** do not open a public issue; see [SECURITY.md](SECURITY.md).
- **Bigger changes** (a new data provider, a new analysis, a change to caching): open an issue first so the approach can be
  agreed before you spend time on it. Say what the provider's terms and rate limits are.

## Running it locally

```bash
LSS_PORT=8641 LSS_CACHE_DIR=/tmp/lss-dev-cache python3 server.py      # a development copy with its own cache
```

The server uses only the Python standard library. Files under `static/` are read on every request, so page changes show up on
reload (if you ran `scripts/precompress.py`, re-run it or delete the stale `.gz` files: the server only uses a `.gz` that is at
least as new as its source). Python changes need a restart. `window.LE` in the browser console is the app state, handy for
debugging. For the radar worker, run `scripts/setup_radar.sh` once.

Please be polite to the providers while you develop: keep a cache directory between runs (CelesTrak asks for at most one
download per group every 2 hours), and do not loop requests against ASF, Hydrocron, Planetary Computer or Global Fishing Watch.

## House rules

- **Machine settings live in `satellite.env`** (`LSS_*` variables). Paths, ports and addresses never go into the code; a new
  setting gets a safe default in `server.py` and a commented line in `satellite.env.example`.
- **No personal or machine-specific data**: no home-directory paths, host names, private addresses, user names, tokens or
  e-mail addresses, in code, docs, comments, screenshots or commit messages.
- **The server stays standard-library only.** Code that needs packages runs in the radar worker's own environment
  (`analysis.py`, started as a subprocess) and passes results back as files.
- **Not an open proxy.** Every upstream URL is a template in the code; every parameter from the browser is validated against a
  whitelist or a strict pattern. Keys never reach the browser and are never logged.
- **Respect the providers.** Cache every upstream, honour their rate rules, keep attributions, and say in the README which
  licence applies (and whether it is non-commercial).
- **Facts need sources.** New entries in `static/data/missions.json` list the pages they came from; leave out what you cannot
  confirm. Re-run `python3 scripts/gen_satellites_table.py` after changing it.
- **Say what changed**: a dated entry in [CHANGELOG.md](CHANGELOG.md), and README updates when behaviour, settings or
  requirements change. Numbers in docs come from a real run; say on what and how many runs.

## Checks

Run before every commit. CI (`.github/workflows/ci.yml`) runs the same script on every push and pull request:

```bash
bash scripts/check.sh            # or one part: py | js | table | hygiene
```

It compiles every Python file, runs `node --check` on every module in `static/js/` and the page's inline script, checks that
the README satellites table matches `static/data/missions.json`, and fails on home-directory paths, private network addresses,
token-shaped strings or a tracked keys file.

## Pull requests

- One focused change per pull request, with a short imperative title ("SWOT: add the Mekong at Phnom Penh").
- Fill in the template: what changed, why, how you tested it, and anything you could not test.
- Do not commit `satellite.env`, `keys.env`, `cache/`, `venv/`, `.gz` files or `__pycache__`.

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
