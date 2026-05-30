// ============================================================
// script.js — WATCH-ME Intelligent Security System — v5
// ------------------------------------------------------------
// Complete rewrite with:
//   1.  JWT Authentication (login, register, email confirm)
//   2.  Supabase PostgreSQL — all data persists permanently
//   3.  Layer expand/collapse showing all features inside
//   4.  FIXED sidebar toggle
//   5.  FIXED "click map to set incident location"
//   6.  FIXED glass sidebar visual enhancements in CSS
//   7.  Layer selector for incident proximity analysis
//   8.  Delete alerts from history
//   9.  All Phase 1-4 features preserved
// ============================================================

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  BACKEND_URL: (window.location.hostname === 'localhost' ||
                window.location.hostname === '127.0.0.1')
    ? 'http://localhost:8000'
     : 'https://chatclaude-ucfe.onrender.com',  // ← Add your backend URL here
    : '',   // empty = same origin on Render

  DEFAULT_LAT:  31.35,
  DEFAULT_LNG:  34.30,
  DEFAULT_ZOOM: 10,
  MAX_LAYERS:   15,

  COLORS: [
    '#3b82f6','#ef4444','#22c55e','#f97316','#a855f7',
    '#eab308','#06b6d4','#ec4899','#14b8a6','#84cc16',
    '#f43f5e','#8b5cf6'
  ]
};

// ── AUTH STATE ────────────────────────────────────────────────
const AUTH = {
  token: localStorage.getItem('wm_token') || null,
  user:  JSON.parse(localStorage.getItem('wm_user') || 'null')
};

function authHeaders() {
  return AUTH.token
    ? { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH.token}` }
    : { 'Content-Type': 'application/json' };
}

// ── APP STATE ─────────────────────────────────────────────────
const STATE = {
  layers:           [],
  activeLayerId:    null,
  incidents:        [],
  alertLogs:        [],
  currentTool:      'pan',
  pendingMarkerLL:  null,
  measurePoints:    [],
  measureLayer:     null,
  importedFeatures: [],
  editingFeature:   null,
};

// Phase 3 state
const P3 = {
  selectedIncType: 'airstrike',
  radiusCircle:    null,
  incidentMarker:  null,
  pickingLocation: false,
  lastIncident:    null,
  lastEndangered:  [],
  socket:          null,
  flashLayers:     [],
};

const INC_TYPES = {
  airstrike:      { label:'Airstrike',       icon:'💥', color:'#ef4444' },
  evacuation:     { label:'Evacuation Order', icon:'🚨', color:'#f97316' },
  ground_op:      { label:'Ground Op',        icon:'⚔',  color:'#eab308' },
  security_alert: { label:'Security Alert',   icon:'🔴', color:'#a855f7' },
  shelling:       { label:'Shelling',         icon:'🔥', color:'#ef4444' },
  other:          { label:'Other',            icon:'📍', color:'#64748b' },
};

// ── MAP ───────────────────────────────────────────────────────
let map, tileLayers, drawnItems, drawControl;

function initMap() {
  map = L.map('map', {
    center: [CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LNG],
    zoom:   CONFIG.DEFAULT_ZOOM,
    zoomControl: true
  });

  tileLayers = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 19
    }),
    satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri', maxZoom: 19 }
    ),
    terrain: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri', maxZoom: 19 }
    )
  };
  tileLayers.osm.addTo(map);

  drawnItems = new L.FeatureGroup().addTo(map);
  drawControl = new L.Control.Draw({
    draw: {
      marker: false, circle: false, rectangle: false, circlemarker: false,
      polyline: { shapeOptions: { color: '#3b82f6', weight: 3 } },
      polygon:  { shapeOptions: { color: '#ef4444', weight: 2, fillOpacity: 0.25 } }
    },
    edit: { featureGroup: drawnItems, remove: true }
  });

  map.on('click', handleMapClick);
  map.on(L.Draw.Event.CREATED, handleDrawCreated);
}

function switchTile(name) {
  Object.values(tileLayers).forEach(tl => { if (map.hasLayer(tl)) map.removeLayer(tl); });
  tileLayers[name].addTo(map);
  document.querySelectorAll('.tile-btn').forEach(b => b.classList.toggle('active', b.dataset.tile === name));
}

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════════════════════════

function showLogin()    { document.getElementById('login-page').classList.remove('hidden');    document.getElementById('register-page').classList.add('hidden');    document.getElementById('resend-page').classList.add('hidden'); }
function showRegister() { document.getElementById('register-page').classList.remove('hidden'); document.getElementById('login-page').classList.add('hidden');     document.getElementById('resend-page').classList.add('hidden'); }
function showResend()   { document.getElementById('resend-page').classList.remove('hidden');   document.getElementById('login-page').classList.add('hidden');     document.getElementById('register-page').classList.add('hidden'); }

function setAuthMsg(elId, msg, type='error') {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = `auth-message ${type}`;
  el.classList.remove('hidden');
}

function togglePass(inputId, btn) {
  const inp = document.getElementById(inputId);
  inp.type  = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

async function doLogin() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn      = document.getElementById('login-btn');
  if (!email || !password) { setAuthMsg('auth-message','Please fill in all fields'); return; }

  btn.textContent = 'Signing in...'; btn.disabled = true;
  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'Login failed');

    AUTH.token = data.token;
    AUTH.user  = data.user;
    localStorage.setItem('wm_token', data.token);
    localStorage.setItem('wm_user',  JSON.stringify(data.user));
    enterApp();
  } catch (e) {
    setAuthMsg('auth-message', e.message);
  } finally {
    btn.textContent = 'Sign In'; btn.disabled = false;
  }
}

async function doRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const btn      = document.getElementById('register-btn');
  if (!name || !email || !password) { setAuthMsg('reg-message','Please fill in all fields'); return; }

  btn.textContent = 'Creating...'; btn.disabled = true;
  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'Registration failed');

    setAuthMsg('reg-message',
      `Account created! Check your email to confirm, then sign in.\n(Dev: confirmation link logged in server console)`,
      'success');

    // In dev mode the confirm_url is returned — show it
    if (data.confirm_url) {
      const link = document.createElement('a');
      link.href = data.confirm_url; link.target = '_blank';
      link.style.cssText = 'color:#60a5fa;font-size:11px;display:block;margin-top:8px;word-break:break-all';
      link.textContent = '▶ Click here to confirm (dev mode)';
      document.getElementById('reg-message').appendChild(link);
    }
  } catch (e) {
    setAuthMsg('reg-message', e.message);
  } finally {
    btn.textContent = 'Create Account'; btn.disabled = false;
  }
}

async function doResend() {
  const email = document.getElementById('resend-email').value.trim();
  const btn   = document.getElementById('resend-btn');
  if (!email) { setAuthMsg('resend-message','Please enter your email'); return; }

  btn.textContent = 'Sending...'; btn.disabled = true;
  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/auth/resend-confirmation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await resp.json();
    setAuthMsg('resend-message', data.message || 'Check your email.', 'success');
    if (data.confirm_url) {
      const link = document.createElement('a');
      link.href = data.confirm_url; link.target = '_blank';
      link.style.cssText = 'color:#60a5fa;font-size:11px;display:block;margin-top:8px;word-break:break-all';
      link.textContent = '▶ Click here to confirm (dev mode)';
      document.getElementById('resend-message').appendChild(link);
    }
  } catch (e) {
    setAuthMsg('resend-message', e.message);
  } finally {
    btn.textContent = 'Resend Email'; btn.disabled = false;
  }
}

function logout() {
  AUTH.token = null; AUTH.user = null;
  localStorage.removeItem('wm_token'); localStorage.removeItem('wm_user');
  closeAllContextMenus();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('auth-container').classList.remove('hidden');
  showLogin();
  // Reset state
  STATE.layers = []; STATE.activeLayerId = null;
  if (map) { map.eachLayer(l => { if (!(l instanceof L.TileLayer)) map.removeLayer(l); }); }
  document.getElementById('layer-list').innerHTML = '';
}

// Check for ?confirmed=1 in URL
function checkConfirmParam() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('confirmed') === '1') {
    setAuthMsg('auth-message', '✅ Email confirmed! You can now sign in.', 'success');
    window.history.replaceState({}, '', window.location.pathname);
  }
  if (params.get('confirm')) {
    // Redirect to backend to process confirmation
    window.location.href = `${CONFIG.BACKEND_URL}/api/auth/confirm?token=${params.get('confirm')}`;
  }
}

function enterApp() {
  document.getElementById('auth-container').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Show user name
  if (AUTH.user) {
    document.getElementById('user-menu-name').textContent  = AUTH.user.name || 'User';
    document.getElementById('user-menu-email').textContent = AUTH.user.email || '';
  }

  // Init map if not already done
  if (!map) initMap();

  // Load persisted layers from DB
  loadLayersFromDB();

  // Connect socket
  connectSocket();

  showToast(`Welcome back, ${AUTH.user?.name || 'User'}!`, 'success');
}

// ═══════════════════════════════════════════════════════════════
// DATABASE — LAYER PERSISTENCE
// ═══════════════════════════════════════════════════════════════

async function loadLayersFromDB() {
  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/layers`, { headers: authHeaders() });
    if (!resp.ok) { if (resp.status === 401) { logout(); return; } throw new Error('DB error'); }
    const dbLayers = await resp.json();

    STATE.layers = [];
    // Clear map
    if (map) map.eachLayer(l => { if (!(l instanceof L.TileLayer)) map.removeLayer(l); });
    drawnItems = new L.FeatureGroup().addTo(map);

    if (dbLayers.length === 0) {
      // Create a default first layer
      await apiCreateLayer('My Locations', CONFIG.COLORS[0]);
    } else {
      for (const dl of dbLayers) {
        const leafletGroup = L.layerGroup().addTo(map);
        const layer = {
          id: dl.id, name: dl.name, color: dl.color,
          visible: dl.visible, opacity: dl.opacity,
          styleField: dl.style_field || '',
          styleRules: dl.style_rules || {},
          features: [],
          leafletGroup
        };
        // Add features from DB
        for (const feat of (dl.features || [])) {
          const f = normaliseDBFeature(feat);
          layer.features.push(f);
          renderFeatureOnMap(f, layer);
        }
        STATE.layers.push(layer);
      }
      STATE.activeLayerId = STATE.layers[0]?.id || null;
    }

    renderLayerList();
    showToast(`Loaded ${STATE.layers.length} layer(s) from database`, 'success');
  } catch (e) {
    console.error('Load layers error:', e);
    showToast('Could not load layers: ' + e.message, 'error');
    // Fall back to a local-only layer
    createLayerLocal('My Locations', CONFIG.COLORS[0]);
  }
}

