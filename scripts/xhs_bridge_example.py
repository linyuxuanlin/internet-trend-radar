"""Bridge xiaohongshu-mcp results into Trend Radar.

The bridge accepts either an MCP JSON export (stdin/XHS_ITEMS_FILE) or can
query the local xiaohongshu-mcp HTTP service directly with XHS_MCP_URL.
Browser cookies and login state remain local to the MCP process.
"""
import os, json, sys, urllib.request, urllib.parse

TREND_RADAR_URL = os.environ["TREND_RADAR_URL"].rstrip("/")
INGEST_TOKEN = os.environ["INGEST_TOKEN"]

def fetch_from_xhs_mcp():
    mcp_url = os.environ.get("XHS_MCP_URL", "").rstrip("/")
    if mcp_url:
        keywords = [x.strip() for x in os.environ.get("XHS_KEYWORDS", "AI,科技,消费").split(",") if x.strip()]
        items = []
        seen = set()
        for keyword in keywords:
            url = mcp_url + "/api/v1/feeds/search?keyword=" + urllib.parse.quote(keyword)
            with urllib.request.urlopen(url, timeout=45) as response:
                result = json.loads(response.read().decode())
            for item in extract_items(result):
                item_id = str(item.get("id") or item.get("note_id") or item.get("noteCard", {}).get("noteId") or "")
                if item_id and item_id not in seen:
                    seen.add(item_id)
                    items.append(item)
        return items

    # The MCP client can pipe a JSON array or {"items": [...]} into this bridge.
    input_path = os.environ.get("XHS_ITEMS_FILE")
    if input_path:
        with open(input_path, encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = json.load(sys.stdin)
    if isinstance(payload, dict) and "items" in payload:
        return payload["items"]
    return extract_items(payload)

def extract_items(payload):
    """Extract feed/note arrays from the MCP REST response shape."""
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    data = payload.get("data", payload)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("feeds", "items", "notes", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return value
    return []

def nested_value(item, *path):
    value = item
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value

def number(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        return int(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None

def push(items):
    payload = []
    upstream = os.environ.get("XHS_MCP_URL", "xiaohongshu-mcp external bridge").rstrip("/")
    for rank, x in enumerate(items, 1):
        if not isinstance(x, dict):
            continue
        note = x.get("noteCard") or x.get("note_card") or {}
        user = note.get("user") or {}
        interact = note.get("interactInfo") or note.get("interact_info") or {}
        item_id = x.get("id") or x.get("note_id") or note.get("noteId") or x.get("url")
        title = x.get("title") or x.get("desc") or note.get("displayTitle") or note.get("title") or ""
        url = x.get("url") or note.get("url") or ("https://www.xiaohongshu.com/explore/" + str(item_id) if item_id else "")
        author = x.get("author") or user.get("nickname") or user.get("nickName") or ""
        likes = number(x.get("likes") or interact.get("likedCount") or interact.get("liked_count"))
        favorites = number(x.get("favorites") or interact.get("collectedCount") or interact.get("collected_count"))
        comments = number(x.get("comments") or interact.get("commentCount") or interact.get("comment_count"))
        if not title or not item_id:
            continue
        safe_raw = dict(x)
        # xsecToken is a note access token, not public evidence; do not persist it.
        safe_raw.pop("xsecToken", None)
        payload.append({
            "externalId": str(item_id),
            "title": title,
            "url": url,
            "author": author,
            "rank": rank,
            "heat": likes,
            "engagement": sum(value for value in (likes, favorites, comments) if value is not None) if any(value is not None for value in (likes, favorites, comments)) else None,
            "raw": {"trendRadarUpstream": upstream, "item": safe_raw},
        })
    req = urllib.request.Request(
        TREND_RADAR_URL + "/api/ingest/xiaohongshu",
        data=json.dumps({"items": payload}, ensure_ascii=False).encode(),
        headers={"content-type": "application/json", "user-agent": "trend-radar-xhs-bridge/1.0", "authorization": "Bearer " + INGEST_TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.read().decode())

if __name__ == "__main__":
    push(fetch_from_xhs_mcp())
