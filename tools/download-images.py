import base64
import json
import os
import re
import sys
import time
import urllib.parse

import requests

WRAPPER_BASE = "https://wrapper.yume.wiki"
GAME = "2kki"
PROBE_URL = "https://yume.wiki/images/0/02/3DStructures.png"
IMAGES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "images", "worlds"))
SECRETS_FILE = os.path.join(os.path.dirname(__file__), ".cf-secrets.json")
PROXY = "socks5://127.0.0.1:10808"
THUMB_WIDTH = 320
MAX_CONSECUTIVE_FAILS = 10


def sanitize_title(title):
    return re.sub(r"[\\/]", "", title)


def make_thumb_url(full_url, width):
    m = re.match(r"https://yume\.wiki/images/([a-f0-9]/[a-f0-9]{2}/(.*?\.\w+))$", full_url)
    if not m:
        return None, None
    path, filename = m.group(1), m.group(2)
    thumb = f"https://yume.wiki/images/thumb/{path}/{width}px-{urllib.parse.quote(filename)}"
    return thumb, filename


def main():
    secrets = json.load(open(SECRETS_FILE, encoding="utf-8"))
    ua = secrets["ua"]
    cookie = secrets["cf_clearance"]

    s = requests.Session()
    s.proxies = {"http": PROXY, "https": PROXY}
    s.headers.update(
        {
            "User-Agent": ua,
            "Cookie": f"cf_clearance={cookie}",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://yume.wiki/yume2kki/Urotsuki%27s_Room",
        }
    )

    probe = s.get(PROBE_URL, timeout=60)
    if probe.status_code != 200:
        print(f"PROBE FAILED: {probe.status_code} — cookie expired or IP/UA mismatch, refresh it in your browser")
        sys.exit(1)
    print(f"probe ok ({probe.status_code}, {len(probe.content)} bytes)")

    os.makedirs(IMAGES_DIR, exist_ok=True)

    locations = []
    continue_key = None
    while True:
        url = f"{WRAPPER_BASE}/locations?game={GAME}"
        if continue_key:
            url += f"&continueKey={urllib.parse.quote(continue_key)}"
        r = s.get(url, timeout=60)
        r.raise_for_status()
        data = r.json()
        locations.extend(data.get("locations") or [])
        print(f"  locations: {len(locations)}")
        continue_key = data.get("continueKey")
        if not continue_key:
            break
        time.sleep(0.3)

    jobs = []
    for loc in locations:
        full = loc.get("locationImage") or ""
        thumb, filename = make_thumb_url(full, THUMB_WIDTH)
        if not thumb:
            continue
        ext = "." + filename.rsplit(".", 1)[1]
        dest = os.path.join(IMAGES_DIR, sanitize_title(loc["title"]) + ext)
        jobs.append((dest, thumb, full))

    existing = sum(1 for j in jobs if os.path.exists(j[0]))
    todo = [j for j in jobs if not os.path.exists(j[0])]
    print(f"total: {len(jobs)} | already present: {existing} | to download: {len(todo)}")

    saved = 0
    failed = 0
    consecutive_fails = 0
    failures = []
    for i, (dest, thumb, full) in enumerate(todo):
        ok = False
        for url in (thumb, full):
            try:
                r = s.get(url, timeout=60)
                if r.status_code == 200 and r.content:
                    with open(dest, "wb") as f:
                        f.write(r.content)
                    ok = True
                    break
                if r.status_code in (403, 429):
                    print(f"BLOCKED ({r.status_code}) at {url} — cookie likely expired, refresh it in your browser")
                    sys.exit(1)
            except Exception as e:
                print("  error:", url, e)
        if ok:
            saved += 1
            consecutive_fails = 0
        else:
            failed += 1
            consecutive_fails += 1
            failures.append((dest, f"thumb={thumb} full={full}"))
            if consecutive_fails >= MAX_CONSECUTIVE_FAILS:
                print("too many consecutive failures, aborting")
                break
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(todo)} (saved {saved}, failed {failed})")

    print(f"done: saved {saved}, failed {failed}")
    for dest, urls in failures[:10]:
        print("  FAIL:", os.path.basename(dest), "-", urls)


if __name__ == "__main__":
    main()