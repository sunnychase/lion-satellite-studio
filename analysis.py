#!/usr/bin/env python3
# Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
"""Lion Satellite Studio - Sentinel-1 RTC analysis worker (CPU only, one job at a time).

Runs in the Python environment named by LSS_VENV_PYTHON, which has the optional radar extras
(requirements-radar.txt). server.py starts it as a niced subprocess.

Usage: analysis.py <job_dir>   (job_dir/job.json written by server.py)
Writes job_dir/progress.json while running and result.json (+ overlay.png, result.geojson) at the end.

Data: Sentinel-1 radiometrically terrain corrected gamma0 (sentinel-1-rtc) on Microsoft Planetary
Computer. Only the COG windows covering the AOI are read (HTTP range requests, anonymous SAS token).
Everything here is an automatic estimate - not validated.
"""
import json
import math
import os
import sys
import time
import traceback
import urllib.request

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("GDAL_NUM_THREADS", "2")
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.enums import Resampling  # noqa: E402
from rasterio.features import rasterize, shapes  # noqa: E402
from rasterio.transform import from_bounds  # noqa: E402
from rasterio.vrt import WarpedVRT  # noqa: E402
from scipy import ndimage  # noqa: E402
import planetary_computer as pc  # noqa: E402
import pystac  # noqa: E402

UA = os.environ.get("LSS_USER_AGENT") or "LionSatelliteStudio/1.0 (+https://github.com/sunnychase/lion-satellite-studio)"
STAC_ITEM = "https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-1-rtc/items/{id}"
STAC_SEARCH = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("LSS_DATA_DIR") or os.path.join(ROOT, "data")
LAND = [os.path.join(DATA_DIR, "ne_10m_land.geojson"), os.path.join(DATA_DIR, "ne_10m_minor_islands.geojson")]
ENL = 4.4  # sar:looks_equivalent_number of the RTC product (from the STAC item)
CAVEAT = "Automatic estimate - not validated."

JOB_DIR = sys.argv[1]
T0 = time.time()


def progress(pct, msg):
    tmp = os.path.join(JOB_DIR, "progress.json.tmp")
    with open(tmp, "w") as f:
        json.dump({"pct": round(pct, 1), "msg": msg, "elapsed_s": round(time.time() - T0, 1)}, f)
    os.replace(tmp, os.path.join(JOB_DIR, "progress.json"))


