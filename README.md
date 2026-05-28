🗺 Palestine Smart Security Dashboard
لوحة تحكم الأمان الذكية لفلسطين
![Python](https://img.shields.io/badge/Python-3.11-blue?logo=python)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111-green?logo=fastapi)
![Leaflet](https://img.shields.io/badge/Leaflet.js-1.9-brightgreen)
![SQLite](https://img.shields.io/badge/SQLite-3-lightblue)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.7-black)
![Deploy](https://img.shields.io/badge/Deploy-Render%20Free-purple)
A real-time emergency alert and staff tracking dashboard for humanitarian organizations operating in Gaza and Palestine.
لوحة تنبيه طارئ وتتبع الموظفين للمنظمات الإنسانية العاملة في غزة وفلسطين.
---
Features
Interactive Leaflet map (Street / Satellite / Terrain)
Import staff from KML, KMZ, CSV, GeoJSON
Up to 15 layers with visibility, color, and opacity controls
Draw markers, routes, and danger zones on the map
Emergency incident reporting with live radius preview
Automatic proximity analysis — who is inside the danger zone?
WhatsApp, Telegram, and SMS alert buttons per staff member
Bulk "Alert All" with channel selection
Full alert history log
Real-time sync via Socket.IO
Dark Mode / Light Mode glassmorphism UI
Export data to KML/KMZ (Google Maps + Maps.me compatible)
---
Tech Stack
Layer	Technology
Map	Leaflet.js 1.9 (free, no API key)
Frontend	HTML5 + CSS3 + JavaScript ES6+
Backend	Python 3.11 + FastAPI
Database	SQLite
Real-time	Socket.IO
Hosting	Render.com (free tier)
---
File Structure
```
gaza-security-dashboard/
├── backend/
│   ├── app.py              Main server (FastAPI + Socket.IO)
│   ├── requirements.txt    Python dependencies
│   ├── .env.example        Environment variables template
│   └── start.sh            Render startup script
├── frontend/
│   ├── index.html          Main HTML page
│   ├── style.css           Glassmorphism styles
│   └── script.js           Map and alert logic
├── scripts/
│   ├── seed_demo.py        Creates demo data
│   └── demo_staff.kml      Sample staff locations in Gaza
├── render.yaml             Render deployment config
├── .gitignore              Files excluded from GitHub
└── README.md               This file
```
---
Deployment (GitHub + Render — No Terminal Needed)
Step 1 — Create GitHub Repository
Go to github.com → Sign in
Click "New" → name it `gaza-security-dashboard`
Set to Public, check "Add a README file"
Click "Create repository"
Step 2 — Upload All Files
For each file: click "Add file" → "Create new file" → type the path → paste content → "Commit new file"
Files to upload (type path exactly as shown):
`backend/requirements.txt`
`backend/app.py`
`backend/.env.example`
`backend/start.sh`
`frontend/index.html`
`frontend/style.css`
`frontend/script.js`
`scripts/seed_demo.py`
`scripts/demo_staff.kml`
`render.yaml`
`.gitignore`
`README.md`
Step 3 — Deploy Backend on Render
Go to render.com → sign in with GitHub
Click "New +" → "Web Service"
Connect your repository
Settings:
Root Directory: `backend`
Runtime: `Python 3`
Build Command: `pip install -r requirements.txt`
Start Command: `uvicorn app:app --host 0.0.0.0 --port $PORT`
Instance Type: `Free`
Add environment variables:
`FRONTEND_URL` = your frontend URL (update after Step 5)
`SECRET_KEY` = any long random string
Click "Create Web Service"
Copy the URL when deployment finishes (e.g. https://gaza-dashboard-api.onrender.com)
Step 4 — Update Frontend Backend URL
On GitHub, open `frontend/script.js`
Click pencil icon to edit
Find: `': '',  // Empty = same origin`
Replace `''` with your backend URL from Step 3
Click "Commit changes"
Step 5 — Deploy Frontend on Render
Click "New +" → "Static Site"
Connect same repository
Settings:
Root Directory: `frontend`
Build Command: `echo "static"`
Publish Directory: `.`
Click "Create Static Site"
Copy the frontend URL
Step 6 — Update CORS
Go to your backend service on Render → Environment tab
Update `FRONTEND_URL` to your frontend URL from Step 5
Click "Save Changes"
Step 7 — Test
Open your frontend URL. Import `scripts/demo_staff.kml` and test the incident alert system.
---
Auto-Deploy Workflow
Every time you edit a file on GitHub:
```
Edit file on GitHub → Render auto-detects change → Rebuilds in 2-4 min → Live
```
---
Load Demo Data
After deployment, to test with sample data:
Download `scripts/demo_staff.kml` from your GitHub repository
Click the Import button (⬆) in the dashboard
Select the KML file
5 staff members, 1 danger zone, and 1 evacuation route appear on the map
---
Connect Real Alert Services
WhatsApp (No setup — works immediately)
Clicking WhatsApp opens a wa.me link with a pre-filled message. No API key needed.
Telegram
Message @BotFather on Telegram → /newbot → get token
Add token as `TELEGRAM_BOT_TOKEN` environment variable on Render
Add staff Telegram chat IDs in their KML ExtendedData as `TelegramID`
SMS via Twilio
Sign up at twilio.com (free trial)
Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` on Render
---
Troubleshooting
Problem	Solution
Map shows grey	Check internet — tiles load from OpenStreetMap
"Sleeping" backend	First request after 15min inactivity takes ~30sec on free tier
Data disappeared	Normal after redeploy — use KML export to save data first
WhatsApp not opening	Allow pop-ups in browser for the dashboard URL
Import fails	Ensure file ends in .kml, .kmz, .csv, or .geojson
---
Keyboard Shortcuts
Key	Action
M	Marker tool
R	Route (polyline) tool
P	Polygon zone tool
D	Distance measure
Esc	Cancel / pan mode
---
Built for humanitarian purposes — for the people of Palestine.
بُني لأغراض إنسانية — لشعب فلسطين
