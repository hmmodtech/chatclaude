# ============================================================
# app.py  —  Gaza Security Dashboard  —  PHASE 3
# ------------------------------------------------------------
# New in Phase 3:
#   • SQLite database (incidents + alert_logs tables persist)
#   • Haversine proximity query (replaces PostGIS — works free)
#   • /api/incidents  POST/GET  — save & list incidents
#   • /api/incidents/:id/analyze — proximity check
#   • /api/alert/send  — unified alert dispatcher
#   • /api/alert/logs  — full alert history
#   • Socket.IO        — real-time map sync across users
# ============================================================

import os, io, json, math, zipfile as zf, re, uuid, datetime, sqlite3, asyncio
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import socketio
from lxml import etree
from shapely.geometry import Point, Polygon as ShapelyPolygon

# ── Socket.IO async server ────────────────────────────────────────────────────
# This handles real-time events (danger zones appearing for all users)
sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins='*',
    logger=False,
    engineio_logger=False
)

# ── FastAPI app ───────────────────────────────────────────────────────────────
_fastapi_app = FastAPI(title="Gaza Security Dashboard API", version="3.0.0")

_fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Wrap FastAPI with Socket.IO so both run on the same port
app = socketio.ASGIApp(sio, other_asgi_app=_fastapi_app)

# ── SQLite database setup ─────────────────────────────────────────────────────
# Database file lives next to app.py
# On Render free tier this resets on redeploy — acceptable for MVP
DB_PATH = os.path.join(os.path.dirname(__file__), "dashboard.db")

def get_db():
    """Open a SQLite connection. Call this inside every route that needs DB."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row   # lets us access columns by name
    conn.execute("PRAGMA journal_mode=WAL")  # safer concurrent writes
    return conn

def init_db():
    """Create tables if they don't exist yet. Called once at startup."""
    conn = get_db()
    conn.executescript("""
        -- Stores every incident that was reported
        CREATE TABLE IF NOT EXISTS incidents (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL,
            lat         REAL NOT NULL,
            lon         REAL NOT NULL,
            radius_m    REAL NOT NULL DEFAULT 500,
            description TEXT DEFAULT '',
            created_at  TEXT NOT NULL
        );

        -- Stores every alert that was sent (one row per person per channel)
        CREATE TABLE IF NOT EXISTS alert_logs (
            id           TEXT PRIMARY KEY,
            incident_id  TEXT NOT NULL,
            staff_name   TEXT NOT NULL,
            channel      TEXT NOT NULL,
            contact      TEXT DEFAULT '',
            message      TEXT DEFAULT '',
            status       TEXT NOT NULL DEFAULT 'sent',
            distance_m   REAL DEFAULT 0,
            layer_name   TEXT DEFAULT '',
            created_at   TEXT NOT NULL,
            FOREIGN KEY (incident_id) REFERENCES incidents(id)
        );
    """)
    conn.commit()
    conn.close()

# Run DB setup immediately when the module loads
init_db()

# ── In-memory layer cache (layers uploaded this session) ─────────────────────
# Layers are not persisted to SQLite (that would require full PostGIS geometry)
# Instead they are held in memory and re-uploaded each browser session
session_layers = []   # list of parsed layer dicts from KML/KMZ uploads

# ─────────────────────────────────────────────────────────────────────────────
# HELPER FUNCTIONS
# ─────────────────────────────────────────────────────────────────────────────

KML_NS = "http://www.opengis.net/kml/2.2"

def ns(tag):
    return f"{{{KML_NS}}}{tag}"

def haversine(lat1, lon1, lat2, lon2):
    """Geodesic distance in metres between two GPS points."""
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a  = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def point_in_polygon(lat, lon, coords):
    """Returns True if point is inside polygon. Uses Shapely."""
    try:
        pt   = Point(lon, lat)
        poly = ShapelyPolygon([(c[1], c[0]) for c in coords])
        return poly.contains(pt)
    except Exception:
        return False

def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"

