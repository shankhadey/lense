"""
Lense backend — FastAPI

Endpoints:
  POST /license/validate    — verify LemonSqueezy license key
  POST /upload/request      — get R2 presigned PUT URL (Pro only)
  POST /share               — store zoom+AI metadata, return share URL
  GET  /v/{video_id}        — viewer HTML page
  GET  /v/{video_id}/meta   — video URL + zoom JSON
  POST /ai/analyze          — Claude Haiku analysis (Pro only, opt-in)
  GET  /health              — health check
"""

import hashlib
import json
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path

import boto3
import httpx
from anthropic import Anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────
LS_API_KEY       = os.getenv("LEMONSQUEEZY_API_KEY", "")
CF_ACCOUNT_ID    = os.getenv("CF_ACCOUNT_ID", "")
CF_R2_ACCESS_KEY = os.getenv("CF_R2_ACCESS_KEY_ID", "")
CF_R2_SECRET_KEY = os.getenv("CF_R2_SECRET_ACCESS_KEY", "")
CF_R2_BUCKET     = os.getenv("CF_R2_BUCKET_NAME", "lense-recordings")
CF_R2_PUBLIC_URL = os.getenv("CF_R2_PUBLIC_URL", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

DB_PATH = Path(__file__).parent / "lense.db"
MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB

# ── Database ──────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS license_cache (
                key_hash   TEXT PRIMARY KEY,
                plan       TEXT NOT NULL,
                validated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS videos (
                video_id    TEXT PRIMARY KEY,
                key_hash    TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                size_bytes  INTEGER NOT NULL
            );
        """)


# ── R2 client (S3-compatible) ─────────────────────────────────────────────────
def get_r2():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{CF_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=CF_R2_ACCESS_KEY,
        aws_secret_access_key=CF_R2_SECRET_KEY,
        region_name="auto",
    )


# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Lense API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ── Helpers ───────────────────────────────────────────────────────────────────
def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


async def validate_license_key(key: str) -> dict:
    """Validate via LemonSqueezy, with 24h SQLite cache."""
    key_hash = hash_key(key)
    now = int(time.time())

    # Check cache first
    with get_db() as conn:
        row = conn.execute(
            "SELECT plan, validated_at FROM license_cache WHERE key_hash = ?",
            (key_hash,)
        ).fetchone()
        if row and (now - row["validated_at"]) < 86400:
            return {"valid": True, "plan": row["plan"]}

    # Call LemonSqueezy
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.post(
                "https://api.lemonsqueezy.com/v1/licenses/validate",
                headers={"Authorization": f"Bearer {LS_API_KEY}"},
                json={"license_key": key},
            )
        except httpx.RequestError:
            # If we have a stale cache entry (within 7 days), honor it
            if row and (now - row["validated_at"]) < 7 * 86400:
                return {"valid": True, "plan": row["plan"]}
            raise HTTPException(503, "License service unavailable")

    if resp.status_code != 200:
        return {"valid": False, "plan": None}

    data = resp.json()
    if not data.get("valid"):
        return {"valid": False, "plan": None}

    meta = data.get("meta", {})
    plan = "lifetime" if "lifetime" in str(meta.get("variant_name", "")).lower() else "monthly"

    # Cache it
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO license_cache (key_hash, plan, validated_at) VALUES (?, ?, ?)",
            (key_hash, plan, now)
        )

    return {"valid": True, "plan": plan}


async def require_pro(x_license_key: str | None) -> str:
    """Dependency: validate license header, raise 401/403 if invalid."""
    if not x_license_key:
        raise HTTPException(401, "X-License-Key header required")
    result = await validate_license_key(x_license_key)
    if not result["valid"]:
        raise HTTPException(403, "Invalid or expired license key")
    return x_license_key


# ── Request / response models ─────────────────────────────────────────────────
class ValidateLicenseRequest(BaseModel):
    key: str


class UploadRequestBody(BaseModel):
    filename: str
    size_bytes: int


class ShareBody(BaseModel):
    video_id: str
    zoom_events: list
    duration_ms: int
    ai_results: dict | None = None


class AnalyzeBody(BaseModel):
    transcript: str
    duration_ms: int
    zoom_events: list


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/license/validate")
async def license_validate(body: ValidateLicenseRequest):
    result = await validate_license_key(body.key)
    return result


@app.post("/upload/request")
async def upload_request(
    body: UploadRequestBody,
    x_license_key: str | None = Header(default=None),
):
    await require_pro(x_license_key)

    if body.size_bytes > MAX_FILE_BYTES:
        raise HTTPException(413, "Recording exceeds 2 GB limit")

    video_id = secrets.token_urlsafe(10)
    object_key = f"recordings/{video_id}/{body.filename}"

    r2 = get_r2()
    upload_url = r2.generate_presigned_url(
        "put_object",
        Params={"Bucket": CF_R2_BUCKET, "Key": object_key, "ContentType": "video/webm"},
        ExpiresIn=1800,  # 30 min
    )
    public_url = f"{CF_R2_PUBLIC_URL}/{object_key}"

    with get_db() as conn:
        conn.execute(
            "INSERT INTO videos (video_id, key_hash, created_at, size_bytes) VALUES (?, ?, ?, ?)",
            (video_id, hash_key(x_license_key), int(time.time()), body.size_bytes)
        )

    return {"upload_url": upload_url, "video_id": video_id, "public_url": public_url}


@app.post("/share")
async def share(body: ShareBody):
    # Verify the video_id exists
    with get_db() as conn:
        row = conn.execute(
            "SELECT video_id FROM videos WHERE video_id = ?", (body.video_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Video not found")

    sidecar = {
        "video_url": f"{CF_R2_PUBLIC_URL}/recordings/{body.video_id}/",
        "zoom_events": body.zoom_events,
        "duration_ms": body.duration_ms,
        "ai_results": body.ai_results,
    }

    r2 = get_r2()
    r2.put_object(
        Bucket=CF_R2_BUCKET,
        Key=f"recordings/{body.video_id}/meta.json",
        Body=json.dumps(sidecar),
        ContentType="application/json",
    )

    return {"share_url": f"/v/{body.video_id}"}


@app.get("/v/{video_id}", response_class=HTMLResponse)
async def viewer(video_id: str):
    # Validate video_id format (alphanumeric + URL-safe chars only)
    if not all(c.isalnum() or c in "-_" for c in video_id):
        raise HTTPException(400, "Invalid video ID")
    return HTMLResponse(content=build_viewer_html(video_id))


@app.get("/v/{video_id}/meta")
async def viewer_meta(video_id: str):
    if not all(c.isalnum() or c in "-_" for c in video_id):
        raise HTTPException(400, "Invalid video ID")
    r2 = get_r2()
    try:
        obj = r2.get_object(Bucket=CF_R2_BUCKET, Key=f"recordings/{video_id}/meta.json")
        meta = json.loads(obj["Body"].read())
    except r2.exceptions.NoSuchKey:
        raise HTTPException(404, "Recording not found")
    except Exception:
        raise HTTPException(503, "Storage unavailable")
    return JSONResponse(meta)


@app.post("/ai/analyze")
async def ai_analyze(
    body: AnalyzeBody,
    x_license_key: str | None = Header(default=None),
):
    await require_pro(x_license_key)

    if not ANTHROPIC_API_KEY:
        raise HTTPException(503, "AI service not configured")

    zoom_summary = "\n".join(
        f"  - {ev.get('type','?')} at {ev.get('t',0)/1000:.1f}s"
        for ev in body.zoom_events[:50]
    )

    # Truncate transcript to stay within context limits (~40k chars ≈ ~10k tokens)
    transcript = body.transcript[:40000]
    truncated = len(body.transcript) > 40000

    prompt = f"""You are analyzing a screen recording transcript. Extract structured information.

Zoom events (moments the presenter zoomed into the screen):
{zoom_summary or "  (none)"}

Recording duration: {body.duration_ms / 1000:.1f}s

Transcript:
{transcript}
{"[transcript truncated to fit context limit]" if truncated else ""}

Respond with valid JSON only, no markdown, no explanation. Use this exact shape:
{{
  "summary": "2-3 sentence overview of what this recording covers",
  "chapters": [
    {{"title": "string", "start_ms": 0, "end_ms": 0}}
  ],
  "action_items": ["string"]
}}

Use zoom events as natural chapter boundaries where appropriate. If there are no clear chapters, return a single chapter covering the whole recording."""

    client = Anthropic(api_key=ANTHROPIC_API_KEY)
    try:
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()
        # Strip any accidental markdown fences
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        result = json.loads(raw)
    except json.JSONDecodeError:
        # Retry once with stricter instruction
        try:
            message = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1024,
                messages=[
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": "{"},
                ],
            )
            result = json.loads("{" + message.content[0].text)
        except Exception:
            raise HTTPException(500, "AI service returned invalid response")
    except Exception:
        raise HTTPException(500, "AI service temporarily unavailable")

    return result


# ── Viewer HTML template ──────────────────────────────────────────────────────
def build_viewer_html(video_id: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Lense — Shared Recording</title>
  <style>
    :root {{
      --bg: #09090b; --bg2: #111113; --bg3: #1a1a1e;
      --border: rgba(255,255,255,0.08);
      --text: #f4f4f5; --text2: #a1a1aa; --text3: #71717a;
      --accent: #f97316; --accent2: #fb923c;
      --accent-bg: rgba(249,115,22,0.12);
      --radius: 14px; --radius-sm: 8px;
    }}
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ background: var(--bg); color: var(--text); font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; }}
    .hidden {{ display: none !important; }}

    /* Nav */
    .nav {{ display: flex; align-items: center; gap: 12px; padding: 16px 32px; border-bottom: 1px solid var(--border); }}
    .logo-mark {{ width: 22px; height: 22px; border-radius: 50%; background: conic-gradient(from 180deg, var(--accent) 0deg, transparent 120deg, var(--accent) 360deg); position: relative; flex-shrink: 0; }}
    .logo-mark::after {{ content: ''; position: absolute; inset: 4px; border-radius: 50%; background: var(--bg); }}
    .brand {{ font-family: Georgia, serif; font-style: italic; font-size: 18px; letter-spacing: -0.02em; }}

    /* Layout */
    .main {{ max-width: 960px; margin: 0 auto; padding: 32px 24px; display: flex; flex-direction: column; gap: 24px; }}

    /* Video */
    .video-wrap {{ border-radius: var(--radius); overflow: hidden; background: #000; border: 1px solid var(--border); }}
    video {{ width: 100%; display: block; max-height: 520px; }}

    /* Timeline */
    .tl-section {{ display: flex; flex-direction: column; gap: 8px; }}
    .section-label {{ font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text3); font-weight: 600; }}
    .tl-wrap {{ position: relative; height: 36px; border-radius: var(--radius-sm); background: var(--bg3); border: 1px solid var(--border); overflow: hidden; cursor: pointer; }}
    .tl-track {{ position: absolute; inset: 0; }}
    .tl-band {{ position: absolute; top: 0; bottom: 0; background: var(--accent-bg); border-left: 2px solid var(--accent); border-right: 2px solid var(--accent); }}
    .tl-marker {{ position: absolute; top: 50%; transform: translateY(-50%); width: 10px; height: 10px; border-radius: 50%; margin-left: -5px; }}
    .tl-marker.in {{ background: var(--accent); }}
    .tl-marker.out {{ background: var(--text3); }}
    .tl-playhead {{ position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; opacity: 0.8; pointer-events: none; }}

    /* Two-column layout */
    .content-grid {{ display: grid; grid-template-columns: 1fr 320px; gap: 24px; }}
    @media (max-width: 700px) {{ .content-grid {{ grid-template-columns: 1fr; }} }}

    /* Zoom list */
    .panel {{ background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; display: flex; flex-direction: column; gap: 16px; }}
    .zoom-item {{ display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg3); border: 1px solid var(--border); }}
    .zoom-num {{ width: 24px; height: 24px; border-radius: 50%; background: var(--accent-bg); color: var(--accent); font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }}
    .zoom-time {{ font-size: 13px; color: var(--text2); font-variant-numeric: tabular-nums; }}
    .seek-btn {{ margin-left: auto; padding: 4px 10px; border-radius: 6px; background: var(--accent-bg); color: var(--accent); font-size: 12px; border: none; cursor: pointer; }}
    .seek-btn:hover {{ background: var(--accent); color: #fff; }}
    .empty {{ color: var(--text3); font-size: 13px; }}

    /* AI results */
    .ai-section {{ display: flex; flex-direction: column; gap: 12px; }}
    .ai-summary {{ font-size: 14px; color: var(--text2); line-height: 1.7; padding: 14px; border-radius: var(--radius-sm); background: var(--bg3); border: 1px solid var(--border); }}
    .chapter-item {{ display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--border); }}
    .chapter-item:last-child {{ border-bottom: none; }}
    .chapter-time {{ font-size: 12px; color: var(--accent); font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; cursor: pointer; }}
    .chapter-time:hover {{ color: var(--accent2); }}
    .chapter-title {{ font-size: 14px; color: var(--text); }}
    .action-item {{ display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: var(--text2); padding: 4px 0; }}
    .action-item::before {{ content: '→'; color: var(--accent); flex-shrink: 0; }}

    /* Loading */
    .loading {{ display: flex; align-items: center; gap: 10px; color: var(--text3); font-size: 13px; padding: 40px 0; justify-content: center; }}
    .spinner {{ width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }}
    @keyframes spin {{ to {{ transform: rotate(360deg); }} }}

    /* Error */
    .error {{ color: var(--text3); font-size: 14px; text-align: center; padding: 60px 20px; }}
  </style>
</head>
<body>
  <nav class="nav">
    <div class="logo-mark"></div>
    <span class="brand">Lense</span>
  </nav>

  <div class="main" id="main">
    <div class="loading"><div class="spinner"></div> Loading recording…</div>
  </div>

  <script>
    const VIDEO_ID = {json.dumps(video_id)};

    function fmt(ms) {{
      const s = Math.floor(ms / 1000);
      return String(Math.floor(s / 60)).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0');
    }}

    function buildTimeline(zoomEvents, durationMs, videoEl) {{
      const wrap = document.createElement('div');
      wrap.className = 'tl-wrap';
      const track = document.createElement('div');
      track.className = 'tl-track';
      wrap.appendChild(track);

      // Bands
      let zStart = null;
      zoomEvents.forEach(ev => {{
        if (ev.type === 'in') {{ zStart = ev.t; }}
        if (ev.type === 'out' && zStart !== null) {{
          const band = document.createElement('div');
          band.className = 'tl-band';
          band.style.left  = (zStart / durationMs * 100) + '%';
          band.style.width = ((ev.t - zStart) / durationMs * 100) + '%';
          track.appendChild(band);
          zStart = null;
        }}
      }});
      if (zStart !== null) {{
        const band = document.createElement('div');
        band.className = 'tl-band';
        band.style.left  = (zStart / durationMs * 100) + '%';
        band.style.width = ((durationMs - zStart) / durationMs * 100) + '%';
        track.appendChild(band);
      }}

      // Markers
      zoomEvents.forEach(ev => {{
        const m = document.createElement('div');
        m.className = 'tl-marker ' + (ev.type === 'in' ? 'in' : 'out');
        m.style.left = (ev.t / durationMs * 100) + '%';
        m.title = (ev.type === 'in' ? 'Zoom in' : 'Zoom out') + ' — ' + fmt(ev.t);
        track.appendChild(m);
      }});

      // Playhead
      const ph = document.createElement('div');
      ph.className = 'tl-playhead';
      ph.id = 'tl-ph';
      track.appendChild(ph);

      // Seek on click
      wrap.addEventListener('click', e => {{
        const r = wrap.getBoundingClientRect();
        videoEl.currentTime = ((e.clientX - r.left) / r.width) * (videoEl.duration || 0);
      }});

      videoEl.addEventListener('timeupdate', () => {{
        if (durationMs) ph.style.left = (videoEl.currentTime / (durationMs / 1000) * 100) + '%';
      }});

      return wrap;
    }}

    function buildZoomList(zoomEvents, videoEl) {{
      const panel = document.createElement('div');
      panel.className = 'panel';
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = 'Zoom Moments';
      panel.appendChild(label);

      const ins = zoomEvents.filter(e => e.type === 'in');
      if (!ins.length) {{
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No zooms recorded';
        panel.appendChild(empty);
        return panel;
      }}
      ins.forEach((ev, i) => {{
        const item = document.createElement('div');
        item.className = 'zoom-item';
        const num = document.createElement('div');
        num.className = 'zoom-num';
        num.textContent = i + 1;
        const time = document.createElement('div');
        time.className = 'zoom-time';
        time.textContent = fmt(ev.t);
        const btn = document.createElement('button');
        btn.className = 'seek-btn';
        btn.textContent = '▶ Jump';
        btn.addEventListener('click', () => {{
          videoEl.currentTime = ev.t / 1000;
          videoEl.play();
        }});
        item.append(num, time, btn);
        panel.appendChild(item);
      }});
      return panel;
    }}

    function buildAiSection(aiResults, videoEl) {{
      if (!aiResults) return null;
      const section = document.createElement('div');
      section.className = 'ai-section';

      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = 'AI Analysis';
      section.appendChild(label);

      if (aiResults.summary) {{
        const s = document.createElement('div');
        s.className = 'ai-summary';
        s.textContent = aiResults.summary;
        section.appendChild(s);
      }}

      if (aiResults.chapters && aiResults.chapters.length) {{
        const cl = document.createElement('div');
        cl.className = 'section-label';
        cl.textContent = 'Chapters';
        cl.style.marginTop = '8px';
        section.appendChild(cl);
        const chaps = document.createElement('div');
        aiResults.chapters.forEach(ch => {{
          const item = document.createElement('div');
          item.className = 'chapter-item';
          const t = document.createElement('div');
          t.className = 'chapter-time';
          t.textContent = fmt(ch.start_ms);
          t.title = 'Jump to chapter';
          t.addEventListener('click', () => {{
            videoEl.currentTime = ch.start_ms / 1000;
            videoEl.play();
          }});
          const title = document.createElement('div');
          title.className = 'chapter-title';
          title.textContent = ch.title;
          item.append(t, title);
          chaps.appendChild(item);
        }});
        section.appendChild(chaps);
      }}

      if (aiResults.action_items && aiResults.action_items.length) {{
        const al = document.createElement('div');
        al.className = 'section-label';
        al.textContent = 'Action Items';
        al.style.marginTop = '8px';
        section.appendChild(al);
        aiResults.action_items.forEach(a => {{
          const item = document.createElement('div');
          item.className = 'action-item';
          item.textContent = a;
          section.appendChild(item);
        }});
      }}

      return section;
    }}

    async function init() {{
      const main = document.getElementById('main');
      let meta;
      try {{
        const r = await fetch('/v/' + VIDEO_ID + '/meta');
        if (!r.ok) throw new Error('not found');
        meta = await r.json();
      }} catch(e) {{
        main.innerHTML = '<div class="error">Recording not found or has been deleted.</div>';
        return;
      }}

      main.innerHTML = '';

      // Video
      const videoWrap = document.createElement('div');
      videoWrap.className = 'video-wrap';
      const video = document.createElement('video');
      video.src = meta.video_url;
      video.controls = true;
      video.playsInline = true;
      videoWrap.appendChild(video);
      main.appendChild(videoWrap);

      // Timeline
      const tlSection = document.createElement('div');
      tlSection.className = 'tl-section';
      const tlLabel = document.createElement('div');
      tlLabel.className = 'section-label';
      tlLabel.textContent = 'Timeline';
      tlSection.appendChild(tlLabel);
      tlSection.appendChild(buildTimeline(meta.zoom_events || [], meta.duration_ms || 0, video));
      main.appendChild(tlSection);

      // Grid: AI section + zoom list
      const grid = document.createElement('div');
      grid.className = 'content-grid';

      const leftCol = document.createElement('div');
      const aiSection = buildAiSection(meta.ai_results, video);
      if (aiSection) leftCol.appendChild(aiSection);
      else {{
        const empty = document.createElement('div');
        empty.style.color = 'var(--text3)';
        empty.style.fontSize = '13px';
        leftCol.appendChild(empty);
      }}

      grid.appendChild(leftCol);
      grid.appendChild(buildZoomList(meta.zoom_events || [], video));
      main.appendChild(grid);
    }}

    init();
  </script>
</body>
</html>"""