function normaliseDBFeature(dbFeat) {
  return {
    id:          dbFeat.id,
    type:        dbFeat.type,
    name:        dbFeat.name || '',
    description: dbFeat.description || '',
    lat:         dbFeat.lat,
    lon:         dbFeat.lon,
    coords:      Array.isArray(dbFeat.coords) ? dbFeat.coords : [],
    color:       dbFeat.color || '#3b82f6',
    stroke_color: dbFeat.stroke_color || '#3b82f6',
    fill_color:  dbFeat.fill_color || '#3b82f6',
    fill_opacity: dbFeat.fill_opacity || 0.35,
    extended:    dbFeat.extended || {},
    leafletRef:  null
  };
}

async function apiCreateLayer(name, color) {
  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/layers`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name, color })
    });
    const dl = await resp.json();
    const leafletGroup = L.layerGroup().addTo(map);
    const layer = { id: dl.id, name: dl.name, color: dl.color, visible: true, opacity: 1.0, styleField: '', styleRules: {}, features: [], leafletGroup };
    STATE.layers.push(layer);
    if (!STATE.activeLayerId) STATE.activeLayerId = dl.id;
    renderLayerList();
    return layer;
  } catch (e) {
    showToast('Could not create layer: ' + e.message, 'error');
    return null;
  }
}

async function apiSaveFeature(feature, layerId) {
  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/layers/${layerId}/features`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        type: feature.type, name: feature.name, description: feature.description,
        lat: feature.lat, lon: feature.lon,
        coords: feature.coords || [],
        color: feature.color, stroke_color: feature.stroke_color || feature.color,
        fill_color: feature.fill_color || feature.color,
        fill_opacity: feature.fill_opacity || 0.35,
        extended: feature.extended || {}
      })
    });
    if (resp.ok) {
      const saved = await resp.json();
      feature.id = saved.id; // use DB id
    }
  } catch (e) { console.warn('Could not save feature to DB:', e.message); }
}

async function apiDeleteFeature(featureId) {
  try {
    await fetch(`${CONFIG.BACKEND_URL}/api/features/${featureId}`, {
      method: 'DELETE', headers: authHeaders()
    });
  } catch (e) { console.warn('Could not delete feature from DB:', e.message); }
}

async function apiUpdateLayer(layer) {
  try {
    await fetch(`${CONFIG.BACKEND_URL}/api/layers/${layer.id}`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({
        name: layer.name, color: layer.color,
        visible: layer.visible, opacity: layer.opacity,
        style_field: layer.styleField, style_rules: layer.styleRules
      })
    });
  } catch (e) { console.warn('Could not update layer in DB:', e.message); }
}

async function apiDeleteLayer(layerId) {
  try {
    await fetch(`${CONFIG.BACKEND_URL}/api/layers/${layerId}`, {
      method: 'DELETE', headers: authHeaders()
    });
  } catch (e) { console.warn('Could not delete layer from DB:', e.message); }
}

// ═══════════════════════════════════════════════════════════════
// LAYER MANAGEMENT  (local state + DB sync)
// ═══════════════════════════════════════════════════════════════

function createLayerLocal(name, color) {
  if (STATE.layers.length >= CONFIG.MAX_LAYERS) { showToast('Max 15 layers reached','error'); return null; }
  const id = 'layer_' + Date.now();
  const leafletGroup = L.layerGroup().addTo(map);
  const layer = { id, name, color: color || CONFIG.COLORS[STATE.layers.length % CONFIG.COLORS.length], visible: true, opacity: 1.0, styleField: '', styleRules: {}, features: [], leafletGroup };
  STATE.layers.push(layer);
  if (!STATE.activeLayerId) STATE.activeLayerId = id;
  renderLayerList();
  return layer;
}

async function createLayer(name, color) {
  if (STATE.layers.length >= CONFIG.MAX_LAYERS) { showToast('Max 15 layers reached','error'); return null; }
  if (AUTH.token) return await apiCreateLayer(name, color);
  return createLayerLocal(name, color);
}

function getLayerById(id) { return STATE.layers.find(l => l.id === id); }

async function deleteLayer(id) {
  const layer = getLayerById(id);
  if (!layer) return;
  map.removeLayer(layer.leafletGroup);
  STATE.layers = STATE.layers.filter(l => l.id !== id);
  if (STATE.activeLayerId === id) STATE.activeLayerId = STATE.layers[0]?.id || null;
  if (AUTH.token) await apiDeleteLayer(id);
  renderLayerList();
  showToast(`Layer "${layer.name}" deleted`, 'info');
}

function toggleLayerVisibility(id) {
  const layer = getLayerById(id);
  if (!layer) return;
  layer.visible = !layer.visible;
  layer.visible ? map.addLayer(layer.leafletGroup) : map.removeLayer(layer.leafletGroup);
  if (AUTH.token) apiUpdateLayer(layer);
  renderLayerList();
}

function setLayerOpacity(id, opacity) {
  const layer = getLayerById(id);
  if (!layer) return;
  layer.opacity = parseFloat(opacity);
  layer.leafletGroup.eachLayer(ll => {
    if (ll.setOpacity) ll.setOpacity(layer.opacity);
    if (ll.setStyle)   ll.setStyle({ opacity: layer.opacity, fillOpacity: layer.opacity * 0.4 });
  });
}

// ── RENDER LAYER LIST (with expand/collapse) ──────────────────
function renderLayerList() {
  const list = document.getElementById('layer-list');
  list.innerHTML = '';

  if (STATE.layers.length === 0) {
    list.innerHTML = `<div class="text-muted" style="padding:18px 4px;text-align:center;line-height:1.8">No layers yet.<br>Click "+ Add new layer"<br>or import a KML/KMZ file.</div>`;
    updateLayerDropdowns();
    updateIncidentLayerCheckboxes();
    return;
  }

  STATE.layers.forEach(layer => {
    const item = document.createElement('div');
    item.className = 'layer-item' + (layer.id === STATE.activeLayerId ? ' active-layer' : '');
    item.dataset.layerId = layer.id;

    // Feature type icon helper
    const ftypeIcon = t => ({ point:'📍', polygon:'⬡', line:'〰' }[t] || '●');

    // Feature rows HTML
    const featRows = layer.features.map(feat => `
      <div class="feature-row" data-feat-id="${feat.id}" data-layer-id="${layer.id}">
        <span class="feature-row-icon">${ftypeIcon(feat.type)}</span>
        <span class="feature-row-name" title="${escapeHtml(feat.name)}">${escapeHtml(feat.name || 'Unnamed')}</span>
        <button class="feature-vis-btn"  title="Toggle visibility"
                onclick="toggleFeatureVisibility('${feat.id}','${layer.id}',this)">👁</button>
        <button class="feature-edit-btn" title="Edit"
                onclick="openFeatureEdit('${feat.id}','${layer.id}')">✏</button>
        <button class="feature-del-btn"  title="Delete"
                onclick="deleteFeatureById('${feat.id}','${layer.id}')">🗑</button>
      </div>`).join('');

    item.innerHTML = `
      <!-- Layer header row -->
      <div class="layer-header" onclick="selectLayer('${layer.id}')">
        <button class="layer-vis-btn ${layer.visible ? '' : 'hidden-layer'}"
                onclick="event.stopPropagation();toggleLayerVisibility('${layer.id}')"
                title="${layer.visible ? 'Hide' : 'Show'}">
          ${layer.visible ? '👁' : '🚫'}
        </button>
        <div class="layer-color-dot" style="background:${layer.color}"
             onclick="event.stopPropagation();openLayerNameModal('${layer.id}')"
             title="Change colour"></div>
        <span class="layer-name" ondblclick="startRenameLayer('${layer.id}',this)">
          ${escapeHtml(layer.name)}
        </span>
        <span class="layer-count">${layer.features.length}</span>
        <!-- Expand/collapse features button -->
        <button class="layer-expand-btn" id="expand-btn-${layer.id}"
                onclick="event.stopPropagation();toggleLayerExpand('${layer.id}')"
                title="Show/hide features">›</button>
        <button class="layer-menu-btn"
                onclick="event.stopPropagation();openLayerMenu(event,'${layer.id}')"
                title="Layer options">⋮</button>
      </div>
      <!-- Opacity slider -->
      <div class="layer-opacity-row">
        <span class="layer-opacity-label">${Math.round(layer.opacity*100)}%</span>
        <input type="range" class="opacity-slider" min="0" max="1" step="0.05"
               value="${layer.opacity}"
               oninput="setLayerOpacity('${layer.id}',this.value);this.previousElementSibling.textContent=Math.round(this.value*100)+'%'"
               onchange="apiUpdateLayer(getLayerById('${layer.id}'))">
      </div>
      <!-- Collapsible feature list -->
      <div class="layer-features-list" id="features-list-${layer.id}">
        ${layer.features.length === 0
          ? '<div class="text-muted" style="padding:8px 20px;font-size:11px">No features yet</div>'
          : featRows}
      </div>`;

    list.appendChild(item);
  });

  updateLayerDropdowns();
  updateIncidentLayerCheckboxes();
}

function toggleLayerExpand(layerId) {
  const list = document.getElementById(`features-list-${layerId}`);
  const btn  = document.getElementById(`expand-btn-${layerId}`);
  if (!list) return;
  const isOpen = list.classList.toggle('open');
  if (btn) btn.classList.toggle('expanded', isOpen);
}

function toggleFeatureVisibility(featId, layerId, btn) {
  const layer = getLayerById(layerId);
  if (!layer) return;
  const feat = layer.features.find(f => f.id === featId);
  if (!feat || !feat.leafletRef) return;
  const isVisible = layer.leafletGroup.hasLayer(feat.leafletRef);
  if (isVisible) {
    layer.leafletGroup.removeLayer(feat.leafletRef);
    btn.style.opacity = '0.35';
    btn.title = 'Show';
  } else {
    layer.leafletGroup.addLayer(feat.leafletRef);
    btn.style.opacity = '1';
    btn.title = 'Hide';
  }
}

function selectLayer(id) { STATE.activeLayerId = id; renderLayerList(); }

function startRenameLayer(id, el) {
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'form-input'; inp.value = el.textContent.trim();
  inp.style.cssText = 'flex:1;padding:2px 6px;font-size:13px;height:24px';
  const done = () => {
    const layer = getLayerById(id);
    if (layer && inp.value.trim()) { layer.name = inp.value.trim(); if (AUTH.token) apiUpdateLayer(layer); }
    renderLayerList();
  };
  inp.addEventListener('blur', done);
  inp.addEventListener('keydown', e => { if (e.key==='Enter') inp.blur(); if (e.key==='Escape') renderLayerList(); });
  el.style.display = 'none';
  el.parentNode.insertBefore(inp, el.nextSibling);
  inp.focus(); inp.select();
}