def parse_kml_bytes(kml_bytes: bytes, filename: str = "layer") -> dict:
    """Parse raw KML bytes → layer dict with features list."""
    try:
        root = etree.fromstring(kml_bytes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid KML: {e}")

    placemarks = root.findall(f".//{ns('Placemark')}")
    features   = []

    for pm in placemarks:
        name = ""
        n_el = pm.find(ns("name"))
        if n_el is not None and n_el.text:
            name = n_el.text.strip()

        desc = ""
        d_el = pm.find(ns("description"))
        if d_el is not None and d_el.text:
            desc = d_el.text.strip()

        extended = {}
        ext_el = pm.find(f".//{ns('ExtendedData')}")
        if ext_el is not None:
            for data in ext_el.findall(ns("Data")):
                key = data.get("name", "")
                v_el = data.find(ns("value"))
                if key and v_el is not None and v_el.text:
                    extended[key] = v_el.text.strip()
            for sd_p in ext_el.findall(f".//{ns('SchemaData')}"):
                for sd in sd_p.findall(ns("SimpleData")):
                    key = sd.get("name", "")
                    if key and sd.text:
                        extended[key] = sd.text.strip()

        color = "#3B82F6"

        pt_el = pm.find(f".//{ns('Point')}")
        if pt_el is not None:
            co = pt_el.find(ns("coordinates"))
            if co is not None and co.text:
                parts = co.text.strip().split(",")
                if len(parts) >= 2:
                    try:
                        lon_v, lat_v = float(parts[0]), float(parts[1])
                        features.append({
                            "type": "point", "name": name, "description": desc,
                            "lat": lat_v, "lon": lon_v, "color": color,
                            "extended": extended
                        })
                    except ValueError:
                        pass
            continue

        poly_el = pm.find(f".//{ns('Polygon')}")
        if poly_el is not None:
            ob = poly_el.find(f".//{ns('outerBoundaryIs')}") or poly_el.find(f".//{ns('LinearRing')}")
            if ob is not None:
                co = ob.find(f".//{ns('coordinates')}")
                if co is not None and co.text:
                    ring = []
                    for tok in co.text.strip().split():
                        p = tok.split(",")
                        if len(p) >= 2:
                            try:
                                ring.append([float(p[1]), float(p[0])])
                            except ValueError:
                                pass
                    if ring:
                        features.append({
                            "type": "polygon", "name": name, "description": desc,
                            "coords": ring, "fill_color": "#3B82F6",
                            "fill_opacity": 0.35, "stroke_color": "#3B82F6",
                            "extended": extended
                        })
            continue

        line_el = pm.find(f".//{ns('LineString')}")
        if line_el is not None:
            co = line_el.find(ns("coordinates"))
            if co is not None and co.text:
                pts = []
                for tok in co.text.strip().split():
                    p = tok.split(",")
                    if len(p) >= 2:
                        try:
                            pts.append([float(p[1]), float(p[0])])
                        except ValueError:
                            pass
                if pts:
                    features.append({
                        "type": "line", "name": name, "description": desc,
                        "coords": pts, "stroke_color": "#3B82F6",
                        "extended": extended
                    })

    layer_name = filename.replace(".kml","").replace(".kmz","").replace("_"," ").title()
    return {
        "id":       str(uuid.uuid4()),
        "name":     layer_name,
        "visible":  True,
        "opacity":  1.0,
        "color":    "#3B82F6",
        "features": features
    }

def build_kml(layers: list, incidents: list) -> bytes:
    """Build KML bytes from layers + incidents. Google Maps / Maps.me compatible."""
    KML_DECL = b'<?xml version="1.0" encoding="UTF-8"?>\n'
    NSMAP = {None: "http://www.opengis.net/kml/2.2", "gx": "http://www.google.com/kml/ext/2.2"}
    root = etree.Element("kml", nsmap=NSMAP)
    doc  = etree.SubElement(root, "Document")
    etree.SubElement(doc, "name").text = "Gaza Security Dashboard Export"
    etree.SubElement(doc, "description").text = f"Exported {now_iso()}"

    def add_ext(parent, data):
        if not data: return
        ext = etree.SubElement(parent, "ExtendedData")
        for k, v in data.items():
            d = etree.SubElement(ext, "Data", name=str(k))
            etree.SubElement(d, "value").text = str(v)

    for layer in layers:
        folder = etree.SubElement(doc, "Folder")
        etree.SubElement(folder, "name").text = layer.get("name","Layer")
        for feat in layer.get("features", []):
            pm = etree.SubElement(folder, "Placemark")
            etree.SubElement(pm, "name").text        = feat.get("name","")
            etree.SubElement(pm, "description").text = feat.get("description","")
            add_ext(pm, feat.get("extended",{}))
            ft = feat.get("type")
            if ft == "point":
                pt = etree.SubElement(pm, "Point")
                etree.SubElement(pt, "coordinates").text = f"{feat['lon']},{feat['lat']},0"
            elif ft == "polygon":
                pg = etree.SubElement(pm, "Polygon")
                oi = etree.SubElement(pg, "outerBoundaryIs")
                lr = etree.SubElement(oi, "LinearRing")
                etree.SubElement(lr, "coordinates").text = " ".join(
                    f"{c[1]},{c[0]},0" for c in feat.get("coords",[]))
            elif ft == "line":
                ls = etree.SubElement(pm, "LineString")
                etree.SubElement(ls, "coordinates").text = " ".join(
                    f"{c[1]},{c[0]},0" for c in feat.get("coords",[]))

    if incidents:
        ifolder = etree.SubElement(doc, "Folder")
        etree.SubElement(ifolder, "name").text = "Incidents"
        for inc in incidents:
            pm = etree.SubElement(ifolder, "Placemark")
            etree.SubElement(pm, "name").text = inc.get("name","Incident")
            add_ext(pm, {"type": inc.get("type",""), "radius_m": inc.get("radius_m",0)})
            pt = etree.SubElement(pm, "Point")
            etree.SubElement(pt, "coordinates").text = f"{inc['lon']},{inc['lat']},0"

    return KML_DECL + etree.tostring(root, pretty_print=True, encoding="unicode").encode("utf-8")

def build_alert_message(incident: dict, staff_name: str, distance_m: float) -> str:
    """Build the standard emergency alert message."""
    dist_str = f"{distance_m/1000:.1f}km" if distance_m >= 1000 else f"{int(distance_m)}m"
    return (
        f"⚠️ SAFETY ALERT\n"
        f"Incident: {incident['type'].replace('_',' ').title()} — {incident['name']}\n"
        f"Distance from your location: {dist_str}\n"
        f"Please follow evacuation procedures immediately.\n"
        f"Stay safe. — Security Dashboard"
    )

# ─────────────────────────────────────────────────────────────────────────────
# SOCKET.IO  EVENTS
# ─────────────────────────────────────────────────────────────────────────────

@sio.event
async def connect(sid, environ):
    """Called when a browser connects via Socket.IO."""
    print(f"[Socket] Client connected: {sid}")

@sio.event
async def disconnect(sid):
    print(f"[Socket] Client disconnected: {sid}")

@sio.event
async def join_map(sid, data):
    """
    Browser calls this to join a 'map room'.
    All clients in the same room get incident broadcasts.
    data = { "map_id": "some-map-id" }
    """
    map_id = data.get("map_id", "default")
    await sio.enter_room(sid, f"map_{map_id}")
    await sio.emit("joined", {"map_id": map_id}, to=sid)

# ─────────────────────────────────────────────────────────────────────────────
# REST API ROUTES  (registered on _fastapi_app)
# ─────────────────────────────────────────────────────────────────────────────

@_fastapi_app.get("/")
def root():
    return {"status": "ok", "service": "Gaza Security Dashboard API v3"}

# ── KML / KMZ Upload ─────────────────────────────────────────────────────────
@_fastapi_app.post("/api/upload-layer")
async def upload_layer(file: UploadFile = File(...)):
    filename = file.filename or "layer.kml"
    raw      = await file.read()

    if filename.lower().endswith(".kmz"):
        try:
            with zf.ZipFile(io.BytesIO(raw)) as z:
                kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
                if not kml_name:
                    raise HTTPException(400, "No KML found inside KMZ")
                kml_bytes = z.read(kml_name)
        except zf.BadZipFile:
            raise HTTPException(400, "Invalid KMZ file")
    elif filename.lower().endswith(".kml"):
        kml_bytes = raw
    else:
        raise HTTPException(400, "Only .kml and .kmz files are supported")

    layer = parse_kml_bytes(kml_bytes, filename)
    session_layers.append(layer)
    return layer

# ── Proximity check (used by frontend JS layers, no DB needed) ────────────────
@_fastapi_app.post("/api/proximity")
async def check_proximity(payload: dict = Body(...)):
    """
    Quick proximity check against layers sent from the browser.
    Used by the old Phase 2 incident form.
    """
    incident = payload.get("incident", {})
    layers   = payload.get("layers", [])
    inc_lat  = float(incident.get("lat", 0))
    inc_lon  = float(incident.get("lon", 0))
    radius   = float(incident.get("radius_m", 500))

    all_polygons = [
        {"name": f.get("name","Zone"), "coords": f.get("coords",[])}
        for layer in layers
        for f in layer.get("features",[])
        if f.get("type") == "polygon"
    ]

    endangered = []
    for layer in layers:
        for feat in layer.get("features", []):
            if feat.get("type") != "point":
                continue
            s_lat = float(feat.get("lat", 0))
            s_lon = float(feat.get("lon", 0))
            dist  = haversine(inc_lat, inc_lon, s_lat, s_lon)

            in_circle = dist <= radius
            in_poly   = False
            zone_name = ""
            for poly in all_polygons:
                if point_in_polygon(s_lat, s_lon, poly["coords"]):
                    in_poly   = True
                    zone_name = poly["name"]
                    break

            if in_circle or in_poly:
                endangered.append({
                    "name":           feat.get("name","Unknown"),
                    "lat":            s_lat,
                    "lon":            s_lon,
                    "distance_m":     round(dist),
                    "within_radius":  in_circle,
                    "inside_polygon": in_poly,
                    "zone_name":      zone_name,
                    "layer_name":     layer.get("name",""),
                    "extended":       feat.get("extended",{})
                })

    endangered.sort(key=lambda x: x["distance_m"])
    return {"endangered": endangered, "total": len(endangered)}

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3 — INCIDENT MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

@_fastapi_app.post("/api/incidents")
async def create_incident(payload: dict = Body(...)):
    """
    Save a new incident to SQLite and broadcast it to all connected
    browser clients via Socket.IO so their maps update in real-time.

    Input:
    {
      "name": "Airstrike on Jabalia",
      "type": "airstrike",
      "lat": 31.5312,
      "lon": 34.4847,
      "radius_m": 800,
      "description": "Reported at 14:32 UTC",
      "map_id": "optional-room-id",
      "layers": [ ... ]   ← optional: layers to run proximity on immediately
    }
    """
    inc_id  = str(uuid.uuid4())
    name    = payload.get("name", "Incident")
    itype   = payload.get("type", "unknown")
    lat     = float(payload.get("lat", 0))
    lon     = float(payload.get("lon", 0))
    radius  = float(payload.get("radius_m", 500))
    desc    = payload.get("description", "")
    map_id  = payload.get("map_id", "default")
    created = now_iso()

    # Save to SQLite
    conn = get_db()
    conn.execute(
        "INSERT INTO incidents (id,name,type,lat,lon,radius_m,description,created_at) VALUES (?,?,?,?,?,?,?,?)",
        (inc_id, name, itype, lat, lon, radius, desc, created)
    )
    conn.commit()
    conn.close()

    incident_obj = {
        "id": inc_id, "name": name, "type": itype,
        "lat": lat, "lon": lon, "radius_m": radius,
        "description": desc, "created_at": created
    }

    # Run proximity immediately if layers were provided
    layers = payload.get("layers", [])
    endangered = []
    if layers:
        result = await check_proximity({
            "incident": {"lat": lat, "lon": lon, "radius_m": radius},
            "layers":   layers
        })
        endangered = result.get("endangered", [])

    # Broadcast to all users viewing this map via Socket.IO
    await sio.emit(
        "new_incident",
        {
            "incident":   incident_obj,
            "endangered": endangered,
            "total":      len(endangered)
        },
        room=f"map_{map_id}"
    )

    return {
        "incident":   incident_obj,
        "endangered": endangered,
        "total":      len(endangered)
    }

@_fastapi_app.get("/api/incidents")
def list_incidents():
    """Return all incidents ordered newest first."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM incidents ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@_fastapi_app.get("/api/incidents/{incident_id}")
def get_incident(incident_id: str):
    """Return a single incident plus its alert logs."""
    conn  = get_db()
    row   = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Incident not found")
    logs  = conn.execute(
        "SELECT * FROM alert_logs WHERE incident_id=? ORDER BY created_at DESC",
        (incident_id,)
    ).fetchall()
    conn.close()
    return {"incident": dict(row), "alert_logs": [dict(l) for l in logs]}

@_fastapi_app.delete("/api/incidents/{incident_id}")
def delete_incident(incident_id: str):
    conn = get_db()
    conn.execute("DELETE FROM incidents WHERE id=?", (incident_id,))
    conn.execute("DELETE FROM alert_logs WHERE incident_id=?", (incident_id,))
    conn.commit()
    conn.close()
    return {"deleted": incident_id}

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3 — ALERT SENDING
# ─────────────────────────────────────────────────────────────────────────────

@_fastapi_app.post("/api/alert/send")
async def send_alert(payload: dict = Body(...)):
    """
    Unified alert dispatcher. Handles SMS, WhatsApp, and Telegram.
    Logs every attempt to the alert_logs table.

    Input:
    {
      "incident_id": "...",
      "incident":    { name, type, ... },
      "staff":       [ { name, distance_m, layer_name, extended: {Phone, TelegramID} } ],
      "channels":    ["whatsapp", "telegram", "sms"],  ← which channels to use
      "map_id":      "default"
    }
    """
    incident_id = payload.get("incident_id", str(uuid.uuid4()))
    incident    = payload.get("incident", {})
    staff_list  = payload.get("staff", [])
    channels    = payload.get("channels", ["whatsapp"])
    map_id      = payload.get("map_id", "default")

    # Read integration credentials from environment variables
    # Set these in Render Dashboard → Environment tab
    TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    TWILIO_SID     = os.environ.get("TWILIO_ACCOUNT_SID", "")
    TWILIO_TOKEN   = os.environ.get("TWILIO_AUTH_TOKEN", "")
    TWILIO_FROM    = os.environ.get("TWILIO_FROM_NUMBER", "")

    results = []
    conn    = get_db()

    for person in staff_list:
        name     = person.get("name", "Unknown")
        dist     = float(person.get("distance_m", 0))
        layer    = person.get("layer_name", "")
        ext      = person.get("extended", {})

        # Extract contact info from extended data (case-insensitive)
        phone = (ext.get("Phone") or ext.get("phone") or
                 ext.get("Mobile") or ext.get("mobile") or "").strip()
        tg_id = (ext.get("TelegramID") or ext.get("telegram_id") or
                 ext.get("Telegram") or ext.get("telegram") or "").strip()

        message = build_alert_message(incident, name, dist)

        for channel in channels:
            log_id  = str(uuid.uuid4())
            status  = "no_contact"
            note    = ""

            # ── WhatsApp ──────────────────────────────────────────
            if channel == "whatsapp":
                if phone:
                    # wa.me link — opens WhatsApp with pre-filled message
                    clean_phone = re.sub(r"[^0-9+]", "", phone)
                    wa_link = f"https://wa.me/{clean_phone}?text={requests_encode(message)}"
                    status  = "link_generated"
                    note    = wa_link
                else:
                    status = "no_phone"
                    note   = "No phone number in feature properties"

            # ── Telegram ──────────────────────────────────────────
            elif channel == "telegram":
                if tg_id and TELEGRAM_TOKEN:
                    try:
                        import urllib.request, urllib.parse
                        tg_url  = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
                        tg_data = urllib.parse.urlencode({
                            "chat_id": tg_id,
                            "text":    message
                        }).encode()
                        req = urllib.request.Request(tg_url, data=tg_data, method="POST")
                        with urllib.request.urlopen(req, timeout=8) as resp:
                            tg_resp = json.loads(resp.read())
                        status = "sent" if tg_resp.get("ok") else "failed"
                        note   = str(tg_resp)
                    except Exception as e:
                        status = "error"
                        note   = str(e)
                elif not TELEGRAM_TOKEN:
                    status = "not_configured"
                    note   = "Set TELEGRAM_BOT_TOKEN environment variable on Render"
                else:
                    status = "no_telegram_id"
                    note   = "No TelegramID in feature properties"

            # ── SMS via Twilio ────────────────────────────────────
            elif channel == "sms":
                if phone and TWILIO_SID and TWILIO_TOKEN:
                    try:
                        import urllib.request, urllib.parse, base64
                        clean_phone = re.sub(r"[^0-9+]", "", phone)
                        twilio_url  = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json"
                        sms_data    = urllib.parse.urlencode({
                            "To":   clean_phone,
                            "From": TWILIO_FROM,
                            "Body": message[:1600]   # Twilio SMS limit
                        }).encode()
                        credentials = base64.b64encode(
                            f"{TWILIO_SID}:{TWILIO_TOKEN}".encode()
                        ).decode()
                        req = urllib.request.Request(
                            twilio_url, data=sms_data, method="POST",
                            headers={"Authorization": f"Basic {credentials}"}
                        )
                        with urllib.request.urlopen(req, timeout=10) as resp:
                            sms_resp = json.loads(resp.read())
                        status = "sent" if sms_resp.get("status") not in ("failed","undelivered") else "failed"
                        note   = sms_resp.get("status","")
                    except Exception as e:
                        status = "error"
                        note   = str(e)
                elif not TWILIO_SID:
                    status = "not_configured"
                    note   = "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER on Render"
                else:
                    status = "no_phone"
                    note   = "No phone number in feature properties"

            # Save log entry
            conn.execute(
                """INSERT INTO alert_logs
                   (id,incident_id,staff_name,channel,contact,message,status,distance_m,layer_name,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (log_id, incident_id, name, channel,
                 phone if channel != "telegram" else tg_id,
                 message, status, dist, layer, now_iso())
            )

            results.append({
                "log_id":     log_id,
                "staff_name": name,
                "channel":    channel,
                "status":     status,
                "note":       note,
                "distance_m": dist
            })

    conn.commit()
    conn.close()

    # Broadcast alert summary to all connected map users
    await sio.emit(
        "alerts_sent",
        {"incident_id": incident_id, "count": len(results), "results": results},
        room=f"map_{map_id}"
    )

    return {"sent": len(results), "results": results}

def requests_encode(text: str) -> str:
    """URL-encode text for use in wa.me links."""
    import urllib.parse
    return urllib.parse.quote(text, safe='')

# ── Bulk "Alert All" shortcut ─────────────────────────────────────────────────
@_fastapi_app.post("/api/alert/bulk")
async def bulk_alert(payload: dict = Body(...)):
    """
    Convenience endpoint: runs proximity then sends alerts in one call.

    Input:
    {
      "incident_id": "...",
      "incident":    { lat, lon, radius_m, name, type },
      "layers":      [ ...layer objects... ],
      "channels":    ["whatsapp","telegram","sms"],
      "radius_tier": null   ← if set (e.g. 200) only alert within that distance
    }
    """
    incident  = payload.get("incident", {})
    layers    = payload.get("layers", [])
    channels  = payload.get("channels", ["whatsapp"])
    tier      = payload.get("radius_tier", None)
    map_id    = payload.get("map_id", "default")

    # Run proximity
    prox = await check_proximity({
        "incident": {
            "lat":      incident.get("lat"),
            "lon":      incident.get("lon"),
            "radius_m": incident.get("radius_m", 500)
        },
        "layers": layers
    })

    endangered = prox["endangered"]

    # Filter by tier if requested
    if tier is not None:
        endangered = [s for s in endangered if s["distance_m"] <= float(tier)]

    if not endangered:
        return {"sent": 0, "results": [], "message": "No staff in range"}

    # Send alerts
    return await send_alert({
        "incident_id": payload.get("incident_id", str(uuid.uuid4())),
        "incident":    incident,
        "staff":       endangered,
        "channels":    channels,
        "map_id":      map_id
    })

# ── Alert logs ────────────────────────────────────────────────────────────────
@_fastapi_app.get("/api/alert/logs")
def get_alert_logs(limit: int = 100):
    """Return recent alert logs, newest first."""
    conn  = get_db()
    rows  = conn.execute(
        "SELECT * FROM alert_logs ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@_fastapi_app.get("/api/alert/logs/{incident_id}")
def get_logs_for_incident(incident_id: str):
    conn  = get_db()
    rows  = conn.execute(
        "SELECT * FROM alert_logs WHERE incident_id=? ORDER BY created_at DESC",
        (incident_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ── Alert log summary (for the alert log page) ────────────────────────────────
@_fastapi_app.get("/api/incidents/summary/all")
def incidents_summary():
    """
    Returns each incident with a count of how many alerts were sent for it.
    Used to populate the Alert Log page.
    """
    conn = get_db()
    rows = conn.execute("""
        SELECT
            i.id, i.name, i.type, i.lat, i.lon, i.radius_m,
            i.description, i.created_at,
            COUNT(a.id) AS alerts_sent,
            COUNT(DISTINCT a.staff_name) AS staff_alerted
        FROM incidents i
        LEFT JOIN alert_logs a ON a.incident_id = i.id
        GROUP BY i.id
        ORDER BY i.created_at DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ── Export endpoints (unchanged from Phase 2) ─────────────────────────────────
@_fastapi_app.post("/api/export/kml")
async def export_kml(payload: dict = Body(...)):
    layers    = payload.get("layers", [])
    incidents = payload.get("incidents", [])
    kml_bytes = build_kml(layers, incidents)
    return StreamingResponse(
        io.BytesIO(kml_bytes),
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": 'attachment; filename="export.kml"'}
    )

@_fastapi_app.post("/api/export/kmz")
async def export_kmz(payload: dict = Body(...)):
    layers    = payload.get("layers", [])
    incidents = payload.get("incidents", [])
    kml_bytes = build_kml(layers, incidents)
    buf = io.BytesIO()
    with zf.ZipFile(buf, "w", zf.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", kml_bytes)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.google-earth.kmz",
        headers={"Content-Disposition": 'attachment; filename="export.kmz"'}
    )

@_fastapi_app.post("/api/parse-coords")
async def parse_coordinates(payload: dict = Body(...)):
    raw = payload.get("coords", "").strip()
    dd  = re.match(r"^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$", raw)
    if dd:
        return {"lat": float(dd.group(1)), "lon": float(dd.group(2))}
    ddm = re.match(r"(\d+)[°\s](\d+\.?\d*)['\s]([NS])[,\s]*(\d+)[°\s](\d+\.?\d*)['\s]([EW])", raw, re.I)
    if ddm:
        lat = int(ddm.group(1)) + float(ddm.group(2))/60
        lon = int(ddm.group(4)) + float(ddm.group(5))/60
        if ddm.group(3).upper()=="S": lat=-lat
        if ddm.group(6).upper()=="W": lon=-lon
        return {"lat": round(lat,6), "lon": round(lon,6)}
    raise HTTPException(400, "Cannot parse coordinates")

# ── Serve frontend static files ───────────────────────────────────────────────
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_path):
    _fastapi_app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
