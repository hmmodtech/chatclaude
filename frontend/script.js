// ============================================================
// script.js — Gaza Security Dashboard — Complete Map Logic
// ------------------------------------------------------------
// This file controls everything:
//   1. The Leaflet map (tiles, zoom, layers)
//   2. Layer management (add, hide, delete, recolor)
//   3. Drawing tools (markers, polylines, polygons)
//   4. Measurement tool (distance + area)
//   5. File import (KML, KMZ, CSV, GeoJSON)
//   6. File export (GeoJSON, KML, KMZ, CSV)
//   7. Live incident analysis (proximity + geofencing)
//   8. Emergency alert sending (SMS, WhatsApp, Telegram)
//   9. Search bar (OSM Nominatim geocoding)
//  10. Dark / Light theme toggle
// ============================================================

// ── CONFIGURATION ─────────────────────────────────────────────
// Change BACKEND_URL to your Render URL when deployed.
// During local testing leave it as-is (localhost:8000).
const CONFIG = {
  BACKEND_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8000'
    : 'https://chatclaude-ucfe.onrender.com',  // Empty = same origin (Render serves frontend + backend together)

  // Gaza Strip default view
  DEFAULT_LAT:  31.35,
  DEFAULT_LNG:  34.30,
  DEFAULT_ZOOM: 10,

  MAX_LAYERS: 15,

  // ── Street View placeholder ──────────────────────────────────
  // If you get a Google Maps API key, paste it here:
  GOOGLE_MAPS_API_KEY: '',

  // Swatch color palette used across the app
  COLORS: [
    '#3b82f6', // blue
    '#ef4444', // red
    '#22c55e', // green
    '#f97316', // orange
    '#a855f7', // purple
    '#eab308', // yellow
    '#06b6d4', // cyan
    '#ec4899', // pink
    '#f43f5e', // rose
    '#14b8a6', // teal
    '#84cc16', // lime
    '#8b5cf6', // violet
  ]
};

// ── GLOBAL STATE ───────────────────────────────────────────────
// All app data lives here. Refreshing the page resets it.
const STATE = {
  layers:          [],       // array of layer objects
  activeLayerId:   null,     // which layer new drawings go into
  incidents:       [],       // array of incident objects
  alertLogs:       [],       // array of sent alert records
  currentTool:     'pan',    // active drawing tool
  pendingMarkerLatLng: null, // set when user clicks map for a marker
  pendingIncidentPick: false,// true when user is clicking map for incident coords
  measurePoints:   [],       // array of [lat,lng] for measurement
  measureLayer:    null,     // Leaflet layer group for measurement visuals
  importedFeatures: [],      // features parsed from uploaded file (before confirming)
  importStyleField: '',      // field to color-code imported features by
  editingFeature:  null,     // the feature object being edited in the modal
  styleFieldRules:  {},      // { fieldValue: colorHex } for conditional styling
  styleFieldTarget: null,    // which layer the style-by-field applies to
};

// ── LEAFLET MAP SETUP ──────────────────────────────────────────
let map;          // the Leaflet map instance
let tileLayers;   // object holding the three tile layer options
let drawControl;  // Leaflet.Draw control (hidden — we use our own toolbar)
let drawnItems;   // FeatureGroup that holds all Leaflet.Draw temporary shapes

function initMap() {
  // Create the map centered on Gaza
  map = L.map('map', {
    center: [CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LNG],
    zoom:   CONFIG.DEFAULT_ZOOM,
    zoomControl: true,
    zoomAnimation: true,
  });

  // ── Tile Layers (base maps) ───────────────────────────────────
  tileLayers = {
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }),
    satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: '© Esri, Maxar, Earthstar Geographics',
        maxZoom: 19,
      }
    ),
    terrain: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: '© Esri, USGS, NOAA',
        maxZoom: 19,
      }
    ),
  };

  // Start with OpenStreetMap
  tileLayers.osm.addTo(map);

  // ── Leaflet.Draw setup ────────────────────────────────────────
  // We use Leaflet.Draw internally but hide its default toolbar
  // because we have our own floating toolbar buttons.
  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  drawControl = new L.Control.Draw({
    draw: {
      marker:    false,
      circle:    false,
      rectangle: false,
      circlemarker: false,
      polyline:  { shapeOptions: { color: '#3b82f6', weight: 3 } },
      polygon:   { shapeOptions: { color: '#ef4444', weight: 2, fillOpacity: 0.25 } },
    },
    edit: { featureGroup: drawnItems, remove: true },
  });
  // Don't add drawControl to map — we trigger drawing programmatically

  // ── Map Click Handler ─────────────────────────────────────────
  map.on('click', handleMapClick);

  // ── Leaflet.Draw Events ───────────────────────────────────────
  // Fires when the user finishes drawing a shape
  map.on(L.Draw.Event.CREATED, handleDrawCreated);
}

// ── TILE SWITCHER ──────────────────────────────────────────────
function switchTile(name) {
  // Remove all tile layers then add the chosen one
  Object.values(tileLayers).forEach(tl => {
    if (map.hasLayer(tl)) map.removeLayer(tl);
  });
  tileLayers[name].addTo(map);

  // Update active button style
  document.querySelectorAll('.tile-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tile === name);
  });
}

// ════════════════════════════════════════════════════════════════
// LAYER MANAGEMENT
// ════════════════════════════════════════════════════════════════

// Each layer object looks like this:
// {
//   id:        'uuid-string',
//   name:      'Staff Locations',
//   color:     '#3b82f6',
//   visible:   true,
//   opacity:   1.0,
//   features:  [],          // array of feature objects
//   leafletGroup: L.layerGroup(),  // Leaflet group for this layer's markers
//   styleField: '',         // field name for conditional coloring
//   styleRules: {}          // { value: color } map
// }

function createLayer(name, color) {
  if (STATE.layers.length >= CONFIG.MAX_LAYERS) {
    showToast('Maximum 15 layers reached', 'error');
    return null;
  }

  const id = 'layer_' + Date.now();
  const leafletGroup = L.layerGroup().addTo(map);

  const layer = {
    id,
    name,
    color: color || CONFIG.COLORS[STATE.layers.length % CONFIG.COLORS.length],
    visible: true,
    opacity: 1.0,
    features: [],
    leafletGroup,
    styleField: '',
    styleRules: {}
  };

  STATE.layers.push(layer);
  if (!STATE.activeLayerId) STATE.activeLayerId = id;

  renderLayerList();
  return layer;
}

function getLayerById(id) {
  return STATE.layers.find(l => l.id === id);
}

function deleteLayer(id) {
  const layer = getLayerById(id);
  if (!layer) return;

  // Remove all Leaflet markers/shapes from this layer
  map.removeLayer(layer.leafletGroup);

  // Remove from state
  STATE.layers = STATE.layers.filter(l => l.id !== id);

  // If we deleted the active layer, pick another
  if (STATE.activeLayerId === id) {
    STATE.activeLayerId = STATE.layers[0]?.id || null;
  }

  renderLayerList();
  showToast(`Layer "${layer.name}" deleted`, 'info');
}

function toggleLayerVisibility(id) {
  const layer = getLayerById(id);
  if (!layer) return;

  layer.visible = !layer.visible;

  if (layer.visible) {
    map.addLayer(layer.leafletGroup);
  } else {
    map.removeLayer(layer.leafletGroup);
  }

  renderLayerList();
}

function setLayerOpacity(id, opacity) {
  const layer = getLayerById(id);
  if (!layer) return;

  layer.opacity = opacity;

  // Update opacity on every Leaflet element in the layer
  layer.leafletGroup.eachLayer(leafletLayer => {
    if (leafletLayer.setOpacity) {
      leafletLayer.setOpacity(opacity);
    }
    if (leafletLayer.setStyle) {
      leafletLayer.setStyle({ opacity: opacity, fillOpacity: opacity * 0.4 });
    }
  });
}

function duplicateLayer(id) {
  const original = getLayerById(id);
  if (!original) return;

  const copy = createLayer(original.name + ' (copy)', original.color);
  if (!copy) return;

  // Deep copy features and re-render them on the map
  original.features.forEach(feat => {
    const featCopy = JSON.parse(JSON.stringify(feat));
    featCopy.id = 'feat_' + Date.now() + '_' + Math.random();
    copy.features.push(featCopy);
    renderFeatureOnMap(featCopy, copy);
  });

  showToast(`Layer "${original.name}" duplicated`, 'success');
}

// ── Render the sidebar layer list ─────────────────────────────
function renderLayerList() {
  const list = document.getElementById('layer-list');
  list.innerHTML = '';

  STATE.layers.forEach((layer, index) => {
    // Wrapper div for the layer row
    const item = document.createElement('div');
    item.className = 'layer-item' + (layer.id === STATE.activeLayerId ? ' active-layer' : '');
    item.dataset.layerId = layer.id;

    item.innerHTML = `
      <!-- Visibility eye button -->
      <button class="layer-vis-btn ${layer.visible ? '' : 'hidden-layer'}"
              title="${layer.visible ? 'Hide layer' : 'Show layer'}"
              onclick="toggleLayerVisibility('${layer.id}')">
        ${layer.visible ? '👁' : '🚫'}
      </button>

      <!-- Colour dot (click to change colour) -->
      <div class="layer-color-dot"
           style="background:${layer.color}"
           title="Change colour"
           onclick="openLayerColorPicker('${layer.id}')"></div>

      <!-- Layer name (double-click to rename) -->
      <span class="layer-name" title="Click to select, double-click to rename"
            onclick="selectLayer('${layer.id}')"
            ondblclick="startRenameLayer('${layer.id}', this)">
        ${escapeHtml(layer.name)}
      </span>

      <!-- Feature count badge -->
      <span class="layer-count">${layer.features.length}</span>

      <!-- Three-dot context menu -->
      <button class="layer-menu-btn" onclick="openLayerMenu(event, '${layer.id}')" title="Layer options">
        ⋮
      </button>
    `;

    list.appendChild(item);

    // Opacity slider row (below the layer item)
    const opRow = document.createElement('div');
    opRow.className = 'layer-opacity-row';
    opRow.innerHTML = `
      <span class="layer-opacity-label">${Math.round(layer.opacity * 100)}%</span>
      <input type="range" class="opacity-slider" min="0" max="1" step="0.05"
             value="${layer.opacity}"
             oninput="setLayerOpacity('${layer.id}', this.value); this.previousElementSibling.textContent = Math.round(this.value * 100) + '%'">
    `;
    list.appendChild(opRow);
  });

  // If no layers yet, show a hint
  if (STATE.layers.length === 0) {
    list.innerHTML = `
      <div class="text-muted" style="padding:20px 4px;text-align:center;line-height:1.7">
        No layers yet.<br/>
        Click "+ Add new layer"<br/>or import a KML/KMZ file.
      </div>`;
  }

  // Update all layer dropdowns in modals
  updateLayerDropdowns();
}

