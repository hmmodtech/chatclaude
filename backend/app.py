# ============================================================
# app.py  —  WATCH-ME Intelligent Security System  —  v5
# ------------------------------------------------------------
# PHASE 5 ADDITIONS:
#   • Supabase PostgreSQL — all data persists permanently
#   • JWT Authentication — email + password + email confirmation
#   • Users own their maps, layers, features, incidents
#   • All previous Phase 1-4 features preserved
#   • Socket.IO real-time incident broadcast
# ============================================================

import os, io, json, math, zipfile as zf, re, uuid, datetime
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, Body, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

import socketio
from lxml import etree
from shapely.geometry import Point, Polygon as ShapelyPolygon
import bcrypt as _bcrypt_lib
from jose import JWTError, jwt
import psycopg2
import psycopg2.extras
import httpx

# ── Config from environment ───────────────────────────────────────────────────
DATABASE_URL    = os.environ.get("DATABASE_URL", "")
JWT_SECRET      = os.environ.get("JWT_SECRET", "watchme-dev-secret-change-in-production")
JWT_ALGORITHM   = "HS256"
JWT_EXPIRE_DAYS = 30
FRONTEND_URL    = os.environ.get("FRONTEND_URL", "http://localhost:8000")

# Supabase settings (for email confirmation)
SUPABASE_URL    = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY    = os.environ.get("SUPABASE_SERVICE_KEY", "")

TELEGRAM_TOKEN  = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TWILIO_SID      = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN    = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM     = os.environ.get("TWILIO_FROM_NUMBER", "")

# ── Password hashing ──────────────────────────────────────────────────────────
# bcrypt used directly via _bcrypt_lib

# ── Socket.IO ─────────────────────────────────────────────────────────────────
sio = socketio.AsyncServer(
    async_mode="asgi", cors_allowed_origins="*",
    logger=False, engineio_logger=False
)

# ── FastAPI app ───────────────────────────────────────────────────────────────
_app = FastAPI(title="WATCH-ME Intelligent Security System", version="5.0.0")

_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app = socketio.ASGIApp(sio, other_asgi_app=_app)

# ── Security scheme ───────────────────────────────────────────────────────────
bearer = HTTPBearer(auto_error=False)

# ─────────────────────────────────────────────────────────────────────────────
# DATABASE HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def get_conn():
    """
    Open a PostgreSQL connection to Supabase.
    Falls back to SQLite-style in-memory dict if no DB_URL set (dev mode).
    """
    if not DATABASE_URL:
        raise HTTPException(503, "DATABASE_URL not configured. See .env.example")
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    return conn

def init_db():
    """
    Create all tables in Supabase PostgreSQL if they don't exist.
    Safe to run multiple times (uses IF NOT EXISTS).
    Call once at startup.
    """
    if not DATABASE_URL:
        print("⚠  No DATABASE_URL — running without persistence")
        return
    try:
        conn = get_conn()
        cur  = conn.cursor()
        cur.execute("""
            -- Users table
            CREATE TABLE IF NOT EXISTS users (
                id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email         TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                name          TEXT NOT NULL DEFAULT '',
                confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
                confirm_token TEXT,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Map layers (belong to a user)
            CREATE TABLE IF NOT EXISTS layers (
                id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name       TEXT NOT NULL DEFAULT 'Layer',
                color      TEXT NOT NULL DEFAULT '#3b82f6',
                visible    BOOLEAN NOT NULL DEFAULT TRUE,
                opacity    FLOAT NOT NULL DEFAULT 1.0,
                style_field TEXT DEFAULT '',
                style_rules JSONB DEFAULT '{}',
                z_order    INT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Features inside layers (markers, polygons, lines)
            CREATE TABLE IF NOT EXISTS features (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                layer_id    UUID NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
                type        TEXT NOT NULL DEFAULT 'point',
                name        TEXT NOT NULL DEFAULT '',
                description TEXT DEFAULT '',
                lat         FLOAT,
                lon         FLOAT,
                coords      JSONB DEFAULT '[]',
                color       TEXT DEFAULT '#3b82f6',
                stroke_color TEXT DEFAULT '#3b82f6',
                fill_color  TEXT DEFAULT '#3b82f6',
                fill_opacity FLOAT DEFAULT 0.35,
                extended    JSONB DEFAULT '{}',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Incidents
            CREATE TABLE IF NOT EXISTS incidents (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                type        TEXT NOT NULL DEFAULT 'other',
                lat         FLOAT NOT NULL,
                lon         FLOAT NOT NULL,
                radius_m    FLOAT NOT NULL DEFAULT 500,
                description TEXT DEFAULT '',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            -- Alert logs
            CREATE TABLE IF NOT EXISTS alert_logs (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                incident_id  UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
                staff_name   TEXT NOT NULL,
                channel      TEXT NOT NULL,
                contact      TEXT DEFAULT '',
                message      TEXT DEFAULT '',
                status       TEXT NOT NULL DEFAULT 'sent',
                distance_m   FLOAT DEFAULT 0,
                layer_name   TEXT DEFAULT '',
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        """)
        conn.commit()
        cur.close()
        conn.close()
        print("✅ Database tables ready")
    except Exception as e:
        print(f"⚠  DB init error: {e}")

