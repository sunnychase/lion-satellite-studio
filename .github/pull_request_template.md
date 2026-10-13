## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Only what you actually ran, with the result: browser and device, the view or layer, the analysis and its box. -->

- [ ] `bash scripts/check.sh` passes
- In a browser: <!-- what you opened and what you saw; or "not run" and why -->

## Checklist

- [ ] One focused change.
- [ ] Machine-specific values come from `LSS_*` settings; new settings are in `satellite.env.example` with a comment.
- [ ] No personal paths, host names, addresses, keys or e-mail addresses in code, docs, screenshots or commit messages.
- [ ] New or changed upstream requests are cached, rate-polite, validated (no open proxy) and attributed; the README lists the provider's licence.
- [ ] Facts added to `static/data/missions.json` have sources, and `python3 scripts/gen_satellites_table.py` was re-run.
- [ ] CHANGELOG.md has a dated entry, and the README is updated if behaviour, settings, data sources or requirements changed.
- [ ] Anything not tested is said above.