function selectLayer(id) {
  STATE.activeLayerId = id;
  renderLayerList();
}

function startRenameLayer(id, el) {
  // Replace the name span with an input field
  const input = document.createElement('input');
  input.type  = 'text';
  input.className = 'layer-name-input';
  input.value = el.textContent.trim();

  const finishRename = () => {
    const layer = getLayerById(id);
    if (layer && input.value.trim()) {
      layer.name = input.value.trim();
    }
    renderLayerList();
  };

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { el.style.display = ''; input.remove(); }
  });

  el.style.display = 'none';
  el.parentNode.insertBefore(input, el.nextSibling);
  input.focus();
  input.select();
}

// ── Layer Context Menu (three-dot button) ──────────────────────
function openLayerMenu(event, layerId) {
  event.stopPropagation();
  closeAllContextMenus();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'layer-context-menu';
  menu.style.left = event.clientX + 'px';
  menu.style.top  = event.clientY + 'px';

  const layer = getLayerById(layerId);

  menu.innerHTML = `
    <div class="context-menu-item" onclick="openLayerNameModal('${layerId}')">✏️ Rename</div>
    <div class="context-menu-item" onclick="duplicateLayer('${layerId}');closeAllContextMenus()">📋 Duplicate</div>
    <div class="context-menu-item" onclick="openStyleFieldModal('${layerId}');closeAllContextMenus()">🎨 Style by Field</div>
    <div class="context-menu-item" onclick="exportSingleLayer('${layerId}');closeAllContextMenus()">⬇ Export this layer</div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" onclick="deleteLayer('${layerId}');closeAllContextMenus()">🗑 Delete Layer</div>
  `;

  document.body.appendChild(menu);

  // Close when clicking anywhere else
  setTimeout(() => {
    document.addEventListener('click', closeAllContextMenus, { once: true });
  }, 10);
}

function closeAllContextMenus() {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
}

// ── Layer Name/Color Picker Modal ──────────────────────────────
let _layerNameCallback = null;

function openLayerNameModal(existingId = null) {
  const modal = document.getElementById('layer-name-modal');
  const title  = document.getElementById('layer-name-modal-title');
  const input  = document.getElementById('layer-name-input');
  const swatches = document.getElementById('layer-color-swatches');

  let selectedColor = CONFIG.COLORS[STATE.layers.length % CONFIG.COLORS.length];

  title.textContent = existingId ? 'Rename Layer' : 'New Layer';
  input.value = existingId ? getLayerById(existingId)?.name || '' : '';

  // Render color swatches
  renderColorSwatches(swatches, selectedColor, (c) => { selectedColor = c; });

  showModal('layer-name-modal');
  input.focus();

  document.getElementById('layer-name-confirm-btn').onclick = () => {
    const name = input.value.trim();
    if (!name) { showToast('Please enter a layer name', 'error'); return; }

    if (existingId) {
      // Rename existing
      const layer = getLayerById(existingId);
      if (layer) { layer.name = name; layer.color = selectedColor; }
      renderLayerList();
    } else {
      // Create new
      createLayer(name, selectedColor);
    }

    closeModal('layer-name-modal');
    showToast(existingId ? 'Layer renamed' : `Layer "${name}" created`, 'success');
  };
}

function openLayerColorPicker(layerId) {
  // Open a quick modal to just pick color
  openLayerNameModal(layerId);
}

// ════════════════════════════════════════════════════════════════
// FEATURE RENDERING ON MAP
// ════════════════════════════════════════════════════════════════

// A "feature" is one item on the map: marker, polygon, or line.
// Each feature object looks like:
// {
//   id:          'feat_xxx',
//   type:        'point' | 'polygon' | 'line',
//   name:        'Staff A',
//   description: 'Security Officer',
//   color:       '#3b82f6',
//   lat:         31.5,       // for points
//   lon:         34.4,       // for points
//   coords:      [[lat,lng]...], // for polygons/lines
//   extended:    { Phone: '+972...', Department: '...' },
//   leafletRef:  <Leaflet layer object>  // added after rendering
// }

function renderFeatureOnMap(feature, layer) {
  let leafletLayer;
  const color = resolveFeatureColor(feature, layer);

  if (feature.type === 'point') {
    // Create a circular marker
    leafletLayer = L.circleMarker([feature.lat, feature.lon], {
      radius:      8,
      color:       '#fff',
      weight:      2,
      fillColor:   color,
      fillOpacity: 0.9,
      opacity:     layer.opacity,
    });
    leafletLayer.bindPopup(() => buildFeaturePopupHTML(feature, layer));

  } else if (feature.type === 'polygon') {
    const latLngs = feature.coords.map(c => [c[0], c[1]]);
    leafletLayer = L.polygon(latLngs, {
      color:       feature.stroke_color || color,
      weight:      2,
      fillColor:   feature.fill_color || color,
      fillOpacity: (feature.fill_opacity || 0.35) * layer.opacity,
      opacity:     layer.opacity,
    });
    leafletLayer.bindPopup(() => buildFeaturePopupHTML(feature, layer));

  } else if (feature.type === 'line') {
    const latLngs = feature.coords.map(c => [c[0], c[1]]);
    leafletLayer = L.polyline(latLngs, {
      color:   feature.stroke_color || color,
      weight:  3,
      opacity: layer.opacity,
    });
    leafletLayer.bindPopup(() => buildFeaturePopupHTML(feature, layer));
  }

  if (leafletLayer) {
    feature.leafletRef = leafletLayer;
    layer.leafletGroup.addLayer(leafletLayer);
  }
}

// Determine color: use styleField rules if configured, else feature color
function resolveFeatureColor(feature, layer) {
  if (layer.styleField && feature.extended) {
    const val = feature.extended[layer.styleField];
    if (val && layer.styleRules[val]) {
      return layer.styleRules[val];
    }
  }
  return feature.color || layer.color;
}

// Build the HTML shown inside a Leaflet popup when you click a feature
function buildFeaturePopupHTML(feature, layer) {
  const coordsText = feature.type === 'point'
    ? `${feature.lat.toFixed(5)}, ${feature.lon.toFixed(5)}`
    : `${feature.coords?.length || 0} coordinate points`;

  const extHtml = Object.entries(feature.extended || {}).map(([k, v]) => `
    <div class="feat-popup-kv">
      <span class="feat-popup-key">${escapeHtml(k)}</span>
      <span class="feat-popup-val">${escapeHtml(String(v))}</span>
    </div>
  `).join('');

  return `
    <div class="feat-popup">
      <div class="feat-popup-name">${escapeHtml(feature.name || 'Unnamed')}</div>
      <div class="feat-popup-type">${feature.type} · ${escapeHtml(layer.name)}</div>
      ${feature.description ? `<div class="feat-popup-desc">${escapeHtml(feature.description)}</div>` : ''}
      <div class="feat-popup-coords">${coordsText}</div>
      ${extHtml ? `<div class="feat-popup-data">${extHtml}</div>` : ''}
      <div class="feat-popup-actions">
        <button class="btn btn-secondary btn-sm"
                onclick="openFeatureEdit('${feature.id}','${layer.id}')">Edit</button>
        <button class="btn btn-danger btn-sm"
                onclick="deleteFeature('${feature.id}','${layer.id}')">Delete</button>
      </div>
    </div>`;
}

function deleteFeature(featureId, layerId) {
  const layer = getLayerById(layerId);
  if (!layer) return;

  const feature = layer.features.find(f => f.id === featureId);
  if (!feature) return;

  // Remove from Leaflet
  if (feature.leafletRef) {
    layer.leafletGroup.removeLayer(feature.leafletRef);
  }

  // Remove from state
  layer.features = layer.features.filter(f => f.id !== featureId);
  renderLayerList();
  showToast('Feature deleted', 'info');
}

// ── Feature Edit Modal ─────────────────────────────────────────
function openFeatureEdit(featureId, layerId) {
  const layer   = getLayerById(layerId);
  const feature = layer?.features.find(f => f.id === featureId);
  if (!feature) return;

  STATE.editingFeature = { feature, layerId };

  document.getElementById('feature-modal-title').textContent =
    `Edit ${feature.type.charAt(0).toUpperCase() + feature.type.slice(1)}`;
  document.getElementById('feature-edit-name').value  = feature.name || '';
  document.getElementById('feature-edit-desc').value  = feature.description || '';
  document.getElementById('feature-edit-coords').textContent =
    feature.type === 'point'
      ? `${feature.lat.toFixed(6)}, ${feature.lon.toFixed(6)}`
      : `${feature.coords?.length || 0} points`;

  // Populate "move to layer" dropdown
  const moveSelect = document.getElementById('feature-move-layer');
  moveSelect.innerHTML = STATE.layers.map(l =>
    `<option value="${l.id}" ${l.id === layerId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`
  ).join('');

  // Color swatches
  const swatches = document.getElementById('feature-color-swatches');
  renderColorSwatches(swatches, feature.color, c => { feature.color = c; });

  // Extended data
  const extDiv = document.getElementById('feature-extended-data');
  if (feature.extended && Object.keys(feature.extended).length > 0) {
    extDiv.innerHTML = `
      <div class="panel-section-title">Properties</div>
      <div class="feat-popup-data">
        ${Object.entries(feature.extended).map(([k,v]) => `
          <div class="feat-popup-kv">
            <span class="feat-popup-key">${escapeHtml(k)}</span>
            <span class="feat-popup-val">${escapeHtml(String(v))}</span>
          </div>`).join('')}
      </div>`;
  } else {
    extDiv.innerHTML = '';
  }

  showModal('feature-modal');

  document.getElementById('feature-save-btn').onclick = () => {
    feature.name        = document.getElementById('feature-edit-name').value.trim();
    feature.description = document.getElementById('feature-edit-desc').value.trim();

    const newLayerId = document.getElementById('feature-move-layer').value;
    if (newLayerId !== layerId) {
      // Move feature to a different layer
      const newLayer = getLayerById(newLayerId);
      if (newLayer) {
        layer.features = layer.features.filter(f => f.id !== featureId);
        if (feature.leafletRef) layer.leafletGroup.removeLayer(feature.leafletRef);
        feature.leafletRef = null;
        newLayer.features.push(feature);
        renderFeatureOnMap(feature, newLayer);
      }
    } else {
      // Re-render in same layer with updated color
      if (feature.leafletRef) layer.leafletGroup.removeLayer(feature.leafletRef);
      feature.leafletRef = null;
      renderFeatureOnMap(feature, layer);
    }

    renderLayerList();
    closeModal('feature-modal');
    showToast('Feature updated', 'success');
  };

  document.getElementById('feature-delete-btn').onclick = () => {
    deleteFeature(featureId, layerId);
    closeModal('feature-modal');
  };
}

// ════════════════════════════════════════════════════════════════
// DRAWING TOOLS
// ════════════════════════════════════════════════════════════════

