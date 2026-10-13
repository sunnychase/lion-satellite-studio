#!/usr/bin/env python3
# Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
"""Lion Satellite Studio - a 3D globe of open satellite data.

One stdlib-only file. Serves static/ and a handful of CACHED, FIXED-URL upstream
endpoints. It is NOT an open proxy: every upstream URL is a hard-coded template
and every user-supplied parameter is validated against a whitelist or a strict
pattern before it is used.

Upstreams (all keyless unless noted):
  CelesTrak GP data      cache >= 2 h per group (CelesTrak asks for no more than 1 download / 2 h)
  USGS earthquake feeds  cache 5 min
  NASA GIBS capabilities cache 6 h  (parsed down to the layers we use)
  NASA GIBS DescribeDomains (sub-daily layers) cache 5 min
  ASF SearchAPI (NISAR)  hourly incremental poll + slow polite backfill into SQLite
  PO.DAAC Hydrocron      cache 12 h per whitelisted feature, one request at a time
  aisstream.io (KEY)     one websocket, only if AISSTREAM_API_KEY is present in keys.env
  Global Fishing Watch (TOKEN) SAR detections, cache 6 h, only if GFW_API_TOKEN is present

Keys are read once at start from the keys file (LSS_KEYS_FILE, default ./keys.env, written by
you, mode 600). They are never logged, never returned by any endpoint, never written anywhere else.

Configuration: environment variables, optionally loaded from satellite.env next to this file
(see satellite.env.example). Real environment variables win over the file.
"""
import base64
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import posixpath
import random
import re
import socket
import sqlite3
import ssl
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from email.utils import formatdate, parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION = "1.0"
REPO_URL = "https://github.com/sunnychase/lion-satellite-studio"