// ── Layer context menu ─────────────────────────────────────────
function openLayerMenu(event, layerId) {
  event.stopPropagation();
  closeAllContextMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu'; menu.id = 'layer-ctx-menu';
  menu.style.left = event.clientX + 'px';
  menu.style.top  = Math.min(event.clientY, window.innerHeight - 200) + 'px';
  menu.innerHTML = `
    <div class="context-menu-item" onclick="openLayerNameModal('${layerId}')">✏️ Rename / Recolour</div>
    <div class="context-menu-item" onclick="duplicateLayer('${layerId}');closeAllContextMenus()">📋 Duplicate</div>
    <div class="context-menu-item" onclick="openStyleFieldModal('${layerId}');closeAllContextMenus()">🎨 Style by Field</div>
    <div class="context-menu-item" onclick="exportSingleLayer('${layerId}');closeAllContextMenus()">⬇ Export this layer</div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" onclick="deleteLayer('${layerId}');closeAllContextMenus()">🗑 Delete Layer</div>`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeAllContextMenus, {once:true}), 10);
}

function closeAllContextMenus() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
  const ud = document.getElementById('user-menu-dropdown');
  if (ud) ud.classList.add('hidden');
}

async function duplicateLayer(id) {
  const orig = getLayerById(id);
  if (!orig) return;
  const copy = await createLayer(orig.name + ' (copy)', orig.color);
  if (!copy) return;
  for (const feat of orig.features) {
    const fc = { ...JSON.parse(JSON.stringify(feat)), id: 'feat_'+Date.now()+'_'+Math.random(), leafletRef: null };
    copy.features.push(fc);
    renderFeatureOnMap(fc, copy);
    if (AUTH.token) await apiSaveFeature(fc, copy.id);
  }
  renderLayerList();
  showToast(`Layer "${orig.name}" duplicated`, 'success');
}

// ── Layer Name / Colour Modal ──────────────────────────────────
function openLayerNameModal(existingId = null) {
  const modal = document.getElementById('layer-name-modal');
  const title = document.getElementById('layer-name-modal-title');
  const input = document.getElementById('layer-name-input');
  const swatches = document.getElementById('layer-color-swatches');
  let selectedColor = existingId ? (getLayerById(existingId)?.color || CONFIG.COLORS[0]) : CONFIG.COLORS[STATE.layers.length % CONFIG.COLORS.length];

  title.textContent = existingId ? 'Rename Layer' : 'New Layer';
  input.value = existingId ? (getLayerById(existingId)?.name || '') : '';
  renderColorSwatches(swatches, selectedColor, c => { selectedColor = c; });
  showModal('layer-name-modal');
  input.focus();

  document.getElementById('layer-name-confirm-btn').onclick = async () => {
    const name = input.value.trim();
    if (!name) { showToast('Please enter a name','error'); return; }
    if (existingId) {
      const layer = getLayerById(existingId);
      if (layer) { layer.name = name; layer.color = selectedColor; if (AUTH.token) await apiUpdateLayer(layer); }
      renderLayerList();
    } else {
      await createLayer(name, selectedColor);
    }
    closeModal('layer-name-modal');
    showToast(existingId ? 'Layer updated' : `Layer "${name}" created`, 'success');
  };
}

// ── Update layer dropdowns in modals ──────────────────────────
function updateLayerDropdowns() {
  ['export-layer-select','marker-layer-select','feature-move-layer','import-layer-select'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const isImport = id === 'import-layer-select';
    const isExport = id === 'export-layer-select';
    el.innerHTML = (isImport ? '<option value="__new__">➕ Create new layer</option>' : '') +
                   (isExport ? '<option value="all">All Layers</option>' : '') +
      STATE.layers.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
    if (!isImport && !isExport && STATE.activeLayerId) el.value = STATE.activeLayerId;
  });
}

function updateIncidentLayerCheckboxes() {
  ['inc-layer-checkboxes','p3-layer-checkboxes'].forEach(id => {
    const box = document.getElementById(id);
    if (!box) return;
    if (STATE.layers.length === 0) {
      box.innerHTML = '<div class="text-muted" style="font-size:11px;padding:4px 0">Add layers first</div>';
      return;
    }
    box.innerHTML = STATE.layers.map(l => `
      <label class="layer-check-item">
        <input type="checkbox" class="layer-check-cb" value="${l.id}">
        <span class="layer-check-dot" style="background:${l.color}"></span>
        ${escapeHtml(l.name)} (${l.features.filter(f=>f.type==='point').length} staff)
      </label>`).join('');
  });
}

// ═══════════════════════════════════════════════════════════════
// FEATURE RENDERING
// ═══════════════════════════════════════════════════════════════

function renderFeatureOnMap(feature, layer) {
  let ll;
  const color = resolveFeatureColor(feature, layer);
  const op    = layer.opacity;

  if (feature.type === 'point') {
    ll = L.circleMarker([feature.lat, feature.lon], {
      radius: 8, color: '#fff', weight: 2,
      fillColor: color, fillOpacity: 0.9, opacity: op
    });
    ll.bindPopup(() => buildPopupHTML(feature, layer));

  } else if (feature.type === 'polygon' && feature.coords?.length) {
    ll = L.polygon(feature.coords.map(c => [c[0],c[1]]), {
      color: feature.stroke_color || color, weight: 2,
      fillColor: feature.fill_color || color,
      fillOpacity: (feature.fill_opacity || 0.35) * op, opacity: op
    });
    ll.bindPopup(() => buildPopupHTML(feature, layer));

  } else if (feature.type === 'line' && feature.coords?.length) {
    ll = L.polyline(feature.coords.map(c => [c[0],c[1]]), {
      color: feature.stroke_color || color, weight: 3, opacity: op
    });
    ll.bindPopup(() => buildPopupHTML(feature, layer));
  }

  if (ll) { feature.leafletRef = ll; layer.leafletGroup.addLayer(ll); }
}

function resolveFeatureColor(feature, layer) {
  if (layer.styleField && feature.extended) {
    const val = feature.extended[layer.styleField];
    if (val && layer.styleRules[val]) return layer.styleRules[val];
  }
  return feature.color || layer.color;
}

function buildPopupHTML(feature, layer) {
  const coords = feature.type === 'point'
    ? `${feature.lat?.toFixed(5)}, ${feature.lon?.toFixed(5)}`
    : `${feature.coords?.length || 0} coordinate points`;
  const extHtml = Object.entries(feature.extended || {}).map(([k,v]) =>
    `<div class="feat-popup-kv"><span class="feat-popup-key">${escapeHtml(k)}</span><span class="feat-popup-val">${escapeHtml(String(v))}</span></div>`
  ).join('');
  return `<div class="feat-popup">
    <div class="feat-popup-name">${escapeHtml(feature.name||'Unnamed')}</div>
    <div class="feat-popup-type">${feature.type} · ${escapeHtml(layer.name)}</div>
    ${feature.description?`<div class="feat-popup-desc">${escapeHtml(feature.description)}</div>`:''}
    <div class="feat-popup-coords">${coords}</div>
    ${extHtml?`<div class="feat-popup-data">${extHtml}</div>`:''}
    <div class="feat-popup-actions">
      <button class="btn btn-secondary btn-sm" onclick="openFeatureEdit('${feature.id}','${layer.id}')">Edit</button>
      <button class="btn btn-danger btn-sm"    onclick="deleteFeatureById('${feature.id}','${layer.id}')">Delete</button>
    </div></div>`;
}

async function deleteFeatureById(featureId, layerId) {
  const layer = getLayerById(layerId);
  if (!layer) return;
  const feat = layer.features.find(f => f.id === featureId);
  if (!feat) return;
  if (feat.leafletRef) layer.leafletGroup.removeLayer(feat.leafletRef);
  layer.features = layer.features.filter(f => f.id !== featureId);
  if (AUTH.token) await apiDeleteFeature(featureId);
  renderLayerList();
  showToast('Feature deleted','info');
}

function openFeatureEdit(featureId, layerId) {
  const layer   = getLayerById(layerId);
  const feature = layer?.features.find(f => f.id === featureId);
  if (!feature) return;
  STATE.editingFeature = { feature, layerId };

  document.getElementById('feature-modal-title').textContent = `Edit ${feature.type}`;
  document.getElementById('feature-edit-name').value  = feature.name || '';
  document.getElementById('feature-edit-desc').value  = feature.description || '';
  document.getElementById('feature-edit-coords').textContent =
    feature.type === 'point' ? `${feature.lat?.toFixed(6)}, ${feature.lon?.toFixed(6)}` : `${feature.coords?.length||0} points`;

  const moveSelect = document.getElementById('feature-move-layer');
  moveSelect.innerHTML = STATE.layers.map(l =>
    `<option value="${l.id}" ${l.id===layerId?'selected':''}>${escapeHtml(l.name)}</option>`
  ).join('');

  let selColor = feature.color;
  renderColorSwatches(document.getElementById('feature-color-swatches'), selColor, c => { selColor = c; });

  const extDiv = document.getElementById('feature-extended-data');
  extDiv.innerHTML = Object.keys(feature.extended||{}).length
    ? `<div class="panel-section-title">Properties</div>
       <div class="feat-popup-data">${Object.entries(feature.extended).map(([k,v])=>
          `<div class="feat-popup-kv"><span class="feat-popup-key">${escapeHtml(k)}</span><span class="feat-popup-val">${escapeHtml(String(v))}</span></div>`
       ).join('')}</div>` : '';

  showModal('feature-modal');

  document.getElementById('feature-save-btn').onclick = async () => {
    feature.name = document.getElementById('feature-edit-name').value.trim();
    feature.description = document.getElementById('feature-edit-desc').value.trim();
    feature.color = selColor;
    const newLayId = document.getElementById('feature-move-layer').value;
    if (newLayId !== layerId) {
      const newLay = getLayerById(newLayId);
      if (newLay) {
        layer.features = layer.features.filter(f => f.id !== featureId);
        if (feature.leafletRef) layer.leafletGroup.removeLayer(feature.leafletRef);
        feature.leafletRef = null;
        newLay.features.push(feature);
        renderFeatureOnMap(feature, newLay);
      }
    } else {
      if (feature.leafletRef) layer.leafletGroup.removeLayer(feature.leafletRef);
      feature.leafletRef = null;
      renderFeatureOnMap(feature, layer);
    }
    if (AUTH.token) {
      try {
        await fetch(`${CONFIG.BACKEND_URL}/api/features/${feature.id}`, {
          method: 'PUT', headers: authHeaders(),
          body: JSON.stringify({ name: feature.name, description: feature.description, color: feature.color, layer_id: newLayId, extended: feature.extended||{} })
        });
      } catch(e) { console.warn('Update feature DB error:', e); }
    }
    renderLayerList();
    closeModal('feature-modal');
    showToast('Feature updated','success');
  };

  document.getElementById('feature-delete-btn').onclick = () => {
    deleteFeatureById(featureId, layerId);
    closeModal('feature-modal');
  };
}