let activeDrawHandler = null;  // the current Leaflet.Draw handler

function setActiveTool(toolName) {
  // Deactivate any current drawing
  if (activeDrawHandler) {
    activeDrawHandler.disable();
    activeDrawHandler = null;
  }

  STATE.currentTool = toolName;

  // Update toolbar button styles
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.getElementById('tool-' + toolName)?.classList.add('active');

  // Remove drawing cursor classes
  map.getContainer().className = map.getContainer().className
    .replace(/tool-\w+/g, '').trim();

  // Reset click-for-incident mode
  if (toolName !== 'incident-pick') {
    STATE.pendingIncidentPick = false;
  }

  // Clear measurement state
  if (toolName !== 'measure' && STATE.measureLayer) {
    map.removeLayer(STATE.measureLayer);
    STATE.measureLayer  = null;
    STATE.measurePoints = [];
    document.getElementById('measure-display').classList.remove('visible');
  }

  switch (toolName) {
    case 'pan':
      // Default — Leaflet handles panning
      break;

    case 'marker':
      // Next map click drops a marker
      map.getContainer().classList.add('tool-marker');
      showToast('Click on the map to place a marker', 'info');
      break;

    case 'polyline':
      map.getContainer().classList.add('tool-polyline');
      activeDrawHandler = new L.Draw.Polyline(map, {
        shapeOptions: { color: getActiveLayerColor(), weight: 3 }
      });
      activeDrawHandler.enable();
      showToast('Click to draw route points. Double-click to finish.', 'info');
      break;

    case 'polygon':
      map.getContainer().classList.add('tool-polygon');
      activeDrawHandler = new L.Draw.Polygon(map, {
        shapeOptions: { color: getActiveLayerColor(), weight: 2, fillOpacity: 0.25 }
      });
      activeDrawHandler.enable();
      showToast('Click to draw zone corners. Double-click to close.', 'info');
      break;

    case 'measure':
      map.getContainer().classList.add('tool-measure');
      STATE.measurePoints = [];
      STATE.measureLayer  = L.layerGroup().addTo(map);
      showToast('Click two or more points to measure distance', 'info');
      break;

    case 'streetview':
      map.getContainer().classList.add('tool-streetview');
      showToast('Click on the map to open Street View', 'info');
      break;
  }
}

function getActiveLayerColor() {
  const layer = getLayerById(STATE.activeLayerId);
  return layer?.color || '#3b82f6';
}

// ── Map Click Handler ──────────────────────────────────────────
function handleMapClick(e) {
  const { lat, lng } = e.latlng;

  // ── Incident coordinate picking ───────────────────────────────
  if (STATE.pendingIncidentPick) {
    document.getElementById('inc-lat').value = lat.toFixed(6);
    document.getElementById('inc-lon').value = lng.toFixed(6);
    STATE.pendingIncidentPick = false;
    setActiveTool('pan');
    showToast(`Incident location set: ${lat.toFixed(4)}, ${lng.toFixed(4)}`, 'info');
    return;
  }

  // ── Marker tool ────────────────────────────────────────────────
  if (STATE.currentTool === 'marker') {
    STATE.pendingMarkerLatLng = { lat, lng };

    // Populate the layer dropdown
    const sel = document.getElementById('marker-layer-select');
    sel.innerHTML = STATE.layers.map(l =>
      `<option value="${l.id}" ${l.id === STATE.activeLayerId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`
    ).join('');

    // Render color swatches
    let selectedColor = getActiveLayerColor();
    renderColorSwatches(
      document.getElementById('marker-color-swatches'),
      selectedColor,
      c => { selectedColor = c; }
    );

    // Store reference so save button can use it
    document.getElementById('marker-save-btn').onclick = () => {
      const name  = document.getElementById('marker-name').value.trim();
      const desc  = document.getElementById('marker-desc').value.trim();
      const layId = document.getElementById('marker-layer-select').value;

      if (!name) { showToast('Please enter a name', 'error'); return; }
      if (!layId) { showToast('Please select a layer', 'error'); return; }

      const layer = getLayerById(layId);
      if (!layer) return;

      const feature = {
        id:          'feat_' + Date.now(),
        type:        'point',
        name,
        description: desc,
        lat:         STATE.pendingMarkerLatLng.lat,
        lon:         STATE.pendingMarkerLatLng.lng,
        color:       selectedColor,
        extended:    {},
        leafletRef:  null,
      };

      layer.features.push(feature);
      renderFeatureOnMap(feature, layer);
      renderLayerList();
      closeModal('marker-modal');
      showToast(`Marker "${name}" added`, 'success');
      document.getElementById('marker-name').value = '';
      document.getElementById('marker-desc').value = '';
    };

    showModal('marker-modal');
    return;
  }

  // ── Measure tool ───────────────────────────────────────────────
  if (STATE.currentTool === 'measure') {
    STATE.measurePoints.push([lat, lng]);

    // Drop a small dot on the map
    L.circleMarker([lat, lng], {
      radius: 5, color: '#06b6d4', fillColor: '#06b6d4', fillOpacity: 1
    }).addTo(STATE.measureLayer);

    if (STATE.measurePoints.length >= 2) {
      // Draw a line between all points
      L.polyline(STATE.measurePoints, { color: '#06b6d4', dashArray: '6,4', weight: 2 })
        .addTo(STATE.measureLayer);

      // Calculate total geodesic distance
      const totalMetres = calculateTotalDistance(STATE.measurePoints);
      const display = document.getElementById('measure-display');
      display.classList.add('visible');
      display.innerHTML = totalMetres >= 1000
        ? `📏 ${(totalMetres / 1000).toFixed(2)} km`
        : `📏 ${Math.round(totalMetres)} m`;
    }
    return;
  }

  // ── Street View tool ───────────────────────────────────────────
  if (STATE.currentTool === 'streetview') {
    document.getElementById('streetview-coords').textContent =
      `Requested at: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    showModal('streetview-modal');
    return;
  }
}

// ── Leaflet.Draw completion handler ───────────────────────────
function handleDrawCreated(e) {
  const layer  = e.layer;
  const type   = e.layerType;

  // Remove the temporary shape from drawnItems
  // (we'll re-add it properly through our feature system)
  drawnItems.clearLayers();

  const activeLayer = getLayerById(STATE.activeLayerId);
  if (!activeLayer) {
    showToast('Please select or create a layer first', 'error');
    return;
  }

  let feature;

  if (type === 'polyline') {
    const coords = layer.getLatLngs().map(ll => [ll.lat, ll.lng]);
    const dist   = calculateTotalDistance(coords);
    feature = {
      id:          'feat_' + Date.now(),
      type:        'line',
      name:        `Route (${dist >= 1000 ? (dist/1000).toFixed(1)+'km' : Math.round(dist)+'m'})`,
      description: '',
      coords,
      stroke_color: activeLayer.color,
      color:       activeLayer.color,
      extended:    {},
      leafletRef:  null,
    };
  } else if (type === 'polygon') {
    const coords = layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
    const area   = calculatePolygonArea(coords);
    feature = {
      id:           'feat_' + Date.now(),
      type:         'polygon',
      name:         `Zone (${area >= 1000000 ? (area/1000000).toFixed(2)+'km²' : Math.round(area)+'m²'})`,
      description:  '',
      coords,
      fill_color:   activeLayer.color,
      stroke_color: activeLayer.color,
      fill_opacity: 0.3,
      color:        activeLayer.color,
      extended:     {},
      leafletRef:   null,
    };
  }

  if (feature) {
    activeLayer.features.push(feature);
    renderFeatureOnMap(feature, activeLayer);
    renderLayerList();
    setActiveTool('pan');
    showToast(`${type === 'polyline' ? 'Route' : 'Zone'} added to "${activeLayer.name}"`, 'success');
  }
}

// ── Distance Calculation (Haversine) ──────────────────────────
// Same formula as the backend — gives accurate geodesic distance
function haversine(lat1, lon1, lat2, lon2) {
  const R     = 6_371_000;  // Earth radius in metres
  const phi1  = lat1 * Math.PI / 180;
  const phi2  = lat2 * Math.PI / 180;
  const dphi  = (lat2 - lat1) * Math.PI / 180;
  const dlam  = (lon2 - lon1) * Math.PI / 180;
  const a     = Math.sin(dphi/2)**2 + Math.cos(phi1)*Math.cos(phi2)*Math.sin(dlam/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calculateTotalDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i-1][0], points[i-1][1], points[i][0], points[i][1]);
  }
  return total;
}

// Shoelace formula for polygon area (approximate, for small areas)
function calculatePolygonArea(coords) {
  const R = 6_371_000;
  const toRad = d => d * Math.PI / 180;
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = toRad(coords[i][1]) * Math.cos(toRad(coords[i][0]));
    const yi = toRad(coords[i][0]);
    const xj = toRad(coords[j][1]) * Math.cos(toRad(coords[j][0]));
    const yj = toRad(coords[j][0]);
    area += xi * yj - xj * yi;
  }
  return Math.abs(area / 2) * R * R;
}

// ════════════════════════════════════════════════════════════════
// FILE IMPORT
// ════════════════════════════════════════════════════════════════

function handleFileImport(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();

  document.getElementById('import-file-info').textContent =
    `📁 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  const progress = document.getElementById('import-progress');
  progress.style.width = '20%';

  const reader = new FileReader();

  reader.onload = async (e) => {
    progress.style.width = '60%';
    let features = [];

    try {
      if (ext === 'kmz') {
        // KMZ = ZIP file containing doc.kml
        const zip     = await JSZip.loadAsync(e.target.result);
        const kmlName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
        if (!kmlName) throw new Error('No KML file found inside KMZ');
        const kmlText = await zip.files[kmlName].async('text');
        features      = parseKMLText(kmlText);

      } else if (ext === 'kml') {
        features = parseKMLText(e.target.result);

      } else if (ext === 'csv') {
        features = parseCSV(e.target.result);

      } else if (ext === 'geojson' || ext === 'json') {
        features = parseGeoJSON(JSON.parse(e.target.result));

      } else {
        throw new Error('Unsupported file type: ' + ext);
      }

      progress.style.width = '90%';

      if (features.length === 0) {
        showToast('No features found in file', 'error');
        return;
      }

      STATE.importedFeatures = features;

      // Collect all field names from extended data
      const allFields = new Set();
      features.forEach(f => Object.keys(f.extended || {}).forEach(k => allFields.add(k)));

      // Populate the style-field dropdown
      const styleFieldSel = document.getElementById('import-style-field');
      styleFieldSel.innerHTML = '<option value="">-- None (use layer color) --</option>' +
        [...allFields].map(f => `<option value="${f}">${escapeHtml(f)}</option>`).join('');

      // Populate preview list (first 30 items)
      const previewList = document.getElementById('import-preview-list');
      previewList.innerHTML = features.slice(0, 30).map(f => `
        <div class="import-preview-item">
          <span class="import-type-badge badge-${f.type}">${f.type}</span>
          <span>${escapeHtml(f.name || 'Unnamed')}</span>
        </div>`).join('') +
        (features.length > 30 ? `<div class="text-muted" style="padding:6px 4px">...and ${features.length - 30} more</div>` : '');

      // Populate layer selection
      populateImportLayerSelect();

      progress.style.width = '100%';
      showModal('import-modal');

    } catch (err) {
      showToast('Import error: ' + err.message, 'error');
      console.error(err);
    }
  };

  if (ext === 'kmz') {
    reader.readAsArrayBuffer(file);
  } else {
    reader.readAsText(file);
  }
}

// ── KML Parser (uses togeojson library then normalizes) ────────
function parseKMLText(kmlText) {
  const parser  = new DOMParser();
  const xmlDoc  = parser.parseFromString(kmlText, 'text/xml');
  const geojson = toGeoJSON.kml(xmlDoc);
  return parseGeoJSON(geojson);
}

// ── GeoJSON Parser ─────────────────────────────────────────────
function parseGeoJSON(geojson) {
  const features = [];
  const items    = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];

  items.forEach(item => {
    const props = item.properties || {};
    const name  = props.name || props.Name || props.title || 'Unnamed';
    const desc  = props.description || props.Description || '';

    // Separate known fields from extended data
    const extended = {};
    Object.entries(props).forEach(([k, v]) => {
      if (!['name','Name','description','Description','stroke','fill','stroke-opacity',
            'fill-opacity','stroke-width','marker-color','marker-size'].includes(k)) {
        if (v !== null && v !== undefined) extended[k] = String(v);
      }
    });

    const color = props['marker-color'] || props.stroke || props.fill || '#3b82f6';

    const geom = item.geometry;
    if (!geom) return;

    if (geom.type === 'Point') {
      features.push({
        id: 'feat_' + Date.now() + '_' + Math.random(),
        type: 'point',
        name, description: desc, color, extended,
        lat: geom.coordinates[1],
        lon: geom.coordinates[0],
        leafletRef: null,
      });

    } else if (geom.type === 'Polygon') {
      const ring = geom.coordinates[0].map(c => [c[1], c[0]]);
      features.push({
        id: 'feat_' + Date.now() + '_' + Math.random(),
        type: 'polygon',
        name, description: desc, color, extended,
        coords:       ring,
        fill_color:   props.fill || color,
        fill_opacity: parseFloat(props['fill-opacity'] || 0.35),
        stroke_color: props.stroke || color,
        leafletRef:   null,
      });

    } else if (geom.type === 'LineString') {
      const pts = geom.coordinates.map(c => [c[1], c[0]]);
      features.push({
        id: 'feat_' + Date.now() + '_' + Math.random(),
        type: 'line',
        name, description: desc, color, extended,
        coords:       pts,
        stroke_color: props.stroke || color,
        leafletRef:   null,
      });

    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach((poly, i) => {
        const ring = poly[0].map(c => [c[1], c[0]]);
        features.push({
          id: 'feat_' + Date.now() + '_' + Math.random(),
          type: 'polygon',
          name: `${name} (${i+1})`, description: desc, color, extended,
          coords: ring, fill_color: color, fill_opacity: 0.35, stroke_color: color,
          leafletRef: null,
        });
      });

    } else if (geom.type === 'MultiLineString') {
      geom.coordinates.forEach((line, i) => {
        const pts = line.map(c => [c[1], c[0]]);
        features.push({
          id: 'feat_' + Date.now() + '_' + Math.random(),
          type: 'line',
          name: `${name} (${i+1})`, description: desc, color, extended,
          coords: pts, stroke_color: color, leafletRef: null,
        });
      });
    }
  });

  return features;
}

