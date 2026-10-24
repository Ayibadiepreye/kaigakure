#!/usr/bin/env python3
"""
Pinterest anonymous-API bridge for Kaigakure.

Why Python: pinterest.com's edge blocks requests that do not carry a real
browser TLS fingerprint. `curl_cffi` impersonates Chrome's ClientHello, which
Node's fetch/undici cannot do. This script is the thin bridge that makes that
capability available to the Node API.

Reads a JSON job from stdin:
    {"action": "pin"|"board"|"search", "url": "...", "limit": 60}

Writes a JSON result to stdout:
    {"ok": true, "data": ...}  or  {"ok": false, "error": "..."}

Only public, anonymous Pinterest data is reachable here — the same thing a
signed-out visitor sees in a browser.
"""

import json
import sys
import urllib.parse

try:
    from curl_cffi import requests as cr
except ImportError:  # pragma: no cover
    print(json.dumps({"ok": False, "error": "curl_cffi is not installed (pip install curl_cffi)"}))
    sys.exit(0)


PIN_API = "https://www.pinterest.com/resource/PinResource/get/"
BOARD_API = "https://www.pinterest.com/resource/BoardFeedResource/get/"
BOARD_INFO_API = "https://www.pinterest.com/resource/BoardResource/get/"
SEARCH_API = "https://www.pinterest.com/resource/BaseSearchResource/get/"

UA_HEADERS = {"X-Pinterest-PWS-Handler": "www/[username].js"}
REFERER = {"Referer": "https://www.pinterest.com/"}


def call(endpoint, options):
    data = urllib.parse.quote(json.dumps({"options": options}))
    res = cr.get(
        f"{endpoint}?data={data}",
        headers=UA_HEADERS,
        impersonate="chrome",
        timeout=30,
    )
    try:
        payload = res.json()
    except Exception:
        return {"ok": False, "error": f"HTTP {res.status_code}: unparseable response"}

    rr = (payload or {}).get("resource_response") or {}
    if rr.get("error"):
        return {"ok": False, "error": rr["error"].get("message") or "Pinterest returned an error"}
    return {"ok": True, "data": rr.get("data")}


def read_pin(pin_id):
    return call(PIN_API, {"field_set_key": "unauth_react_main_pin", "id": pin_id})


def read_board(username, slug, limit):
    info = call(BOARD_INFO_API, {"slug": slug, "username": username})
    if not info["ok"]:
        return info
    board_id = (info.get("data") or {}).get("id") or slug

    pins = []
    bookmark = None
    for _ in range(5):
        options = {"board_id": board_id, "page_size": 50}
        if bookmark:
            options["bookmarks"] = [bookmark]
        feed = call(BOARD_API, options)
        if not feed["ok"]:
            return feed
        items = feed.get("data")
        if not isinstance(items, list):
            items = (items or {}).get("data") or []
        for item in items:
            if isinstance(item, dict) and item.get("type") == "pin" and item.get("id"):
                pins.append(item)
                if len(pins) >= limit:
                    break
        feed_raw = feed.get("data")
        bookmark = None
        if isinstance(feed_raw, dict):
            bookmark = (feed_raw.get("bookmark") or [None])[0]
        if not bookmark or not items:
            break
    return {"ok": True, "data": pins}


def read_search(query, limit):
    res = call(SEARCH_API, {"query": query, "scope": "pins", "page_size": 50})
    if not res["ok"]:
        return res
    data = res.get("data")
    items = data if isinstance(data, list) else (data or {}).get("data") or (data or {}).get("results") or []
    pins = [i for i in items if isinstance(i, dict) and i.get("id")]
    return {"ok": True, "data": pins[:limit]}


def main():
    try:
        job = json.load(sys.stdin)
    except Exception:
        print(json.dumps({"ok": False, "error": "invalid JSON on stdin"}))
        return

    action = job.get("action")
    url = job.get("url") or ""
    limit = int(job.get("limit") or 60)

    try:
        if action == "pin":
            m = urllib.parse.urlparse(url).path.split("/")
            pin_id = next((p for p in m if p.isdigit() and len(p) >= 8), None)
            if not pin_id:
                print(json.dumps({"ok": False, "error": "no pin id in url"}))
                return
            print(json.dumps(read_pin(pin_id)))

        elif action == "board":
            parts = [p for p in urllib.parse.urlparse(url).path.split("/") if p]
            if len(parts) < 2:
                print(json.dumps({"ok": False, "error": "no board in url"}))
                return
            username, slug = parts[0], parts[1]
            print(json.dumps(read_board(username, slug, limit)))

        elif action == "search":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("q", [""])[0]
            if not q:
                print(json.dumps({"ok": False, "error": "no search query"}))
                return
            print(json.dumps(read_search(q, limit)))

        else:
            print(json.dumps({"ok": False, "error": f"unknown action: {action}"}))

    except Exception as exc:  # pragma: no cover
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))


if __name__ == "__main__":
    main()