init_db()

# ─────────────────────────────────────────────────────────────────────────────
# AUTH HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def hash_password(pw: str) -> str:
    return _bcrypt_lib.hashpw(pw.encode('utf-8'), _bcrypt_lib.gensalt()).decode('utf-8')

def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _bcrypt_lib.checkpw(plain.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False

def create_token(user_id: str, email: str) -> str:
    expire = datetime.datetime.utcnow() + datetime.timedelta(days=JWT_EXPIRE_DAYS)
    return jwt.encode(
        {"sub": user_id, "email": email, "exp": expire},
        JWT_SECRET, algorithm=JWT_ALGORITHM
    )

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(401, "Invalid or expired token")

async def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)
) -> dict:
    """
    Dependency injected into protected routes.
    Reads the Authorization: Bearer <token> header.
    Returns the user dict from the database.
    """
    if not creds:
        raise HTTPException(401, "Authentication required")
    payload = decode_token(creds.credentials)
    uid = payload.get("sub")
    if not uid:
        raise HTTPException(401, "Invalid token payload")
    try:
        conn = get_conn()
        cur  = conn.cursor()
        cur.execute("SELECT id, email, name, confirmed FROM users WHERE id=%s", (uid,))
        user = cur.fetchone()
        cur.close(); conn.close()
    except Exception:
        raise HTTPException(503, "Database error")
    if not user:
        raise HTTPException(401, "User not found")
    return dict(user)

# ─────────────────────────────────────────────────────────────────────────────
# EMAIL CONFIRMATION  (uses Supabase email OR simple token link)
# ─────────────────────────────────────────────────────────────────────────────

async def send_confirmation_email(email: str, name: str, token: str):
    """
    Send a confirmation email.
    If SUPABASE_URL + SUPABASE_KEY are set, uses Supabase transactional email.
    Otherwise prints the link to server logs (for development).
    """
    confirm_url = f"{FRONTEND_URL}?confirm={token}"

    if SUPABASE_URL and SUPABASE_KEY:
        # Use Supabase Edge Function or REST to send email
        # For now we use a simple HTTP POST to Supabase auth admin
        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{SUPABASE_URL}/auth/v1/admin/users",
                    headers={
                        "apikey": SUPABASE_KEY,
                        "Authorization": f"Bearer {SUPABASE_KEY}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "email": email,
                        "email_confirm": False,
                        "user_metadata": {"name": name}
                    }
                )
        except Exception as e:
            print(f"Supabase email error: {e}")

    # Always log the link so it works even without email service
    print(f"\n📧 CONFIRM EMAIL LINK for {email}:")
    print(f"   {confirm_url}\n")
    return confirm_url

# ─────────────────────────────────────────────────────────────────────────────
# KML / KMZ  HELPERS  (unchanged from Phase 1–4)
# ─────────────────────────────────────────────────────────────────────────────

KML_NS = "http://www.opengis.net/kml/2.2"

def ns(tag):
    return f"{{{KML_NS}}}{tag}"

def haversine(lat1, lon1, lat2, lon2):
    R = 6_371_000
    p1,p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2-lat1); dl = math.radians(lon2-lon1)
    a  = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def point_in_polygon(lat, lon, coords):
    try:
        pt   = Point(lon, lat)
        poly = ShapelyPolygon([(c[1],c[0]) for c in coords])
        return poly.contains(pt)
    except Exception:
        return False

def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"