// ═══════════════════════════════════════════════════════════════
// DRAWING TOOLS
// ═══════════════════════════════════════════════════════════════

let activeDrawHandler = null;

function setActiveTool(toolName) {
  if (activeDrawHandler) { activeDrawHandler.disable(); activeDrawHandler = null; }
  STATE.currentTool = toolName;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const tb = document.getElementById('tool-' + toolName);
  if (tb) tb.classList.add('active');
  const mc = map.getContainer();
  mc.className = mc.className.replace(/tool-\S+/g,'').replace(/picking-location/g,'').trim();
  if (toolName !== 'measure' && STATE.measureLayer) {
    map.removeLayer(STATE.measureLayer); STATE.measureLayer = null; STATE.measurePoints = [];
    document.getElementById('measure-display').classList.remove('visible');
  }
  switch(toolName) {
    case 'marker':   mc.classList.add('tool-marker'); showToast('Click map to place marker','info'); break;
    case 'polyline':
      mc.classList.add('tool-polyline');
      activeDrawHandler = new L.Draw.Polyline(map, { shapeOptions:{color:getActiveLayerColor(),weight:3} });
      activeDrawHandler.enable(); showToast('Click points. Double-click to finish.','info'); break;
    case 'polygon':
      mc.classList.add('tool-polygon');
      activeDrawHandler = new L.Draw.Polygon(map, { shapeOptions:{color:getActiveLayerColor(),weight:2,fillOpacity:0.25} });
      activeDrawHandler.enable(); showToast('Click corners. Double-click to close.','info'); break;
    case 'measure':
      mc.classList.add('tool-measure');
      STATE.measurePoints = []; STATE.measureLayer = L.layerGroup().addTo(map);
      showToast('Click points to measure distance','info'); break;
    case 'streetview':
      showToast('Click map to open Street View','info'); break;
  }
}

function getActiveLayerColor() { return getLayerById(STATE.activeLayerId)?.color || '#3b82f6'; }