// ── CSV Parser ─────────────────────────────────────────────────
function parseCSV(text) {
  const lines   = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const latIdx  = headers.findIndex(h => ['lat','latitude','y'].includes(h));
  const lngIdx  = headers.findIndex(h => ['lng','lon','longitude','x'].includes(h));
  const nameIdx = headers.findIndex(h => ['name','title','label'].includes(h));

  if (latIdx === -1 || lngIdx === -1) {
    throw new Error('CSV must have "lat" and "lng" (or "latitude"/"longitude") columns');
  }

  return lines.slice(1).map((line, i) => {
    const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
    const extended = {};
    headers.forEach((h, idx) => {
      if (idx !== latIdx && idx !== lngIdx && idx !== nameIdx) {
        if (vals[idx]) extended[headers[idx]] = vals[idx];
      }
    });

    return {
      id:          'feat_csv_' + i,
      type:        'point',
      name:        nameIdx !== -1 ? (vals[nameIdx] || `Row ${i+1}`) : `Row ${i+1}`,
      description: '',
      lat:         parseFloat(vals[latIdx]),
      lon:         parseFloat(vals[lngIdx]),
      color:       '#3b82f6',
      extended,
      leafletRef:  null,
    };
  }).filter(f => !isNaN(f.lat) && !isNaN(f.lon));
}

// ── Confirm Import ─────────────────────────────────────────────
function confirmImport() {
  const layerSel    = document.getElementById('import-layer-select');
  const styleField  = document.getElementById('import-style-field').value;
  let   targetLayer = getLayerById(layerSel.value);

  // If user chose "New Layer", create one
  if (layerSel.value === '__new__') {
    targetLayer = createLayer('Imported Layer', CONFIG.COLORS[STATE.layers.length % CONFIG.COLORS.length]);
  }

  if (!targetLayer) {
    showToast('Please select a layer', 'error');
    return;
  }

  targetLayer.styleField = styleField;

  // Add all imported features
  STATE.importedFeatures.forEach(feature => {
    targetLayer.features.push(feature);
    renderFeatureOnMap(feature, targetLayer);
  });

  renderLayerList();
  closeModal('import-modal');
  showToast(`✅ Imported ${STATE.importedFeatures.length} features to "${targetLayer.name}"`, 'success');
  STATE.importedFeatures = [];

  // Zoom map to fit all imported features
  try {
    const bounds = targetLayer.leafletGroup.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
  } catch(e) {}
}

function populateImportLayerSelect() {
  const sel = document.getElementById('import-layer-select');
  sel.innerHTML =
    '<option value="__new__">➕ Create new layer</option>' +
    STATE.layers.map(l =>
      `<option value="${l.id}" ${l.id === STATE.activeLayerId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`
    ).join('');
}

// ════════════════════════════════════════════════════════════════
// FILE EXPORT
// ════════════════════════════════════════════════════════════════

function getExportLayers() {
  const sel = document.getElementById('export-layer-select').value;
  return sel === 'all' ? STATE.layers : STATE.layers.filter(l => l.id === sel);
}

async function confirmExport() {
  const format         = document.getElementById('export-format').value;
  const inclIncidents  = document.getElementById('export-incidents').value === 'yes';
  const layers         = getExportLayers();

  try {
    if (format === 'geojson') {
      exportGeoJSON(layers, inclIncidents);
    } else if (format === 'kml' || format === 'kmz') {
      await exportViaBackend(format, layers, inclIncidents);
    } else if (format === 'csv') {
      exportCSV(layers);
    }
    closeModal('export-modal');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}

// ── GeoJSON Export ─────────────────────────────────────────────
function exportGeoJSON(layers, inclIncidents) {
  const features = [];

  layers.forEach(layer => {
    layer.features.forEach(feat => {
      let geom;
      if (feat.type === 'point') {
        geom = { type: 'Point', coordinates: [feat.lon, feat.lat] };
      } else if (feat.type === 'polygon') {
        geom = { type: 'Polygon', coordinates: [feat.coords.map(c => [c[1], c[0]])] };
      } else if (feat.type === 'line') {
        geom = { type: 'LineString', coordinates: feat.coords.map(c => [c[1], c[0]]) };
      }
      if (geom) {
        features.push({
          type: 'Feature',
          properties: { name: feat.name, description: feat.description, layer: layer.name, ...feat.extended },
          geometry: geom
        });
      }
    });
  });

  if (inclIncidents) {
    STATE.incidents.forEach(inc => {
      features.push({
        type: 'Feature',
        properties: { name: inc.name, type: inc.type, radius_m: inc.radius_m, timestamp: inc.timestamp },
        geometry: { type: 'Point', coordinates: [inc.lon, inc.lat] }
      });
    });
  }

  const json = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
  downloadFile(json, 'application/geo+json', 'export.geojson');
  showToast('GeoJSON downloaded', 'success');
}

// ── KML/KMZ Export (via backend) ──────────────────────────────
async function exportViaBackend(format, layers, inclIncidents) {
  const endpoint = `${CONFIG.BACKEND_URL}/api/export/${format}`;
  const resp = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      layers:    layers.map(l => ({
        name:     l.name,
        features: l.features.map(f => ({
          type:        f.type,
          name:        f.name,
          description: f.description,
          lat:         f.lat,
          lon:         f.lon,
          coords:      f.coords,
          extended:    f.extended || {},
        }))
      })),
      incidents: inclIncidents ? STATE.incidents : []
    })
  });

  if (!resp.ok) throw new Error(`Server error ${resp.status}`);

  const blob     = await resp.blob();
  const mimeMap  = { kml: 'application/vnd.google-earth.kml+xml', kmz: 'application/vnd.google-earth.kmz' };
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = `export.${format}`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`${format.toUpperCase()} downloaded`, 'success');
}

// ── CSV Export ─────────────────────────────────────────────────
function exportCSV(layers) {
  const rows   = [['name','lat','lon','description','layer']];
  const fields = new Set();

  layers.forEach(l => l.features.forEach(f => {
    if (f.type === 'point') {
      Object.keys(f.extended || {}).forEach(k => fields.add(k));
    }
  }));

  rows[0].push(...fields);

  layers.forEach(layer => {
    layer.features.forEach(feat => {
      if (feat.type !== 'point') return;
      const row = [
        `"${(feat.name||'').replace(/"/g,'""')}"`,
        feat.lat, feat.lon,
        `"${(feat.description||'').replace(/"/g,'""')}"`,
        `"${layer.name.replace(/"/g,'""')}"`,
        ...[...fields].map(f => `"${(feat.extended?.[f]||'').replace(/"/g,'""')}"`)
      ];
      rows.push(row);
    });
  });

  downloadFile(rows.map(r => r.join(',')).join('\n'), 'text/csv', 'export.csv');
  showToast('CSV downloaded', 'success');
}

function exportSingleLayer(layerId) {
  const layer = getLayerById(layerId);
  if (!layer) return;
  // Set the export modal to pre-select this layer, then open
  const sel = document.getElementById('export-layer-select');
  sel.value = layerId;
  showModal('export-modal');
}

