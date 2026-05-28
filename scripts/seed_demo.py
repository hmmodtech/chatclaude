
#!/usr/bin/env python3
# ============================================================
# seed_demo.py — Gaza Security Dashboard Demo Data
# ------------------------------------------------------------
# What this script does:
#   Creates sample data so you can test the dashboard
#   immediately after deployment without uploading real files.
#
# HOW TO RUN:
#   From the project root folder, type:
#     python scripts/seed_demo.py
#
# WHAT IT CREATES:
#   • dashboard.db with 3 sample incidents and alert logs
#   • scripts/demo_staff.kml  ← import this file into the dashboard
# ============================================================

import sys, os, sqlite3, uuid
from datetime import datetime, timedelta

script_dir = os.path.dirname(os.path.abspath(__file__))
db_path    = os.path.normpath(os.path.join(script_dir, '..', 'backend', 'dashboard.db'))

print(f"📂 Using database: {db_path}")

conn = sqlite3.connect(db_path)
conn.executescript("""
    CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
        lat REAL NOT NULL, lon REAL NOT NULL, radius_m REAL NOT NULL DEFAULT 500,
        description TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alert_logs (
        id TEXT PRIMARY KEY, incident_id TEXT NOT NULL,
        staff_name TEXT NOT NULL, channel TEXT NOT NULL,
        contact TEXT DEFAULT '', message TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'sent', distance_m REAL DEFAULT 0,
        layer_name TEXT DEFAULT '', created_at TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id)
    );
""")
conn.commit()

def ts(h=0):
    return (datetime.utcnow() - timedelta(hours=h)).isoformat() + "Z"

# ── Sample incidents ───────────────────────────────────────────
incidents = [
    ("Airstrike near Jabalia Camp",    "airstrike",      31.5312, 34.4847, 800,  ts(3)),
    ("Evacuation Order — North Gaza",  "evacuation",     31.5500, 34.4700, 2000, ts(1)),
    ("Security Alert — Rafah Crossing","security_alert", 31.2167, 34.2500, 500,  ts(0)),
]

inc_ids = []
for name, itype, lat, lon, radius, created in incidents:
    iid = str(uuid.uuid4())
    inc_ids.append(iid)
    conn.execute(
        "INSERT OR IGNORE INTO incidents VALUES (?,?,?,?,?,?,?,?)",
        (iid, name, itype, lat, lon, radius, "", created)
    )
    print(f"  ✅ Incident: {name}")

# ── Sample alert logs for first incident ──────────────────────
staff = [
    ("Ahmed Hassan",   "+972501234001", "whatsapp",  320, "link_generated"),
    ("Sara Khalil",    "+972501234002", "sms",        155, "sent"),
    ("Omar Nasser",    "+972501234003", "telegram",   620, "not_configured"),
    ("Layla Ibrahim",  "+972501234004", "whatsapp",   890, "link_generated"),
    ("Yousef Al-Amin", "+972501234005", "sms",        210, "sent"),
]

for i, (sname, phone, ch, dist, status) in enumerate(staff):
    conn.execute(
        "INSERT OR IGNORE INTO alert_logs VALUES (?,?,?,?,?,?,?,?,?,?)",
        (str(uuid.uuid4()), inc_ids[0], sname, ch, phone,
         f"SAFETY ALERT — {incidents[0][0]}", status, dist, "Field Staff", ts(3 - i*0.1))
    )
    print(f"  ✅ Alert log: {sname} via {ch} ({status})")

conn.commit()
conn.close()

# ── Generate importable KML demo file ─────────────────────────
kml = '''<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Gaza Demo Staff — Import Me</name>

  <Placemark>
    <name>Ahmed Hassan</name>
    <description>Senior Security Officer</description>
    <ExtendedData>
      <Data name="Department"><value>Security</value></Data>
      <Data name="Phone"><value>+972501234001</value></Data>
      <Data name="TelegramID"><value>@ahmed_h</value></Data>
      <Data name="Status"><value>active</value></Data>
    </ExtendedData>
    <Point><coordinates>34.4847,31.5212,0</coordinates></Point>
  </Placemark>

  <Placemark>
    <name>Sara Khalil</name>
    <description>Medical Coordinator</description>
    <ExtendedData>
      <Data name="Department"><value>Medical</value></Data>
      <Data name="Phone"><value>+972501234002</value></Data>
      <Data name="TelegramID"><value>@sara_k</value></Data>
      <Data name="Status"><value>active</value></Data>
    </ExtendedData>
    <Point><coordinates>34.4721,31.5156,0</coordinates></Point>
  </Placemark>

  <Placemark>
    <name>Omar Nasser</name>
    <description>Logistics Manager</description>
    <ExtendedData>
      <Data name="Department"><value>Logistics</value></Data>
      <Data name="Phone"><value>+972501234003</value></Data>
      <Data name="TelegramID"><value>@omar_n</value></Data>
      <Data name="Status"><value>active</value></Data>
    </ExtendedData>
    <Point><coordinates>34.4612,31.5089,0</coordinates></Point>
  </Placemark>

  <Placemark>
    <name>Layla Ibrahim</name>
    <description>Field Security Officer</description>
    <ExtendedData>
      <Data name="Department"><value>Security</value></Data>
      <Data name="Phone"><value>+972501234004</value></Data>
      <Data name="TelegramID"><value>@layla_i</value></Data>
      <Data name="Status"><value>at-risk</value></Data>
    </ExtendedData>
    <Point><coordinates>34.4902,31.5398,0</coordinates></Point>
  </Placemark>

  <Placemark>
    <name>Yousef Al-Amin</name>
    <description>Emergency Medical Technician</description>
    <ExtendedData>
      <Data name="Department"><value>Medical</value></Data>
      <Data name="Phone"><value>+972501234005</value></Data>
      <Data name="TelegramID"><value>@yousef_a</value></Data>
      <Data name="Status"><value>active</value></Data>
    </ExtendedData>
    <Point><coordinates>34.4534,31.4987,0</coordinates></Point>
  </Placemark>

  <Placemark>
    <name>Restricted Zone Alpha</name>
    <description>No-go zone — active military operations</description>
    <Polygon>
      <outerBoundaryIs><LinearRing>
        <coordinates>
          34.480,31.530 34.500,31.530 34.500,31.515 34.480,31.515 34.480,31.530
        </coordinates>
      </LinearRing></outerBoundaryIs>
    </Polygon>
  </Placemark>

  <Placemark>
    <name>Evacuation Route — South Corridor</name>
    <description>Salah al-Din Road evacuation path</description>
    <LineString>
      <coordinates>
        34.4700,31.5200 34.4650,31.5100 34.4600,31.5000
        34.4550,31.4900 34.4500,31.4800
      </coordinates>
    </LineString>
  </Placemark>

</Document>
</kml>'''

kml_path = os.path.join(script_dir, 'demo_staff.kml')
with open(kml_path, 'w', encoding='utf-8') as f:
    f.write(kml)

print(f"\n  ✅ KML file saved: {kml_path}")
print()
print("=" * 56)
print("🎉 Demo data ready!")
print("=" * 56)
print()
print("Next steps:")
print("  1. Open your dashboard in the browser")
print("  2. Click ⬆ Import → select scripts/demo_staff.kml")
print("  3. 5 staff members + 1 zone + 1 route will appear")
print("  4. Click ⚠ Report Incident to test the alert system")
print()