def parse_kml_bytes(kml_bytes: bytes, filename: str = "layer") -> dict:
    try:
        root = etree.fromstring(kml_bytes)
    except Exception as e:
        raise HTTPException(400, f"Invalid KML: {e}")
    placemarks = root.findall(f".//{ns('Placemark')}")
    features   = []
    for pm in placemarks:
        name = ""; n_el = pm.find(ns("name"))
        if n_el is not None and n_el.text: name = n_el.text.strip()
        desc = ""; d_el = pm.find(ns("description"))
        if d_el is not None and d_el.text: desc = d_el.text.strip()
        extended = {}
        ext_el = pm.find(f".//{ns('ExtendedData')}")
        if ext_el is not None:
            for data in ext_el.findall(ns("Data")):
                key = data.get("name",""); v_el = data.find(ns("value"))
                if key and v_el is not None and v_el.text: extended[key] = v_el.text.strip()
            for sd_p in ext_el.findall(f".//{ns('SchemaData')}"):
                for sd in sd_p.findall(ns("SimpleData")):
                    key = sd.get("name","")
                    if key and sd.text: extended[key] = sd.text.strip()
        pt_el = pm.find(f".//{ns('Point')}")
        if pt_el is not None:
            co = pt_el.find(ns("coordinates"))
            if co is not None and co.text:
                parts = co.text.strip().split(",")
                if len(parts) >= 2:
                    try:
                        features.append({"type":"point","name":name,"description":desc,
                            "lat":float(parts[1]),"lon":float(parts[0]),
                            "color":"#3b82f6","extended":extended})
                    except ValueError: pass
            continue
        poly_el = pm.find(f".//{ns('Polygon')}")
        if poly_el is not None:
            ob = poly_el.find(f".//{ns('outerBoundaryIs')}")
            if ob is None:
                ob = poly_el.find(f".//{ns('LinearRing')}")
            if ob is not None:
                co = ob.find(f".//{ns('coordinates')}")
                if co is not None and co.text:
                    ring = []
                    for tok in co.text.strip().split():
                        p = tok.split(",")
                        if len(p) >= 2:
                            try: ring.append([float(p[1]),float(p[0])])
                            except ValueError: pass
                    if ring:
                        features.append({"type":"polygon","name":name,"description":desc,
                            "coords":ring,"fill_color":"#3b82f6","fill_opacity":0.35,
                            "stroke_color":"#3b82f6","extended":extended})
            continue
        line_el = pm.find(f".//{ns('LineString')}")
        if line_el is not None:
            co = line_el.find(ns("coordinates"))
            if co is not None and co.text:
                pts = []
                for tok in co.text.strip().split():
                    p = tok.split(",")
                    if len(p) >= 2:
                        try: pts.append([float(p[1]),float(p[0])])
                        except ValueError: pass
                if pts:
                    features.append({"type":"line","name":name,"description":desc,
                        "coords":pts,"stroke_color":"#3b82f6","extended":extended})
    return {"name": filename.replace(".kml","").replace(".kmz","").replace("_"," ").title(),
            "color":"#3b82f6","visible":True,"opacity":1.0,"features":features}

def build_kml(layers, incidents):
    KML_DECL = b'<?xml version="1.0" encoding="UTF-8"?>\n'
    NSMAP = {None:"http://www.opengis.net/kml/2.2","gx":"http://www.google.com/kml/ext/2.2"}
    root = etree.Element("kml", nsmap=NSMAP)
    doc  = etree.SubElement(root,"Document")
    etree.SubElement(doc,"name").text = "WATCH-ME Export"
    etree.SubElement(doc,"description").text = f"Exported {now_iso()}"
    def add_ext(parent, data):
        if not data: return
        ext = etree.SubElement(parent,"ExtendedData")
        for k,v in data.items():
            d = etree.SubElement(ext,"Data",name=str(k))
            etree.SubElement(d,"value").text = str(v)
    for layer in layers:
        folder = etree.SubElement(doc,"Folder")
        etree.SubElement(folder,"name").text = layer.get("name","Layer")
        for feat in layer.get("features",[]):
            pm = etree.SubElement(folder,"Placemark")
            etree.SubElement(pm,"name").text = feat.get("name","")
            etree.SubElement(pm,"description").text = feat.get("description","")
            add_ext(pm, feat.get("extended",{}))
            ft = feat.get("type")
            if ft=="point":
                pt = etree.SubElement(pm,"Point")
                etree.SubElement(pt,"coordinates").text = f"{feat.get('lon',0)},{feat.get('lat',0)},0"
            elif ft=="polygon":
                pg = etree.SubElement(pm,"Polygon")
                oi = etree.SubElement(pg,"outerBoundaryIs")
                lr = etree.SubElement(oi,"LinearRing")
                etree.SubElement(lr,"coordinates").text = " ".join(
                    f"{c[1]},{c[0]},0" for c in feat.get("coords",[]))
            elif ft=="line":
                ls = etree.SubElement(pm,"LineString")
                etree.SubElement(ls,"coordinates").text = " ".join(
                    f"{c[1]},{c[0]},0" for c in feat.get("coords",[]))
    if incidents:
        ifolder = etree.SubElement(doc,"Folder")
        etree.SubElement(ifolder,"name").text = "Incidents"
        for inc in incidents:
            pm = etree.SubElement(ifolder,"Placemark")
            etree.SubElement(pm,"name").text = inc.get("name","Incident")
            add_ext(pm,{"type":inc.get("type",""),"radius_m":inc.get("radius_m",0)})
            pt = etree.SubElement(pm,"Point")
            etree.SubElement(pt,"coordinates").text = f"{inc.get('lon',0)},{inc.get('lat',0)},0"
    return KML_DECL + etree.tostring(root,pretty_print=True,encoding="unicode").encode("utf-8")

def build_alert_message(incident, staff_name, distance_m):
    dist_str = f"{distance_m/1000:.1f}km" if distance_m >= 1000 else f"{int(distance_m)}m"
    return (f"⚠️ SAFETY ALERT\n"
            f"Incident: {incident.get('type','').replace('_',' ').title()} — {incident.get('name','')}\n"
            f"Distance from your location: {dist_str}\n"
            f"Please follow evacuation procedures immediately.\n"
            f"Stay safe. — WATCH-ME Security System")

# ─────────────────────────────────────────────────────────────────────────────
# SOCKET.IO EVENTS
# ─────────────────────────────────────────────────────────────────────────────