# --------------------------------------------------------------------------- config
def load_env_file(path):
    """KEY=VALUE lines into os.environ (existing variables win). Never used for keys."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                if k.startswith("export "):
                    k = k[7:].strip()
                if re.fullmatch(r"LSS_[A-Z0-9_]+", k):
                    os.environ.setdefault(k, v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


load_env_file(os.environ.get("LSS_ENV_FILE") or os.path.join(ROOT, "satellite.env"))


def _path(name, default):
    return os.path.abspath(os.path.expanduser(os.environ.get(name) or default))


STATIC = os.path.join(ROOT, "static")
HOST = os.environ.get("LSS_HOST", "127.0.0.1")
PORT = int(os.environ.get("LSS_PORT", "8640"))
CACHE = _path("LSS_CACHE_DIR", os.path.join(ROOT, "cache"))
DATA_DIR = _path("LSS_DATA_DIR", os.path.join(ROOT, "data"))
KEYS_FILE = _path("LSS_KEYS_FILE", os.path.join(ROOT, "keys.env"))
VENV_PY = _path("LSS_VENV_PYTHON", os.path.join(ROOT, "venv", "bin", "python"))
os.environ["LSS_DATA_DIR"] = DATA_DIR  # the analysis worker inherits it
# Upstream User-Agent: generic, plus an optional contact (LSS_CONTACT) so providers can reach the operator.
_contact = re.sub(r"[^\x20-\x7e]", "", os.environ.get("LSS_CONTACT", "")).strip()[:120]
UA = "LionSatelliteStudio/%s (+%s%s)" % (VERSION, REPO_URL, "; " + _contact if _contact else "")
os.environ["LSS_USER_AGENT"] = UA
START_TIME = time.time()


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), *a, flush=True)


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    if isinstance(t, (int, float)):
        t = dt.datetime.fromtimestamp(t, dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    s = s.strip().replace("Z", "+00:00")
    if "." in s:
        head, tail = s.split(".", 1)
        m = re.match(r"(\d+)(.*)", tail)
        s = head + "." + m.group(1)[:6] + m.group(2)
    t = dt.datetime.fromisoformat(s)
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t


# --------------------------------------------------------------------------- keys
def load_keys():
    """Read keys.env once. Values stay in this dict only; never logged."""
    keys = {}
    try:
        with open(KEYS_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k in ("AISSTREAM_API_KEY", "GFW_API_TOKEN") and v:
                    keys[k] = v
    except FileNotFoundError:
        pass
    except Exception as e:  # never print the content
        log("keys.env could not be parsed:", type(e).__name__)
    log("keys present:", sorted(keys.keys()) or "none")
    return keys


KEYS = load_keys()


def redact(msg):
    msg = str(msg)
    for v in KEYS.values():
        if v and v in msg:
            msg = msg.replace(v, "[redacted]")
    return msg[:300]


# --------------------------------------------------------------------------- status
STATUS_LOCK = threading.Lock()
STATUS = {}


def set_status(name, state, **kw):
    with STATUS_LOCK:
        s = STATUS.setdefault(name, {})
        if state in ("ok", "enabled") and s.get("state") not in ("ok", "enabled"):
            s.pop("error", None)
            s.pop("retry_in_s", None)
        s["state"] = state
        s["updated"] = iso(time.time())
        for k, v in kw.items():
            s[k] = redact(v) if isinstance(v, str) else v


def get_status():
    with STATUS_LOCK:
        return json.loads(json.dumps(STATUS))


# --------------------------------------------------------------------------- http client
class Upstream(Exception):
    pass


UPSTREAM_HITS = {}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None          # → HTTPError with the 3xx code, reported as an upstream error


_DEFAULT = urllib.request.build_opener()
_NO_REDIRECT = urllib.request.build_opener(_NoRedirect)


def http_get(url, headers=None, timeout=60, max_bytes=120 * 2**20, data=None, method=None, source="?"):
    h = {"User-Agent": UA, "Accept-Encoding": "gzip"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, data=data, method=method)
    UPSTREAM_HITS[source] = UPSTREAM_HITS.get(source, 0) + 1
    # a request that carries credentials never follows a redirect (urllib would re-send the Authorization header to the new host)
    opener = _NO_REDIRECT if any(k.lower() == "authorization" for k in h) else _DEFAULT
    try:
        with opener.open(req, timeout=timeout) as r:
            body = r.read(max_bytes + 1)
            status = r.status
            rh = r.headers
    except urllib.error.HTTPError as e:
        body = e.read(200000) if e.fp else b""
        if e.headers.get("Content-Encoding") == "gzip":
            try:
                body = gzip.decompress(body)
            except Exception:
                pass
        raise Upstream(f"HTTP {e.code}: {body[:200].decode('utf-8', 'replace')}") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, ssl.SSLError) as e:
        raise Upstream(f"network: {getattr(e, 'reason', e)}") from None
    if len(body) > max_bytes:
        raise Upstream("response too large")
    if rh.get("Content-Encoding") == "gzip":
        body = gzip.decompress(body)
    return status, body, rh


# --------------------------------------------------------------------------- disk cache
def atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp%d" % os.getpid()
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class Unavailable(Exception):
    def __init__(self, msg, retry=300):
        super().__init__(msg)
        self.retry = retry


class Cached:
    """A disk-cached upstream resource (stored gzip-compressed).

    get() returns (gz_bytes, meta). Fresh -> served from cache. Stale -> served from
    cache while ONE background refresh runs. Missing -> one synchronous fetch.
    fetch() returns raw bytes, or None to mean 'upstream says unchanged; keep cache'.
    """

    def __init__(self, name, path, ttl, fetch, err_backoff=900, source=None):
        self.name, self.path, self.ttl, self.fetch = name, path, ttl, fetch
        self.err_backoff = err_backoff
        self.source = source or name
        self.lock = threading.Lock()
        self.refreshing = False
        self.mem = None
        self.mem_mtime = 0
        self.last_err_at = 0
        self.last_err = None

    def mtime(self):
        try:
            return os.path.getmtime(self.path)
        except OSError:
            return None

    def _refresh(self):
        with self.lock:
            m = self.mtime()
            if m is not None and time.time() - m < self.ttl:
                return
            try:
                raw = self.fetch()
                if raw is None:
                    if m is not None:
                        os.utime(self.path, None)
                else:
                    atomic_write(self.path, gzip.compress(raw, 6))
                self.last_err = None
                set_status(self.source, "ok", fetched=iso(time.time()))
                log("refreshed", self.name)
            except Exception as e:
                self.last_err_at = time.time()
                self.last_err = redact(e)
                set_status(self.source, "error", error=self.last_err)
                log("refresh failed", self.name, self.last_err)
            finally:
                self.refreshing = False

    def get(self):
        m = self.mtime()
        hit = "hit"
        if m is None:
            if time.time() - self.last_err_at < self.err_backoff:
                raise Unavailable(self.last_err or "upstream unavailable",
                                  int(self.err_backoff - (time.time() - self.last_err_at)))
            self._refresh()
            m = self.mtime()
            hit = "miss"
            if m is None:
                raise Unavailable(self.last_err or "upstream unavailable", self.err_backoff)
        elif time.time() - m >= self.ttl and not self.refreshing \
                and time.time() - self.last_err_at >= self.err_backoff:
            self.refreshing = True
            threading.Thread(target=self._refresh, daemon=True).start()
            hit = "stale"
        m = self.mtime()
        if self.mem is None or m != self.mem_mtime:
            with open(self.path, "rb") as f:
                self.mem = f.read()
            self.mem_mtime = m
        return self.mem, {"fetched": iso(m), "age_s": int(time.time() - m), "cache": hit}

    def raw_json(self):
        gz, meta = self.get()
        return json.loads(gzip.decompress(gz)), meta


# --------------------------------------------------------------------------- CelesTrak
SAT_GROUPS = ["stations", "active", "starlink", "gps-ops", "galileo", "weather", "resource",
              "science", "geo", "visual", "last-30-days"]
CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
CELESTRAK_TTL = 2 * 3600 + 120

# NASA Earth fleet, by NORAD id (verified against CelesTrak 'active' on 2026-10-13).
FLEET = {
    25544: "ISS (ZARYA)", 25994: "TERRA", 27424: "AQUA", 37849: "SUOMI NPP",
    43013: "NOAA 20 (JPSS-1)", 54234: "NOAA 21 (JPSS-2)", 39084: "LANDSAT 8", 49260: "LANDSAT 9",
    39574: "GPM-CORE", 40376: "SMAP", 43613: "ICESAT-2", 43476: "GRACE-FO 1", 43477: "GRACE-FO 2",
    54754: "SWOT", 40059: "OCO 2", 58928: "PACE", 65053: "NISAR", 41866: "GOES 16",
    51850: "GOES 18", 60133: "GOES 19", 56174: "INTELSAT 40E (IS-40E)",
}


def make_celestrak_fetch(group):
    def fetch():
        url = CELESTRAK_URL.format(group=urllib.parse.quote(group))
        try:
            _, body, _ = http_get(url, timeout=120, source="celestrak")
        except Upstream as e:
            if "has not updated" in str(e):
                return None  # data unchanged since our last download: keep the cache
            raise
        txt = body.lstrip()[:1]
        if txt != b"[":
            msg = body[:200].decode("utf-8", "replace")
            if "has not updated" in msg:
                return None
            raise Upstream("CelesTrak: " + msg)
        arr = json.loads(body)
        if not isinstance(arr, list) or not arr:
            raise Upstream("CelesTrak: empty group")
        return body
    return fetch


SATS = {g: Cached("celestrak:" + g, os.path.join(CACHE, "celestrak", g + ".json.gz"), CELESTRAK_TTL,
                  make_celestrak_fetch(g), err_backoff=7200, source="celestrak")   # 2 h on errors too: CelesTrak blocks on request count
        for g in SAT_GROUPS}

# migrate a pre-seeded plain JSON (fetched once during setup) into the gz cache
for _g in SAT_GROUPS:
    _plain = os.path.join(CACHE, "celestrak", _g + ".json")
    _gzp = os.path.join(CACHE, "celestrak", _g + ".json.gz")
    if os.path.exists(_plain) and not os.path.exists(_gzp):
        try:
            with open(_plain, "rb") as _f:
                _b = _f.read()
            json.loads(_b)
            atomic_write(_gzp, gzip.compress(_b, 6))
            _m = os.path.getmtime(_plain)
            os.utime(_gzp, (_m, _m))
            os.remove(_plain)
        except Exception:
            pass

FLEET_CACHE = {"src_mtime": None, "gz": None}


def fleet_group():
    arr, meta = SATS["active"].raw_json()
    if FLEET_CACHE["src_mtime"] != meta["fetched"]:
        keep = [s for s in arr if s.get("NORAD_CAT_ID") in FLEET]
        FLEET_CACHE["gz"] = gzip.compress(json.dumps(keep, separators=(",", ":")).encode(), 6)
        FLEET_CACHE["src_mtime"] = meta["fetched"]
        FLEET_CACHE["n"] = len(keep)
    return FLEET_CACHE["gz"], dict(meta, derived_from="active")


# --------------------------------------------------------------------------- USGS
QUAKE_FEEDS = {
    "all_day": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    "2.5_week": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson",
}


def make_quake_fetch(url):
    def fetch():
        _, body, _ = http_get(url, timeout=60, source="usgs")
        d = json.loads(body)
        if d.get("type") != "FeatureCollection":
            raise Upstream("USGS: unexpected payload")
        return body
    return fetch


QUAKES = {k: Cached("usgs:" + k, os.path.join(CACHE, "usgs", k + ".json.gz"), 300,
                    make_quake_fetch(u), err_backoff=300, source="usgs")
          for k, u in QUAKE_FEEDS.items()}

# --------------------------------------------------------------------------- GIBS
GIBS_CAPS_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"
GIBS_DOMAINS_URL = ("https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/{layer}/default/"
                    "{tms}/all/{day}.xml")
# The layer catalogue. Every id is checked against GetCapabilities at run time; ids
# missing there are reported as unavailable and disabled in the UI.
# group: base | overlay | nrt | science.  time: none | daily | subdaily | fixed
GIBS_LAYERS = [
    # base imagery
    dict(id="BlueMarble_ShadedRelief_Bathymetry", group="base", title="Blue Marble · relief & bathymetry", time="none"),
    dict(id="BlueMarble_NextGeneration", group="base", title="Blue Marble · Next Generation", time="none"),
    dict(id="MODIS_Terra_CorrectedReflectance_TrueColor", group="base", title="MODIS Terra · true colour (daily)", time="daily", truecolor=True, sat=25994),
    dict(id="VIIRS_SNPP_CorrectedReflectance_TrueColor", group="base", title="VIIRS Suomi NPP · true colour (daily)", time="daily", truecolor=True, sat=37849),
    dict(id="VIIRS_NOAA20_CorrectedReflectance_TrueColor", group="base", title="VIIRS NOAA-20 · true colour (daily)", time="daily", truecolor=True, sat=43013),
    dict(id="VIIRS_NOAA21_CorrectedReflectance_TrueColor", group="base", title="VIIRS NOAA-21 · true colour (daily)", time="daily", truecolor=True, sat=54234),
    dict(id="OCI_PACE_True_Color", group="base", title="PACE OCI · true colour (daily)", time="daily", truecolor=True, sat=58928),
    # overlays
    dict(id="VIIRS_Black_Marble", group="overlay", title="City lights (Black Marble 2016) · night side", time="fixed", fixed="2016-01-01", family="night"),
    dict(id="MODIS_Terra_Cloud_Fraction_Day", group="overlay", title="Clouds · MODIS Terra cloud fraction", time="daily", family="cloud"),
    dict(id="Reference_Labels", group="overlay", title="Place labels", time="none"),
    dict(id="Coastlines", group="overlay", title="Coastlines", time="none"),
    dict(id="Reference_Features", group="overlay", title="Roads & features", time="none"),
    # near-real-time, sub-daily
    dict(id="GOES-East_ABI_GeoColor", group="nrt", title="GOES-East · GeoColor", time="subdaily", region="goes_east", sat=60133),
    dict(id="GOES-West_ABI_GeoColor", group="nrt", title="GOES-West · GeoColor", time="subdaily", region="goes_west", sat=51850),
    dict(id="GOES-East_ABI_Band2_Red_Visible_1km", group="nrt", title="GOES-East · red visible (band 2)", time="subdaily", region="goes_east", sat=60133),
    dict(id="GOES-West_ABI_Band2_Red_Visible_1km", group="nrt", title="GOES-West · red visible (band 2)", time="subdaily", region="goes_west", sat=51850),
    dict(id="GOES-East_ABI_Band13_Clean_Infrared", group="nrt", title="GOES-East · clean IR (band 13)", time="subdaily", region="goes_east", sat=60133),
    dict(id="GOES-West_ABI_Band13_Clean_Infrared", group="nrt", title="GOES-West · clean IR (band 13)", time="subdaily", region="goes_west", sat=51850),
    dict(id="GOES-East_ABI_Air_Mass", group="nrt", title="GOES-East · air mass RGB", time="subdaily", region="goes_east", sat=60133),
    dict(id="GOES-West_ABI_Air_Mass", group="nrt", title="GOES-West · air mass RGB", time="subdaily", region="goes_west", sat=51850),
    dict(id="GOES-East_ABI_FireTemp", group="nrt", title="GOES-East · fire temperature RGB", time="subdaily", region="goes_east", sat=60133),
    dict(id="GOES-West_ABI_FireTemp", group="nrt", title="GOES-West · fire temperature RGB", time="subdaily", region="goes_west", sat=51850),
    dict(id="Himawari_AHI_Band3_Red_Visible_1km", group="nrt", title="Himawari · red visible (band 3)", time="subdaily", region="himawari"),
    dict(id="Himawari_AHI_Band13_Clean_Infrared", group="nrt", title="Himawari · clean IR (band 13)", time="subdaily", region="himawari"),
    dict(id="Himawari_AHI_Air_Mass", group="nrt", title="Himawari · air mass RGB", time="subdaily", region="himawari"),
    dict(id="IMERG_Precipitation_Rate_30min", group="nrt", title="GPM IMERG · precipitation (30 min)", time="subdaily", sat=39574),
    # fires: vector-only in WMTS (MVT), rendered as PNG through GIBS WMS
    dict(id="VIIRS_SNPP_Thermal_Anomalies_375m_All", group="fire", title="VIIRS Suomi NPP fires 375 m", time="daily", service="wms", sat=37849),
    dict(id="VIIRS_NOAA20_Thermal_Anomalies_375m_All", group="fire", title="VIIRS NOAA-20 fires 375 m", time="daily", service="wms", sat=43013),
    dict(id="VIIRS_NOAA21_Thermal_Anomalies_375m_All", group="fire", title="VIIRS NOAA-21 fires 375 m", time="daily", service="wms", sat=54234),
    dict(id="MODIS_Combined_Thermal_Anomalies_All", group="fire", title="MODIS Terra+Aqua fires 1 km", time="daily", service="wms"),
    # Earth science (one at a time)
    dict(id="IMERG_Precipitation_Rate", group="science", title="Precipitation · GPM IMERG (daily)", time="daily", sat=39574, family="water"),
    dict(id="SMAP_L4_Analyzed_Surface_Soil_Moisture", group="science", title="Soil moisture · SMAP L4 surface", time="daily", sat=40376),
    dict(id="SMAP_L3_Passive_Enhanced_Day_Soil_Moisture", group="science", title="Soil moisture · SMAP L3 (AM pass)", time="daily", sat=40376),
    dict(id="MODIS_Combined_Value_Added_AOD", group="science", title="Aerosol optical depth · MODIS combined", time="daily"),
    dict(id="MODIS_Terra_Aerosol_Optical_Depth_3km", group="science", title="Aerosol optical depth · MODIS Terra 3 km", time="daily", sat=25994),
    dict(id="VIIRS_SNPP_AOD_Dark_Target_Land_Ocean", group="science", title="Aerosol optical depth · VIIRS Suomi NPP", time="daily", sat=37849),
    dict(id="OCI_PACE_Chlorophyll_a", group="science", title="Chlorophyll-a · PACE OCI", time="daily", sat=58928),
    dict(id="MODIS_Aqua_L2_Chlorophyll_A", group="science", title="Chlorophyll-a · MODIS Aqua", time="daily", sat=27424),
    dict(id="TEMPO_L3_NO2_Vertical_Column_Troposphere", group="science", title="NO₂ (troposphere) · TEMPO, North America", time="subdaily", region="tempo", sat=56174),
    dict(id="GHRSST_L4_MUR_Sea_Surface_Temperature", group="science", title="Sea-surface temperature · GHRSST MUR", time="daily"),
    dict(id="GHRSST_L4_MUR_Sea_Ice_Concentration", group="science", title="Sea-ice concentration · GHRSST MUR", time="daily"),
    dict(id="MODIS_Terra_NDSI_Snow_Cover", group="science", title="Snow cover · MODIS Terra NDSI", time="daily", sat=25994),
    dict(id="HLS_L30_Nadir_BRDF_Adjusted_Reflectance", group="science", title="HLS Landsat 30 m · recent detailed", time="daily", sat=39084, detailed=True),
    dict(id="HLS_S30_Nadir_BRDF_Adjusted_Reflectance", group="science", title="HLS Sentinel-2 30 m · recent detailed", time="daily", detailed=True),
    dict(id="VIIRS_SNPP_DayNightBand_At_Sensor_Radiance", group="science", title="Night lights · VIIRS day/night band (nightly)", time="daily", sat=37849, family="night"),
    dict(id="VIIRS_Black_Marble", group="science", title="Night lights · Black Marble 2016", time="fixed", fixed="2016-01-01", family="night"),
]
GIBS_BY_ID = {}
for _l in GIBS_LAYERS:
    GIBS_BY_ID.setdefault(_l["id"], _l)
SUBDAILY = {l["id"] for l in GIBS_LAYERS if l["time"] == "subdaily"}


def fetch_gibs_catalog():
    """Download GetCapabilities and keep only what we need for our whitelisted ids."""
    _, body, _ = http_get(GIBS_CAPS_URL, timeout=180, source="gibs")
    W = "{http://www.opengis.net/wmts/1.0}"
    O = "{http://www.opengis.net/ows/1.1}"
    X = "{http://www.w3.org/1999/xlink}"
    want = set(GIBS_BY_ID)
    found = {}
    import io
    for ev, el in ET.iterparse(io.BytesIO(body), events=("end",)):
        if el.tag != W + "Layer":
            continue
        ident = el.find(O + "Identifier")
        lid = ident.text if ident is not None else None
        if lid in want:
            tms = [x.find(W + "TileMatrixSet").text for x in el.findall(W + "TileMatrixSetLink")]
            fmts = [x.text for x in el.findall(W + "Format")]
            info = {"tms": tms[0] if tms else None, "format": fmts[0] if fmts else None}
            dim = el.find(W + "Dimension")
            if dim is not None:
                vals = [v.text for v in dim.findall(W + "Value")]
                dflt = dim.find(W + "Default")
                info["default"] = dflt.text if dflt is not None else None
                info["ranges"] = vals[-6:]
                if vals:
                    parts = vals[-1].split("/")
                    info["latest"] = parts[1] if len(parts) > 1 else parts[0]
                    info["earliest"] = vals[0].split("/")[0]
            for lg in el.iter(W + "LegendURL"):
                href = lg.get(X + "href")
                role = lg.get(X + "role", "")
                if href and role.endswith("horizontal"):
                    info["legend"] = href
                elif href and "legend" not in info and role.endswith("vertical"):
                    info["legend_v"] = href
            tpl = el.find(W + "ResourceURL")
            if tpl is not None:
                info["template"] = tpl.get("template")
            found[lid] = info
        el.clear()
    if len(found) < 5:
        raise Upstream("GIBS capabilities parse found too few layers")
    out = {"fetched": iso(time.time()), "layers": found}
    return json.dumps(out, separators=(",", ":")).encode()


GIBS_CATALOG = Cached("gibs:caps", os.path.join(CACHE, "gibs", "catalog.json.gz"), 6 * 3600,
                      fetch_gibs_catalog, err_backoff=900, source="gibs")
LAYERS_OUT = {"src": None, "gz": None}


def gibs_layers_json():
    cat, meta = GIBS_CATALOG.raw_json()
    if LAYERS_OUT["src"] != meta["fetched"]:
        out = []
        for l in GIBS_LAYERS:
            c = cat["layers"].get(l["id"])
            d = dict(l)
            if c is None:
                d["available"] = False
                d["why"] = "not in GIBS GetCapabilities (epsg4326/best)"
            else:
                d["available"] = True
                d["tms"] = c.get("tms")
                d["format"] = c.get("format")
                for k in ("latest", "earliest", "default", "legend", "legend_v"):
                    if c.get(k):
                        d[k] = c[k]
                if d.get("service") == "wms":
                    d["format"] = "image/png"
                elif c.get("format") and "vector" in c["format"]:
                    d["available"] = False
                    d["why"] = "vector tiles only (MVT) in WMTS"
            out.append(d)
        body = {"capabilities_fetched": cat["fetched"], "layers": out}
        LAYERS_OUT["gz"] = gzip.compress(json.dumps(body, separators=(",", ":")).encode(), 6)
        LAYERS_OUT["src"] = meta["fetched"]
    return LAYERS_OUT["gz"], meta


def _expand_domain(text, since):
    """'start/end/PT10M,...' -> sorted ISO strings >= since (cap 300)."""
    out = []
    for part in text.split(","):
        p = part.strip().split("/")
        if not p or not p[0]:
            continue
        try:
            a = parse_iso(p[0] if "T" in p[0] else p[0] + "T00:00:00Z")
            b = parse_iso(p[1]) if len(p) > 1 else a
            step = p[2] if len(p) > 2 else "PT10M"
        except Exception:
            continue
        m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", step)
        secs = 600
        if m and any(m.groups()):
            secs = int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)
        if step.startswith("P1D"):
            secs = 86400
        secs = max(secs, 60)
        t = a
        n = 0
        while t <= b and n < 2000:
            if t >= since:
                out.append(iso(t))
            t += dt.timedelta(seconds=secs)
            n += 1
    out = sorted(set(out))
    return out[-300:]


DOMAIN_CACHE = {}
DOMAIN_LOCK = threading.Lock()


def gibs_times(layer):
    tms = None
    try:
        cat, _ = GIBS_CATALOG.raw_json()
        tms = (cat["layers"].get(layer) or {}).get("tms")
    except Exception:
        pass
    tms = tms or "2km"
    now = time.time()
    with DOMAIN_LOCK:
        c = DOMAIN_CACHE.get(layer)
        if c and now - c["t"] < 300:
            return c["body"], "hit"
    since = utcnow() - dt.timedelta(hours=26)
    times = []
    for day in sorted({(utcnow() - dt.timedelta(days=1)).strftime("%Y-%m-%d"), utcnow().strftime("%Y-%m-%d")}):
        url = GIBS_DOMAINS_URL.format(layer=layer, tms=tms, day=day)
        _, body, _ = http_get(url, timeout=40, source="gibs")
        m = re.search(rb"<Domain>(.*?)</Domain>", body, re.S)
        if m:
            times += _expand_domain(m.group(1).decode(), since)
    times = sorted(set(times))
    body = {"layer": layer, "tms": tms, "times": times, "latest": times[-1] if times else None,
            "fetched": iso(now)}
    with DOMAIN_LOCK:
        DOMAIN_CACHE[layer] = {"t": now, "body": body}
    set_status("gibs-times", "ok", fetched=iso(now))
    return body, "miss"


# --------------------------------------------------------------------------- NISAR (ASF)
ASF_URL = "https://api.daac.asf.alaska.edu/services/search/param"
NISAR_START = dt.datetime(2026, 6, 17, tzinfo=dt.timezone.utc)
NISAR_PAGE = 500
NISAR_TYPES = re.compile(r"^[A-Z0-9]{2,6}$")
# Frame products (~30 s acquisitions) window cleanly by acquisition time. Pair / mosaic products
# (RIFG, RUNW, ROFF, GUNW, GOFF, SME2) span days, overlap every window and are collected only by
# the hourly processing-date poll.
NISAR_FRAME_TYPES = "RSLC,GSLC,GCOV"
NISAR_ALL_TYPES = ["RSLC", "GSLC", "GCOV", "RIFG", "RUNW", "ROFF", "GUNW", "GOFF", "SME2"]


class Nisar:
    def __init__(self):
        os.makedirs(os.path.join(CACHE, "nisar"), exist_ok=True)
        self.path = os.path.join(CACHE, "nisar", "nisar.sqlite")
        self.lock = threading.Lock()
        self.db = sqlite3.connect(self.path, check_same_thread=False, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS g (gn TEXT PRIMARY KEY, pt TEXT, st INTEGER, et INTEGER,
          path INTEGER, frame INTEGER, dir TEXT, orbit INTEGER, pol TEXT, bytes INTEGER,
          coll TEXT, crid TEXT, cov TEXT, geom TEXT, du INTEGER, br INTEGER, seen INTEGER);
        CREATE INDEX IF NOT EXISTS g_st ON g(st);
        CREATE INDEX IF NOT EXISTS g_pt_st ON g(pt, st);
        CREATE INDEX IF NOT EXISTS g_seen ON g(seen);
        CREATE TABLE IF NOT EXISTS tpl (id INTEGER PRIMARY KEY, s TEXT UNIQUE);
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        """)
        self.db.commit()
        if self.meta("bf_version") != "2":
            # earlier backfill windows mixed in multi-day pair products and hit page caps: redo from now
            self.set_meta("bf_cursor", iso(utcnow()))
            self.set_meta("bf_version", "2")
            self.db.commit()
        self.resp_cache = {}
        self.wake = threading.Event()
        self.active = False  # becomes True on first client request (no polling until someone looks)

    def meta(self, k, default=None):
        r = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r[0] if r else default

    def set_meta(self, k, v):
        self.db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", (k, str(v)))

    def tpl_id(self, s):
        if not s:
            return None
        r = self.db.execute("SELECT id FROM tpl WHERE s=?", (s,)).fetchone()
        if r:
            return r[0]
        cur = self.db.execute("INSERT INTO tpl(s) VALUES(?)", (s,))
        return cur.lastrowid

    def tpl(self, i):
        if i is None:
            return None
        r = self.db.execute("SELECT s FROM tpl WHERE id=?", (i,)).fetchone()
        return r[0] if r else None

    @staticmethod
    def parse_wkt(w):
        if not w:
            return None
        rings = re.findall(r"\(\(?([-\d\.\s,eE]+)\)", w)
        out = []
        for ring in rings[:2]:
            pts = []
            for pair in ring.split(","):
                xy = pair.split()
                if len(xy) >= 2:
                    pts.append([round(float(xy[0]), 3), round(float(xy[1]), 3)])
            if len(pts) >= 3:
                out.append(pts)
        return out or None

    def query(self, params):
        q = dict(platform="NISAR", output="jsonlite2", maxResults=str(NISAR_PAGE))
        q.update(params)
        url = ASF_URL + "?" + urllib.parse.urlencode(q)
        for attempt in range(3):
            try:
                _, body, _ = http_get(url, timeout=180, source="asf")
                break
            except Upstream as e:
                if attempt == 2 or not re.search(r"HTTP 5\d\d|network", str(e)):
                    raise
                log("asf retry after", str(e)[:80], params)
                time.sleep(15 * (attempt + 1))
        d = json.loads(body)
        return d.get("results") or []

    def ingest(self, results, seen):
        n = 0
        with self.lock:
            for r in results:
                gn = r.get("gn")
                if not gn:
                    continue
                nsr = r.get("nsr") or {}
                size = None
                for fn, v in (nsr.get("sizeMB") or {}).items():
                    if fn.endswith(".h5") and "QA" not in fn and isinstance(v, dict):
                        size = v.get("bytes")
                        break
                pol = []
                for k in ("mainBandPolarization", "sideBandPolarization"):
                    v = nsr.get(k)
                    if v:
                        pol.append(("A:" if k.startswith("main") else "B:") + "/".join(v))
                geom = self.parse_wkt(r.get("w"))
                if not geom:
                    continue
                browse = None
                for b in r.get("b") or []:
                    if b.endswith("_LATLON.png"):
                        browse = b
                        break
                try:
                    st = int(parse_iso(r["st"]).timestamp())
                    et = int(parse_iso(r.get("stp") or r["st"]).timestamp())
                except Exception:
                    continue
                orbit = None
                try:
                    orbit = int((r.get("o") or [None])[0])
                except Exception:
                    pass
                prev = self.db.execute("SELECT seen FROM g WHERE gn=?", (gn,)).fetchone()
                s = prev[0] if prev else seen
                self.db.execute(
                    "INSERT OR REPLACE INTO g VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (gn, r.get("pt"), st, et, r.get("p"), r.get("f"), (r.get("fd") or "?")[:1], orbit,
                     " ".join(pol) or None, size, r.get("cnm"), nsr.get("crid"), nsr.get("frameCoverage"),
                     json.dumps(geom, separators=(",", ":")), self.tpl_id(r.get("du")), self.tpl_id(browse),
                     s))
                n += 1
            self.db.commit()
        return n

    def fetch_window(self, start, end, seen, extra=None, depth=0):
        """Fetch acquisitions in [start,end); split the window if a page comes back full."""
        p = {"start": iso(start), "end": iso(end)}
        if extra:
            p.update(extra)
        res = self.query(p)
        if len(res) >= NISAR_PAGE and (end - start).total_seconds() > 1200 and depth < 14:
            mid = start + (end - start) / 2
            return (self.fetch_window(start, mid, seen, extra, depth + 1) +
                    self.fetch_window(mid, end, seen, extra, depth + 1))
        n = self.ingest(res, seen)
        time.sleep(2)
        return n

    def incremental(self):
        last = self.meta("last_poll")
        now = utcnow()
        since = parse_iso(last) - dt.timedelta(minutes=20) if last else now - dt.timedelta(hours=2)
        # everything ASF processed since the last poll; one request normally (~300-450 granules/h),
        # one request per product type if a page comes back full
        seen = int(time.time())
        res = self.query({"processingDate": iso(since)})
        if len(res) < NISAR_PAGE:
            n = self.ingest(res, seen)
        else:
            n = 0
            for t in NISAR_ALL_TYPES:
                r2 = self.query({"processingDate": iso(since), "processingLevel": t})
                if len(r2) >= NISAR_PAGE:
                    log("nisar incremental: %s page full (capped at %d)" % (t, NISAR_PAGE))
                n += self.ingest(r2, seen)
                time.sleep(2)
        with self.lock:
            self.set_meta("last_poll", iso(now))
            self.db.commit()
        self.resp_cache.clear()
        log("nisar incremental: %d granules" % n)
        return n

    def backfill_step(self):
        cur = self.meta("bf_cursor")
        cur = parse_iso(cur) if cur else utcnow()
        if cur <= NISAR_START:
            return False
        a = max(NISAR_START, cur - dt.timedelta(hours=2))
        n = self.fetch_window(a, cur, 0, {"processingLevel": NISAR_FRAME_TYPES})
        with self.lock:
            self.set_meta("bf_cursor", iso(a))
            self.db.commit()
        self.resp_cache.clear()
        log("nisar backfill %s..%s: %d" % (iso(a), iso(cur), n))
        return True

    def coverage_from(self):
        c = self.meta("bf_cursor")
        return c

    def run(self):
        set_status("asf", "idle", note="starts polling when the NISAR layer is first opened")
        while True:
            if not self.active:
                self.wake.wait(60)
                self.wake.clear()
                continue
            try:
                last = self.meta("last_poll")
                if not last or time.time() - parse_iso(last).timestamp() >= 3600:
                    if not self.meta("bf_cursor"):
                        with self.lock:
                            self.set_meta("bf_cursor", iso(utcnow()))
                            self.db.commit()
                    self.incremental()
                    set_status("asf", "ok", fetched=iso(time.time()), coverage_from=self.coverage_from(),
                               granules=self.count())
                    continue
                more = self.backfill_step()
                set_status("asf", "ok", coverage_from=self.coverage_from(), granules=self.count(),
                           backfill="running" if more else "complete")
                if not more:
                    time.sleep(300)
                    continue
                cur = parse_iso(self.meta("bf_cursor"))
                recent = utcnow() - cur < dt.timedelta(days=8)
                time.sleep(8 if recent else 40)
            except Exception as e:
                set_status("asf", "error", error=redact(e), retry_in_s=300)
                log("nisar error", redact(e))
                time.sleep(300)

    def count(self):
        return self.db.execute("SELECT COUNT(*) FROM g").fetchone()[0]

    def listing(self, days, types):
        key = (days, tuple(types))
        c = self.resp_cache.get(key)
        if c and time.time() - c[0] < 600:
            return c[1]
        now = int(time.time())
        cap = 20000
        with self.lock:
            tq = ""
            args = []
            if types:
                tq = " AND pt IN (%s)" % ",".join("?" * len(types))
                args = list(types)
            if days == "all":
                sql = ("SELECT gn,pt,MAX(st),path,frame,dir,seen,geom FROM g WHERE 1=1%s "
                       "GROUP BY pt,path,frame,dir ORDER BY 3 DESC LIMIT %d" % (tq, cap))
                rows = self.db.execute(sql, args).fetchall()
            else:
                since = now - int(days) * 86400
                sql = ("SELECT gn,pt,st,path,frame,dir,seen,geom FROM g WHERE st>=?%s "
                       "ORDER BY st DESC LIMIT %d" % (tq, cap))
                rows = self.db.execute(sql, [since] + args).fetchall()
            counts = dict(self.db.execute("SELECT pt, COUNT(*) FROM g GROUP BY pt").fetchall())
        pts = sorted({r[1] for r in rows} | set(counts))
        pidx = {p: i for i, p in enumerate(pts)}
        out = []
        for gn, pt, st, path, frame, d, seen, geom in rows:
            ring = json.loads(geom)[0]
            flat = [v for xy in ring for v in xy]
            out.append([gn, pidx[pt], st // 60, path, frame, d, (seen or 0) // 60, flat])
        body = {"generated": iso(now), "days": days, "types": pts, "db_counts": counts,
                "coverage_from": self.coverage_from(), "last_poll": self.meta("last_poll"),
                "capped": len(rows) >= cap, "rows": out}
        gz = gzip.compress(json.dumps(body, separators=(",", ":")).encode(), 5)
        self.resp_cache[key] = (time.time(), gz)
        return gz

    def granule(self, gn):
        with self.lock:
            r = self.db.execute("SELECT * FROM g WHERE gn=?", (gn,)).fetchone()
            if not r:
                return None
            cols = [c[0] for c in self.db.execute("SELECT * FROM g LIMIT 0").description]
            d = dict(zip(cols, r))
            du = self.tpl(d.pop("du"))
            br = self.tpl(d.pop("br"))
        d["download_url"] = du.replace("{gn}", gn) if du else None
        d["browse_url"] = br.replace("{gn}", gn) if br else None
        d["geom"] = json.loads(d["geom"])
        d["start"] = iso(d.pop("st"))
        d["end"] = iso(d.pop("et"))
        d["vertex_url"] = ("https://search.asf.alaska.edu/#/?dataset=NISAR&searchType=List%20Search&searchList="
                           + urllib.parse.quote(gn) + "&resultsLoaded=true")
        d["download_note"] = "Download needs a free NASA Earthdata login (search does not)."
        return d


NISAR = Nisar()

# --------------------------------------------------------------------------- SWOT (Hydrocron)
HYDROCRON_URL = "https://soto.podaac.earthdatacloud.nasa.gov/hydrocron/v1/timeseries"
SWOT_FIELDS = {
    "Reach": "reach_id,time_str,wse,width,slope,dschg_c,reach_q,crid,collection_version",
    "PriorLake": "lake_id,time_str,wse,area_total,quality_f,crid,collection_version",
}
SWOT_LOCK = threading.Lock()


def load_swot_whitelist():
    try:
        with open(os.path.join(STATIC, "data", "swot_features.json"), encoding="utf-8") as f:
            d = json.load(f)
        return {(x["type"], str(x["id"])): x for x in d.get("features", [])}
    except Exception:
        return {}


SWOT_WL = load_swot_whitelist()


def swot_series(feature, fid):
    path = os.path.join(CACHE, "swot", "%s_%s.json.gz" % (feature, fid))

    def fetch():
        end = utcnow()
        start = end - dt.timedelta(days=365)
        q = {"feature": feature, "feature_id": fid, "start_time": iso(start), "end_time": iso(end),
             "output": "csv", "fields": SWOT_FIELDS[feature]}
        url = HYDROCRON_URL + "?" + urllib.parse.urlencode(q)
        with SWOT_LOCK:  # one request at a time, ever
            try:
                _, body, _ = http_get(url, timeout=90, source="hydrocron")
            except Upstream as e:
                if "HTTP 400" in str(e) and "not found" in str(e).lower():
                    body = json.dumps({"status": "200 OK", "results": {"csv": "", "nohits": True}}).encode()
                else:
                    raise
            time.sleep(1)
        d = json.loads(body)
        csv_text = (d.get("results") or {}).get("csv") or ""
        rows = []
        import csv as _csv
        import io
        rdr = _csv.DictReader(io.StringIO(csv_text))
        for row in rdr:
            rows.append(row)
        out = {"feature": feature, "id": fid, "fetched": iso(time.time()), "n": len(rows), "rows": rows,
               "hits": (d.get("hits")), "status": d.get("status")}
        return json.dumps(out, separators=(",", ":")).encode()

    c = Cached("swot:%s:%s" % (feature, fid), path, 12 * 3600, fetch, err_backoff=600, source="hydrocron")
    return c.get()


SWOT_OBJS = {}


def swot_get(feature, fid):
    k = (feature, fid)
    if k not in SWOT_OBJS:
        SWOT_OBJS[k] = True
    return swot_series(feature, fid)


# --------------------------------------------------------------------------- websocket client (RFC 6455 + RFC 7692)
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WSClosed(Exception):
    pass


class WebSocket:
    def __init__(self, url, timeout=90):
        u = urllib.parse.urlparse(url)
        self.host = u.hostname
        self.port = u.port or (443 if u.scheme == "wss" else 80)
        self.path = (u.path or "/") + (("?" + u.query) if u.query else "")
        raw = socket.create_connection((self.host, self.port), timeout=20)
        if u.scheme == "wss":
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=self.host)
        self.sock = raw
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n"
               "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n"
               "User-Agent: %s\r\n\r\n") % (self.path, self.host, key, UA)
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSClosed("handshake: connection closed")
            head += chunk
            if len(head) > 65536:
                raise WSClosed("handshake: header too large")
        head, self.buf = head.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        if " 101 " not in lines[0] + " ":
            raise WSClosed("handshake: " + lines[0][:80])
        hdr = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                hdr[k.strip().lower()] = v.strip()
        expect = base64.b64encode(hashlib.sha1(key.encode() + WS_GUID).digest()).decode()
        if hdr.get("sec-websocket-accept") != expect:
            raise WSClosed("handshake: bad accept")
        ext = hdr.get("sec-websocket-extensions", "")
        self.deflate = "permessage-deflate" in ext
        self.no_ctx = "server_no_context_takeover" in ext
        self.inflater = zlib.decompressobj(-15)
        self.sock.settimeout(timeout)
        self.wlock = threading.Lock()

    def _read(self, n):
        # bytearray + read offset: avoids re-copying the buffer for every small frame
        if not isinstance(self.buf, bytearray):
            self.buf = bytearray(self.buf)
            self.pos = 0
        while len(self.buf) - self.pos < n:
            if self.pos > 262144:
                del self.buf[:self.pos]
                self.pos = 0
            chunk = self.sock.recv(max(65536, n - (len(self.buf) - self.pos)))
            if not chunk:
                raise WSClosed("connection closed")
            self.buf += chunk
        out = bytes(self.buf[self.pos:self.pos + n])
        self.pos += n
        return out

    def _send_frame(self, opcode, payload):
        hdr = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack("!H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack("!Q", n)
        mask = os.urandom(4)
        hdr += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self.wlock:
            self.sock.sendall(bytes(hdr) + masked)

    def send_text(self, s):
        self._send_frame(0x1, s.encode())

    def recv(self):
        """Return one complete data message as bytes (text or binary)."""
        parts = []
        compressed = False
        while True:
            b1, b2 = self._read(2)
            fin = b1 & 0x80
            rsv1 = b1 & 0x40
            op = b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            if n > 16 * 2**20:
                raise WSClosed("frame too large")
            mask = self._read(4) if b2 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if op == 0x8:
                try:
                    self._send_frame(0x8, payload[:2])
                except Exception:
                    pass
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                raise WSClosed("closed by server (%d) %s" % (code, payload[2:120].decode("utf-8", "replace")))
            if op == 0x9:
                self._send_frame(0xA, payload)
                continue
            if op == 0xA:
                continue
            if op in (0x1, 0x2):
                parts = [payload]
                compressed = bool(rsv1)
            elif op == 0x0:
                parts.append(payload)
            if fin and op in (0x0, 0x1, 0x2):
                data = b"".join(parts)
                if compressed and self.deflate:
                    data = self.inflater.decompress(data + b"\x00\x00\xff\xff")
                    if self.no_ctx:
                        self.inflater = zlib.decompressobj(-15)
                return data

    def close(self):
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- AIS (aisstream.io)
AIS_URL = "wss://stream.aisstream.io/v0/stream"
AIS_MAX_AGE = 30 * 60


def ship_class(t):
    try:
        t = int(t)
    except Exception:
        return "other"
    if t == 30:
        return "fishing"
    if 60 <= t <= 69:
        return "passenger"
    if 70 <= t <= 79:
        return "cargo"
    if 80 <= t <= 89:
        return "tanker"
    return "other"


class AIS:
    def __init__(self):
        self.ships = {}  # mmsi -> [lat, lon, sog, cog, hdg, t, navstat]
        self.static = {}  # mmsi -> {name, type, dest, callsign, imo, dim, t}
        self.lock = threading.Lock()
        self.msgs = 0
        self.connected_at = None

    def handle(self, raw):
        try:
            m = json.loads(raw)
        except Exception:
            return
        if "error" in m:
            raise WSClosed("aisstream error: " + str(m.get("error"))[:120])
        mt = m.get("MessageType")
        md = {k.lower(): v for k, v in (m.get("MetaData") or m.get("Metadata") or {}).items()}
        msg = (m.get("Message") or {}).get(mt) or {}
        try:
            mmsi = int(md.get("mmsi") or msg.get("UserID"))
        except Exception:
            return
        now = time.time()
        self.msgs += 1
        if mt in ("PositionReport", "StandardClassBPositionReport"):
            lat = msg.get("Latitude", md.get("latitude"))
            lon = msg.get("Longitude", md.get("longitude"))
            if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180 or (lat == 0 and lon == 0):
                return
            hdg = msg.get("TrueHeading")
            if hdg is None or hdg >= 360:
                hdg = None
            cog = msg.get("Cog")
            if cog is not None and cog >= 360:
                cog = None
            sog = msg.get("Sog")
            if sog is not None and sog >= 102.3:
                sog = None
            with self.lock:
                self.ships[mmsi] = [round(lat, 5), round(lon, 5), sog, cog, hdg, now,
                                    msg.get("NavigationalStatus"), "B" if mt.startswith("Standard") else "A"]
                name = (md.get("shipname") or "").strip()
                if name:
                    st = self.static.setdefault(mmsi, {})
                    st.setdefault("name", name)
        elif mt == "ShipStaticData":
            dim = msg.get("Dimension") or {}
            eta = msg.get("Eta") or {}
            with self.lock:
                st = self.static.setdefault(mmsi, {})
                st.update({"name": (msg.get("Name") or md.get("shipname") or "").strip() or st.get("name"),
                           "type": msg.get("Type"), "dest": (msg.get("Destination") or "").strip(),
                           "callsign": (msg.get("CallSign") or "").strip(), "imo": msg.get("ImoNumber"),
                           "length": (dim.get("A") or 0) + (dim.get("B") or 0) or None,
                           "beam": (dim.get("C") or 0) + (dim.get("D") or 0) or None,
                           "draught": msg.get("MaximumStaticDraught"),
                           "eta": ("%02d-%02d %02d:%02d" % (eta.get("Month", 0), eta.get("Day", 0),
                                                           eta.get("Hour", 0), eta.get("Minute", 0)))
                           if eta.get("Month") else None, "t": now})

    def purge(self):
        cut = time.time() - AIS_MAX_AGE
        with self.lock:
            for k in [k for k, v in self.ships.items() if v[5] < cut]:
                del self.ships[k]
            for k in [k for k, v in self.static.items() if k not in self.ships and v.get("t", 0) < cut - 3600]:
                del self.static[k]

    def run(self):
        key = KEYS.get("AISSTREAM_API_KEY")
        if not key:
            set_status("aisstream", "missing key", note="add AISSTREAM_API_KEY to the keys file and restart")
            return
        backoff = 5
        threading.Thread(target=self._purger, daemon=True).start()
        while True:
            ws = None
            t0 = time.time()
            try:
                set_status("aisstream", "connecting")
                ws = WebSocket(AIS_URL, timeout=120)
                sub = {"APIKey": key, "BoundingBoxes": [[[-90, -180], [90, 180]]],
                       "FilterMessageTypes": ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"]}
                ws.send_text(json.dumps(sub))  # within 3 s of connecting
                self.connected_at = time.time()
                set_status("aisstream", "enabled", connected=iso(time.time()), compression=ws.deflate)
                while True:
                    self.handle(ws.recv())
            except Exception as e:
                msg = redact(e)
                set_status("aisstream", "error", error=msg, retry_in_s=backoff)
                log("aisstream:", msg)
            finally:
                if ws:
                    ws.close()
            if time.time() - t0 > 300:
                backoff = 5
            time.sleep(backoff + random.uniform(0, backoff / 2))
            backoff = min(backoff * 2, 600)

    def _purger(self):
        while True:
            time.sleep(60)
            self.purge()
            with STATUS_LOCK:
                s = STATUS.get("aisstream", {})
                s["ships"] = len(self.ships)
                s["messages"] = self.msgs

    def in_bbox(self, w, s, e, n, cap=20000):
        out = []
        now = time.time()
        with self.lock:
            items = list(self.ships.items())
            static = self.static
            for mmsi, v in items:
                lat, lon = v[0], v[1]
                if lat < s or lat > n:
                    continue
                if w <= e:
                    if lon < w or lon > e:
                        continue
                elif lon < w and lon > e:
                    continue
                st = static.get(mmsi) or {}
                out.append([mmsi, lat, lon, v[3] if v[3] is not None else -1, v[4] if v[4] is not None else -1,
                            v[2] if v[2] is not None else -1, ship_class(st.get("type")), int(now - v[5])])
        total = len(out)
        if total > cap:
            out.sort(key=lambda r: r[7])
            out = out[:cap]
        return {"total": total, "returned": len(out), "ships": out, "generated": iso(now)}

    def one(self, mmsi):
        with self.lock:
            v = self.ships.get(mmsi)
            st = dict(self.static.get(mmsi) or {})
        if not v:
            return None
        st.pop("t", None)
        return {"mmsi": mmsi, "lat": v[0], "lon": v[1], "sog_kn": v[2], "cog": v[3], "heading": v[4],
                "age_s": int(time.time() - v[5]), "nav_status": v[6], "class": v[7],
                "type_class": ship_class(st.get("type")), **st}


AISD = AIS()

# --------------------------------------------------------------------------- Global Fishing Watch
GFW_REPORT = ("https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=LOW"
              "&temporal-resolution=ENTIRE&datasets[0]=public-global-sar-presence:latest"
              "&filters[0]=matched='false'&format=JSON&date-range={a},{b}")
GFW_LAST = "https://gateway.api.globalfishingwatch.org/v3/4wings/last-report"


def gfw_fetch():
    tok = KEYS.get("GFW_API_TOKEN")
    if not tok:
        raise Unavailable("missing token")
    end = utcnow().date()
    start = end - dt.timedelta(days=14)  # SAR data lags ~5 days; 14 d window covers the last ~7-9 days of data
    url = GFW_REPORT.format(a=start.isoformat(), b=end.isoformat())
    url = url.replace("[", "%5B").replace("]", "%5D").replace("'", "%27")
    hdr = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
    rows = []
    # four longitude bands, sequentially (GFW runs one report per user at a time)
    for w in (-180, -90, 0, 90):
        poly = {"geojson": {"type": "Polygon", "coordinates": [[[w, -85], [w + 90, -85], [w + 90, 85], [w, 85], [w, -85]]]}}
        body = None
        try:
            _, body, _ = http_get(url, headers=hdr, data=json.dumps(poly).encode(), method="POST",
                                  timeout=150, source="gfw")
        except Upstream as e:
            if "524" in str(e) or "running" in str(e):
                for _ in range(20):
                    time.sleep(30)
                    try:
                        _, body, _ = http_get(GFW_LAST, headers=hdr, timeout=60, source="gfw")
                        if b'"running"' not in body[:200]:
                            break
                    except Upstream:
                        pass
            else:
                raise
        if not body:
            continue
        d = json.loads(body)
        for ent in d.get("entries") or []:
            for _, arr in ent.items():
                for r in arr or []:
                    if r.get("lat") is not None:
                        rows.append([round(r["lat"], 2), round(r["lon"], 2), r.get("detections", 1)])
        time.sleep(3)
    out = {"fetched": iso(time.time()), "date_range": [start.isoformat(), end.isoformat()],
           "dataset": "public-global-sar-presence:latest", "filter": "matched='false'",
           "resolution": "0.1 degree grid cells", "cells": rows}
    return json.dumps(out, separators=(",", ":")).encode()


GFW = Cached("gfw:sar", os.path.join(CACHE, "gfw", "sar_dark.json.gz"), 6 * 3600, gfw_fetch,
             err_backoff=3600, source="gfw")
if not KEYS.get("GFW_API_TOKEN"):
    set_status("gfw", "missing key", note="add GFW_API_TOKEN to the keys file and restart")
if not KEYS.get("AISSTREAM_API_KEY"):
    set_status("aisstream", "missing key", note="add AISSTREAM_API_KEY to the keys file and restart")

# --------------------------------------------------------------------------- Sentinel-1 RTC (Planetary Computer)
PC_SEARCH = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
S1_ID_RE = re.compile(r"^S1[A-D]_(IW|EW|SM)_GRD[HM]_1S[DSH][VH]_\d{8}T\d{6}_\d{8}T\d{6}_\d{6}_[0-9A-F]{6}_rtc$")
S1_JOBS = os.path.join(CACHE, "s1jobs")
S1_SEARCH_DIR = os.path.join(CACHE, "s1search")
S1_LOCK = threading.Lock()
S1_RUN = {"key": None, "proc": None, "started": 0}
JOB_TIMEOUT = 600
S1_ALGO_VERSION = 4  # part of the result cache key: bump when analysis.py changes
MAX_AOI_KM2 = 2500.0


def bbox_param(txt, max_span=None):
    w, s, e, n = [float(x) for x in txt.split(",")]
    if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
        raise ValueError("bbox must be w,s,e,n with w<e, s<n")
    if max_span and (e - w > max_span or n - s > max_span):
        cx, cy = (w + e) / 2, (s + n) / 2
        h = max_span / 2
        w, e, s, n = max(-180, cx - h), min(180, cx + h), max(-85, cy - h), min(85, cy + h)
    return w, s, e, n


def aoi_km2(b):
    w, s, e, n = b
    return (e - w) * 111.32 * math.cos(math.radians((s + n) / 2)) * (n - s) * 110.57


def s1_search(bbox, day_from, day_to):
    """Sentinel-1 RTC scenes intersecting a rounded bbox and date window. Cached 1 h on disk."""
    w, s, e, n = bbox
    q = 0.25
    w, s = math.floor(w / q) * q, math.floor(s / q) * q
    e, n = math.ceil(e / q) * q, math.ceil(n / q) * q
    key = "%s_%s_%s" % (",".join("%.2f" % x for x in (w, s, e, n)), day_from, day_to)
    path = os.path.join(S1_SEARCH_DIR, hashlib.sha1(key.encode()).hexdigest()[:20] + ".json.gz")

    def fetch():
        out, url, pages = [], None, 0
        params = {"collections": "sentinel-1-rtc", "bbox": "%.2f,%.2f,%.2f,%.2f" % (w, s, e, n),
                  "datetime": "%sT00:00:00Z/%sT23:59:59Z" % (day_from, day_to), "limit": "200", "sortby": "-datetime"}
        url = PC_SEARCH + "?" + urllib.parse.urlencode(params)
        while url and pages < 3:
            _, body, _ = http_get(url, timeout=60, source="planetary-computer")
            d = json.loads(body)
            for f in d.get("features", []):
                p = f.get("properties", {})
                geom = f.get("geometry") or {}
                coords = geom.get("coordinates") or []
                ring = coords[0] if geom.get("type") == "Polygon" else (coords[0][0] if coords else [])
                out.append({"id": f["id"], "dt": p.get("datetime"), "platform": p.get("platform"),
                            "dir": p.get("sat:orbit_state"), "rel": p.get("sat:relative_orbit"),
                            "abs": p.get("sat:absolute_orbit"), "pols": p.get("sar:polarizations"),
                            "timeliness": p.get("s1:product_timeliness"), "bbox": [round(x, 4) for x in f.get("bbox", [])],
                            "ring": [[round(x, 3), round(y, 3)] for x, y in ring[:200]]})
            nxt = [l for l in d.get("links", []) if l.get("rel") == "next" and l.get("method", "GET") == "GET"]
            url = nxt[0]["href"] if nxt and nxt[0]["href"].startswith(PC_SEARCH + "?") else None
            pages += 1
        body = {"bbox": [w, s, e, n], "from": day_from, "to": day_to, "fetched": iso(time.time()), "scenes": out}
        return json.dumps(body, separators=(",", ":")).encode()

    c = Cached("s1search:" + key, path, 3600, fetch, err_backoff=300, source="planetary-computer")
    return c.get()


PC_TILE = ("https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png"
           "?collection=sentinel-1-rtc&item={item}&{q}")
_FC = ("0.03 + log (10e-4 - log (0.05 / (0.02 + 2 * vv)));0.05 + exp (0.25 * (log (0.01 + 2 * vv) + "
       "log (0.02 + 5 * vh)));1 - log (0.05 / (0.045 - 0.9 * vv))")
S1_RENDER = {  # Planetary Computer's documented sentinel-1-rtc render options + dB variants
    "fc": "assets=vv&assets=vh&expression=" + urllib.parse.quote(_FC) +
          "&rescale=0,.8000&rescale=0,1.000&rescale=0,1.000&asset_as_band=True",
    "vv": "assets=vv&expression=" + urllib.parse.quote("10*log10(vv)") + "&asset_as_band=True&rescale=-25,0&colormap_name=gray",
    "vh": "assets=vh&expression=" + urllib.parse.quote("10*log10(vh)") + "&asset_as_band=True&rescale=-30,-5&colormap_name=gray",
}
def _png_transparent(w=1, h=1):
    def chunk(t, d):
        return struct.pack("!I", len(d)) + t + d + struct.pack("!I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x00\x00\x00\x00" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", w, h, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


EMPTY_PNG = _png_transparent()  # fully transparent 1x1 RGBA
TILE_LRU = {}
TILE_SEM = threading.BoundedSemaphore(8)


def s1_tile(item, mode, z, x, y):
    k = (item, mode, z, x, y)
    hit = TILE_LRU.get(k)
    if hit:
        return hit, "hit"
    url = PC_TILE.format(z=z, x=x, y=y, item=urllib.parse.quote(item), q=S1_RENDER[mode])
    with TILE_SEM:
        try:
            _, body, _ = http_get(url, timeout=45, max_bytes=4 * 2**20, source="pc-tiles")
        except Upstream as e:
            if "HTTP 404" in str(e) or "HTTP 204" in str(e):
                body = EMPTY_PNG  # outside the scene footprint: transparent, not an error
            else:
                raise
    if len(TILE_LRU) > 400:
        for kk in list(TILE_LRU)[:100]:
            TILE_LRU.pop(kk, None)
    TILE_LRU[k] = body
    return body, "miss"


def s1_job_dir(key):
    return os.path.join(S1_JOBS, key)


def s1_reap():
    """Collect a finished worker; enforce the timeout (kills our own child by PID)."""
    with S1_LOCK:
        p = S1_RUN["proc"]
        if not p:
            return
        if p.poll() is None and time.time() - S1_RUN["started"] > JOB_TIMEOUT:
            p.kill()
            p.wait(5)
            with open(os.path.join(s1_job_dir(S1_RUN["key"]), "error.json"), "w") as f:
                json.dump({"error": "timed out after %d s" % JOB_TIMEOUT}, f)
        if p.poll() is not None:
            S1_RUN.update(key=None, proc=None)


def s1_cleanup():
    """Results are kept 7 days; search caches 1 day (this app's own cache files only)."""
    import shutil
    now = time.time()
    for base, age in ((S1_JOBS, 7 * 86400), (S1_SEARCH_DIR, 86400)):
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            pth = os.path.join(base, name)
            try:
                if now - os.path.getmtime(pth) > age and name != S1_RUN.get("key"):
                    shutil.rmtree(pth) if os.path.isdir(pth) else os.remove(pth)
            except OSError:
                pass


def s1_submit(job):
    canon = json.dumps(job, sort_keys=True, separators=(",", ":"))
    key = hashlib.sha1(canon.encode()).hexdigest()[:20]
    jd = s1_job_dir(key)
    if os.path.exists(os.path.join(jd, "result.json")):
        return key, "done"
    s1_reap()
    with S1_LOCK:
        if S1_RUN["proc"] is not None:
            if S1_RUN["key"] == key:
                return key, "running"
            raise Unavailable("another analysis is running - one job at a time; try again when it finishes", 30)
        if not os.path.exists(VENV_PY):
            raise Unavailable("radar analysis needs the optional extras (requirements-radar.txt in LSS_VENV_PYTHON's venv)", 3600)
        if os.path.isdir(jd):
            for fn in ("error.json", "progress.json"):
                try:
                    os.remove(os.path.join(jd, fn))
                except OSError:
                    pass
        os.makedirs(jd, exist_ok=True)
        with open(os.path.join(jd, "job.json"), "w") as f:
            f.write(canon)
        env = dict(os.environ, OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2", GDAL_NUM_THREADS="2",
                   GDAL_CACHEMAX="128")
        log_f = open(os.path.join(jd, "worker.log"), "w")
        p = subprocess.Popen([VENV_PY, os.path.join(ROOT, "analysis.py"), jd], cwd=ROOT, env=env,
                             stdout=log_f, stderr=subprocess.STDOUT, preexec_fn=lambda: os.nice(19))
        S1_RUN.update(key=key, proc=p, started=time.time())
        set_status("s1-analysis", "running", job=key, type=job["type"])
    return key, "running"


def ais_crossmatch(res_path):
    """Match ship detections against live AIS. AIS here is 'now', so only near-live scenes can match."""
    with open(res_path) as f:
        r = json.load(f)
    if r.get("type") != "ships" or "ais" in r:
        return r
    scene_t = parse_iso(r["scenes"][0]["datetime"]).timestamp()
    lag = time.time() - scene_t
    pts = r["result"]["points"]
    if not KEYS.get("AISSTREAM_API_KEY"):
        r["ais"] = {"state": "no AIS key - cross-match unavailable"}
    elif abs(lag) > 1800:
        r["ais"] = {"state": "not possible", "scene_age_h": round(lag / 3600, 1),
                    "note": "AIS here is live (last 30 min). This scene is %.1f h old, so ship positions at scene time "
                            "are unknown; detections are left unmatched." % (lag / 3600)}
        for p in pts:
            p["ais"] = "not checked (scene not live)"
    else:
        with AISD.lock:
            ships = [(m, v[0], v[1], v[5]) for m, v in AISD.ships.items()]
        matched = 0
        for p in pts:
            best = None
            for m, la, lo, t in ships:
                if abs(t - scene_t) > 1800:
                    continue
                dkm = math.hypot((la - p["lat"]) * 110.57, (lo - p["lon"]) * 111.32 * math.cos(math.radians(la)))
                if dkm < 1.0 and (best is None or dkm < best[1]):
                    best = (m, dkm)
            if best:
                p["ais"] = "AIS-matched"
                p["mmsi"] = best[0]
                p["ais_dist_km"] = round(best[1], 2)
                matched += 1
            else:
                p["ais"] = "no AIS at scene time (possible dark vessel)"
        r["ais"] = {"state": "matched", "matched": matched, "unmatched": len(pts) - matched, "window_min": 30,
                    "radius_km": 1.0, "note": "A missing AIS message is not proof of a dark vessel: terrestrial AIS "
                    "coverage is incomplete and small craft need not carry AIS."}
    with open(res_path + ".tmp", "w") as f:
        json.dump(r, f, separators=(",", ":"))
    os.replace(res_path + ".tmp", res_path)
    return r


# --------------------------------------------------------------------------- HTTP handler
CTYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json", ".geojson": "application/geo+json", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif",
    ".webp": "image/webp", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
    ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
    ".ico": "image/x-icon", ".ktx2": "image/ktx2", ".bin": "application/octet-stream",
    ".webmanifest": "application/manifest+json",
}
LONG_CACHE = ("/vendor/", "/models/", "/fonts/")
GN_RE = re.compile(r"^NISAR_[A-Z0-9_]{20,160}$")


class Handler(BaseHTTPRequestHandler):
    server_version = "LionSatelliteStudio/" + VERSION
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def gz_ok(self):
        return "gzip" in (self.headers.get("Accept-Encoding") or "")

    def send_body(self, code, body, ctype, gz=False, headers=None, cache="no-store"):
        if gz and not self.gz_ok():
            body = gzip.decompress(body)
            gz = False
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, obj, code=200, headers=None, cache="no-store"):
        body = json.dumps(obj, separators=(",", ":")).encode()
        if len(body) > 2048 and self.gz_ok():
            self.send_body(code, gzip.compress(body, 5), "application/json", gz=True, headers=headers, cache=cache)
        else:
            self.send_body(code, body, "application/json", headers=headers, cache=cache)

    def send_err(self, code, msg, retry=None):
        h = {"Retry-After": retry} if retry else None
        self.send_json({"error": redact(msg), "retry_in_s": retry}, code=code, headers=h)

    def cached_out(self, gz, meta, cache="no-cache"):
        h = {"X-Cache": meta.get("cache", "hit"), "X-Fetched-At": meta.get("fetched", ""),
             "X-Age": meta.get("age_s", "")}
        self.send_body(200, gz, "application/json", gz=True, headers=h, cache=cache)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        self.send_err(405, "method not allowed")

    do_PUT = do_DELETE = do_PATCH = do_POST

    def do_GET(self):
        try:
            u = urllib.parse.urlsplit(self.path)
            if len(self.path) > 2048:
                return self.send_err(414, "uri too long")
            q = urllib.parse.parse_qs(u.query, keep_blank_values=False)
            p = u.path
            if p.startswith("/api/"):
                return self.api(p, q)
            return self.static(p)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            log("handler error", self.path[:120], redact(e))
            tb = traceback.format_exc()
            for v in KEYS.values():               # the full traceback goes through the same key scrub as every other sink
                if v:
                    tb = tb.replace(v, "[redacted]")
            sys.stderr.write(tb)
            try:
                self.send_err(500, "internal error")
            except Exception:
                pass

    # ---- static
    def static(self, p):
        if p == "/" or p == "":
            p = "/index.html"
        p = posixpath.normpath(urllib.parse.unquote(p))
        if ".." in p.split("/") or "\x00" in p:
            return self.send_err(400, "bad path")
        full = os.path.realpath(os.path.join(STATIC, p.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self.send_err(404, "not found")
        ext = os.path.splitext(full)[1].lower()
        ctype = CTYPES.get(ext, "application/octet-stream")
        st = os.stat(full)
        lm = formatdate(st.st_mtime, usegmt=True)
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        cache = "public, max-age=604800" if p.startswith(LONG_CACHE) else "no-cache"
        gzpath = full + ".gz"
        if self.gz_ok() and os.path.isfile(gzpath) and os.path.getmtime(gzpath) >= st.st_mtime:
            with open(gzpath, "rb") as f:
                body = f.read()
            return self.send_body(200, body, ctype, gz=True, cache=cache,
                                  headers={"Last-Modified": lm, "ETag": etag, "Vary": "Accept-Encoding"})
        with open(full, "rb") as f:
            body = f.read()
        self.send_body(200, body, ctype, cache=cache, headers={"Last-Modified": lm, "ETag": etag})

    # ---- api
    def api(self, p, q):
        one = lambda k, d=None: (q.get(k) or [d])[0]
        try:
            if p == "/api/sats":
                g = one("group", "fleet")
                if g == "fleet":
                    gz, meta = fleet_group()
                    return self.cached_out(gz, meta)
                if g not in SATS:
                    return self.send_err(400, "unknown group")
                gz, meta = SATS[g].get()
                return self.cached_out(gz, meta)
            if p == "/api/quakes":
                f = one("feed", "all_day")
                if f not in QUAKES:
                    return self.send_err(400, "unknown feed")
                gz, meta = QUAKES[f].get()
                return self.cached_out(gz, meta)
            if p == "/api/gibs/layers":
                gz, meta = gibs_layers_json()
                return self.cached_out(gz, meta)
            if p == "/api/gibs/times":
                layer = one("layer", "")
                if layer not in SUBDAILY:
                    return self.send_err(400, "layer is not a whitelisted sub-daily layer")
                try:
                    body, hit = gibs_times(layer)
                except Upstream as e:
                    set_status("gibs-times", "error", error=str(e))
                    return self.send_err(503, "GIBS time domain unavailable: " + str(e), 300)
                return self.send_json(body, headers={"X-Cache": hit})
            if p == "/api/nisar":
                NISAR.active = True
                NISAR.wake.set()
                days = one("days", "7")
                if days not in ("7", "30", "all"):
                    return self.send_err(400, "days must be 7, 30 or all")
                types = [t for t in (one("types", "") or "").split(",") if t]
                if any(not NISAR_TYPES.match(t) for t in types) or len(types) > 12:
                    return self.send_err(400, "bad types")
                return self.cached_out(NISAR.listing(days, types), {"cache": "db"})
            if p == "/api/nisar/granule":
                gn = one("id", "")
                if not GN_RE.match(gn):
                    return self.send_err(400, "bad granule id")
                d = NISAR.granule(gn)
                if not d:
                    return self.send_err(404, "unknown granule")
                return self.send_json(d)
            if p == "/api/swot":
                feat = one("feature", "")
                fid = one("id", "")
                if feat not in SWOT_FIELDS or (feat, fid) not in SWOT_WL:
                    return self.send_err(400, "feature/id not in the curated whitelist")
                gz, meta = swot_get(feat, fid)
                return self.cached_out(gz, meta)
            if p == "/api/ships":
                if not KEYS.get("AISSTREAM_API_KEY"):
                    return self.send_json({"enabled": False, "reason": "missing key",
                                           "hint": "Ships: add a free aisstream.io key (see About)"})
                bb = (one("bbox", "-180,-90,180,90") or "").split(",")
                try:
                    w, s, e, n = [float(x) for x in bb]
                    assert -180 <= w <= 180 and -180 <= e <= 180 and -90 <= s <= n <= 90
                except Exception:
                    return self.send_err(400, "bbox must be w,s,e,n in degrees")
                d = AISD.in_bbox(w, s, e, n)
                d["enabled"] = True
                d["state"] = get_status().get("aisstream", {}).get("state")
                return self.send_json(d)
            if p.startswith("/api/ship/"):
                if not KEYS.get("AISSTREAM_API_KEY"):
                    return self.send_err(404, "ships disabled")
                m = p.rsplit("/", 1)[-1]
                if not re.fullmatch(r"\d{6,9}", m):
                    return self.send_err(400, "bad mmsi")
                d = AISD.one(int(m))
                return self.send_json(d) if d else self.send_err(404, "not heard in the last 30 min")
            if p == "/api/gfw/sar":
                if not KEYS.get("GFW_API_TOKEN"):
                    return self.send_json({"enabled": False, "reason": "missing key",
                                           "hint": "Dark vessels: add a free Global Fishing Watch token"})
                gz, meta = GFW.get()
                return self.cached_out(gz, meta)
            if p == "/api/s1/search":
                try:
                    bb = bbox_param(one("bbox", ""), max_span=8.0)
                    d_to = one("to") or utcnow().strftime("%Y-%m-%d")
                    d_from = one("from") or (utcnow() - dt.timedelta(days=30)).strftime("%Y-%m-%d")
                    a = dt.date.fromisoformat(d_from)
                    b = dt.date.fromisoformat(d_to)
                    assert dt.date(2014, 4, 1) <= a <= b and (b - a).days <= 400
                except Exception:
                    return self.send_err(400, "bbox=w,s,e,n and optional from/to=YYYY-MM-DD (window <= 400 days)")
                gz, meta = s1_search(bb, a.isoformat(), b.isoformat())
                set_status("planetary-computer", "ok", fetched=meta["fetched"])
                return self.cached_out(gz, meta)
            if p == "/api/s1/tile":
                item, mode = one("item", ""), one("mode", "")
                try:
                    z, x, y = int(one("z")), int(one("x")), int(one("y"))
                    assert 6 <= z <= 15 and 0 <= x < 2 ** z and 0 <= y < 2 ** z
                except Exception:
                    return self.send_err(400, "z/x/y out of range")
                if not S1_ID_RE.match(item) or mode not in S1_RENDER:
                    return self.send_err(400, "bad item or mode")
                try:
                    body, hit = s1_tile(item, mode, z, x, y)
                except Upstream as e:
                    return self.send_err(502, "tile unavailable: " + str(e)[:80], 60)
                return self.send_body(200, body, "image/png", headers={"X-Cache": hit}, cache="public, max-age=86400")
            if p == "/api/s1/analyze":
                return self.s1_analyze(one)
            if p == "/api/s1/job":
                key = one("key", "")
                if not re.fullmatch(r"[0-9a-f]{20}", key):
                    return self.send_err(400, "bad key")
                s1_reap()
                jd = s1_job_dir(key)
                if os.path.exists(os.path.join(jd, "result.json")):
                    return self.send_json({"state": "done", "key": key, "result": ais_crossmatch(os.path.join(jd, "result.json"))})
                if os.path.exists(os.path.join(jd, "error.json")):
                    with open(os.path.join(jd, "error.json")) as f:
                        e = json.load(f)
                    return self.send_json({"state": "error", "key": key, "error": e.get("error")})
                if not os.path.isdir(jd):
                    return self.send_err(404, "unknown job")
                pr = {}
                try:
                    with open(os.path.join(jd, "progress.json")) as f:
                        pr = json.load(f)
                except Exception:
                    pass
                running = S1_RUN["key"] == key
                return self.send_json({"state": "running" if running else "stalled", "key": key, "progress": pr})
            if p == "/api/s1/file":
                key, name = one("key", ""), one("name", "")
                if not re.fullmatch(r"[0-9a-f]{20}", key) or name not in ("overlay.png", "result.geojson", "result.json"):
                    return self.send_err(400, "bad key or file name")
                fp = os.path.join(s1_job_dir(key), name)
                if not os.path.isfile(fp):
                    return self.send_err(404, "not found")
                with open(fp, "rb") as f:
                    body = f.read()
                ct = {"overlay.png": "image/png", "result.geojson": "application/geo+json", "result.json": "application/json"}[name]
                hdr = {"Content-Disposition": 'attachment; filename="lion-satellite-studio-%s-%s"' % (key[:8], name)} if one("dl") else None
                return self.send_body(200, body, ct, headers=hdr, cache="private, max-age=600")
            if p == "/api/status":
                return self.send_json(self.status())
            return self.send_err(404, "unknown endpoint")
        except Unavailable as e:
            return self.send_err(503, str(e), e.retry)

    def s1_analyze(self, one):
        typ = one("type", "")
        if typ not in ("flood", "change", "ships", "timeseries"):
            return self.send_err(400, "type must be flood, change, ships or timeseries")
        try:
            bb = bbox_param(one("bbox", ""))
        except Exception:
            return self.send_err(400, "bbox must be w,s,e,n")
        bb = [round(x, 4) for x in bb]
        km2 = aoi_km2(bb)
        if km2 > MAX_AOI_KM2:
            return self.send_err(400, "AOI is %.0f km2 - the limit is %.0f km2. Draw a smaller box." % (km2, MAX_AOI_KM2))
        if km2 < 0.5:
            return self.send_err(400, "AOI is too small (< 0.5 km2)")
        # "+" joins slices of one pass; parse_qs turns an unescaped "+" into a space
        scenes = [x.replace(" ", "+") for x in (one("scenes", "") or "").split(",") if x]
        # a "scene" is one pass: 1-3 adjacent slice ids joined with "+"
        ok_pass = lambda x: 1 <= len(x.split("+")) <= 3 and all(S1_ID_RE.match(i) for i in x.split("+"))
        if len(scenes) > 20 or any(not ok_pass(x) for x in scenes):
            return self.send_err(400, "scenes must be up to 20 Sentinel-1 RTC passes (item ids, slices joined by +)")
        ref = (one("ref") or "").replace(" ", "+") or None
        if ref and not ok_pass(ref):
            return self.send_err(400, "bad reference scene id")

        def num(k, lo, hi, default=None):
            v = one(k)
            if v is None or v == "":
                return default
            return max(lo, min(hi, float(v)))
        params = {}
        try:
            if typ == "flood":
                if len(scenes) < 1:
                    return self.send_err(400, "flood needs one scene")
                scenes = scenes[:1]
                t = num("threshold", -30, -8)
                if t is not None:
                    params["threshold"] = round(t, 1)
            elif typ == "change":
                if len(scenes) != 2:
                    return self.send_err(400, "change needs two scenes (before,after)")
                params["t_db"] = round(num("t", 0.5, 10, 3.0), 1)
            elif typ == "ships":
                scenes = scenes[:1]
                if not scenes:
                    return self.send_err(400, "ships needs one scene")
                params["k"] = round(num("k", 3, 10, 5.0), 1)
                params["min_db"] = round(num("min_db", -20, 0, -12.0), 1)
                params["ratio_db"] = round(num("ratio_db", 3, 20, 9.0), 1)
                pol = one("pol", "vv")
                if pol not in ("vv", "vh"):
                    return self.send_err(400, "pol must be vv or vh")
                params["pol"] = pol
            elif typ == "timeseries":
                rel = int(one("rel", "0"))
                d = one("dir", "")
                if not (1 <= rel <= 175) or d not in ("ascending", "descending"):
                    return self.send_err(400, "timeseries needs rel (1-175) and dir")
                params.update(relative_orbit=rel, orbit_state=d, month=utcnow().strftime("%Y-%m"))
                scenes = []
        except ValueError:
            return self.send_err(400, "bad numeric parameter")
        job = {"type": typ, "bbox": bb, "scenes": scenes, "ref": ref if typ == "flood" else None, "params": params,
               "algo": S1_ALGO_VERSION}
        key, state = s1_submit(job)
        return self.send_json({"state": state, "key": key, "aoi_km2": round(km2, 1)})

    def status(self):
        st = get_status()
        out = {"server_time": iso(time.time()), "uptime_s": int(time.time() - START_TIME),
               "sources": st, "upstream_requests": dict(UPSTREAM_HITS)}
        cache = {}
        for g, c in SATS.items():
            m = c.mtime()
            if m:
                cache["celestrak:" + g] = {"age_s": int(time.time() - m), "ttl_s": c.ttl}
        for k, c in QUAKES.items():
            m = c.mtime()
            if m:
                cache["usgs:" + k] = {"age_s": int(time.time() - m), "ttl_s": c.ttl}
        m = GIBS_CATALOG.mtime()
        if m:
            cache["gibs:caps"] = {"age_s": int(time.time() - m), "ttl_s": GIBS_CATALOG.ttl}
        out["cache"] = cache
        out["keys"] = {"aisstream": "present" if KEYS.get("AISSTREAM_API_KEY") else "missing",
                       "gfw": "present" if KEYS.get("GFW_API_TOKEN") else "missing"}
        try:
            out["nisar"] = {"granules": NISAR.count(), "coverage_from": NISAR.coverage_from(),
                            "last_poll": NISAR.meta("last_poll"), "polling": NISAR.active}
        except Exception:
            pass
        return out


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


def main():
    os.makedirs(CACHE, exist_ok=True)
    threading.Thread(target=NISAR.run, daemon=True, name="nisar").start()

    def housekeeping():
        while True:
            try:
                s1_reap()
                s1_cleanup()
            except Exception as e:
                log("housekeeping", redact(e))
            time.sleep(6 * 3600)
    threading.Thread(target=housekeeping, daemon=True, name="housekeeping").start()

    def reaper():
        while True:
            time.sleep(5)
            try:
                s1_reap()
                if S1_RUN["proc"] is None and get_status().get("s1-analysis", {}).get("state") == "running":
                    set_status("s1-analysis", "idle")
            except Exception:
                pass
    threading.Thread(target=reaper, daemon=True, name="reaper").start()
    if os.environ.get("LSS_DISABLE_AIS") == "1":
        set_status("aisstream", "disabled", note="disabled for this run (LSS_DISABLE_AIS=1)")
    else:
        threading.Thread(target=AISD.run, daemon=True, name="ais").start()
    srv = Server((HOST, PORT), Handler)
    log("Lion Satellite Studio listening on http://%s:%d" % (HOST, PORT))
    try:
        srv.serve_forever(poll_interval=1.0)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
