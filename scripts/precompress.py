#!/usr/bin/env python3
"""Write gzip copies (file.gz) next to the text-like files under static/, so the server can send them compressed.

Optional: the server works without them, it just sends larger files (Cesium.js is ~6 MB uncompressed; ~1.6 MB gzipped).
Re-run after editing anything under static/: the server only uses a .gz that is at least as new as its source.
The .gz files are git-ignored.   Usage: python3 scripts/precompress.py
"""
import gzip
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent / "static"
EXT = {".js", ".mjs", ".css", ".html", ".json", ".geojson", ".svg", ".wasm", ".glb", ".txt", ".md", ".xml"}
n = saved = 0
for p in ROOT.rglob("*"):
    if not p.is_file() or p.suffix.lower() not in EXT or p.stat().st_size < 1024:
        continue
    gz = p.with_name(p.name + ".gz")
    if gz.exists() and gz.stat().st_mtime >= p.stat().st_mtime:
        continue
    raw = p.read_bytes()
    comp = gzip.compress(raw, 9, mtime=0)
    if len(comp) > 0.9 * len(raw):
        continue  # not worth it (already compressed data)
    tmp = gz.with_name(gz.name + ".tmp")
    tmp.write_bytes(comp)
    os.replace(tmp, gz)
    n += 1
    saved += len(raw) - len(comp)
print("precompressed %d files, %.1f MB smaller on the wire" % (n, saved / 1e6))