@sio.event
async def connect(sid, environ):
    print(f"[WS] connected: {sid}")

@sio.event
async def disconnect(sid):
    print(f"[WS] disconnected: {sid}")

@sio.event
async def join_map(sid, data):
    room = f"user_{data.get('user_id','default')}"
    await sio.enter_room(sid, room)
    await sio.emit("joined", {"room": room}, to=sid)

# ─────────────────────────────────────────────────────────────────────────────
# AUTH ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@_app.post("/api/auth/register")
async def register(payload: dict = Body(...)):
    """
    Create a new account.
    Sends a confirmation email (or logs the link in dev mode).
    Input: { email, password, name }
    """
    email    = payload.get("email","").strip().lower()
    password = payload.get("password","")
    name     = payload.get("name","").strip()

    if not email or "@" not in email:
        raise HTTPException(400, "Valid email required")
    if len(password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    if not name:
        raise HTTPException(400, "Name required")

    pw_hash  = hash_password(password)
    conf_tok = str(uuid.uuid4())
    uid      = str(uuid.uuid4())

    try:
        conn = get_conn(); cur = conn.cursor()
        # Check email not already registered
        cur.execute("SELECT id FROM users WHERE email=%s", (email,))
        if cur.fetchone():
            cur.close(); conn.close()
            raise HTTPException(409, "Email already registered")
        cur.execute(
            "INSERT INTO users (id,email,password_hash,name,confirmed,confirm_token) VALUES (%s,%s,%s,%s,%s,%s)",
            (uid, email, pw_hash, name, False, conf_tok)
        )
        conn.commit(); cur.close(); conn.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(503, f"Database error: {e}")

    confirm_url = await send_confirmation_email(email, name, conf_tok)

    return {
        "message": "Account created. Please check your email to confirm.",
        "confirm_url": confirm_url,  # shown in dev — remove in production
        "user_id": uid
    }

@_app.get("/api/auth/confirm")
async def confirm_email(token: str):
    """
    Called when the user clicks the confirmation link in their email.
    Marks the account as confirmed.
    """
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("SELECT id FROM users WHERE confirm_token=%s", (token,))
        row = cur.fetchone()
        if not row:
            cur.close(); conn.close()
            raise HTTPException(404, "Invalid or expired confirmation token")
        cur.execute("UPDATE users SET confirmed=TRUE, confirm_token=NULL WHERE id=%s", (row["id"],))
        conn.commit(); cur.close(); conn.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(503, f"Database error: {e}")

    # Redirect to frontend with success flag
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url=f"{FRONTEND_URL}?confirmed=1")

@_app.post("/api/auth/login")
async def login(payload: dict = Body(...)):
    """
    Log in with email + password.
    Returns a JWT token valid for 30 days.
    Input: { email, password }
    """
    email    = payload.get("email","").strip().lower()
    password = payload.get("password","")

    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("SELECT id,email,name,password_hash,confirmed FROM users WHERE email=%s", (email,))
        user = cur.fetchone(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503, f"Database error: {e}")

    if not user or not verify_password(password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")

    if not user["confirmed"]:
        raise HTTPException(403, "Please confirm your email before logging in")

    token = create_token(str(user["id"]), user["email"])
    return {
        "token": token,
        "user": {"id": str(user["id"]), "email": user["email"], "name": user["name"]}
    }

@_app.get("/api/auth/me")
async def get_me(user: dict = Depends(get_current_user)):
    """Return the currently logged-in user's profile."""
    return user

@_app.post("/api/auth/resend-confirmation")
async def resend_confirmation(payload: dict = Body(...)):
    """Resend the confirmation email."""
    email = payload.get("email","").strip().lower()
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("SELECT id,name,confirm_token,confirmed FROM users WHERE email=%s",(email,))
        user = cur.fetchone(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503, f"Database error: {e}")
    if not user:
        return {"message": "If that email is registered, a confirmation link was sent."}
    if user["confirmed"]:
        return {"message": "Email already confirmed. You can log in."}
    tok = user["confirm_token"] or str(uuid.uuid4())
    confirm_url = await send_confirmation_email(email, user["name"], tok)
    return {"message": "Confirmation email resent.", "confirm_url": confirm_url}

# ─────────────────────────────────────────────────────────────────────────────
# LAYER ROUTES  (persistent in PostgreSQL)
# ─────────────────────────────────────────────────────────────────────────────

@_app.get("/api/layers")
async def get_layers(user: dict = Depends(get_current_user)):
    """Get all layers for the logged-in user, including their features."""
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute(
            "SELECT * FROM layers WHERE user_id=%s ORDER BY z_order, created_at",
            (user["id"],)
        )
        layers = [dict(r) for r in cur.fetchall()]
        for layer in layers:
            cur.execute(
                "SELECT * FROM features WHERE layer_id=%s ORDER BY created_at",
                (layer["id"],)
            )
            feats = []
            for row in cur.fetchall():
                f = dict(row)
                # Convert UUID and JSONB to plain Python types
                f["id"]       = str(f["id"])
                f["layer_id"] = str(f["layer_id"])
                f["coords"]   = f["coords"] if isinstance(f["coords"],list) else []
                f["extended"] = f["extended"] if isinstance(f["extended"],dict) else {}
                feats.append(f)
            layer["features"] = feats
            layer["id"]       = str(layer["id"])
            layer["user_id"]  = str(layer["user_id"])
            layer["style_rules"] = layer.get("style_rules") or {}
        cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503, f"Database error: {e}")
    return layers