function downloadFile(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ════════════════════════════════════════════════════════════════
// INCIDENT ANALYSIS & ALERTS
// ════════════════════════════════════════════════════════════════

let incidentMarker = null;   // Leaflet marker showing incident location
let dangerCircle   = null;   // Leaflet circle showing danger radius

async function runIncidentAnalysis() {
  const name   = document.getElementById('inc-name').value.trim();
  const type   = document.getElementById('inc-type').value;
  const lat    = parseFloat(document.getElementById('inc-lat').value);
  const lon    = parseFloat(document.getElementById('inc-lon').value);
  const radius = parseFloat(document.getElementById('inc-radius').value);

  if (!name)       { showToast('Please enter an incident name', 'error');  return; }
  if (isNaN(lat))  { showToast('Please enter or pick a latitude',  'error'); return; }
  if (isNaN(lon))  { showToast('Please enter or pick a longitude', 'error'); return; }

  // Draw incident marker + danger circle on map
  if (incidentMarker) map.removeLayer(incidentMarker);
  if (dangerCircle)   map.removeLayer(dangerCircle);

  incidentMarker = L.marker([lat, lon], {
    icon: L.divIcon({
      className: '',
      html: `<div style="font-size:28px;line-height:1">💥</div>`,
      iconAnchor: [14, 14],
    })
  }).addTo(map).bindPopup(`<b>${escapeHtml(name)}</b><br>Type: ${type}`);

  dangerCircle = L.circle([lat, lon], {
    radius,
    color:       '#ef4444',
    fillColor:   '#ef4444',
    fillOpacity: 0.12,
    dashArray:   '8,4',
    weight:      2,
  }).addTo(map);

  map.setView([lat, lon], Math.max(map.getZoom(), 12));

  // Call backend proximity API
  try {
    showToast('Analysing proximity...', 'info');
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/proximity`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        incident: { lat, lon, radius_m: radius },
        layers:   STATE.layers.map(l => ({
          name:     l.name,
          features: l.features.map(f => ({
            type:     f.type,
            name:     f.name,
            lat:      f.lat,
            lon:      f.lon,
            coords:   f.coords,
            extended: f.extended || {},
          }))
        }))
      })
    });

    const data = await resp.json();

    // Log incident
    const incident = { id: 'inc_' + Date.now(), name, type, lat, lon, radius_m: radius, timestamp: new Date().toISOString() };
    STATE.incidents.push(incident);

    renderEndangeredList(data.endangered);

    document.getElementById('incident-stats').classList.remove('hidden');
    document.getElementById('stat-endangered').textContent = data.total;
    document.getElementById('stat-total').textContent = countAllStaff();

    showToast(`⚠️ ${data.total} staff member(s) at risk`, data.total > 0 ? 'error' : 'success');

  } catch (err) {
    showToast('Could not reach backend: ' + err.message, 'error');
    console.error(err);
  }
}

function countAllStaff() {
  return STATE.layers.reduce((sum, l) =>
    sum + l.features.filter(f => f.type === 'point').length, 0
  );
}

function renderEndangeredList(endangered) {
  const container = document.getElementById('endangered-list');
  container.innerHTML = '';

  if (endangered.length === 0) {
    container.innerHTML = '<div class="text-muted" style="padding:12px 4px;text-align:center">✅ No staff in danger zone</div>';
    return;
  }

  container.innerHTML = `
    <div class="endangered-header">
      ⚠️ Endangered Staff
      <span class="endangered-badge">${endangered.length}</span>
    </div>`;

  endangered.forEach(staff => {
    const card = document.createElement('div');
    card.className = 'staff-alert-card';

    const distText = staff.distance_m >= 1000
      ? `${(staff.distance_m/1000).toFixed(1)} km`
      : `${staff.distance_m} m`;

    const reason = staff.inside_polygon
      ? `Inside zone: ${staff.zone_name}`
      : `${distText} from incident`;

    const phone = staff.extended?.Phone || staff.extended?.phone || '';
    const dept  = staff.extended?.Department || staff.extended?.department || '';

    card.innerHTML = `
      <div class="staff-card-name">${escapeHtml(staff.name)}</div>
      <div class="staff-card-dist">🔴 ${reason}</div>
      ${dept ? `<div class="staff-card-meta">🏢 ${escapeHtml(dept)}</div>` : ''}
      ${phone ? `<div class="staff-card-meta">📞 ${escapeHtml(phone)}</div>` : ''}
      <div class="alert-btns">
        <button class="alert-btn alert-btn-sms"      onclick="sendAlert('sms','${escapeHtml(staff.name)}','${phone}')">📱 SMS</button>
        <button class="alert-btn alert-btn-whatsapp" onclick="sendAlert('whatsapp','${escapeHtml(staff.name)}','${phone}')">💬 WhatsApp</button>
        <button class="alert-btn alert-btn-telegram" onclick="sendAlert('telegram','${escapeHtml(staff.name)}','')">✈ Telegram</button>
      </div>`;

    container.appendChild(card);

    // Highlight the endangered staff on the map with a pulsing ring
    if (staff.lat && staff.lon) {
      L.circleMarker([staff.lat, staff.lon], {
        radius: 14, color: '#ef4444', weight: 3,
        fillColor: 'transparent', fillOpacity: 0, dashArray: '4,3',
        opacity: 0.8
      }).addTo(map).bindTooltip(staff.name, { permanent: false });
    }
  });
}

// ── Send Alert (calls backend mock API) ───────────────────────
async function sendAlert(channel, staffName, contact) {
  const message = `EMERGENCY ALERT: Please evacuate immediately. An incident has been logged near your location. Stay safe. — Security Dashboard`;

  const payload = {
    sms:       { to: contact, message },
    whatsapp:  { to: contact, message },
    telegram:  { chat_id: contact, message },
  }[channel];

  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/alert/${channel}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    const log = await resp.json();

    // Add to alert log tab
    STATE.alertLogs.unshift({ ...log, staffName, channel });
    renderAlertLog();

    showToast(`${channel.toUpperCase()} alert sent to ${staffName}`, 'success');
  } catch (err) {
    showToast('Alert failed: ' + err.message, 'error');
  }
}

function renderAlertLog() {
  const container = document.getElementById('alert-log-list');
  if (STATE.alertLogs.length === 0) return;

  container.innerHTML = STATE.alertLogs.slice(0, 20).map(log => {
    const icon = { sms: '📱', whatsapp: '💬', telegram: '✈' }[log.channel] || '📣';
    const time = new Date(log.timestamp).toLocaleTimeString();
    return `
      <div style="padding:8px 4px;border-bottom:1px solid var(--border-glass);font-size:12px">
        <div style="display:flex;justify-content:space-between;margin-bottom:2px">
          <span>${icon} ${escapeHtml(log.staffName || log.to || 'Unknown')}</span>
          <span class="text-muted">${time}</span>
        </div>
        <span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">
          ${log.channel} · ${log.status}
        </span>
      </div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════
// SEARCH BAR (Nominatim geocoding — free, no API key)
// ════════════════════════════════════════════════════════════════

let searchTimeout;

function handleSearch(query) {
  clearTimeout(searchTimeout);
  const results = document.getElementById('search-results');

  if (query.trim().length < 2) {
    results.classList.add('hidden');
    return;
  }

  // Check if user typed coordinates (e.g. "31.5, 34.4" or "31.5000 34.4667")
  const coordMatch = query.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lon = parseFloat(coordMatch[2]);
    results.innerHTML = `
      <div class="search-result-item" onclick="flyToCoords(${lat},${lon})">
        📍 Go to coordinates: ${lat.toFixed(5)}, ${lon.toFixed(5)}
      </div>`;
    results.classList.remove('hidden');
    return;
  }

  // Debounce — don't search on every keystroke
  searchTimeout = setTimeout(async () => {
    try {
      // Bias results toward Palestine/Gaza area
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&viewbox=34.0,31.7,35.5,31.0&bounded=0&limit=6&accept-language=en`;
      const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await resp.json();

      if (data.length === 0) {
        results.innerHTML = `<div class="search-result-item" style="cursor:default">No results found</div>`;
        results.classList.remove('hidden');
        return;
      }

      results.innerHTML = data.map(item => `
        <div class="search-result-item"
             onclick="flyToCoords(${item.lat},${item.lon},'${escapeHtml(item.display_name).replace(/'/g,"\\'")}')">
          📍 ${escapeHtml(item.display_name.split(',').slice(0,3).join(', '))}
        </div>`).join('');
      results.classList.remove('hidden');
    } catch (err) {
      console.error('Search error:', err);
    }
  }, 400);
}

function flyToCoords(lat, lon, label = '') {
  map.flyTo([lat, lon], 14, { duration: 1.2 });
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('search-input').value = label || `${lat}, ${lon}`;
  if (label) {
    showToast(`📍 Flew to: ${label.slice(0, 50)}`, 'info');
  }
}

// ════════════════════════════════════════════════════════════════
// STYLE-BY-FIELD (conditional color coding)
// ════════════════════════════════════════════════════════════════

function openStyleFieldModal(layerId) {
  const layer = getLayerById(layerId);
  if (!layer) return;

  STATE.styleFieldTarget = layerId;

  // Collect all unique field names across features in this layer
  const fields = new Set();
  layer.features.forEach(f => Object.keys(f.extended || {}).forEach(k => fields.add(k)));

  const sel = document.getElementById('style-field-select');
  sel.innerHTML = '<option value="">-- Select field --</option>' +
    [...fields].map(f => `<option value="${f}" ${f === layer.styleField ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('');

  sel.onchange = () => renderStyleRules(layer, sel.value);
  renderStyleRules(layer, layer.styleField);

  showModal('style-field-modal');

  document.getElementById('style-field-apply-btn').onclick = () => {
    const field = sel.value;
    layer.styleField = field;

    // Collect rules from the UI
    const ruleInputs = document.querySelectorAll('.style-rule-color');
    ruleInputs.forEach(input => {
      layer.styleRules[input.dataset.value] = input.value;
    });

    // Re-render all features with new colors
    layer.features.forEach(f => {
      if (f.leafletRef) layer.leafletGroup.removeLayer(f.leafletRef);
      f.leafletRef = null;
      renderFeatureOnMap(f, layer);
    });

    closeModal('style-field-modal');
    showToast('Style rules applied', 'success');
  };
}

function renderStyleRules(layer, fieldName) {
  const list = document.getElementById('style-rules-list');
  if (!fieldName) { list.innerHTML = ''; return; }

  // Find all unique values for this field across features
  const values = new Set();
  layer.features.forEach(f => {
    const val = f.extended?.[fieldName];
    if (val) values.add(String(val));
  });

  const colorPalette = ['#22c55e','#ef4444','#f97316','#3b82f6','#a855f7','#eab308','#06b6d4','#ec4899'];

  list.innerHTML = `<div class="panel-section-title">Map values to colors:</div>` +
    [...values].map((val, i) => `
      <div class="style-rule-row">
        <span class="style-rule-val">${escapeHtml(val)}</span>
        <input type="color" class="style-rule-color"
               data-value="${escapeHtml(val)}"
               value="${layer.styleRules[val] || colorPalette[i % colorPalette.length]}"
               style="width:36px;height:28px;border:none;border-radius:4px;cursor:pointer;background:none">
      </div>`).join('');
}

// ════════════════════════════════════════════════════════════════
// THEME TOGGLE (Dark / Light)
// ════════════════════════════════════════════════════════════════

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  document.getElementById('theme-toggle').textContent = isLight ? '🌙' : '☀️';
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

function loadSavedTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.body.classList.add('light-mode');
    document.getElementById('theme-toggle').textContent = '🌙';
  }
}

// ════════════════════════════════════════════════════════════════
// MODAL HELPERS
// ════════════════════════════════════════════════════════════════

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Close modal when clicking backdrop
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.classList.add('hidden');
  }
});