def http_json(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def get_item(item_id):
    d = http_json(STAC_ITEM.format(id=item_id))
    return pc.sign(pystac.Item.from_dict(d))


class Pass:
    """One satellite pass = 1-3 adjacent RTC slices (ids joined with '+'), read as a mosaic."""
    def __init__(self, pid):
        self.items = [get_item(i) for i in pid.split("+")]
        self.id = pid
        self.properties = self.items[0].properties


def read_pass(ps, band, g):
    out = None
    for it in ps.items:
        a = read_band(it, band, g)
        out = a if out is None else np.where(np.isfinite(out), out, a)
    return out


# ---------------------------------------------------------------- grid + reading
def make_grid(bbox, target_m, max_px):
    w, s, e, n = bbox
    lat0 = math.radians((s + n) / 2)
    mx, my = 111320.0 * math.cos(lat0), 110574.0
    wm, hm = (e - w) * mx, (n - s) * my
    px = target_m
    while (wm / px) * (hm / px) > max_px:
        px *= 1.2
    width, height = max(2, int(round(wm / px))), max(2, int(round(hm / px)))
    tr = from_bounds(w, s, e, n, width, height)
    return {"transform": tr, "width": width, "height": height, "px_m": round(math.sqrt(wm * hm / (width * height)), 1),
            "pix_area_km2": (wm * hm) / (width * height) / 1e6, "mx": wm / width, "my": hm / height}


def read_band(item, band, g):
    """Warp one RTC band onto the AOI grid (EPSG:4326). Linear gamma0, NaN where no data."""
    href = item.assets[band].href
    ovr = None
    if g["px_m"] >= 75:
        ovr = 2
    elif g["px_m"] >= 38:
        ovr = 1
    elif g["px_m"] >= 19:
        ovr = 0
    kw = {"overview_level": ovr} if ovr is not None else {}
    with rasterio.Env():
        with rasterio.open(href, **kw) as src:
            with WarpedVRT(src, crs="EPSG:4326", transform=g["transform"], width=g["width"], height=g["height"],
                           resampling=Resampling.bilinear, src_nodata=-32768, nodata=np.nan, dtype="float32") as vrt:
                a = vrt.read(1)
    a = a.astype(np.float32)
    a[~np.isfinite(a) | (a <= 0)] = np.nan
    return a


def lee(img, size=5):
    """Lee speckle filter on linear intensity (noise cv^2 = 1/ENL)."""
    bad = ~np.isfinite(img)
    fill = np.nanmedian(img) if np.any(~bad) else 0.0
    x = np.where(bad, fill, img).astype(np.float32)
    m = ndimage.uniform_filter(x, size)
    m2 = ndimage.uniform_filter(x * x, size)
    var = np.maximum(m2 - m * m, 0)
    ci2 = var / np.maximum(m * m, 1e-12)
    w = np.clip(1.0 - (1.0 / ENL) / np.maximum(ci2, 1e-12), 0.0, 1.0)
    out = m + w * (x - m)
    out[bad] = np.nan
    return out


def db(a):
    with np.errstate(divide="ignore", invalid="ignore"):
        return 10.0 * np.log10(a)


def otsu(values):
    v = values[np.isfinite(values)]
    v = v[(v > -35) & (v < 5)]
    if v.size < 500:
        return None
    hist, edges = np.histogram(v, bins=256)
    p = hist.astype(np.float64) / hist.sum()
    centers = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(p)
    w1 = 1 - w0
    mu = np.cumsum(p * centers)
    mt = mu[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        sb = (mt * w0 - mu) ** 2 / (w0 * w1)
    sb[~np.isfinite(sb)] = 0
    return float(centers[int(np.argmax(sb))])


def clean_mask(m, min_px=6):
    m = ndimage.binary_opening(m, structure=np.ones((2, 2)))
    lab, n = ndimage.label(m)
    if n == 0:
        return m
    sizes = ndimage.sum(m, lab, index=np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= min_px
    return keep[lab]


def write_png(path, rgba):
    h, w = rgba.shape[1:]
    with rasterio.open(path, "w", driver="PNG", width=w, height=h, count=4, dtype="uint8") as dst:
        dst.write(rgba)
    aux = path + ".aux.xml"
    if os.path.exists(aux):
        os.remove(aux)


def overlay(shape, layers):
    """layers: list of (mask, (r,g,b,a))"""
    rgba = np.zeros((4,) + shape, np.uint8)
    for m, col in layers:
        for i in range(4):
            rgba[i][m] = col[i]
    return rgba


def vectorize(mask, g, props_fn, max_features=3000):
    feats = []
    if not mask.any():
        return feats
    m = mask.astype(np.uint8)
    for geom, val in shapes(m, mask=mask, transform=g["transform"], connectivity=8):
        ring = geom["coordinates"][0]
        a = 0.0
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            a += x1 * y2 - x2 * y1
        feats.append((abs(a), geom))
    feats.sort(key=lambda t: -t[0])
    out = []
    for _, geom in feats[:max_features]:
        geom["coordinates"] = [[[round(x, 6), round(y, 6)] for x, y in r] for r in geom["coordinates"]]
        out.append({"type": "Feature", "geometry": geom, "properties": props_fn()})
    return out


def land_mask(g, bbox, buffer_m=1000):
    w, s, e, n = bbox
    geoms = []
    for path in LAND:
        try:
            with open(path) as f:
                d = json.load(f)
        except FileNotFoundError:
            continue
        for ft in d["features"]:
            gm = ft["geometry"]
            if not gm:
                continue
            # cheap bbox test over the coordinates
            polys = gm["coordinates"] if gm["type"] == "MultiPolygon" else [gm["coordinates"]]
            for poly in polys:
                xs = [c[0] for c in poly[0]]
                ys = [c[1] for c in poly[0]]
                if max(xs) < w - 0.05 or min(xs) > e + 0.05 or max(ys) < s - 0.05 or min(ys) > n + 0.05:
                    continue
                geoms.append({"type": "Polygon", "coordinates": poly})
    if not geoms:
        return np.zeros((g["height"], g["width"]), bool), 0
    m = rasterize(geoms, out_shape=(g["height"], g["width"]), transform=g["transform"], fill=0, default_value=1,
                  all_touched=True, dtype="uint8").astype(bool)
    if not m.any():
        return m, len(geoms)
    # 1 km buffer via a Euclidean distance transform (a 200 px structuring element would be very slow)
    dist = ndimage.distance_transform_edt(~m, sampling=(g["my"], g["mx"]))
    return dist <= buffer_m, len(geoms)


def worldcover_land(bbox, g):
    body = {"collections": ["esa-worldcover"], "bbox": bbox, "limit": 20}
    d = http_json(STAC_SEARCH, json.dumps(body).encode())
    feats = [f for f in d.get("features", []) if "_2021_" in f["id"]]
    if not feats:
        return None
    out = np.zeros((g["height"], g["width"]), np.uint8)
    for f in feats:
        it = pc.sign(pystac.Item.from_dict(f))
        with rasterio.open(it.assets["map"].href) as src:
            with WarpedVRT(src, crs="EPSG:4326", transform=g["transform"], width=g["width"], height=g["height"],
                           resampling=Resampling.nearest) as vrt:
                a = vrt.read(1)
        out = np.where(out == 0, a, out)
    return (out != 80) & (out != 0)


def scene_meta(it):
    p = it.properties
    return {"id": it.id, "datetime": p.get("datetime"), "platform": p.get("platform"),
            "orbit_state": p.get("sat:orbit_state"), "relative_orbit": p.get("sat:relative_orbit"),
            "timeliness": p.get("s1:product_timeliness")}


def coverage(a):
    return float(np.isfinite(a).mean())


# ---------------------------------------------------------------- analyses
def run_flood(job):
    bbox = job["bbox"]
    g = make_grid(bbox, 10, 6_000_000)
    ids = [job["scenes"][0]] + ([job["ref"]] if job.get("ref") else [])
    progress(5, f"reading {len(ids)} scene(s) …")
    items = [Pass(i) for i in ids]
    vv = []
    for k, it in enumerate(items):
        progress(10 + 35 * k / len(items), f"reading VV window of {it.id[:32]}…")
        vv.append(read_pass(it, "vv", g))
    progress(50, "speckle filtering (Lee 5×5) …")
    vvf = [lee(a) for a in vv]
    vdb = [db(a) for a in vvf]
    progress(65, "thresholding (Otsu) …")
    raw = otsu(vdb[0])
    thr = job["params"].get("threshold")
    method = "user threshold"
    if thr is None:
        if raw is None:
            thr, method = -18.0, "fallback -18 dB (too few valid pixels for Otsu)"
        else:
            thr = float(min(-15.0, max(-24.0, raw)))
            method = "Otsu on the AOI VV histogram, clamped to [-24, -15] dB"
    water = clean_mask(np.isfinite(vdb[0]) & (vdb[0] < thr))
    area = float(water.sum() * g["pix_area_km2"])
    res = {"water_km2": round(area, 2), "threshold_db": round(thr, 2), "otsu_raw_db": None if raw is None else round(raw, 2),
           "threshold_method": method, "coverage": round(coverage(vv[0]), 3)}
    layers = [(water, (40, 140, 255, 150))]
    feats = vectorize(water, g, lambda: {"class": "water"})
    if len(items) > 1:
        water_ref = clean_mask(np.isfinite(vdb[1]) & (vdb[1] < thr))
        new = water & ~water_ref & np.isfinite(vdb[1])
        gone = water_ref & ~water & np.isfinite(vdb[0])
        res.update({"reference_water_km2": round(float(water_ref.sum() * g["pix_area_km2"]), 2),
                    "new_water_km2": round(float(new.sum() * g["pix_area_km2"]), 2),
                    "receded_water_km2": round(float(gone.sum() * g["pix_area_km2"]), 2),
                    "reference_coverage": round(coverage(vv[1]), 3)})
        layers = [(water & ~new, (40, 140, 255, 110)), (new, (255, 120, 40, 200)), (gone, (230, 230, 230, 120))]
        feats = vectorize(new, g, lambda: {"class": "new water vs reference"}) + feats[:1500]
    progress(85, "writing overlay …")
    write_png(os.path.join(JOB_DIR, "overlay.png"), overlay(water.shape, layers))
    method_txt = (f"Lee 5×5 speckle filter on linear VV gamma0, then VV (dB) < threshold = open water; "
                  f"specks under 6 px removed. Threshold: {method}.")
    if len(items) > 1:
        method_txt += " New flooding = water in the scene and not water in the reference scene."
    return g, items, res, feats, method_txt


def run_change(job):
    bbox = job["bbox"]
    g = make_grid(bbox, 10, 5_000_000)
    ids = job["scenes"][:2]
    items = [Pass(i) for i in ids]
    T = float(job["params"].get("t_db", 3.0))
    pols = ["vv", "vh"]
    out = {}
    progress(5, "reading 2 scenes × VV, VH …")
    bands = {}
    n = 0
    for it in items:
        for p in pols:
            progress(8 + 40 * n / 4, f"reading {p.upper()} of {it.id[:32]}…")
            bands[(it.id, p)] = read_pass(it, p, g)
            n += 1
    progress(55, "speckle filtering (Lee 5×5) …")
    lr = {}
    for p in pols:
        a = db(lee(bands[(ids[0], p)]))
        b = db(lee(bands[(ids[1], p)]))
        lr[p] = b - a  # after minus before (dB)
    progress(75, "log-ratio + threshold …")
    valid = np.isfinite(lr["vv"])
    inc = clean_mask(valid & (lr["vv"] > T))
    dec = clean_mask(valid & (lr["vv"] < -T))
    res = {"threshold_db": T, "increase_km2": round(float(inc.sum() * g["pix_area_km2"]), 2),
           "decrease_km2": round(float(dec.sum() * g["pix_area_km2"]), 2),
           "vh_increase_km2": round(float(clean_mask(np.isfinite(lr["vh"]) & (lr["vh"] > T)).sum() * g["pix_area_km2"]), 2),
           "vh_decrease_km2": round(float(clean_mask(np.isfinite(lr["vh"]) & (lr["vh"] < -T)).sum() * g["pix_area_km2"]), 2),
           "vv_logratio_median_db": round(float(np.nanmedian(lr["vv"])), 2) if valid.any() else None,
           "coverage": round(float(valid.mean()), 3)}
    progress(85, "writing overlay …")
    write_png(os.path.join(JOB_DIR, "overlay.png"), overlay(inc.shape, [(inc, (255, 70, 70, 190)), (dec, (40, 230, 255, 190))]))
    feats = vectorize(inc, g, lambda: {"class": "backscatter increase", "pol": "VV"}, 1500) + \
        vectorize(dec, g, lambda: {"class": "backscatter decrease", "pol": "VV"}, 1500)
    method_txt = (f"Lee 5×5 speckle filter on both scenes, log-ratio 10·log10(after/before) for VV and VH; "
                  f"|change| > {T} dB flagged (VV drives the overlay: red = increase, cyan = decrease).")
    return g, items, res, feats, method_txt


def run_ships(job):
    bbox = job["bbox"]
    g = make_grid(bbox, 10, 6_000_000)
    it = Pass(job["scenes"][0])
    pol = job["params"].get("pol", "vv")
    k = float(job["params"].get("k", 5.0))
    min_db = float(job["params"].get("min_db", -12.0))
    ratio_db = float(job["params"].get("ratio_db", 9.0))
    min_px = max(3, int(round(1200 / (g["px_m"] ** 2))))  # >= ~1200 m2 (e.g. a 40 m x 30 m bright cluster)
    progress(5, "building sea mask (Natural Earth 10 m land, 1 km buffer) …")
    t_m = time.time()
    land, npoly = land_mask(g, bbox, 1000)
    t_mask = round(time.time() - t_m, 1)
    progress(15, f"reading {pol.upper()} of {it.id[:32]} …")
    I = read_pass(it, pol, g)
    # Natural Earth's coastline predates recent reclamation (e.g. Maasvlakte 2) and has no quays, so
    # ESA WorldCover 2021 (10 m; class 80 = permanent water) is added as a second land mask.
    progress(30, "adding ESA WorldCover 2021 land mask (10 m) …")
    wc_note = "ESA WorldCover 2021 v200 land (all classes except 80 permanent water) buffered by 150 m"
    try:
        wc_land = worldcover_land(bbox, g)
        if wc_land is None:
            wc_note = "ESA WorldCover not available here (open ocean) - Natural Earth only"
            wc_land = np.zeros_like(land)
        else:
            dist = ndimage.distance_transform_edt(~wc_land, sampling=(g["my"], g["mx"])) if wc_land.any() else None
            wc_land = dist <= 150.0 if dist is not None else wc_land
    except Exception as e:
        wc_note = f"ESA WorldCover read failed ({type(e).__name__}) - Natural Earth only"
        wc_land = np.zeros_like(land)
    sea = np.isfinite(I) & ~land & ~wc_land
    progress(45, "CFAR detection …")
    x = np.where(sea, I, 0.0).astype(np.float64)
    v = sea.astype(np.float64)
    bg = max(9, int(round(600 / g["px_m"])) | 1)
    gd = max(5, int(round(260 / g["px_m"])) | 1)
    s_bg = ndimage.uniform_filter(x, bg) * bg * bg - ndimage.uniform_filter(x, gd) * gd * gd
    s2_bg = ndimage.uniform_filter(x * x, bg) * bg * bg - ndimage.uniform_filter(x * x, gd) * gd * gd
    n_bg = ndimage.uniform_filter(v, bg) * bg * bg - ndimage.uniform_filter(v, gd) * gd * gd
    with np.errstate(divide="ignore", invalid="ignore"):
        mu = s_bg / n_bg
        sd = np.sqrt(np.maximum(s2_bg / n_bg - mu * mu, 1e-12))
        z = (x - mu) / sd
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = db(x / mu)
    det = sea & (n_bg > 0.5 * (bg * bg - gd * gd)) & (z > k) & (ratio > ratio_db) & (db(np.where(sea, I, np.nan)) > min_db)
    progress(70, "grouping detections …")
    lab, n = ndimage.label(det, structure=np.ones((3, 3)))
    pts = []
    tr = g["transform"]
    max_len = 500.0
    for idx, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        sub = lab[sl] == idx
        npx = int(sub.sum())
        if npx < min_px:
            continue
        ys, xs = np.nonzero(sub)
        ys = ys + sl[0].start
        xs = xs + sl[1].start
        # principal-axis length in metres
        P = np.stack([xs * g["mx"], ys * g["my"]], 1)
        if npx >= 3:
            c = P - P.mean(0)
            evals, evecs = np.linalg.eigh(np.cov(c.T))
            proj = c @ evecs[:, -1]
            length = float(proj.max() - proj.min()) + g["px_m"]
        else:
            length = float(np.hypot(np.ptp(P[:, 0]), np.ptp(P[:, 1]))) + g["px_m"]
        if length > max_len:
            continue
        zmax = float(np.nanmax(z[ys, xs]))
        conf = round(min(0.99, 1 - math.exp(-(zmax - k) / 4.0) * 0.6), 2)
        cy, cx = ys.mean() + 0.5, xs.mean() + 0.5
        lon, lat = tr * (cx, cy)
        pts.append({"lon": round(lon, 6), "lat": round(lat, 6), "length_m": round(length), "pixels": npx,
                    "peak_db": round(float(db(np.nanmax(I[ys, xs]))), 1), "cfar_z": round(zmax, 1), "confidence": conf})
    pts.sort(key=lambda p: -p["confidence"])
    pts = pts[:600]
    res = {"detections": len(pts), "sea_km2": round(float(sea.sum() * g["pix_area_km2"]), 1),
           "land_polygons_used": npoly, "mask_s": t_mask, "worldcover": wc_note, "coverage": round(coverage(I), 3), "points": pts}
    progress(85, "writing overlay …")
    lmask = land & np.isfinite(I)
    write_png(os.path.join(JOB_DIR, "overlay.png"), overlay(lmask.shape, [(lmask, (20, 20, 20, 70))]))
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
              "properties": {k2: v2 for k2, v2 in p.items() if k2 not in ("lon", "lat")}} for p in pts]
    method_txt = (f"Two-parameter CFAR on unfiltered {pol.upper()} gamma0 over sea pixels: background ring "
                  f"{bg}×{bg} px minus guard {gd}×{gd} px; detect z > {k}, ≥ {ratio_db} dB above the local sea mean and "
                  f"{pol.upper()} > {min_db} dB; 8-connected clusters of ≥ {min_px} px and ≤ {int(max_len)} m kept. Length = principal-axis extent + 1 px. "
                  f"Sea = outside Natural Earth 10 m land (+ minor islands) buffered by 1 km, and outside {wc_note}. "
                  f"Fixed structures at sea (wind turbines, platforms, buoys) still appear as detections.")
    return g, [it], res, feats, method_txt


def run_timeseries(job):
    bbox = job["bbox"]
    g = make_grid(bbox, 40, 400_000)
    rel, direction = job["params"]["relative_orbit"], job["params"]["orbit_state"]
    progress(4, f"searching 12 months of relative orbit {rel} ({direction}) …")
    end = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 365 * 86400))
    body = {"collections": ["sentinel-1-rtc"], "bbox": bbox, "datetime": f"{start}/{end}", "limit": 250,
            "query": {"sat:relative_orbit": {"eq": rel}, "sat:orbit_state": {"eq": direction}},
            "sortby": [{"field": "datetime", "direction": "asc"}]}
    d = http_json(STAC_SEARCH, json.dumps(body).encode())
    feats = d.get("features", [])
    # one item per pass (adjacent slices of the same pass share a date)
    by_day = {}
    for f in feats:
        day = f["properties"]["datetime"][:10]
        by_day.setdefault(day, f)
    days = sorted(by_day)
    total = len(days)
    if total > 20:
        idx = np.unique(np.round(np.linspace(0, total - 1, 20)).astype(int))
        days = [days[i] for i in idx]
    series = []
    items = []
    for k, day in enumerate(days):
        progress(8 + 85 * k / max(1, len(days)), f"reading scene {k + 1}/{len(days)} ({day}) …")
        it = pc.sign(pystac.Item.from_dict(by_day[day]))
        try:
            vv = read_band(it, "vv", g)
            vh = read_band(it, "vh", g)
        except Exception as e:  # one bad scene shouldn't sink the series
            series.append({"date": it.properties["datetime"], "id": it.id, "error": str(e)[:120]})
            continue
        cov = coverage(vv)
        row = {"date": it.properties["datetime"], "id": it.id, "coverage": round(cov, 3)}
        if cov >= 0.3:
            row["vv_db"] = round(float(db(np.nanmean(vv))), 2)
            row["vh_db"] = round(float(db(np.nanmean(vh))), 2)
            row["vh_vv_ratio_db"] = round(row["vh_db"] - row["vv_db"], 2)
        series.append(row)
        items.append(it)
    res = {"series": series, "passes_found_12mo": total, "passes_used": len(days), "relative_orbit": rel, "orbit_state": direction}
    method_txt = (f"Mean of linear gamma0 over the AOI (no speckle filter needed for an area mean), converted to dB, "
                  f"for every pass of relative orbit {rel} ({direction}) in the last 12 months; "
                  f"{'evenly subsampled to 20 of ' + str(total) + ' passes' if total > 20 else 'all passes used'}. "
                  f"Passes covering < 30% of the AOI are skipped. Read at ~{g['px_m']} m from the COG overviews.")
    feat = [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]]},
             "properties": {"series": series}}]
    return g, items, res, feat, method_txt