@_app.post("/api/layers")
async def create_layer(payload: dict = Body(...), user: dict = Depends(get_current_user)):
    """Create a new layer."""
    lid = str(uuid.uuid4())
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute(
            "INSERT INTO layers (id,user_id,name,color,visible,opacity,z_order) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (lid, user["id"], payload.get("name","Layer"),
             payload.get("color","#3b82f6"), True, 1.0, payload.get("z_order",0))
        )
        layer = dict(cur.fetchone())
        layer["id"]       = str(layer["id"])
        layer["user_id"]  = str(layer["user_id"])
        layer["features"] = []
        layer["style_rules"] = {}
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503, f"Database error: {e}")
    return layer

@_app.put("/api/layers/{layer_id}")
async def update_layer(layer_id: str, payload: dict = Body(...),
                       user: dict = Depends(get_current_user)):
    """Update layer name, color, visibility, opacity, style rules."""
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute(
            """UPDATE layers SET
               name=%s, color=%s, visible=%s, opacity=%s,
               style_field=%s, style_rules=%s
               WHERE id=%s AND user_id=%s""",
            (payload.get("name","Layer"), payload.get("color","#3b82f6"),
             payload.get("visible", True), payload.get("opacity", 1.0),
             payload.get("style_field",""),
             json.dumps(payload.get("style_rules",{})),
             layer_id, user["id"])
        )
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503, f"Database error: {e}")
    return {"updated": layer_id}

@_app.delete("/api/layers/{layer_id}")
async def delete_layer(layer_id: str, user: dict = Depends(get_current_user)):
    """Delete a layer and all its features."""
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("DELETE FROM layers WHERE id=%s AND user_id=%s", (layer_id, user["id"]))
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503, f"Database error: {e}")
    return {"deleted": layer_id}

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE ROUTES  (markers, polygons, lines)
# ─────────────────────────────────────────────────────────────────────────────

@_app.post("/api/layers/{layer_id}/features")
async def add_feature(layer_id: str, payload: dict = Body(...),
                      user: dict = Depends(get_current_user)):
    """Add a feature to a layer. Verifies ownership of the layer."""
    # Verify user owns this layer
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("SELECT id FROM layers WHERE id=%s AND user_id=%s",(layer_id,user["id"]))
        if not cur.fetchone():
            cur.close(); conn.close()
            raise HTTPException(403,"Layer not found or access denied")
        fid = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO features
               (id,layer_id,type,name,description,lat,lon,coords,
                color,stroke_color,fill_color,fill_opacity,extended)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (fid, layer_id,
             payload.get("type","point"),
             payload.get("name",""),
             payload.get("description",""),
             payload.get("lat"), payload.get("lon"),
             json.dumps(payload.get("coords",[])),
             payload.get("color","#3b82f6"),
             payload.get("stroke_color","#3b82f6"),
             payload.get("fill_color","#3b82f6"),
             payload.get("fill_opacity",0.35),
             json.dumps(payload.get("extended",{})))
        )
        feat = dict(cur.fetchone())
        feat["id"] = str(feat["id"]); feat["layer_id"] = str(feat["layer_id"])
        conn.commit(); cur.close(); conn.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return feat

@_app.put("/api/features/{feature_id}")
async def update_feature(feature_id: str, payload: dict = Body(...),
                         user: dict = Depends(get_current_user)):
    """Update a feature's name, description, color, or move to another layer."""
    try:
        conn = get_conn(); cur = conn.cursor()
        # Verify ownership via join
        cur.execute("""
            SELECT f.id FROM features f
            JOIN layers l ON f.layer_id=l.id
            WHERE f.id=%s AND l.user_id=%s""", (feature_id, user["id"]))
        if not cur.fetchone():
            cur.close(); conn.close()
            raise HTTPException(403,"Feature not found or access denied")
        cur.execute("""
            UPDATE features SET
              name=%s, description=%s, color=%s,
              stroke_color=%s, fill_color=%s, fill_opacity=%s,
              layer_id=%s, extended=%s
            WHERE id=%s""",
            (payload.get("name",""), payload.get("description",""),
             payload.get("color","#3b82f6"),
             payload.get("stroke_color","#3b82f6"),
             payload.get("fill_color","#3b82f6"),
             payload.get("fill_opacity",0.35),
             payload.get("layer_id", feature_id),
             json.dumps(payload.get("extended",{})),
             feature_id))
        conn.commit(); cur.close(); conn.close()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return {"updated": feature_id}