// Close modal buttons (data-close attribute)
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// ════════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ════════════════════════════════════════════════════════════════

function showToast(message, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || ''}</span> ${escapeHtml(message)}`;
  document.getElementById('toast-container').appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ════════════════════════════════════════════════════════════════
// COLOR SWATCHES RENDERER
// ════════════════════════════════════════════════════════════════

function renderColorSwatches(container, selectedColor, onSelect) {
  container.innerHTML = CONFIG.COLORS.map(color => `
    <div class="color-swatch ${color === selectedColor ? 'selected' : ''}"
         style="background:${color}"
         data-color="${color}"
         title="${color}"
         onclick="selectSwatch(this, '${color}')"></div>
  `).join('') +
  `<input type="color" value="${selectedColor || '#3b82f6'}"
          style="width:24px;height:24px;border:none;border-radius:50%;cursor:pointer;background:none;padding:0"
          title="Custom color"
          onchange="onCustomColor(this)">`;

  // Store callback on the container so swatches can call it
  container._onSelect = onSelect;
}

function selectSwatch(el, color) {
  const container = el.closest('.color-swatch-row');
  container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
  if (container._onSelect) container._onSelect(color);
}

function onCustomColor(input) {
  const container = input.closest('.color-swatch-row');
  if (container._onSelect) container._onSelect(input.value);
}

// ════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ════════════════════════════════════════════════════════════════

// Prevent XSS — always escape user-provided text before inserting as HTML
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function updateLayerDropdowns() {
  // Update export modal layer list
  const exportSel = document.getElementById('export-layer-select');
  if (exportSel) {
    exportSel.innerHTML =
      '<option value="all">All Layers</option>' +
      STATE.layers.map(l =>
        `<option value="${l.id}">${escapeHtml(l.name)}</option>`
      ).join('');
  }
}

// ════════════════════════════════════════════════════════════════
// EVENT LISTENERS — wire up all buttons
// ════════════════════════════════════════════════════════════════

function setupEventListeners() {

  // ── Sidebar tabs ────────────────────────────────────────────
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
    });
  });

  // ── Tool buttons ────────────────────────────────────────────
  document.getElementById('tool-pan')      .addEventListener('click', () => setActiveTool('pan'));
  document.getElementById('tool-marker')   .addEventListener('click', () => setActiveTool('marker'));
  document.getElementById('tool-polyline') .addEventListener('click', () => setActiveTool('polyline'));
  document.getElementById('tool-polygon')  .addEventListener('click', () => setActiveTool('polygon'));
  document.getElementById('tool-measure')  .addEventListener('click', () => setActiveTool('measure'));
  document.getElementById('tool-streetview').addEventListener('click', () => setActiveTool('streetview'));

  // ── Tile switcher ────────────────────────────────────────────
  document.querySelectorAll('.tile-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTile(btn.dataset.tile));
  });

  // ── Theme toggle ─────────────────────────────────────────────
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // ── Sidebar toggle (mobile) ──────────────────────────────────
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // ── Add new layer ─────────────────────────────────────────────
  document.getElementById('add-layer-btn').addEventListener('click', () => {
    openLayerNameModal(null);
  });

  // ── Import button ─────────────────────────────────────────────
  document.getElementById('import-btn').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  document.getElementById('file-input').addEventListener('change', e => {
    if (e.target.files[0]) {
      handleFileImport(e.target.files[0]);
      e.target.value = ''; // allow re-importing the same file
    }
  });

  document.getElementById('import-confirm-btn').addEventListener('click', confirmImport);

  // ── Export button ─────────────────────────────────────────────
  document.getElementById('export-btn').addEventListener('click', () => showModal('export-modal'));
  document.getElementById('export-confirm-btn').addEventListener('click', confirmExport);

  // ── Incident panel ────────────────────────────────────────────
  document.getElementById('incident-pick-btn').addEventListener('click', () => {
    STATE.pendingIncidentPick = true;
    setActiveTool('pan');
    // Switch to incidents tab
    document.querySelector('[data-panel="incidents"]').click();
    showToast('Click anywhere on the map to set incident location', 'info');
  });

  document.getElementById('incident-submit-btn').addEventListener('click', runIncidentAnalysis);

  // ── Search ────────────────────────────────────────────────────
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input',   e => handleSearch(e.target.value));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('search-results').classList.add('hidden');
    }
    if (e.key === 'Enter') {
      const first = document.querySelector('.search-result-item');
      if (first) first.click();
    }
  });

  // Hide search results when clicking elsewhere
  document.addEventListener('click', e => {
    if (!e.target.closest('#search-box')) {
      document.getElementById('search-results').classList.add('hidden');
    }
  });

  // ── Keyboard shortcuts ─────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      setActiveTool('pan');
      closeAllContextMenus();
    }
    if (e.key === 'm') setActiveTool('marker');
    if (e.key === 'r') setActiveTool('polyline');
    if (e.key === 'p') setActiveTool('polygon');
    if (e.key === 'd') setActiveTool('measure');
  });
}

// ════════════════════════════════════════════════════════════════
// STARTUP — runs when the page first loads
// ════════════════════════════════════════════════════════════════

function init() {
  // 1. Initialize the Leaflet map
  initMap();

  // 2. Set up all event listeners
  setupEventListeners();

  // 3. Load the user's saved theme preference
  loadSavedTheme();

  // 4. Create a default starting layer so the user can immediately draw
  createLayer('My Locations', '#3b82f6');

  // 5. Hide the loading screen after a short delay
  setTimeout(() => {
    document.getElementById('loading-screen').classList.add('hidden');
    showToast('Map ready. Use the toolbar above to start.', 'info');
  }, 1500);
}

// Run init() as soon as the HTML is fully loaded
document.addEventListener('DOMContentLoaded', init);

// ============================================================
// PHASE 3 — Emergency Alert System
// ------------------------------------------------------------
// New features added here:
//   1. Incident form with type cards + map-click location pick
//   2. Live radius preview circle on the map
//   3. Alert results modal with color-coded endangered rows
//   4. Per-person WhatsApp / Telegram / SMS buttons
//   5. Bulk "Alert All" with channel selection checkboxes
//   6. Alert Log full-page view with incident details drawer
//   7. Socket.IO real-time sync (new incidents appear on all screens)
// ============================================================

// ── PHASE 3 STATE ──────────────────────────────────────────────
const P3 = {
  selectedIncType:  'airstrike',   // currently selected incident type card
  radiusCircle:     null,          // Leaflet circle layer for radius preview
  incidentMarker:   null,          // Leaflet marker for the incident pin
  pickingLocation:  false,         // true while user is clicking map to set coords
  lastIncident:     null,          // the most recent incident object
  lastEndangered:   [],            // the most recent endangered staff list
  socket:           null,          // Socket.IO client instance
  flashLayers:      [],            // Leaflet layers added to flash endangered markers
};

// ── INCIDENT TYPE DEFINITIONS ──────────────────────────────────
const INC_TYPES = {
  airstrike:      { label: 'Airstrike',       icon: '💥', color: '#ef4444' },
  evacuation:     { label: 'Evacuation Order', icon: '🚨', color: '#f97316' },
  ground_op:      { label: 'Ground Operation', icon: '⚔',  color: '#eab308' },
  security_alert: { label: 'Security Alert',   icon: '🔴', color: '#a855f7' },
  shelling:       { label: 'Shelling',         icon: '🔥', color: '#ef4444' },
  other:          { label: 'Other',            icon: '📍', color: '#64748b' },
};

// ─────────────────────────────────────────────────────────────
// SOCKET.IO  REAL-TIME SYNC
// ─────────────────────────────────────────────────────────────

function initSocketIO() {
  // Load Socket.IO client from CDN if not already loaded
  if (typeof io === 'undefined') {
    const script = document.createElement('script');
    script.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
    script.onload = connectSocket;
    document.head.appendChild(script);
  } else {
    connectSocket();
  }
}

function connectSocket() {
  const dot   = document.getElementById('socket-dot');
  const label = document.getElementById('socket-label');

  // Connect to same host as the page (backend serves socket too)
  const serverURL = CONFIG.BACKEND_URL || window.location.origin;

  try {
    P3.socket = io(serverURL, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    P3.socket.on('connect', () => {
      dot.className   = 'socket-dot connected';
      label.textContent = 'LIVE';
      // Join the default map room so we receive incident broadcasts
      P3.socket.emit('join_map', { map_id: 'default' });
    });

    P3.socket.on('disconnect', () => {
      dot.className   = 'socket-dot disconnected';
      label.textContent = 'OFF';
    });

    P3.socket.on('connect_error', () => {
      dot.className   = 'socket-dot disconnected';
      label.textContent = 'ERR';
    });

    // ── Receive new incident from another user ────────────────
    P3.socket.on('new_incident', (data) => {
      const inc  = data.incident;
      const endd = data.endangered || [];

      // If WE sent this incident, skip (we already show the modal)
      if (P3.lastIncident && P3.lastIncident.id === inc.id) return;

      // Show a red banner at the top of the screen
      const banner = document.getElementById('realtime-banner');
      const type   = INC_TYPES[inc.type] || INC_TYPES.other;
      document.getElementById('banner-text').innerHTML =
        `${type.icon} <strong>NEW INCIDENT:</strong> ${escapeHtml(inc.name)} — ` +
        `${endd.length} staff at risk`;
      banner.classList.add('visible');
      setTimeout(() => banner.classList.remove('visible'), 8000);

      // Draw the danger circle on the map
      drawIncidentOnMap(inc);
      showToast(`⚠ Incoming: ${inc.name} — ${endd.length} at risk`, 'error');
    });

    // ── Receive alerts_sent confirmation ──────────────────────
    P3.socket.on('alerts_sent', (data) => {
      showToast(`✅ ${data.count} alert(s) dispatched by team member`, 'success');
    });

  } catch (e) {
    console.warn('Socket.IO init failed (backend may not support it):', e.message);
    dot.className   = 'socket-dot disconnected';
    label.textContent = 'OFF';
  }
}

// ─────────────────────────────────────────────────────────────
// INCIDENT FORM
// ─────────────────────────────────────────────────────────────

function openIncidentForm() {
  // Reset form to clean state
  document.getElementById('p3-inc-name').value = '';
  document.getElementById('p3-inc-lat').value  = '';
  document.getElementById('p3-inc-lon').value  = '';
  document.getElementById('p3-radius-slider').value = '500';
  updateRadiusPreview(500);

  // Reset type card selection
  document.querySelectorAll('.inc-type-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.type === 'airstrike');
  });
  P3.selectedIncType = 'airstrike';

  showModal('incident-form-modal');
}

// Update the radius preview circle on the map while slider is dragged
function updateRadiusPreview(value) {
  const metres = parseInt(value);
  const badge  = document.getElementById('p3-radius-badge');
  badge.textContent = metres >= 1000
    ? `${(metres/1000).toFixed(1)}km`
    : `${metres}m`;

  // Update the slider fill color gradient
  const slider  = document.getElementById('p3-radius-slider');
  const pct     = ((metres - 100) / (10000 - 100)) * 100;
  slider.style.setProperty('--val', pct + '%');

  // If a location is already chosen, update the circle
  const lat = parseFloat(document.getElementById('p3-inc-lat').value);
  const lon = parseFloat(document.getElementById('p3-inc-lon').value);
  if (!isNaN(lat) && !isNaN(lon)) {
    drawPreviewCircle(lat, lon, metres);
  }
}

function drawPreviewCircle(lat, lon, radius) {
  // Remove old preview circle if any
  if (P3.radiusCircle) {
    map.removeLayer(P3.radiusCircle);
    P3.radiusCircle = null;
  }

  // Draw dashed animated circle showing the danger zone
  P3.radiusCircle = L.circle([lat, lon], {
    radius,
    color:       '#ef4444',
    fillColor:   '#ef4444',
    fillOpacity: 0.08,
    weight:      2,
    dashArray:   '10, 6',
    className:   'incident-radius-circle',
  }).addTo(map);
}

function drawIncidentOnMap(incident) {
  // Remove old incident marker if any
  if (P3.incidentMarker) map.removeLayer(P3.incidentMarker);

  const type = INC_TYPES[incident.type] || INC_TYPES.other;

  P3.incidentMarker = L.marker([incident.lat, incident.lon], {
    icon: L.divIcon({
      className: '',
      html: `<div style="font-size:30px;line-height:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.5))">${type.icon}</div>`,
      iconAnchor: [15, 15],
      iconSize:   [30, 30],
    }),
    zIndexOffset: 1000,
  }).addTo(map);

  P3.incidentMarker.bindPopup(`
    <div class="feat-popup">
      <div class="feat-popup-name">${type.icon} ${escapeHtml(incident.name)}</div>
      <div class="feat-popup-type">${type.label}</div>
      <div class="feat-popup-coords">${incident.lat.toFixed(5)}, ${incident.lon.toFixed(5)}</div>
      <div class="feat-popup-desc">Radius: ${incident.radius_m}m</div>
    </div>`);

  drawPreviewCircle(incident.lat, incident.lon, incident.radius_m);
}

// ─────────────────────────────────────────────────────────────
// RUN INCIDENT ANALYSIS
// ─────────────────────────────────────────────────────────────

async function runP3Analysis() {
  const name   = document.getElementById('p3-inc-name').value.trim();
  const lat    = parseFloat(document.getElementById('p3-inc-lat').value);
  const lon    = parseFloat(document.getElementById('p3-inc-lon').value);
  const radius = parseInt(document.getElementById('p3-radius-slider').value);

  if (!name)      { showToast('Please enter an incident name', 'error');     return; }
  if (isNaN(lat)) { showToast('Please set a latitude (click map or type)', 'error'); return; }
  if (isNaN(lon)) { showToast('Please set a longitude', 'error');            return; }

  // Build the layers payload from current state
  const layersPayload = STATE.layers.map(l => ({
    name:     l.name,
    features: l.features.map(f => ({
      type:     f.type,
      name:     f.name,
      lat:      f.lat,
      lon:      f.lon,
      coords:   f.coords,
      extended: f.extended || {},
    }))
  }));

  closeModal('incident-form-modal');
  showToast('⚡ Analyzing...', 'info');

  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/incidents`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name,
        type:        P3.selectedIncType,
        lat, lon,
        radius_m:    radius,
        description: '',
        map_id:      'default',
        layers:      layersPayload,
      })
    });

    if (!resp.ok) throw new Error(`Server error ${resp.status}`);
    const data = await resp.json();

    P3.lastIncident  = data.incident;
    P3.lastEndangered = data.endangered;

    // Draw incident on map
    drawIncidentOnMap(data.incident);

    // Flash endangered markers and zoom map to fit everyone
    flashEndangeredMarkers(data.endangered);
    fitMapToIncident(data.incident, data.endangered);

    // Show results modal
    showAlertResultsModal(data.incident, data.endangered);

  } catch (err) {
    showToast('Analysis failed: ' + err.message, 'error');
    console.error(err);
  }
}

