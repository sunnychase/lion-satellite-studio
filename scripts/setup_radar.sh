#!/bin/bash
# Optional: install the radar extras (Sentinel-1 water / change / ships / time series) into ./venv.
# The globe itself needs none of this. Needs python3 with the venv module (Debian/Ubuntu: apt install python3-venv).
# About 250 MB on disk. Point LSS_VENV_PYTHON elsewhere in satellite.env if you keep the venv somewhere else.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x venv/bin/python ] || python3 -m venv venv
venv/bin/python -m pip install --upgrade pip
venv/bin/python -m pip install -r requirements-radar.txt
venv/bin/python - <<'PY'
import numpy, scipy, rasterio, pystac, planetary_computer
print("radar extras OK: numpy", numpy.__version__, "· scipy", scipy.__version__, "· rasterio", rasterio.__version__,
      "(GDAL", rasterio.__gdal_version__ + ")", "· pystac", pystac.__version__)
PY
echo "Restart the server so it picks up the extras."