def main():
    with open(os.path.join(JOB_DIR, "job.json")) as f:
        job = json.load(f)
    progress(1, "starting …")
    fn = {"flood": run_flood, "change": run_change, "ships": run_ships, "timeseries": run_timeseries}[job["type"]]
    g, items, res, feats, method_txt = fn(job)
    progress(95, "writing GeoJSON …")
    meta = {"type": job["type"], "bbox": job["bbox"], "params": job["params"], "method": method_txt,
            "pixel_m": g["px_m"], "grid": [g["width"], g["height"]], "crs": "EPSG:4326 (AOI grid, bilinear from UTM COGs)",
            "scenes": [scene_meta(it) for it in items], "result": res, "caveat": CAVEAT,
            "data": "Contains modified Copernicus Sentinel data 2025-2026; RTC processing by Catalyst; via Microsoft Planetary Computer.",
            "runtime_s": round(time.time() - T0, 1),
            "cpu_s": round(sum(os.times()[:2]), 1),
            "peak_rss_mb": round(__import__("resource").getrusage(__import__("resource").RUSAGE_SELF).ru_maxrss / 1024),
            "has_overlay": os.path.exists(os.path.join(JOB_DIR, "overlay.png"))}
    gj = {"type": "FeatureCollection", "properties": {k: v for k, v in meta.items() if k != "result"} | {"summary": {k: v for k, v in res.items() if k not in ("points", "series")}},
          "features": feats}
    with open(os.path.join(JOB_DIR, "result.geojson"), "w") as f:
        json.dump(gj, f, separators=(",", ":"))
    with open(os.path.join(JOB_DIR, "result.json.tmp"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    os.replace(os.path.join(JOB_DIR, "result.json.tmp"), os.path.join(JOB_DIR, "result.json"))
    progress(100, f"done in {meta['runtime_s']:.0f} s")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        with open(os.path.join(JOB_DIR, "error.json"), "w") as f:
            json.dump({"error": f"{type(e).__name__}: {str(e)[:300]}", "trace": traceback.format_exc()[-1500:]}, f)
        sys.exit(1)
