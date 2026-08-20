"""Example bridge for xiaohongshu-mcp -> Trend Radar.
Replace `fetch_from_xhs_mcp()` with your MCP client call. Keep the Trend Radar payload stable.
"""
import os, json, urllib.request

TREND_RADAR_URL = os.environ["TREND_RADAR_URL"].rstrip("/")
INGEST_TOKEN = os.environ["INGEST_TOKEN"]

def fetch_from_xhs_mcp():
    # Integrate xpzouying/xiaohongshu-mcp here. Typical fields available from search/feed/detail:
    # title, note id/xsec token, likes, favorites, comments, author, URL.
    raise NotImplementedError("Connect your authenticated xiaohongshu-mcp client here")

def push(items):
    payload = []
    for rank, x in enumerate(items, 1):
        payload.append({
            "externalId": str(x.get("id") or x.get("note_id") or x.get("url")),
            "title": x.get("title") or x.get("desc") or "",
            "url": x.get("url") or "",
            "author": x.get("author") or "",
            "rank": rank,
            "heat": x.get("likes") or 0,
            "engagement": (x.get("likes") or 0) + (x.get("favorites") or 0) + (x.get("comments") or 0),
            "raw": x,
        })
    req = urllib.request.Request(
        TREND_RADAR_URL + "/api/ingest/xiaohongshu",
        data=json.dumps({"items": payload}, ensure_ascii=False).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer " + INGEST_TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.read().decode())

if __name__ == "__main__":
    push(fetch_from_xhs_mcp())
