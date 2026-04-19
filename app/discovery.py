import logging
import re

import requests

from . import database

logger = logging.getLogger(__name__)

CAMERA_PAGE_URL = "https://www.lynnwoodwa.gov/Government/Departments/Public-Works/Streets-Traffic-and-Transportation/Traffic-Cameras"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_HEADERS = {"User-Agent": "LynnwoodTrafficStats/1.0 (quinn@qmvo.org)"}


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


def _scrape_with_playwright() -> list[dict]:
    """Scrape camera list from lynnwoodwa.gov using Playwright."""
    from playwright.sync_api import sync_playwright

    cameras = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page()
        try:
            page.goto(CAMERA_PAGE_URL, wait_until="networkidle", timeout=30000)

            # Find all "Tell me more about" links which go directly to camera images
            links = page.query_selector_all("a[href*='camera'], a[href*='Camera']")

            # Also try to find the main camera links from the page structure
            # The page lists street names with links to camera image URLs
            all_links = page.query_selector_all("a")
            for link in all_links:
                href = link.get_attribute("href") or ""
                text = (link.inner_text() or "").strip()

                # Camera image links typically end in .jpg or point to camera endpoints
                if re.search(r"\.(jpg|jpeg|png|mjpg)(\?|$)", href, re.I):
                    cameras.append({"url": href, "address": text or href, "lat": None, "lon": None})
                    continue

                # "Tell me more" style links that open camera pages
                if "camera" in href.lower() and href.startswith("http"):
                    # Try to fetch the linked page to find the actual image URL
                    try:
                        cam_page = browser.new_page()
                        cam_page.goto(href, wait_until="domcontentloaded", timeout=15000)
                        img = cam_page.query_selector("img[src*='camera'], img[src*='stream'], img[src*='.jpg']")
                        if img:
                            img_url = img.get_attribute("src")
                            if img_url:
                                cameras.append({"url": img_url, "address": text or href, "lat": None, "lon": None})
                        cam_page.close()
                    except Exception as e:
                        logger.debug("Skipping camera link %s: %s", href, e)

        finally:
            browser.close()

    return cameras


def _scrape_with_requests() -> list[dict]:
    """Fallback: try direct HTTP with browser-like headers."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    try:
        resp = requests.get(CAMERA_PAGE_URL, headers=headers, timeout=15)
        resp.raise_for_status()
        html = resp.text

        cameras = []
        # Find image URLs in page content
        for match in re.finditer(r'https?://[^\s"\'<>]+\.(?:jpg|jpeg|png|mjpg)(?:\?[^\s"\'<>]*)?', html, re.I):
            url = match.group(0)
            cameras.append({"url": url, "address": url, "lat": None, "lon": None})
        return cameras
    except Exception as e:
        logger.warning("Direct HTTP scrape failed: %s", e)
        return []


def discover_cameras() -> int:
    """Scrape lynnwoodwa.gov, upsert cameras into DB. Returns count of new/updated cameras."""
    logger.info("Starting camera discovery")

    try:
        raw = _scrape_with_playwright()
    except Exception as e:
        logger.warning("Playwright scrape failed (%s), trying requests fallback", e)
        raw = _scrape_with_requests()

    if not raw:
        logger.warning("No cameras discovered")
        return 0

    seen_urls = []
    count = 0
    for cam in raw:
        url = cam["url"]
        address = cam["address"]
        lat, lon = cam.get("lat"), cam.get("lon")

        if lat is None or lon is None:
            coords = _geocode(address)
            if coords:
                lat, lon = coords
            else:
                # Default to Lynnwood city center if geocoding fails
                lat, lon = 47.8209, -122.3151

        database.upsert_camera(url, address, lat, lon, is_custom=0)
        seen_urls.append(url)
        count += 1

    database.deactivate_missing_cameras(seen_urls)
    logger.info("Discovery complete: %d cameras found", count)
    return count