@_app.delete("/api/features/{feature_id}")
async def delete_feature_db(feature_id: str, user: dict = Depends(get_current_user)):
    """Delete a single feature."""
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("""
            DELETE FROM features WHERE id=%s
            AND layer_id IN (SELECT id FROM layers WHERE user_id=%s)""",
            (feature_id, user["id"]))
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return {"deleted": feature_id}

# ─────────────────────────────────────────────────────────────────────────────
# KML / KMZ  UPLOAD  →  saves to DB automatically
# ─────────────────────────────────────────────────────────────────────────────

@_app.post("/api/upload-layer")
async def upload_layer(file: UploadFile = File(...),
                       authorization: Optional[str] = Header(None)):
    """
    Upload a KML/KMZ file.
    If Authorization header present: saves features to DB under logged-in user.
    If no auth: returns parsed data for guest preview (not saved).
    """
    filename = file.filename or "layer.kml"
    raw      = await file.read()

    if filename.lower().endswith(".kmz"):
        try:
            with zf.ZipFile(io.BytesIO(raw)) as z:
                kml_name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
                if not kml_name: raise HTTPException(400,"No KML inside KMZ")
                kml_bytes = z.read(kml_name)
        except zf.BadZipFile:
            raise HTTPException(400,"Invalid KMZ file")
    elif filename.lower().endswith(".kml"):
        kml_bytes = raw
    else:
        raise HTTPException(400,"Only .kml and .kmz files supported")

    parsed = parse_kml_bytes(kml_bytes, filename)

    # If user is logged in, persist to DB
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        try:
            payload_jwt = decode_token(token)
            uid = payload_jwt.get("sub")
            if uid:
                conn = get_conn(); cur = conn.cursor()
                lid = str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO layers (id,user_id,name,color,visible,opacity) VALUES (%s,%s,%s,%s,%s,%s)",
                    (lid, uid, parsed["name"], parsed["color"], True, 1.0)
                )
                for feat in parsed["features"]:
                    fid = str(uuid.uuid4())
                    cur.execute(
                        """INSERT INTO features
                           (id,layer_id,type,name,description,lat,lon,coords,
                            color,stroke_color,fill_color,fill_opacity,extended)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (fid, lid, feat["type"], feat.get("name",""),
                         feat.get("description",""),
                         feat.get("lat"), feat.get("lon"),
                         json.dumps(feat.get("coords",[])),
                         feat.get("color","#3b82f6"),
                         feat.get("stroke_color","#3b82f6"),
                         feat.get("fill_color","#3b82f6"),
                         feat.get("fill_opacity",0.35),
                         json.dumps(feat.get("extended",{})))
                    )
                conn.commit(); cur.close(); conn.close()
                parsed["id"] = lid
                parsed["saved_to_db"] = True
        except Exception as e:
            print(f"DB save error: {e}")

    return parsed

# ─────────────────────────────────────────────────────────────────────────────
# PROXIMITY  (unchanged logic, now accepts layer_ids filter)
# ─────────────────────────────────────────────────────────────────────────────

@_app.post("/api/proximity")
async def check_proximity(payload: dict = Body(...)):
    """
    Proximity analysis.
    Input:
    {
      "incident":   { lat, lon, radius_m },
      "layers":     [ ...layer objects with features... ],
      "layer_ids":  ["id1","id2"]  ← optional: only analyse these layers
    }
    """
    incident   = payload.get("incident", {})
    layers     = payload.get("layers", [])
    layer_ids  = payload.get("layer_ids", None)  # None = all layers

    inc_lat  = float(incident.get("lat", 0))
    inc_lon  = float(incident.get("lon", 0))
    radius   = float(incident.get("radius_m", 500))

    # Filter layers if requested
    if layer_ids is not None:
        layers = [l for l in layers if l.get("id") in layer_ids]

    all_polygons = [
        {"name": f.get("name","Zone"), "coords": f.get("coords",[])}
        for l in layers for f in l.get("features",[])
        if f.get("type") == "polygon"
    ]

    endangered = []
    for layer in layers:
        for feat in layer.get("features",[]):
            if feat.get("type") != "point": continue
            s_lat = float(feat.get("lat") or 0)
            s_lon = float(feat.get("lon") or 0)
            if s_lat == 0 and s_lon == 0: continue
            dist      = haversine(inc_lat, inc_lon, s_lat, s_lon)
            in_circle = dist <= radius
            in_poly   = False; zone_name = ""
            for poly in all_polygons:
                if point_in_polygon(s_lat, s_lon, poly["coords"]):
                    in_poly = True; zone_name = poly["name"]; break
            if in_circle or in_poly:
                endangered.append({
                    "name":           feat.get("name","Unknown"),
                    "lat":            s_lat, "lon": s_lon,
                    "distance_m":     round(dist),
                    "within_radius":  in_circle,
                    "inside_polygon": in_poly,
                    "zone_name":      zone_name,
                    "layer_name":     layer.get("name",""),
                    "layer_id":       layer.get("id",""),
                    "extended":       feat.get("extended",{})
                })
    endangered.sort(key=lambda x: x["distance_m"])
    return {"endangered": endangered, "total": len(endangered)}

# ─────────────────────────────────────────────────────────────────────────────
# INCIDENT  ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@_app.post("/api/incidents")
async def create_incident(payload: dict = Body(...),
                          user: dict = Depends(get_current_user)):
    inc_id  = str(uuid.uuid4())
    name    = payload.get("name","Incident")
    itype   = payload.get("type","other")
    lat     = float(payload.get("lat",0))
    lon     = float(payload.get("lon",0))
    radius  = float(payload.get("radius_m",500))
    desc    = payload.get("description","")
    layers  = payload.get("layers",[])
    layer_ids = payload.get("layer_ids", None)
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute(
            "INSERT INTO incidents (id,user_id,name,type,lat,lon,radius_m,description) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING created_at",
            (inc_id, user["id"], name, itype, lat, lon, radius, desc)
        )
        row = cur.fetchone()
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")

    incident_obj = {"id":inc_id,"name":name,"type":itype,"lat":lat,"lon":lon,
                    "radius_m":radius,"description":desc,
                    "created_at":str(row["created_at"])}

    endangered = []
    if layers:
        r = await check_proximity({
            "incident":{"lat":lat,"lon":lon,"radius_m":radius},
            "layers":layers, "layer_ids":layer_ids
        })
        endangered = r.get("endangered",[])

    await sio.emit("new_incident",
        {"incident":incident_obj,"endangered":endangered,"total":len(endangered)},
        room=f"user_{user['id']}")

    return {"incident":incident_obj,"endangered":endangered,"total":len(endangered)}

@_app.get("/api/incidents")
async def list_incidents(user: dict = Depends(get_current_user)):
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute(
            "SELECT * FROM incidents WHERE user_id=%s ORDER BY created_at DESC",(user["id"],))
        rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            r["id"] = str(r["id"]); r["user_id"] = str(r["user_id"])
            r["created_at"] = str(r["created_at"])
        cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return rows

@_app.delete("/api/incidents/{incident_id}")
async def delete_incident(incident_id: str, user: dict = Depends(get_current_user)):
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("DELETE FROM incidents WHERE id=%s AND user_id=%s",(incident_id,user["id"]))
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return {"deleted":incident_id}

# ─────────────────────────────────────────────────────────────────────────────
# ALERT  ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@_app.post("/api/alert/send")
async def send_alert(payload: dict = Body(...), user: dict = Depends(get_current_user)):
    incident_id = payload.get("incident_id", str(uuid.uuid4()))
    incident    = payload.get("incident",{})
    staff_list  = payload.get("staff",[])
    channels    = payload.get("channels",["whatsapp"])
    results     = []

    try:
        conn = get_conn(); cur = conn.cursor()
        for person in staff_list:
            name  = person.get("name","Unknown")
            dist  = float(person.get("distance_m",0))
            layer = person.get("layer_name","")
            ext   = person.get("extended",{})
            phone = (ext.get("Phone") or ext.get("phone") or
                     ext.get("Mobile") or ext.get("mobile") or "").strip()
            tg_id = (ext.get("TelegramID") or ext.get("telegram_id") or
                     ext.get("Telegram") or "").strip()
            message = build_alert_message(incident, name, dist)

            for channel in channels:
                log_id = str(uuid.uuid4()); status = "no_contact"; note = ""

                if channel == "whatsapp":
                    if phone:
                        import urllib.parse
                        clean = re.sub(r"[^0-9+]","",phone)
                        note  = f"https://wa.me/{clean}?text={urllib.parse.quote(message,safe='')}"
                        status= "link_generated"
                    else:
                        status = "no_phone"

                elif channel == "telegram":
                    if tg_id and TELEGRAM_TOKEN:
                        try:
                            import urllib.request, urllib.parse
                            data = urllib.parse.urlencode({"chat_id":tg_id,"text":message}).encode()
                            req  = urllib.request.Request(
                                f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
                                data=data, method="POST")
                            with urllib.request.urlopen(req,timeout=8) as resp:
                                tg_resp = json.loads(resp.read())
                            status = "sent" if tg_resp.get("ok") else "failed"
                            note   = str(tg_resp)
                        except Exception as e:
                            status = "error"; note = str(e)
                    elif not TELEGRAM_TOKEN:
                        status = "not_configured"
                    else:
                        status = "no_telegram_id"

                elif channel == "sms":
                    if phone and TWILIO_SID and TWILIO_TOKEN:
                        try:
                            import urllib.request, urllib.parse, base64
                            clean = re.sub(r"[^0-9+]","",phone)
                            data  = urllib.parse.urlencode(
                                {"To":clean,"From":TWILIO_FROM,"Body":message[:1600]}).encode()
                            cred  = base64.b64encode(f"{TWILIO_SID}:{TWILIO_TOKEN}".encode()).decode()
                            req   = urllib.request.Request(
                                f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json",
                                data=data, method="POST",
                                headers={"Authorization":f"Basic {cred}"})
                            with urllib.request.urlopen(req,timeout=10) as resp:
                                sms_resp = json.loads(resp.read())
                            status = "sent" if sms_resp.get("status") not in ("failed","undelivered") else "failed"
                        except Exception as e:
                            status = "error"; note = str(e)
                    elif not TWILIO_SID:
                        status = "not_configured"
                    else:
                        status = "no_phone"

                cur.execute("""
                    INSERT INTO alert_logs
                    (id,incident_id,staff_name,channel,contact,message,status,distance_m,layer_name)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (log_id, incident_id, name, channel,
                     phone if channel != "telegram" else tg_id,
                     message, status, dist, layer))
                results.append({"log_id":log_id,"staff_name":name,"channel":channel,
                                 "status":status,"note":note,"distance_m":dist})

        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")

    return {"sent":len(results),"results":results}

