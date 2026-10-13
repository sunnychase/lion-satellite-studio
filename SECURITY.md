# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through **Report a vulnerability** in this repository's **Security** tab
(GitHub private vulnerability reporting). Do not open a public issue, and do not post exploit details or keys anywhere public.

Include what is affected, how to reproduce it, what an attacker could do with it, and the commit you tested. Remove personal
paths, addresses and keys from logs before you send them. You will get an acknowledgement, and the fix and its disclosure
will be coordinated with you.

There are no releases or version numbers: fixes go to `main` and are listed in [CHANGELOG.md](CHANGELOG.md).

## What the app is built for

Lion Satellite Studio is a viewer for **one person or a trusted local network**. Please keep these boundaries in mind:

- **No login.** The server listens on `127.0.0.1` by default and has no accounts. Anyone who can reach its port can use every
  feature, including starting radar analyses (one at a time, each limited in area and time). To use it from another device,
  put it behind an authenticating reverse proxy or tunnel; never expose it bare to a network you do not trust.
- **Not an open proxy.** Every upstream URL is a fixed template; browser parameters are checked against whitelists and strict
  patterns before use. A way to make the server fetch an arbitrary URL is a vulnerability: please report it.
- **Keys.** `AISSTREAM_API_KEY` and `GFW_API_TOKEN` are read once from the keys file (mode 600 recommended), are never logged,
  never returned by any endpoint and never sent to the browser. Error messages are scrubbed of key values.
- **`satellite.env` is trusted configuration.** `LSS_VENV_PYTHON` names the interpreter the server runs for analyses; whoever
  can edit that file can already run programs as you.
- **Static files** are served only from `static/`, with path normalisation and a real-path check.

Reports we especially want: reaching an upstream URL the code does not intend, reading files outside `static/` or the cache,
leaking a key (in a response, a log line or an error), running commands through request data, and requests that make the
server use unbounded memory, disk or upstream traffic.
