#!/bin/bash
# ============================================================
# start.sh — Render startup script
# ------------------------------------------------------------
# Render runs this script to start the backend server.
# It uses the PORT environment variable that Render provides.
# ============================================================
exec uvicorn app:app --host 0.0.0.0 --port "${PORT:-8000}"
