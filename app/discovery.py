import logging
import os
import re

import requests
from playwright.sync_api import sync_playwright

from . import database

logger = logging.getLogger(__name__)

CAMERAS_PAGE = (
    "https://www.lynnwoodwa.gov/Government/Departments/Public-Works"
    "/Streets-Traffic-and-Transportation/Traffic-Cameras"
)
MARKERINFO_API = (
    "https://www.lynnwoodwa.gov/ocapi/get/markerinfo/{content_id}"
    "/en-US?mainContentId=00000000-0000-0000-0000-000000000000"
)
DACAST_ACCESS_API = "https://playback.dacast.com/content/access?contentId={content_id}&provider=universe"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_HEADERS = {"User-Agent": "LynnwoodTrafficStats/1.0 (quinn@qmvo.org)"}
BROWSER_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"]


def _geocode(address: str) -> tuple[float, float] | None:
    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={"q": address + ", Lynnwood, WA", "format": "json", "limit": 1},
            headers=NOMINATIM_HEADERS,
            timeout=10,
        )
        data = resp.json()
        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception as e:
        logger.warning("Geocoding failed for %r: %s", address, e)
    return None


def _capture_layer_items(page) -> list[dict]:
    """Navigate to the cameras page and capture the /ocmaps/layer XHR response."""
    captured: list[dict] = []

    def on_response(response):
        if "ocmaps/layer" in response.url:
            try:
                data = response.json()
                captured.extend(data.get("layerItems", []))
            except Exception:
                pass

    page.on("response", on_response)
    page.goto(CAMERAS_PAGE, wait_until="networkidle", timeout=30000)
    return captured


def _get_subpage_link(content_id: str) -> str | None:
    try:
        r = requests.get(MARKERINFO_API.format(content_id=content_id), timeout=10)
        r.raise_for_status()
        return r.json()["markerInfo"]["Link"]
    except Exception as e:
        logger.warning("markerinfo failed for %s: %s", content_id, e)
        return None


def _get_hls_url(subpage_url: str) -> str | None:
    """Fetch a camera subpage, extract the Dacast contentId, and return the HLS stream URL."""
    try:
        r = requests.get(subpage_url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        m = re.search(r'contentId=([A-Za-z0-9-]+-live-[A-Za-z0-9-]+)', r.text)
        if not m:
            logger.warning("No Dacast contentId found on %s", subpage_url)
            return None
        content_id = m.group(1)
        ar = requests.get(DACAST_ACCESS_API.format(content_id=content_id), timeout=10)
        ar.raise_for_status()
        return ar.json().get("hls")
    except Exception as e:
        logger.warning("Failed to get HLS URL from %s: %s", subpage_url, e)
        return None


def discover_cameras() -> int:
    """Discover all cameras from lynnwoodwa.gov and upsert into the DB."""
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = "/ms-playwright"
    logger.info("Starting camera discovery")

    found = 0
    seen_urls: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(args=BROWSER_ARGS)
        page = browser.new_page()

        layer_items = _capture_layer_items(page)
        if not layer_items:
            logger.warning("No cameras found in /ocmaps/layer — page structure may have changed")
            browser.close()
            return 0

        logger.info("Layer data: %d cameras", len(layer_items))
        browser.close()

        for item in layer_items:
            content_id = item.get("ContentId", "")
            address = item.get("ContentTitle", "").strip()
            try:
                lat = float(item.get("Lat", 0))
                lon = float(str(item.get("Lng", "0")).strip())
            except ValueError:
                lat, lon = 0.0, 0.0

            if not content_id:
                continue

            # GPS from layer data is accurate — only fall back to geocoding if missing
            if lat == 0.0 and lon == 0.0:
                coords = _geocode(address)
                if coords:
                    lat, lon = coords
                else:
                    lat, lon = 47.8209, -122.3151

            subpage_link = _get_subpage_link(content_id)
            if not subpage_link:
                logger.warning("No subpage link for %s — skipping", address)
                continue

            hls_url = _get_hls_url(subpage_link)
            if not hls_url:
                logger.warning("No HLS URL for %s — skipping", address)
                continue

            database.upsert_camera(hls_url, address, lat, lon, is_custom=0)
            seen_urls.append(hls_url)
            found += 1
            logger.info("Camera: %s  lat=%.5f lon=%.5f  url=%s", address, lat, lon, hls_url)

    database.deactivate_missing_cameras(seen_urls)
    logger.info("Discovery complete: %d cameras upserted", found)
    return found