// ── FIXED: unified map click handler ──────────────────────────
function handleMapClick(e) {
  const { lat, lng } = e.latlng;

  // Phase 3: picking incident location
  if (P3.pickingLocation) {
    document.getElementById('p3-inc-lat').value = lat.toFixed(6);
    document.getElementById('p3-inc-lon').value = lng.toFixed(6);
    P3.pickingLocation = false;
    map.getContainer().classList.remove('picking-location');
    document.getElementById('p3-pick-status').textContent = `✅ Location set: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const radius = parseInt(document.getElementById('p3-radius-slider').value);
    drawPreviewCircle(lat, lng, radius);
    showModal('incident-form-modal');
    showToast(`Location set: ${lat.toFixed(4)}, ${lng.toFixed(4)}`,'info');
    return;
  }

  // Phase 2: incident pick from sidebar
  if (STATE.pendingIncidentPick) {
    document.getElementById('inc-lat').value = lat.toFixed(6);
    document.getElementById('inc-lon').value = lng.toFixed(6);
    STATE.pendingIncidentPick = false;
    map.getContainer().classList.remove('picking-location');
    showToast(`Location set: ${lat.toFixed(4)}, ${lng.toFixed(4)}`,'info');
    return;
  }

  if (STATE.currentTool === 'marker') {
    STATE.pendingMarkerLL = { lat, lng };
    const sel = document.getElementById('marker-layer-select');
    sel.innerHTML = STATE.layers.map(l=>
      `<option value="${l.id}" ${l.id===STATE.activeLayerId?'selected':''}>${escapeHtml(l.name)}</option>`
    ).join('');
    let selColor = getActiveLayerColor();
    renderColorSwatches(document.getElementById('marker-color-swatches'), selColor, c=>{selColor=c;});
    document.getElementById('marker-name').value = '';
    document.getElementById('marker-desc').value = '';
    document.getElementById('marker-save-btn').onclick = async () => {
      const name  = document.getElementById('marker-name').value.trim();
      const desc  = document.getElementById('marker-desc').value.trim();
      const layId = document.getElementById('marker-layer-select').value;
      if (!name) { showToast('Please enter a name','error'); return; }
      const layer = getLayerById(layId);
      if (!layer) return;
      const feat = { id:'feat_'+Date.now(), type:'point', name, description:desc, lat:STATE.pendingMarkerLL.lat, lon:STATE.pendingMarkerLL.lng, color:selColor, extended:{}, leafletRef:null };
      layer.features.push(feat);
      renderFeatureOnMap(feat, layer);
      if (AUTH.token) await apiSaveFeature(feat, layId);
      renderLayerList();
      closeModal('marker-modal');
      showToast(`Marker "${name}" added`,'success');
    };
    showModal('marker-modal');
    return;
  }

  if (STATE.currentTool === 'measure') {
    STATE.measurePoints.push([lat,lng]);
    L.circleMarker([lat,lng],{radius:5,color:'#06b6d4',fillColor:'#06b6d4',fillOpacity:1}).addTo(STATE.measureLayer);
    if (STATE.measurePoints.length >= 2) {
      L.polyline(STATE.measurePoints,{color:'#06b6d4',dashArray:'6,4',weight:2}).addTo(STATE.measureLayer);
      const d = calcTotalDist(STATE.measurePoints);
      const disp = document.getElementById('measure-display');
      disp.classList.add('visible');
      disp.textContent = d>=1000 ? `📏 ${(d/1000).toFixed(2)} km` : `📏 ${Math.round(d)} m`;
    }
    return;
  }

  if (STATE.currentTool === 'streetview') {
    document.getElementById('streetview-coords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    showModal('streetview-modal');
    return;
  }
}

function handleDrawCreated(e) {
  drawnItems.clearLayers();
  const activeLayer = getLayerById(STATE.activeLayerId);
  if (!activeLayer) { showToast('Please select a layer first','error'); return; }
  let feat;
  if (e.layerType === 'polyline') {
    const coords = e.layer.getLatLngs().map(ll=>[ll.lat,ll.lng]);
    const dist   = calcTotalDist(coords);
    feat = { id:'feat_'+Date.now(), type:'line', name:`Route (${dist>=1000?(dist/1000).toFixed(1)+'km':Math.round(dist)+'m'})`, description:'', coords, stroke_color:activeLayer.color, color:activeLayer.color, extended:{}, leafletRef:null };
  } else if (e.layerType === 'polygon') {
    const coords = e.layer.getLatLngs()[0].map(ll=>[ll.lat,ll.lng]);
    const area   = calcPolygonArea(coords);
    feat = { id:'feat_'+Date.now(), type:'polygon', name:`Zone (${area>=1000000?(area/1000000).toFixed(2)+'km²':Math.round(area)+'m²'})`, description:'', coords, fill_color:activeLayer.color, stroke_color:activeLayer.color, fill_opacity:0.3, color:activeLayer.color, extended:{}, leafletRef:null };
  }
  if (feat) {
    activeLayer.features.push(feat);
    renderFeatureOnMap(feat, activeLayer);
    if (AUTH.token) apiSaveFeature(feat, activeLayer.id);
    renderLayerList();
    setActiveTool('pan');
    showToast(`${e.layerType==='polyline'?'Route':'Zone'} added to "${activeLayer.name}"`,'success');
  }
}

// ═══════════════════════════════════════════════════════════════
// GEOMETRY MATH
// ═══════════════════════════════════════════════════════════════

function haversine(lat1,lon1,lat2,lon2) {
  const R=6371000,p1=lat1*Math.PI/180,p2=lat2*Math.PI/180,dp=(lat2-lat1)*Math.PI/180,dl=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function calcTotalDist(pts) { let t=0; for(let i=1;i<pts.length;i++) t+=haversine(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]); return t; }
function calcPolygonArea(coords) {
  const R=6371000,rad=d=>d*Math.PI/180; let a=0; const n=coords.length;
  for(let i=0;i<n;i++){const j=(i+1)%n;a+=(rad(coords[i][1])*Math.cos(rad(coords[i][0])))*(rad(coords[j][0]))-(rad(coords[j][1])*Math.cos(rad(coords[j][0])))*(rad(coords[i][0]));}
  return Math.abs(a/2)*R*R;
}

// ═══════════════════════════════════════════════════════════════
// FILE IMPORT
// ═══════════════════════════════════════════════════════════════

async function handleFileImport(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  document.getElementById('import-file-info').textContent = `📁 ${file.name} (${(file.size/1024).toFixed(1)} KB)`;
  document.getElementById('import-progress').style.width = '20%';
  const reader = new FileReader();
  reader.onload = async e => {
    let features = [];
    try {
      if (ext==='kmz') {
        const zip = await JSZip.loadAsync(e.target.result);
        const kmlName = Object.keys(zip.files).find(n=>n.toLowerCase().endsWith('.kml'));
        if (!kmlName) throw new Error('No KML inside KMZ');
        features = parseKMLText(await zip.files[kmlName].async('text'));
      } else if (ext==='kml') {
        features = parseKMLText(e.target.result);
      } else if (ext==='csv') {
        features = parseCSV(e.target.result);
      } else if (ext==='geojson'||ext==='json') {
        features = parseGeoJSON(JSON.parse(e.target.result));
      } else { throw new Error('Unsupported file type'); }

      document.getElementById('import-progress').style.width = '90%';
      STATE.importedFeatures = features;

      const allFields = new Set();
      features.forEach(f=>Object.keys(f.extended||{}).forEach(k=>allFields.add(k)));
      const sfSel = document.getElementById('import-style-field');
      sfSel.innerHTML = '<option value="">-- None --</option>'+[...allFields].map(f=>`<option value="${f}">${escapeHtml(f)}</option>`).join('');

      const prev = document.getElementById('import-preview-list');
      prev.innerHTML = features.slice(0,30).map(f=>`
        <div class="import-preview-item">
          <span class="import-type-badge badge-${f.type}">${f.type}</span>
          <span>${escapeHtml(f.name||'Unnamed')}</span>
        </div>`).join('') + (features.length>30?`<div class="text-muted" style="padding:4px">...and ${features.length-30} more</div>`:'');

      updateLayerDropdowns();
      document.getElementById('import-progress').style.width = '100%';
      showModal('import-modal');
    } catch(err) { showToast('Import error: '+err.message,'error'); }
  };
  ext==='kmz' ? reader.readAsArrayBuffer(file) : reader.readAsText(file);
}

function parseKMLText(kmlText) {
  const xml = new DOMParser().parseFromString(kmlText,'text/xml');
  return parseGeoJSON(toGeoJSON.kml(xml));
}

function parseGeoJSON(geojson) {
  const items = geojson.type==='FeatureCollection' ? geojson.features : [geojson];
  const features = [];
  items.forEach(item => {
    const p = item.properties || {};
    const name = p.name||p.Name||p.title||'Unnamed';
    const desc = p.description||p.Description||'';
    const color = p['marker-color']||p.stroke||p.fill||'#3b82f6';
    const extended = {};
    Object.entries(p).forEach(([k,v])=>{
      if(!['name','Name','description','Description','stroke','fill','stroke-opacity','fill-opacity','stroke-width','marker-color','marker-size'].includes(k)&&v!==null&&v!==undefined)
        extended[k]=String(v);
    });
    const g = item.geometry; if(!g) return;
    const id = ()=>'feat_'+Date.now()+'_'+Math.random();
    if(g.type==='Point') features.push({id:id(),type:'point',name,description:desc,color,extended,lat:g.coordinates[1],lon:g.coordinates[0],leafletRef:null});
    else if(g.type==='Polygon') features.push({id:id(),type:'polygon',name,description:desc,color,extended,coords:g.coordinates[0].map(c=>[c[1],c[0]]),fill_color:p.fill||color,fill_opacity:parseFloat(p['fill-opacity']||0.35),stroke_color:p.stroke||color,leafletRef:null});
    else if(g.type==='LineString') features.push({id:id(),type:'line',name,description:desc,color,extended,coords:g.coordinates.map(c=>[c[1],c[0]]),stroke_color:p.stroke||color,leafletRef:null});
    else if(g.type==='MultiPolygon') g.coordinates.forEach((poly,i)=>features.push({id:id(),type:'polygon',name:`${name}(${i+1})`,description:desc,color,extended,coords:poly[0].map(c=>[c[1],c[0]]),fill_color:color,fill_opacity:0.35,stroke_color:color,leafletRef:null}));
    else if(g.type==='MultiLineString') g.coordinates.forEach((line,i)=>features.push({id:id(),type:'line',name:`${name}(${i+1})`,description:desc,color,extended,coords:line.map(c=>[c[1],c[0]]),stroke_color:color,leafletRef:null}));
  });
  return features;
}

function parseCSV(text) {
  const lines = text.trim().split('\n'); if(lines.length<2) return [];
  const headers = lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/"/g,''));
  const latIdx = headers.findIndex(h=>['lat','latitude','y'].includes(h));
  const lngIdx = headers.findIndex(h=>['lng','lon','longitude','x'].includes(h));
  const nameIdx = headers.findIndex(h=>['name','title','label'].includes(h));
  if(latIdx===-1||lngIdx===-1) throw new Error('CSV must have lat and lng columns');
  return lines.slice(1).map((line,i)=>{
    const vals = line.split(',').map(v=>v.trim().replace(/"/g,''));
    const extended = {};
    headers.forEach((h,idx)=>{ if(idx!==latIdx&&idx!==lngIdx&&idx!==nameIdx&&vals[idx]) extended[headers[idx]]=vals[idx]; });
    return { id:'feat_csv_'+i, type:'point', name:nameIdx!==-1?(vals[nameIdx]||`Row ${i+1}`):`Row ${i+1}`, description:'', lat:parseFloat(vals[latIdx]), lon:parseFloat(vals[lngIdx]), color:'#3b82f6', extended, leafletRef:null };
  }).filter(f=>!isNaN(f.lat)&&!isNaN(f.lon));
}

async function confirmImport() {
  const layerSel   = document.getElementById('import-layer-select');
  const styleField = document.getElementById('import-style-field').value;
  let target = getLayerById(layerSel.value);
  if (layerSel.value === '__new__') target = await createLayer('Imported Layer', CONFIG.COLORS[STATE.layers.length % CONFIG.COLORS.length]);
  if (!target) { showToast('Please select a layer','error'); return; }
  target.styleField = styleField;
  for (const feat of STATE.importedFeatures) {
    target.features.push(feat);
    renderFeatureOnMap(feat, target);
    if (AUTH.token) await apiSaveFeature(feat, target.id);
  }
  renderLayerList();
  closeModal('import-modal');
  showToast(`✅ Imported ${STATE.importedFeatures.length} features to "${target.name}"`,'success');
  STATE.importedFeatures = [];
  try { const b=target.leafletGroup.getBounds(); if(b.isValid()) map.fitBounds(b,{padding:[40,40]}); } catch(e){}
}

// ═══════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════

function getExportLayers() {
  const v = document.getElementById('export-layer-select').value;
  return v==='all' ? STATE.layers : STATE.layers.filter(l=>l.id===v);
}

async function confirmExport() {
  const fmt    = document.getElementById('export-format').value;
  const layers = getExportLayers();
  if(fmt==='geojson')       exportGeoJSON(layers);
  else if(fmt==='kml'||fmt==='kmz') await exportViaBackend(fmt, layers);
  else if(fmt==='csv')      exportCSV(layers);
  closeModal('export-modal');
}

function exportGeoJSON(layers) {
  const features = [];
  layers.forEach(l=>l.features.forEach(f=>{
    let geom;
    if(f.type==='point') geom={type:'Point',coordinates:[f.lon,f.lat]};
    else if(f.type==='polygon') geom={type:'Polygon',coordinates:[f.coords.map(c=>[c[1],c[0]])]};
    else if(f.type==='line') geom={type:'LineString',coordinates:f.coords.map(c=>[c[1],c[0]])};
    if(geom) features.push({type:'Feature',properties:{name:f.name,description:f.description,layer:l.name,...f.extended},geometry:geom});
  }));
  downloadFile(JSON.stringify({type:'FeatureCollection',features},null,2),'application/geo+json','watchme_export.geojson');
  showToast('GeoJSON downloaded','success');
}

async function exportViaBackend(fmt, layers) {
  const resp = await fetch(`${CONFIG.BACKEND_URL}/api/export/${fmt}`,{
    method:'POST',headers:authHeaders(),
    body:JSON.stringify({layers:layers.map(l=>({name:l.name,features:l.features.map(f=>({type:f.type,name:f.name,description:f.description,lat:f.lat,lon:f.lon,coords:f.coords,extended:f.extended||{}}))}))}),
  });
  if(!resp.ok) throw new Error('Export failed');
  const blob=await resp.blob(), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`watchme_export.${fmt}`; a.click(); URL.revokeObjectURL(url);
  showToast(`${fmt.toUpperCase()} downloaded`,'success');
}

function exportCSV(layers) {
  const fields=new Set();
  layers.forEach(l=>l.features.forEach(f=>f.type==='point'&&Object.keys(f.extended||{}).forEach(k=>fields.add(k))));
  const rows=[['name','lat','lon','description','layer',...fields]];
  layers.forEach(l=>l.features.forEach(f=>{
    if(f.type!=='point') return;
    rows.push([`"${(f.name||'').replace(/"/g,'""')}"`,f.lat,f.lon,`"${(f.description||'').replace(/"/g,'""')}"`,`"${l.name.replace(/"/g,'""')}"`, ...[...fields].map(k=>`"${(f.extended?.[k]||'').replace(/"/g,'""')}"`)])
  }));
  downloadFile(rows.map(r=>r.join(',')).join('\n'),'text/csv','watchme_export.csv');
  showToast('CSV downloaded','success');
}

function exportSingleLayer(layerId) {
  const sel=document.getElementById('export-layer-select');
  sel.value=layerId; showModal('export-modal');
}

function downloadFile(content, mimeType, filename) {
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([content],{type:mimeType}));
  a.download=filename; a.click();
}

// ═══════════════════════════════════════════════════════════════
// INCIDENT ANALYSIS (Phase 2 sidebar + Phase 3 modal)
// ═══════════════════════════════════════════════════════════════

let incidentMarker=null, dangerCircle=null;

async function runIncidentAnalysis() {
  const name   = document.getElementById('inc-name').value.trim();
  const itype  = document.getElementById('inc-type').value;
  const lat    = parseFloat(document.getElementById('inc-lat').value);
  const lon    = parseFloat(document.getElementById('inc-lon').value);
  const radius = parseFloat(document.getElementById('inc-radius').value);

  if(!name)      { showToast('Please enter an incident name','error'); return; }
  if(isNaN(lat)) { showToast('Please set a latitude — click "Click Map to Set Location" first','error'); return; }
  if(isNaN(lon)) { showToast('Please set a longitude','error'); return; }

  const selectedLayerIds = getCheckedLayerIds('inc-layer-checkboxes');

  if(incidentMarker) map.removeLayer(incidentMarker);
  if(dangerCircle)   map.removeLayer(dangerCircle);
  incidentMarker = L.marker([lat,lon],{icon:L.divIcon({className:'',html:'<div style="font-size:28px">💥</div>',iconAnchor:[14,14]})}).addTo(map);
  dangerCircle   = L.circle([lat,lon],{radius,color:'#ef4444',fillColor:'#ef4444',fillOpacity:0.1,dashArray:'8,4',weight:2}).addTo(map);
  map.setView([lat,lon],Math.max(map.getZoom(),12));

  try {
    showToast('Analysing proximity...','info');
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/proximity`,{
      method:'POST',headers:authHeaders(),
      body:JSON.stringify({
        incident:{lat,lon,radius_m:radius},
        layers:STATE.layers.map(l=>({id:l.id,name:l.name,features:l.features.map(f=>({type:f.type,name:f.name,lat:f.lat,lon:f.lon,coords:f.coords,extended:f.extended||{}}))})),
        layer_ids: selectedLayerIds.length>0 ? selectedLayerIds : null
      })
    });
    const data = await resp.json();
    P3.lastIncident   = {id:'inc_'+Date.now(),name,type:itype,lat,lon,radius_m:radius};
    P3.lastEndangered = data.endangered;

    renderEndangeredList(data.endangered);
    document.getElementById('incident-stats').classList.remove('hidden');
    document.getElementById('stat-endangered').textContent = data.total;
    document.getElementById('stat-total').textContent = STATE.layers.reduce((s,l)=>s+l.features.filter(f=>f.type==='point').length,0);
    showToast(`⚠ ${data.total} staff member(s) at risk`, data.total>0?'error':'success');
  } catch(e) { showToast('Analysis failed: '+e.message,'error'); }
}