@_app.get("/api/alert/logs")
async def get_alert_logs(user: dict = Depends(get_current_user)):
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("""
            SELECT a.*, i.name as incident_name, i.type as incident_type
            FROM alert_logs a
            JOIN incidents i ON a.incident_id=i.id
            WHERE i.user_id=%s
            ORDER BY a.created_at DESC LIMIT 200""", (user["id"],))
        rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            r["id"] = str(r["id"]); r["incident_id"] = str(r["incident_id"])
            r["created_at"] = str(r["created_at"])
        cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return rows

@_app.delete("/api/alert/logs/{log_id}")
async def delete_alert_log(log_id: str, user: dict = Depends(get_current_user)):
    """Delete a single alert log entry."""
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("""
            DELETE FROM alert_logs WHERE id=%s
            AND incident_id IN (SELECT id FROM incidents WHERE user_id=%s)""",
            (log_id, user["id"]))
        conn.commit(); cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return {"deleted": log_id}

@_app.get("/api/incidents/summary/all")
async def incidents_summary(user: dict = Depends(get_current_user)):
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("""
            SELECT i.id,i.name,i.type,i.lat,i.lon,i.radius_m,i.description,i.created_at,
                   COUNT(a.id) AS alerts_sent,
                   COUNT(DISTINCT a.staff_name) AS staff_alerted
            FROM incidents i
            LEFT JOIN alert_logs a ON a.incident_id=i.id
            WHERE i.user_id=%s
            GROUP BY i.id ORDER BY i.created_at DESC""", (user["id"],))
        rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            r["id"] = str(r["id"]); r["user_id"] = str(r.get("user_id",""))
            r["created_at"] = str(r["created_at"])
        cur.close(); conn.close()
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return rows