// ─────────────────────────────────────────────────────────────
// ALERT RESULTS MODAL
// ─────────────────────────────────────────────────────────────

function showAlertResultsModal(incident, endangered) {
  const type = INC_TYPES[incident.type] || INC_TYPES.other;

  document.getElementById('ar-count').textContent = endangered.length;
  document.getElementById('ar-title').textContent =
    `${endangered.length} staff within ${incident.radius_m}m danger zone`;
  document.getElementById('ar-sub').textContent =
    `${type.icon} ${type.label}: ${incident.name}`;

  const tbody = document.getElementById('endangered-table-body');
  tbody.innerHTML = '';

  if (endangered.length === 0) {
    tbody.innerHTML = `
      <div style="padding:30px;text-align:center;color:var(--text-muted)">
        ✅ No staff found within the danger zone.<br>
        <span style="font-size:11px">All staff are currently outside the ${incident.radius_m}m radius.</span>
      </div>`;
  } else {
    endangered.forEach(person => {
      const row = buildEndangeredRow(person, incident);
      tbody.appendChild(row);
    });
  }

  showModal('alert-results-modal');
}

function getDistTier(dist) {
  if (dist < 200)  return 'red';
  if (dist < 500)  return 'orange';
  return 'yellow';
}

function buildEndangeredRow(person, incident) {
  const tier     = getDistTier(person.distance_m);
  const distText = person.distance_m >= 1000
    ? `${(person.distance_m/1000).toFixed(1)}km`
    : `${Math.round(person.distance_m)}m`;

  const dept  = person.extended?.Department || person.extended?.department || '';
  const phone = person.extended?.Phone || person.extended?.phone || '';
  const tgId  = person.extended?.TelegramID || person.extended?.telegram_id || '';

  const row = document.createElement('div');
  row.className = `endangered-row tier-${tier}`;
  row.dataset.personId = person.name;

  row.innerHTML = `
    <div class="er-info">
      <div class="er-name">${escapeHtml(person.name)}</div>
      <div class="er-meta">
        ${dept ? escapeHtml(dept) + ' · ' : ''}
        ${escapeHtml(person.layer_name)}
        ${person.inside_polygon ? ` · <span style="color:var(--accent-red)">Inside zone: ${escapeHtml(person.zone_name||'')}</span>` : ''}
      </div>
    </div>
    <div class="er-dist tier-${tier}">${distText}</div>
    <div class="er-channels">
      <button class="er-channel-btn ch-whatsapp"
              title="Send WhatsApp${phone ? ' to '+phone : ' — no phone'}"
              onclick="sendSingleAlert('whatsapp','${escapeHtml(person.name)}',this)"
              ${!phone ? 'style="opacity:0.35" title="No phone number in properties"' : ''}>
        💬
      </button>
      <button class="er-channel-btn ch-telegram"
              title="Send Telegram${tgId ? ' to '+tgId : ' — no Telegram ID'}"
              onclick="sendSingleAlert('telegram','${escapeHtml(person.name)}',this)"
              ${!tgId ? 'style="opacity:0.35"' : ''}>
        ✈
      </button>
      <button class="er-channel-btn ch-sms"
              title="Send SMS${phone ? ' to '+phone : ' — no phone'}"
              onclick="sendSingleAlert('sms','${escapeHtml(person.name)}',this)"
              ${!phone ? 'style="opacity:0.35"' : ''}>
        📱
      </button>
    </div>`;

  return row;
}

// ─────────────────────────────────────────────────────────────
// SINGLE ALERT SEND
// ─────────────────────────────────────────────────────────────

async function sendSingleAlert(channel, staffName, btnEl) {
  if (!P3.lastIncident) return;

  // Find the person in endangered list
  const person = P3.lastEndangered.find(p => p.name === staffName);
  if (!person) { showToast('Person data not found', 'error'); return; }

  // Mark button as loading
  btnEl.style.opacity = '0.5';
  btnEl.disabled = true;

  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/alert/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        incident_id: P3.lastIncident.id,
        incident:    P3.lastIncident,
        staff:       [person],
        channels:    [channel],
        map_id:      'default',
      })
    });

    const data = await resp.json();
    const result = data.results?.[0];

    if (result?.status === 'link_generated' && channel === 'whatsapp') {
      // Open WhatsApp in new tab
      window.open(result.note, '_blank');
      markButtonSent(btnEl, 'link');
      showToast(`WhatsApp opened for ${staffName}`, 'success');

    } else if (result?.status === 'sent') {
      markButtonSent(btnEl, 'sent');
      showToast(`${channel} alert sent to ${staffName}`, 'success');

    } else if (result?.status === 'not_configured') {
      btnEl.style.opacity = '1';
      btnEl.disabled = false;
      showToast(`${channel} not configured — see README for setup`, 'error');

    } else {
      btnEl.style.opacity = '0.4';
      btnEl.disabled = true;
      showToast(`${channel}: ${result?.status || 'unknown'}`, 'info');
    }

  } catch (err) {
    btnEl.style.opacity = '1';
    btnEl.disabled = false;
    showToast('Send failed: ' + err.message, 'error');
  }
}

function markButtonSent(btn, mode) {
  btn.classList.add('sent');
  btn.disabled = true;
  btn.style.opacity = '';
  // Add a small green tick
  const tick = document.createElement('span');
  tick.className = 'sent-tick';
  tick.textContent = '✓';
  btn.appendChild(tick);
}

// ─────────────────────────────────────────────────────────────
// BULK ALERT ALL
// ─────────────────────────────────────────────────────────────