function getCheckedLayerIds(containerId) {
  const cbs = document.querySelectorAll(`#${containerId} .layer-check-cb:checked`);
  return [...cbs].map(cb=>cb.value);
}

function renderEndangeredList(endangered) {
  const container = document.getElementById('endangered-list');
  container.innerHTML = '';
  if(endangered.length===0){
    container.innerHTML='<div class="text-muted" style="padding:12px 4px;text-align:center">✅ No staff in danger zone</div>';
    return;
  }
  container.innerHTML=`<div class="endangered-header">⚠ Endangered<span class="endangered-badge">${endangered.length}</span></div>`;
  endangered.forEach(person=>{
    const distText=person.distance_m>=1000?`${(person.distance_m/1000).toFixed(1)}km`:`${person.distance_m}m`;
    const phone=person.extended?.Phone||person.extended?.phone||'';
    const dept=person.extended?.Department||person.extended?.department||'';
    const card=document.createElement('div'); card.className='staff-alert-card';
    card.innerHTML=`<div class="staff-card-name">${escapeHtml(person.name)}</div>
      <div class="staff-card-dist">🔴 ${person.inside_polygon?`Inside zone: ${escapeHtml(person.zone_name||'')}`:distText+' from incident'}</div>
      ${dept?`<div class="staff-card-meta">🏢 ${escapeHtml(dept)}</div>`:''}
      ${phone?`<div class="staff-card-meta">📞 ${escapeHtml(phone)}</div>`:''}
      <div class="alert-btns">
        <button class="alert-btn alert-btn-sms"      onclick="sendSingleAlert('sms','${escapeHtml(person.name)}',this)">📱 SMS</button>
        <button class="alert-btn alert-btn-whatsapp" onclick="sendSingleAlert('whatsapp','${escapeHtml(person.name)}',this)">💬 WA</button>
        <button class="alert-btn alert-btn-telegram" onclick="sendSingleAlert('telegram','${escapeHtml(person.name)}',this)">✈ TG</button>
      </div>`;
    container.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3 — INCIDENT FORM MODAL
// ═══════════════════════════════════════════════════════════════

// FIXED: activateLocationPick — closes modal, waits for click, reopens
function activateLocationPick() {
  closeModal('incident-form-modal');
  P3.pickingLocation = true;
  map.getContainer().classList.add('picking-location');
  document.getElementById('p3-pick-status').textContent = '';
  showToast('📍 Now click anywhere on the map to set the incident location','info');
}

function openIncidentForm() {
  document.getElementById('p3-inc-name').value = '';
  document.getElementById('p3-inc-lat').value  = '';
  document.getElementById('p3-inc-lon').value  = '';
  document.getElementById('p3-pick-status').textContent = '';
  document.getElementById('p3-radius-slider').value = 500;
  updateRadiusPreview(500);
  document.querySelectorAll('.inc-type-card').forEach(c=>c.classList.toggle('selected',c.dataset.type==='airstrike'));
  P3.selectedIncType='airstrike';
  updateIncidentLayerCheckboxes();
  showModal('incident-form-modal');
  document.getElementById('incident-report-btn').classList.add('active');
}

function updateRadiusPreview(value) {
  const m=parseInt(value);
  document.getElementById('p3-radius-badge').textContent=m>=1000?`${(m/1000).toFixed(1)}km`:`${m}m`;
  const lat=parseFloat(document.getElementById('p3-inc-lat').value);
  const lon=parseFloat(document.getElementById('p3-inc-lon').value);
  if(!isNaN(lat)&&!isNaN(lon)) drawPreviewCircle(lat,lon,m);
}

function drawPreviewCircle(lat,lon,radius) {
  if(P3.radiusCircle){map.removeLayer(P3.radiusCircle);P3.radiusCircle=null;}
  P3.radiusCircle=L.circle([lat,lon],{radius,color:'#ef4444',fillColor:'#ef4444',fillOpacity:0.07,weight:2,dashArray:'10,6',className:'incident-radius-circle'}).addTo(map);
}

function drawIncidentOnMap(incident) {
  if(P3.incidentMarker) map.removeLayer(P3.incidentMarker);
  const type=INC_TYPES[incident.type]||INC_TYPES.other;
  P3.incidentMarker=L.marker([incident.lat,incident.lon],{icon:L.divIcon({className:'',html:`<div style="font-size:30px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5))">${type.icon}</div>`,iconAnchor:[15,15],iconSize:[30,30]}),zIndexOffset:1000}).addTo(map);
  P3.incidentMarker.bindPopup(`<div class="feat-popup"><div class="feat-popup-name">${type.icon} ${escapeHtml(incident.name)}</div><div class="feat-popup-type">${type.label}</div><div class="feat-popup-coords">${incident.lat.toFixed(5)}, ${incident.lon.toFixed(5)}</div><div class="feat-popup-desc">Radius: ${incident.radius_m}m</div></div>`);
  drawPreviewCircle(incident.lat,incident.lon,incident.radius_m);
}

async function runP3Analysis() {
  const name   = document.getElementById('p3-inc-name').value.trim();
  const lat    = parseFloat(document.getElementById('p3-inc-lat').value);
  const lon    = parseFloat(document.getElementById('p3-inc-lon').value);
  const radius = parseInt(document.getElementById('p3-radius-slider').value);
  const selectedLayerIds = getCheckedLayerIds('p3-layer-checkboxes');

  if(!name)      { showToast('Please enter an incident name','error'); return; }
  if(isNaN(lat)||isNaN(lon)) { showToast('Please set a location — click the pick button then click the map','error'); return; }

  closeModal('incident-form-modal');
  document.getElementById('incident-report-btn').classList.remove('active');
  showToast('⚡ Analysing...','info');

  try {
    const resp=await fetch(`${CONFIG.BACKEND_URL}/api/incidents`,{
      method:'POST',headers:authHeaders(),
      body:JSON.stringify({
        name,type:P3.selectedIncType,lat,lon,radius_m:radius,description:'',map_id:'default',
        layers:STATE.layers.map(l=>({id:l.id,name:l.name,features:l.features.map(f=>({type:f.type,name:f.name,lat:f.lat,lon:f.lon,coords:f.coords,extended:f.extended||{}}))})),
        layer_ids: selectedLayerIds.length>0 ? selectedLayerIds : null
      })
    });
    if(!resp.ok){const e=await resp.json();throw new Error(e.detail||'Server error');}
    const data=await resp.json();
    P3.lastIncident=data.incident;
    P3.lastEndangered=data.endangered;
    drawIncidentOnMap(data.incident);
    flashEndangeredMarkers(data.endangered);
    fitMapToIncident(data.incident,data.endangered);
    showAlertResultsModal(data.incident,data.endangered);
  } catch(e) { showToast('Analysis failed: '+e.message,'error'); }
}

function showAlertResultsModal(incident,endangered) {
  const type=INC_TYPES[incident.type]||INC_TYPES.other;
  document.getElementById('ar-count').textContent=endangered.length;
  document.getElementById('ar-title').textContent=`${endangered.length} staff within ${incident.radius_m}m`;
  document.getElementById('ar-sub').textContent=`${type.icon} ${type.label}: ${incident.name}`;
  const tbody=document.getElementById('endangered-table-body');
  tbody.innerHTML='';
  if(endangered.length===0){
    tbody.innerHTML='<div style="padding:28px;text-align:center;color:var(--text-muted)">✅ No staff in danger zone</div>';
  } else {
    endangered.forEach(p=>{
      const tier=p.distance_m<200?'red':p.distance_m<500?'orange':'yellow';
      const dist=p.distance_m>=1000?`${(p.distance_m/1000).toFixed(1)}km`:`${Math.round(p.distance_m)}m`;
      const dept=p.extended?.Department||p.extended?.department||'';
      const row=document.createElement('div'); row.className=`endangered-row tier-${tier}`;
      row.innerHTML=`<div class="er-info"><div class="er-name">${escapeHtml(p.name)}</div><div class="er-meta">${dept?escapeHtml(dept)+' · ':''}${escapeHtml(p.layer_name)}</div></div>
        <div class="er-dist tier-${tier}">${dist}</div>
        <div class="er-channels">
          <button class="er-channel-btn ch-whatsapp" onclick="sendSingleAlert('whatsapp','${escapeHtml(p.name)}',this)" title="WhatsApp">💬</button>
          <button class="er-channel-btn ch-telegram"  onclick="sendSingleAlert('telegram','${escapeHtml(p.name)}',this)"  title="Telegram">✈</button>
          <button class="er-channel-btn ch-sms"       onclick="sendSingleAlert('sms','${escapeHtml(p.name)}',this)"       title="SMS">📱</button>
        </div>`;
      tbody.appendChild(row);
    });
  }
  showModal('alert-results-modal');
}

async function sendSingleAlert(channel,staffName,btnEl) {
  if(!P3.lastIncident) return;
  const person=P3.lastEndangered.find(p=>p.name===staffName);
  if(!person){showToast('Person not found','error');return;}
  btnEl.style.opacity='0.5'; btnEl.disabled=true;
  try {
    const resp=await fetch(`${CONFIG.BACKEND_URL}/api/alert/send`,{
      method:'POST',headers:authHeaders(),
      body:JSON.stringify({incident_id:P3.lastIncident.id,incident:P3.lastIncident,staff:[person],channels:[channel],map_id:'default'})
    });
    const data=await resp.json();
    const result=data.results?.[0];
    if(result?.status==='link_generated'&&channel==='whatsapp'){window.open(result.note,'_blank');markBtnSent(btnEl);}
    else if(result?.status==='sent'){markBtnSent(btnEl);}
    else if(result?.status==='not_configured'){btnEl.style.opacity='1';btnEl.disabled=false;showToast(`${channel} not configured — add credentials on Render`,'error');}
    else{btnEl.style.opacity='0.4';btnEl.disabled=true;}
    showToast(`${channel} alert → ${staffName}: ${result?.status||'unknown'}`,'info');
  } catch(e){btnEl.style.opacity='1';btnEl.disabled=false;showToast('Send failed: '+e.message,'error');}
}

function markBtnSent(btn) {
  btn.classList.add('sent'); btn.disabled=true; btn.style.opacity='';
  const tick=document.createElement('span'); tick.className='sent-tick'; tick.textContent='✓'; btn.appendChild(tick);
}

async function alertAll(tierFilter=null) {
  if(!P3.lastIncident||P3.lastEndangered.length===0){showToast('No endangered staff','error');return;}
  const channels=[];
  if(document.getElementById('bulk-ch-whatsapp').checked) channels.push('whatsapp');
  if(document.getElementById('bulk-ch-telegram').checked) channels.push('telegram');
  if(document.getElementById('bulk-ch-sms').checked)      channels.push('sms');
  if(channels.length===0){showToast('Select at least one channel','error');return;}
  let staff=P3.lastEndangered;
  if(tierFilter!==null) staff=staff.filter(p=>p.distance_m<=tierFilter);
  if(staff.length===0){showToast('No staff within that distance','info');return;}
  const btn=document.getElementById('alert-all-btn'); btn.disabled=true; btn.textContent='⏳ Sending...';
  try {
    const resp=await fetch(`${CONFIG.BACKEND_URL}/api/alert/send`,{
      method:'POST',headers:authHeaders(),
      body:JSON.stringify({incident_id:P3.lastIncident.id,incident:P3.lastIncident,staff,channels,map_id:'default'})
    });
    const data=await resp.json();
    data.results?.forEach(r=>{if(r.status==='link_generated'&&r.note?.startsWith('https://wa.me'))window.open(r.note,'_blank');});
    const sent=data.results?.filter(r=>['sent','link_generated'].includes(r.status)).length||0;
    showToast(`✅ ${sent} alert(s) dispatched`,'success');
    document.querySelectorAll('.er-channel-btn').forEach(b=>channels.forEach(ch=>{if(b.classList.contains(`ch-${ch}`))markBtnSent(b);}));
  } catch(e){showToast('Bulk alert failed: '+e.message,'error');}
  finally{btn.disabled=false;btn.textContent='⚡ Alert All';}
}

function flashEndangeredMarkers(endangered) {
  P3.flashLayers.forEach(l=>map.removeLayer(l)); P3.flashLayers=[];
  endangered.forEach(p=>{
    if(!p.lat||!p.lon) return;
    const tier=p.distance_m<200?'#ef4444':p.distance_m<500?'#f97316':'#eab308';
    const ring=L.circleMarker([p.lat,p.lon],{radius:18,color:tier,weight:3,fillOpacity:0,dashArray:'5,4',opacity:0.85,className:'leaflet-marker-flash'}).addTo(map);
    const dot=L.circleMarker([p.lat,p.lon],{radius:6,color:'#fff',weight:2,fillColor:tier,fillOpacity:0.9}).addTo(map);
    dot.bindTooltip(p.name,{permanent:false,direction:'top'});
    P3.flashLayers.push(ring,dot);
  });
}

function fitMapToIncident(incident,endangered) {
  try {
    const pts=[[incident.lat,incident.lon],...endangered.map(p=>[p.lat,p.lon]).filter(p=>p[0]&&p[1])];
    pts.length===1 ? map.setView(pts[0],13,{animate:true}) : map.fitBounds(L.latLngBounds(pts),{padding:[60,60],maxZoom:14,animate:true});
  } catch(e){map.setView([incident.lat,incident.lon],13);}
}

// ═══════════════════════════════════════════════════════════════
// ALERT LOG PAGE
// ═══════════════════════════════════════════════════════════════

async function openAlertLog() {
  document.getElementById('alert-log-panel').classList.remove('hidden');
  await loadIncidentLog();
}
function closeAlertLog() {
  document.getElementById('alert-log-panel').classList.add('hidden');
  document.getElementById('log-detail-drawer').classList.add('hidden');
}

async function loadIncidentLog() {
  const tbody=document.getElementById('incidents-table-body');
  tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">Loading...</td></tr>`;
  try {
    const resp=await fetch(`${CONFIG.BACKEND_URL}/api/incidents/summary/all`,{headers:authHeaders()});
    if(!resp.ok) throw new Error('Could not load incidents');
    const data=await resp.json();
    const totalAlerts=data.reduce((s,r)=>s+(r.alerts_sent||0),0);
    document.getElementById('log-total-incidents').textContent=data.length;
    document.getElementById('log-total-alerts').textContent=totalAlerts;
    if(data.length===0){tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px">No incidents logged yet.</td></tr>`;return;}
    tbody.innerHTML=data.map(inc=>{
      const type=INC_TYPES[inc.type]||INC_TYPES.other;
      const dt=new Date(inc.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
      const radius=inc.radius_m>=1000?`${(inc.radius_m/1000).toFixed(1)}km`:`${inc.radius_m}m`;
      return `<tr onclick="openIncidentDetail('${inc.id}','${escapeHtml(inc.name)}')">
        <td style="color:var(--text-muted)">${dt}</td>
        <td><span class="inc-type-chip chip-${inc.type}">${type.icon} ${type.label}</span></td>
        <td style="font-weight:500">${escapeHtml(inc.name)}</td>
        <td style="font-family:'Rajdhani',sans-serif">${radius}</td>
        <td><span class="alerted-count">${inc.staff_alerted||0}</span><span style="color:var(--text-muted);font-size:11px"> staff</span></td>
        <td style="text-align:right">
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteIncidentFromLog('${inc.id}')">🗑</button>
        </td>
      </tr>`;
    }).join('');
  } catch(e){tbody.innerHTML=`<tr><td colspan="6" style="color:var(--accent-red);padding:24px;text-align:center">${escapeHtml(e.message)}</td></tr>`;}
}

async function deleteIncidentFromLog(incidentId) {
  if(!confirm('Delete this incident and all its alert logs?')) return;
  try {
    await fetch(`${CONFIG.BACKEND_URL}/api/incidents/${incidentId}`,{method:'DELETE',headers:authHeaders()});
    showToast('Incident deleted','info');
    loadIncidentLog();
  } catch(e){showToast('Delete failed: '+e.message,'error');}
}

async function openIncidentDetail(incidentId,incidentName) {
  const drawer=document.getElementById('log-detail-drawer');
  const body=document.getElementById('drawer-body');
  document.getElementById('drawer-title').textContent=incidentName;
  body.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-muted)">Loading...</div>';
  drawer.classList.remove('hidden');
  try {
    const resp=await fetch(`${CONFIG.BACKEND_URL}/api/incidents/${incidentId}`,{headers:authHeaders()});
    const data=await resp.json();
    const logs=data.alert_logs||[];
    if(logs.length===0){body.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-muted)">No alerts sent for this incident.</div>';return;}
    const icons={whatsapp:'💬',telegram:'✈',sms:'📱'};
    body.innerHTML=logs.map(log=>{
      const time=new Date(log.created_at).toLocaleTimeString('en-GB');
      const dist=log.distance_m>=1000?`${(log.distance_m/1000).toFixed(1)}km`:`${Math.round(log.distance_m)}m`;
      return `<div class="detail-log-row">
        <span class="detail-channel-icon">${icons[log.channel]||'📣'}</span>
        <div style="flex:1;min-width:0">
          <div class="detail-staff-name">${escapeHtml(log.staff_name)}</div>
          <div style="font-size:10px;color:var(--text-muted)">${escapeHtml(log.layer_name)} · ${dist} · ${time}</div>
        </div>
        <span class="detail-status status-${log.status}">${log.status.replace(/_/g,' ')}</span>
        <button class="log-delete-btn" onclick="deleteAlertLog('${log.id}')" title="Remove this alert">🗑</button>
      </div>`;
    }).join('');
  } catch(e){body.innerHTML=`<div style="padding:20px;color:var(--accent-red)">${escapeHtml(e.message)}</div>`;}
}

async function deleteAlertLog(logId) {
  try {
    await fetch(`${CONFIG.BACKEND_URL}/api/alert/logs/${logId}`,{method:'DELETE',headers:authHeaders()});
    // Remove the row from DOM
    const row=document.querySelector(`[onclick="deleteAlertLog('${logId}')"]`)?.closest('.detail-log-row');
    if(row) row.remove();
    showToast('Alert log removed','info');
  } catch(e){showToast('Could not delete: '+e.message,'error');}
}

// ═══════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════

let searchTimeout;
function handleSearch(query) {
  clearTimeout(searchTimeout);
  const results=document.getElementById('search-results');
  if(query.trim().length<2){results.classList.add('hidden');return;}
  const coordMatch=query.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if(coordMatch){
    const lat=parseFloat(coordMatch[1]),lon=parseFloat(coordMatch[2]);
    results.innerHTML=`<div class="search-result-item" onclick="flyToCoords(${lat},${lon})">📍 Go to coordinates: ${lat.toFixed(5)}, ${lon.toFixed(5)}</div>`;
    results.classList.remove('hidden'); return;
  }
  searchTimeout=setTimeout(async()=>{
    try {
      const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&viewbox=34.0,31.7,35.5,31.0&bounded=0&limit=6&accept-language=en`;
      const data=await(await fetch(url,{headers:{'Accept-Language':'en'}})).json();
      if(data.length===0){results.innerHTML='<div class="search-result-item" style="cursor:default">No results</div>';results.classList.remove('hidden');return;}
      results.innerHTML=data.map(i=>`<div class="search-result-item" onclick="flyToCoords(${i.lat},${i.lon},'${escapeHtml(i.display_name).replace(/'/g,"\\'")}')">📍 ${escapeHtml(i.display_name.split(',').slice(0,3).join(', '))}</div>`).join('');
      results.classList.remove('hidden');
    } catch(e){console.error('Search error:',e);}
  },400);
}
function flyToCoords(lat,lon,label=''){
  map.flyTo([lat,lon],14,{duration:1.2});
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('search-input').value=label||`${lat}, ${lon}`;
}

// ═══════════════════════════════════════════════════════════════
// STYLE-BY-FIELD
// ═══════════════════════════════════════════════════════════════

function openStyleFieldModal(layerId) {
  const layer=getLayerById(layerId);
  if(!layer) return;
  const fields=new Set();
  layer.features.forEach(f=>Object.keys(f.extended||{}).forEach(k=>fields.add(k)));
  const sel=document.getElementById('style-field-select');
  sel.innerHTML='<option value="">-- Select field --</option>'+[...fields].map(f=>`<option value="${f}" ${f===layer.styleField?'selected':''}>${escapeHtml(f)}</option>`).join('');
  sel.onchange=()=>renderStyleRules(layer,sel.value);
  renderStyleRules(layer,layer.styleField);
  showModal('style-field-modal');
  document.getElementById('style-field-apply-btn').onclick=()=>{
    layer.styleField=sel.value;
    document.querySelectorAll('.style-rule-color').forEach(inp=>{layer.styleRules[inp.dataset.value]=inp.value;});
    layer.features.forEach(f=>{if(f.leafletRef)layer.leafletGroup.removeLayer(f.leafletRef);f.leafletRef=null;renderFeatureOnMap(f,layer);});
    if(AUTH.token) apiUpdateLayer(layer);
    closeModal('style-field-modal'); showToast('Style rules applied','success');
  };
}
function renderStyleRules(layer,fieldName) {
  const list=document.getElementById('style-rules-list');
  if(!fieldName){list.innerHTML='';return;}
  const values=new Set();
  layer.features.forEach(f=>{const v=f.extended?.[fieldName];if(v)values.add(String(v));});
  const pal=['#22c55e','#ef4444','#f97316','#3b82f6','#a855f7','#eab308','#06b6d4','#ec4899'];
  list.innerHTML='<div class="panel-section-title">Map values to colours:</div>'+[...values].map((val,i)=>`
    <div class="style-rule-row">
      <span class="style-rule-val">${escapeHtml(val)}</span>
      <input type="color" class="style-rule-color" data-value="${escapeHtml(val)}"
             value="${layer.styleRules[val]||pal[i%pal.length]}"
             style="width:36px;height:28px;border:none;border-radius:4px;cursor:pointer;background:none">
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════

function connectSocket() {
  const dot=document.getElementById('socket-dot'), label=document.getElementById('socket-label');
  try {
    if(typeof io==='undefined'){console.warn('Socket.IO not loaded');return;}
    const url=CONFIG.BACKEND_URL||window.location.origin;
    P3.socket=io(url,{transports:['websocket','polling'],reconnectionAttempts:5,reconnectionDelay:2000});
    P3.socket.on('connect',()=>{dot.className='socket-dot connected';label.textContent='LIVE';P3.socket.emit('join_map',{user_id:AUTH.user?.id||'guest'});});
    P3.socket.on('disconnect',()=>{dot.className='socket-dot disconnected';label.textContent='OFF';});
    P3.socket.on('connect_error',()=>{dot.className='socket-dot disconnected';label.textContent='ERR';});
    P3.socket.on('new_incident',data=>{
      if(P3.lastIncident&&P3.lastIncident.id===data.incident?.id) return;
      const inc=data.incident; const type=INC_TYPES[inc.type]||INC_TYPES.other;
      document.getElementById('banner-text').innerHTML=`${type.icon} <strong>NEW INCIDENT:</strong> ${escapeHtml(inc.name)} — ${data.endangered?.length||0} staff at risk`;
      document.getElementById('realtime-banner').classList.add('visible');
      setTimeout(()=>document.getElementById('realtime-banner').classList.remove('visible'),8000);
      drawIncidentOnMap(inc);
      showToast(`⚠ Incoming: ${inc.name}`,'error');
    });
  } catch(e){console.warn('Socket.IO init error:',e.message);dot.className='socket-dot disconnected';label.textContent='OFF';}
}

// ═══════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════

function toggleTheme(){
  const isLight=document.body.classList.toggle('light-mode');
  document.getElementById('theme-toggle').textContent=isLight?'🌙':'☀️';
  localStorage.setItem('wm_theme',isLight?'light':'dark');
}
function loadTheme(){
  if(localStorage.getItem('wm_theme')==='light'){
    document.body.classList.add('light-mode');
    document.getElementById('theme-toggle').textContent='🌙';
  }
}

// ═══════════════════════════════════════════════════════════════
// MODAL HELPERS
// ═══════════════════════════════════════════════════════════════

function showModal(id){document.getElementById(id)?.classList.remove('hidden');}
function closeModal(id){document.getElementById(id)?.classList.add('hidden');}
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))e.target.classList.add('hidden');});
document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));});

// ═══════════════════════════════════════════════════════════════
// TOASTS + UTILS
// ═══════════════════════════════════════════════════════════════

function showToast(message,type='info'){
  const icons={success:'✅',error:'❌',info:'ℹ️'};
  const t=document.createElement('div'); t.className=`toast ${type}`;
  t.innerHTML=`<span>${icons[type]||''}</span> ${escapeHtml(message)}`;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(()=>{t.style.animation='toastOut 0.3s ease forwards';setTimeout(()=>t.remove(),300);},3500);
}

function escapeHtml(str){
  if(str===null||str===undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function renderColorSwatches(container,selectedColor,onSelect){
  container.innerHTML=CONFIG.COLORS.map(color=>`
    <div class="color-swatch ${color===selectedColor?'selected':''}" style="background:${color}" data-color="${color}" title="${color}" onclick="selectSwatch(this,'${color}')"></div>
  `).join('')+`<input type="color" value="${selectedColor||'#3b82f6'}" style="width:24px;height:24px;border:none;border-radius:50%;cursor:pointer;background:none;padding:0" title="Custom" onchange="onCustomColor(this)">`;
  container._onSelect=onSelect;
}
function selectSwatch(el,color){
  el.closest('.color-swatch-row').querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
  el.classList.add('selected');
  const c=el.closest('.color-swatch-row');
  if(c._onSelect) c._onSelect(color);
}
function onCustomColor(inp){const c=inp.closest('.color-swatch-row');if(c._onSelect)c._onSelect(inp.value);}

// ═══════════════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════════════

function setupEvents(){
  // Auth
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-password').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
  document.getElementById('register-btn').addEventListener('click', doRegister);
  document.getElementById('resend-btn').addEventListener('click', doResend);

  // Sidebar tabs
  document.querySelectorAll('.sidebar-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.sidebar-tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.sidebar-panel').forEach(p=>p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-'+tab.dataset.panel).classList.add('active');
    });
  });

  // FIX: Sidebar toggle — properly toggles 'collapsed' class
  document.getElementById('sidebar-toggle').addEventListener('click',()=>{
    const sidebar=document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    // On mobile, use 'open' class instead
    if(window.innerWidth<=768) { sidebar.classList.remove('collapsed'); sidebar.classList.toggle('open'); }
  });

  // Tool buttons
  ['pan','marker','polyline','polygon','measure','streetview'].forEach(t=>{
    document.getElementById('tool-'+t)?.addEventListener('click',()=>setActiveTool(t));
  });

  // Tile switcher
  document.querySelectorAll('.tile-btn').forEach(b=>b.addEventListener('click',()=>switchTile(b.dataset.tile)));

  // Theme
  document.getElementById('theme-toggle').addEventListener('click',toggleTheme);

  // User menu
  document.getElementById('user-menu-btn').addEventListener('click',e=>{
    e.stopPropagation();
    const menu=document.getElementById('user-menu-dropdown');
    const rect=e.currentTarget.getBoundingClientRect();
    menu.style.top=(rect.bottom+8)+'px'; menu.style.right=(window.innerWidth-rect.right)+'px';
    menu.classList.toggle('hidden');
  });

  // Add layer
  document.getElementById('add-layer-btn').addEventListener('click',()=>openLayerNameModal(null));

  // Import / Export
  document.getElementById('import-btn').addEventListener('click',()=>document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change',e=>{if(e.target.files[0]){handleFileImport(e.target.files[0]);e.target.value='';}});
  document.getElementById('import-confirm-btn').addEventListener('click',confirmImport);
  document.getElementById('export-btn').addEventListener('click',()=>showModal('export-modal'));
  document.getElementById('export-confirm-btn').addEventListener('click',confirmExport);

  // Incident sidebar (Phase 2)
  document.getElementById('incident-pick-btn').addEventListener('click',()=>{
    STATE.pendingIncidentPick=true;
    map.getContainer().classList.add('picking-location');
    showToast('📍 Click anywhere on the map to set incident location','info');
  });
  document.getElementById('incident-submit-btn').addEventListener('click',runIncidentAnalysis);

  // Incident modal (Phase 3)
  document.getElementById('incident-report-btn').addEventListener('click',openIncidentForm);
  document.querySelectorAll('[data-close="incident-form-modal"]').forEach(b=>b.addEventListener('click',()=>{
    document.getElementById('incident-report-btn').classList.remove('active');
    if(P3.pickingLocation){P3.pickingLocation=false;map.getContainer().classList.remove('picking-location');}
  }));
  document.getElementById('p3-pick-btn').addEventListener('click',activateLocationPick);
  document.querySelectorAll('.inc-type-card').forEach(card=>card.addEventListener('click',()=>{
    document.querySelectorAll('.inc-type-card').forEach(c=>c.classList.remove('selected'));
    card.classList.add('selected'); P3.selectedIncType=card.dataset.type;
  }));
  document.getElementById('p3-analyze-btn').addEventListener('click',runP3Analysis);
  ['p3-inc-lat','p3-inc-lon'].forEach(id=>{
    document.getElementById(id).addEventListener('input',()=>{
      const lat=parseFloat(document.getElementById('p3-inc-lat').value);
      const lon=parseFloat(document.getElementById('p3-inc-lon').value);
      if(!isNaN(lat)&&!isNaN(lon)) drawPreviewCircle(lat,lon,parseInt(document.getElementById('p3-radius-slider').value));
    });
  });

  // Alert results
  document.getElementById('alert-all-btn').addEventListener('click',()=>alertAll(null));
  document.getElementById('alert-200m-btn').addEventListener('click',()=>alertAll(200));

  // Alert log
  document.getElementById('open-log-btn').addEventListener('click',openAlertLog);
  document.getElementById('close-log-btn').addEventListener('click',closeAlertLog);

  // Search
  const si=document.getElementById('search-input');
  si.addEventListener('input',e=>handleSearch(e.target.value));
  si.addEventListener('keydown',e=>{
    if(e.key==='Escape') document.getElementById('search-results').classList.add('hidden');
    if(e.key==='Enter'){const f=document.querySelector('.search-result-item');if(f)f.click();}
  });
  document.addEventListener('click',e=>{if(!e.target.closest('#search-box'))document.getElementById('search-results').classList.add('hidden');});

  // Keyboard shortcuts
  document.addEventListener('keydown',e=>{
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
    if(e.key==='Escape'){setActiveTool('pan');closeAllContextMenus();if(P3.pickingLocation){P3.pickingLocation=false;map.getContainer().classList.remove('picking-location');}}
    if(e.key==='m') setActiveTool('marker');
    if(e.key==='r') setActiveTool('polyline');
    if(e.key==='p') setActiveTool('polygon');
    if(e.key==='d') setActiveTool('measure');
  });

  // Close menus on click outside
  document.addEventListener('click',()=>closeAllContextMenus());
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded',()=>{
  checkConfirmParam();
  loadTheme();
  setupEvents();

  // If already logged in (token in localStorage), go straight to app
  if(AUTH.token && AUTH.user){
    initMap();
    enterApp();
    setTimeout(()=>{document.getElementById('loading-screen').classList.add('hidden');},1500);
  } else {
    setTimeout(()=>{
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('auth-container').classList.remove('hidden');
    },1500);
  }
});