@_app.get("/api/incidents/{incident_id}")
async def get_incident(incident_id: str, user: dict = Depends(get_current_user)):
    try:
        conn = get_conn(); cur = conn.cursor()
        cur.execute("SELECT * FROM incidents WHERE id=%s AND user_id=%s",(incident_id,user["id"]))
        row = cur.fetchone()
        if not row: raise HTTPException(404,"Incident not found")
        cur.execute("SELECT * FROM alert_logs WHERE incident_id=%s ORDER BY created_at DESC",(incident_id,))
        logs = [dict(l) for l in cur.fetchall()]
        for l in logs:
            l["id"] = str(l["id"]); l["incident_id"] = str(l["incident_id"])
            l["created_at"] = str(l["created_at"])
        cur.close(); conn.close()
        inc = dict(row); inc["id"] = str(inc["id"])
        inc["user_id"] = str(inc["user_id"]); inc["created_at"] = str(inc["created_at"])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(503,f"Database error: {e}")
    return {"incident": inc, "alert_logs": logs}

# ─────────────────────────────────────────────────────────────────────────────
# EXPORT  ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@_app.post("/api/export/kml")
async def export_kml(payload: dict = Body(...)):
    kml = build_kml(payload.get("layers",[]), payload.get("incidents",[]))
    return StreamingResponse(io.BytesIO(kml),
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition":'attachment; filename="watchme_export.kml"'})

@_app.post("/api/export/kmz")
async def export_kmz(payload: dict = Body(...)):
    kml = build_kml(payload.get("layers",[]), payload.get("incidents",[]))
    buf = io.BytesIO()
    with zf.ZipFile(buf,"w",zf.ZIP_DEFLATED) as z: z.writestr("doc.kml",kml)
    buf.seek(0)
    return StreamingResponse(buf,
        media_type="application/vnd.google-earth.kmz",
        headers={"Content-Disposition":'attachment; filename="watchme_export.kmz"'})

# ─────────────────────────────────────────────────────────────────────────────
# HEALTH  +  STATIC  FILES
# ─────────────────────────────────────────────────────────────────────────────

@_app.get("/api/health")
def health():
    return {"status":"ok","service":"WATCH-ME Intelligent Security System v5",
            "db": "connected" if DATABASE_URL else "not configured"}

@_app.get("/")
def root():
    return {"status":"ok","service":"WATCH-ME v5"}

frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_path):
    _app.mount("/", StaticFiles(directory=frontend_path, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.environ.get("PORT",8000)), reload=True)