async function alertAll(tierFilter = null) {
  if (!P3.lastIncident || P3.lastEndangered.length === 0) {
    showToast('No endangered staff to alert', 'error');
    return;
  }

  // Read which channels are checked
  const channels = [];
  if (document.getElementById('bulk-ch-whatsapp').checked) channels.push('whatsapp');
  if (document.getElementById('bulk-ch-telegram').checked) channels.push('telegram');
  if (document.getElementById('bulk-ch-sms').checked)      channels.push('sms');

  if (channels.length === 0) {
    showToast('Please select at least one channel', 'error');
    return;
  }

  // Filter by tier if requested
  let staff = P3.lastEndangered;
  if (tierFilter !== null) {
    staff = staff.filter(p => p.distance_m <= tierFilter);
    if (staff.length === 0) {
      showToast(`No staff within ${tierFilter}m`, 'info');
      return;
    }
  }

  // Disable buttons while sending
  const alertAllBtn  = document.getElementById('alert-all-btn');
  const alert200mBtn = document.getElementById('alert-200m-btn');
  alertAllBtn.disabled  = true;
  alert200mBtn.disabled = true;
  alertAllBtn.textContent = '⏳ Sending...';

  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/alert/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        incident_id: P3.lastIncident.id,
        incident:    P3.lastIncident,
        staff,
        channels,
        map_id: 'default',
      })
    });

    const data = await resp.json();

    // Open WhatsApp links for all wa.me results
    data.results?.forEach(r => {
      if (r.status === 'link_generated' && r.note?.startsWith('https://wa.me')) {
        window.open(r.note, '_blank');
      }
    });

    const sentCount = data.results?.filter(r =>
      ['sent','link_generated'].includes(r.status)
    ).length || 0;

    showToast(`✅ ${sentCount} alert(s) dispatched across ${channels.join(', ')}`, 'success');

    // Mark all channel buttons in rows as sent
    document.querySelectorAll('.er-channel-btn').forEach(btn => {
      channels.forEach(ch => {
        if (btn.classList.contains(`ch-${ch}`)) markButtonSent(btn, 'sent');
      });
    });

  } catch (err) {
    showToast('Bulk alert failed: ' + err.message, 'error');
  } finally {
    alertAllBtn.disabled  = false;
    alert200mBtn.disabled = false;
    alertAllBtn.textContent = '⚡ Alert All';
  }
}

// ─────────────────────────────────────────────────────────────
// MAP VISUAL HELPERS
// ─────────────────────────────────────────────────────────────

function flashEndangeredMarkers(endangered) {
  // Remove old flash layers
  P3.flashLayers.forEach(l => map.removeLayer(l));
  P3.flashLayers = [];

  endangered.forEach(person => {
    if (!person.lat || !person.lon) return;

    const tier  = getDistTier(person.distance_m);
    const color = { red: '#ef4444', orange: '#f97316', yellow: '#eab308' }[tier];

    // Outer pulsing ring
    const ring = L.circleMarker([person.lat, person.lon], {
      radius:      20,
      color,
      weight:      3,
      fillOpacity: 0,
      opacity:     0.8,
      dashArray:   '5,4',
      className:   'leaflet-marker-flash',
    }).addTo(map);

    // Inner filled circle
    const dot = L.circleMarker([person.lat, person.lon], {
      radius:      7,
      color:       '#fff',
      weight:      2,
      fillColor:   color,
      fillOpacity: 0.9,
    }).addTo(map);

    dot.bindTooltip(person.name, { permanent: false, direction: 'top' });

    P3.flashLayers.push(ring, dot);
  });
}

function fitMapToIncident(incident, endangered) {
  try {
    const points = [
      [incident.lat, incident.lon],
      ...endangered.map(p => [p.lat, p.lon]).filter(p => p[0] && p[1])
    ];

    if (points.length === 1) {
      map.setView(points[0], 13, { animate: true });
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 14, animate: true });
    }
  } catch (e) {
    map.setView([incident.lat, incident.lon], 13);
  }
}

// ─────────────────────────────────────────────────────────────
// ALERT LOG PAGE
// ─────────────────────────────────────────────────────────────

async function openAlertLog() {
  document.getElementById('alert-log-panel').classList.remove('hidden');
  await loadIncidentLog();
}

function closeAlertLog() {
  document.getElementById('alert-log-panel').classList.add('hidden');
  document.getElementById('log-detail-drawer').classList.add('hidden');
}

async function loadIncidentLog() {
  const tbody = document.getElementById('incidents-table-body');
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">Loading...</td></tr>`;

  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/incidents/summary/all`);
    const data = await resp.json();

    // Update summary stats
    const totalAlerts = data.reduce((s, r) => s + (r.alerts_sent || 0), 0);
    document.getElementById('log-total-incidents').textContent = data.length;
    document.getElementById('log-total-alerts').textContent    = totalAlerts;

    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px">No incidents logged yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(inc => {
      const type   = INC_TYPES[inc.type] || INC_TYPES.other;
      const dt     = new Date(inc.created_at).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      const chipCls = `inc-type-chip chip-${inc.type}`;
      const radius  = inc.radius_m >= 1000 ? `${(inc.radius_m/1000).toFixed(1)}km` : `${inc.radius_m}m`;

      return `
        <tr onclick="openIncidentDetail('${inc.id}','${escapeHtml(inc.name)}')">
          <td style="color:var(--text-muted)">${dt}</td>
          <td><span class="${chipCls}">${type.icon} ${type.label}</span></td>
          <td style="font-weight:500">${escapeHtml(inc.name)}</td>
          <td style="font-family:'Rajdhani',sans-serif">${radius}</td>
          <td>
            <span class="alerted-count">${inc.staff_alerted || 0}</span>
            <span style="color:var(--text-muted);font-size:11px"> staff</span>
          </td>
          <td style="text-align:right">
            <span style="color:var(--text-muted);font-size:18px">›</span>
          </td>
        </tr>`;
    }).join('');

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--accent-red);padding:24px">
      Could not load incidents: ${escapeHtml(err.message)}
    </td></tr>`;
  }
}

async function openIncidentDetail(incidentId, incidentName) {
  const drawer = document.getElementById('log-detail-drawer');
  const body   = document.getElementById('drawer-body');
  document.getElementById('drawer-title').textContent = incidentName;

  body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted)">Loading...</div>`;
  drawer.classList.remove('hidden');

  try {
    const resp = await fetch(`${CONFIG.BACKEND_URL}/api/incidents/${incidentId}`);
    const data = await resp.json();
    const logs = data.alert_logs || [];

    if (logs.length === 0) {
      body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted)">No alerts were sent for this incident.</div>`;
      return;
    }

    const channelIcons = { whatsapp: '💬', telegram: '✈', sms: '📱' };

    body.innerHTML = logs.map(log => {
      const time    = new Date(log.created_at).toLocaleTimeString('en-GB');
      const dist    = log.distance_m >= 1000
        ? `${(log.distance_m/1000).toFixed(1)}km`
        : `${Math.round(log.distance_m)}m`;

      return `
        <div class="detail-log-row">
          <span class="detail-channel-icon">${channelIcons[log.channel] || '📣'}</span>
          <div style="flex:1;min-width:0">
            <div class="detail-staff-name">${escapeHtml(log.staff_name)}</div>
            <div style="font-size:10px;color:var(--text-muted)">
              ${escapeHtml(log.layer_name)} · ${dist} away · ${time}
            </div>
          </div>
          <span class="detail-status status-${log.status}">${log.status.replace(/_/g,' ')}</span>
        </div>`;
    }).join('');

  } catch (err) {
    body.innerHTML = `<div style="padding:20px;color:var(--accent-red)">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// ─────────────────────────────────────────────────────────────
// PHASE 3 EVENT WIRING
// ─────────────────────────────────────────────────────────────

function setupPhase3Events() {

  // ── Incident report button in toolbar ────────────────────────
  document.getElementById('incident-report-btn').addEventListener('click', () => {
    document.getElementById('incident-report-btn').classList.add('active');
    openIncidentForm();
  });

  // Remove active state when modal closes
  document.querySelectorAll('[data-close="incident-form-modal"]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('incident-report-btn').classList.remove('active');
      // Remove radius preview circle if no incident was submitted
      if (P3.radiusCircle && !P3.lastIncident) {
        map.removeLayer(P3.radiusCircle);
        P3.radiusCircle = null;
      }
    });
  });

  // ── Incident type cards ───────────────────────────────────────
  document.querySelectorAll('.inc-type-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.inc-type-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      P3.selectedIncType = card.dataset.type;
    });
  });

  // ── Map-click location pick ───────────────────────────────────
  document.getElementById('p3-pick-btn').addEventListener('click', () => {
    closeModal('incident-form-modal');
    P3.pickingLocation = true;
    map.getContainer().style.cursor = 'crosshair';
    showToast('📍 Click on the map to set incident location', 'info');
  });

  // Hook into the existing map click handler
  const originalMapClick = handleMapClick;
  map.off('click');  // remove old handler
  map.on('click', (e) => {
    if (P3.pickingLocation) {
      const { lat, lng } = e.latlng;
      document.getElementById('p3-inc-lat').value = lat.toFixed(6);
      document.getElementById('p3-inc-lon').value = lng.toFixed(6);
      P3.pickingLocation = false;
      map.getContainer().style.cursor = '';
      // Update radius circle at the newly set location
      const radius = parseInt(document.getElementById('p3-radius-slider').value);
      drawPreviewCircle(lat, lng, radius);
      showModal('incident-form-modal');
      showToast(`Location set: ${lat.toFixed(4)}, ${lng.toFixed(4)}`, 'info');
      return;
    }
    originalMapClick(e);  // call original handler for other tools
  });

  // ── Analyze & Alert button ────────────────────────────────────
  document.getElementById('p3-analyze-btn').addEventListener('click', runP3Analysis);

  // ── Bulk alert buttons ────────────────────────────────────────
  document.getElementById('alert-all-btn') .addEventListener('click', () => alertAll(null));
  document.getElementById('alert-200m-btn').addEventListener('click', () => alertAll(200));

  // ── Alert log page ────────────────────────────────────────────
  document.getElementById('open-log-btn') .addEventListener('click', openAlertLog);
  document.getElementById('close-log-btn').addEventListener('click', closeAlertLog);

  // ── Lat/lon fields update radius circle in real time ─────────
  ['p3-inc-lat', 'p3-inc-lon'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      const lat    = parseFloat(document.getElementById('p3-inc-lat').value);
      const lon    = parseFloat(document.getElementById('p3-inc-lon').value);
      const radius = parseInt(document.getElementById('p3-radius-slider').value);
      if (!isNaN(lat) && !isNaN(lon)) {
        drawPreviewCircle(lat, lon, radius);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────
// PHASE 3 INIT  — called once after the map is ready
// ─────────────────────────────────────────────────────────────

// We extend the existing init() by hooking into the DOMContentLoaded
// callback that's already set up in Phase 2
document.addEventListener('DOMContentLoaded', () => {
  // Wait briefly to ensure Phase 2 init() has already run
  setTimeout(() => {
    setupPhase3Events();
    initSocketIO();
  }, 200);
});
