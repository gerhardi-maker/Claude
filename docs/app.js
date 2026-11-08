(function () {
  'use strict';

  // ---------- Ortstypen ----------
  var TYPES = {
    frei:   { emoji: '🐕', label: 'Freilauf',      color: '#2e9e5b' },
    leine:  { emoji: '🦮', label: 'Leinenpflicht', color: '#e0a21a' },
    wasser: { emoji: '💧', label: 'Wasser',        color: '#2f7fd1' },
    beutel: { emoji: '🚮', label: 'Kotbeutel',     color: '#7a6a58' },
    verbot: { emoji: '🚫', label: 'Hundeverbot',   color: '#d0453b' },
    gefahr: { emoji: '⚠️', label: 'Achtung',       color: '#8e44ad' }
  };
  var TYPE_KEYS = Object.keys(TYPES);

  var KEY_PLACES = 'hunderoute.places.v1';
  var KEY_FILTER = 'hunderoute.filter.v1';
  var KEY_VIEW = 'hunderoute.view.v1';

  // ---------- Speicher (mit Absicherung, falls localStorage fehlt) ----------
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignorieren */ }
  }

  var places = sanitizeList(load(KEY_PLACES, []));
  var activeFilter = load(KEY_FILTER, TYPE_KEYS.slice()).filter(function (k) { return TYPES[k]; });

  function sanitizeList(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (p) {
      if (!p || !TYPES[p.type]) return;
      var lat = Number(p.lat), lng = Number(p.lng);
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
      out.push({
        id: String(p.id || newId()).slice(0, 40),
        type: p.type,
        name: String(p.name || '').slice(0, 60),
        note: String(p.note || '').slice(0, 300),
        lat: lat,
        lng: lng,
        created: Number(p.created) || Date.now()
      });
    });
    return out;
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Karte ----------
  var $ = function (id) { return document.getElementById(id); };
  var savedView = load(KEY_VIEW, null);
  var start = savedView && isFinite(savedView.lat) ? savedView : { lat: 52.515, lng: 13.50, zoom: 14 };

  var map = L.map('map', { zoomControl: true, attributionControl: true })
    .setView([start.lat, start.lng], start.zoom);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  var markerLayer = L.layerGroup().addTo(map);
  var meMarker = null;

  map.on('moveend', function () {
    var c = map.getCenter();
    save(KEY_VIEW, { lat: c.lat, lng: c.lng, zoom: map.getZoom() });
  });

  function makeIcon(type) {
    var t = TYPES[type];
    var html = '<div class="pin" style="background:' + t.color + '"><span>' + t.emoji + '</span></div>';
    return L.divIcon({
      className: 'pinwrap',
      html: html,
      iconSize: [38, 38],
      iconAnchor: [4, 40],
      popupAnchor: [15, -38]
    });
  }

  function popupFor(p) {
    var t = TYPES[p.type];
    var box = document.createElement('div');

    var type = document.createElement('div');
    type.className = 'pop-type';
    type.textContent = t.emoji + ' ' + t.label;
    box.appendChild(type);

    var name = document.createElement('div');
    name.className = 'pop-name';
    name.textContent = p.name || t.label;
    box.appendChild(name);

    if (p.note) {
      var note = document.createElement('p');
      note.className = 'pop-note';
      note.textContent = p.note;
      box.appendChild(note);
    }

    var actions = document.createElement('div');
    actions.className = 'pop-actions';

    var nav = document.createElement('button');
    nav.textContent = '🧭 Hin';
    nav.addEventListener('click', function () {
      var url = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=' + p.lat + ',' + p.lng;
      window.open(url, '_blank', 'noopener');
    });
    actions.appendChild(nav);

    var del = document.createElement('button');
    del.className = 'del';
    del.textContent = '🗑 Löschen';
    del.addEventListener('click', function () {
      if (confirm('Diesen Ort löschen?')) {
        places = places.filter(function (x) { return x.id !== p.id; });
        persist();
        render();
        toast('Gelöscht');
      }
    });
    actions.appendChild(del);

    box.appendChild(actions);
    return box;
  }

  function render() {
    markerLayer.clearLayers();
    places.forEach(function (p) {
      if (activeFilter.indexOf(p.type) === -1) return;
      L.marker([p.lat, p.lng], { icon: makeIcon(p.type), title: p.name || TYPES[p.type].label })
        .bindPopup(function () { return popupFor(p); })
        .addTo(markerLayer);
    });
    $('countInfo').textContent = places.length + (places.length === 1 ? ' Ort gespeichert.' : ' Orte gespeichert.');
  }

  function persist() { save(KEY_PLACES, places); }

  // ---------- Filter ----------
  function renderFilters() {
    var box = $('filters');
    box.textContent = '';
    TYPE_KEYS.forEach(function (k) {
      var t = TYPES[k];
      var b = document.createElement('button');
      b.className = 'chip' + (activeFilter.indexOf(k) === -1 ? ' off' : '');
      b.textContent = t.emoji + ' ' + t.label;
      b.setAttribute('aria-pressed', activeFilter.indexOf(k) !== -1);
      b.addEventListener('click', function () {
        var i = activeFilter.indexOf(k);
        if (i === -1) activeFilter.push(k); else activeFilter.splice(i, 1);
        save(KEY_FILTER, activeFilter);
        renderFilters();
        render();
      });
      box.appendChild(b);
    });
  }

  // ---------- Standort ----------
  function locate(userInitiated) {
    if (!navigator.geolocation) {
      if (userInitiated) toast('Standort wird von diesem Gerät nicht unterstützt.');
      return;
    }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var ll = [pos.coords.latitude, pos.coords.longitude];
      if (meMarker) meMarker.setLatLng(ll);
      else meMarker = L.circleMarker(ll, {
        radius: 9, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1
      }).addTo(map);
      map.setView(ll, Math.max(map.getZoom(), 16));
    }, function () {
      if (userInitiated) toast('Standort nicht verfügbar. Bitte in den Einstellungen erlauben.');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }
  $('locateBtn').addEventListener('click', function () { locate(true); });

  // ---------- Ort hinzufügen ----------
  var selectedType = null;
  var CROSS_Y = 0.35; // Höhe der Nadelspitze im Bildschirm (Anteil)

  function renderTypePicker() {
    var box = $('typePicker');
    box.textContent = '';
    TYPE_KEYS.forEach(function (k) {
      var t = TYPES[k];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (selectedType === k ? ' sel' : '');
      b.textContent = t.emoji + ' ' + t.label;
      b.addEventListener('click', function () {
        selectedType = k;
        renderTypePicker();
        updateSaveState();
      });
      box.appendChild(b);
    });
  }

  function updateSaveState() { $('saveAdd').disabled = !selectedType; }

  function openAdd() {
    $('toast').hidden = true;
    selectedType = null;
    $('nameInput').value = '';
    $('noteInput').value = '';
    renderTypePicker();
    updateSaveState();
    $('menuSheet').hidden = true;
    $('addSheet').hidden = false;
    $('crosshair').hidden = false;
    $('fabs').hidden = true;
    map.closePopup();
  }

  function closeAdd() {
    $('addSheet').hidden = true;
    $('crosshair').hidden = true;
    $('fabs').hidden = false;
  }

  function pinLatLng() {
    var size = map.getSize();
    return map.containerPointToLatLng([size.x / 2, size.y * CROSS_Y]);
  }

  $('addBtn').addEventListener('click', openAdd);
  $('cancelAdd').addEventListener('click', closeAdd);
  $('saveAdd').addEventListener('click', function () {
    if (!selectedType) return;
    var ll = pinLatLng();
    places.push({
      id: newId(),
      type: selectedType,
      name: $('nameInput').value.trim().slice(0, 60),
      note: $('noteInput').value.trim().slice(0, 300),
      lat: ll.lat,
      lng: ll.lng,
      created: Date.now()
    });
    if (activeFilter.indexOf(selectedType) === -1) {
      activeFilter.push(selectedType);
      save(KEY_FILTER, activeFilter);
      renderFilters();
    }
    persist();
    render();
    closeAdd();
    toast('Gespeichert ✓');
  });

  // ---------- Menü ----------
  $('menuBtn').addEventListener('click', function () {
    closeAdd();
    $('toast').hidden = true;
    $('menuSheet').hidden = false;
  });
  $('closeMenu').addEventListener('click', function () { $('menuSheet').hidden = true; });

  $('demoBtn').addEventListener('click', function () {
    var c = map.getCenter();
    var demo = [
      { type: 'frei',   name: 'Beispiel: Freilaufwiese',  dLat:  0.0012, dLng: -0.0016 },
      { type: 'wasser', name: 'Beispiel: Wassernapf',     dLat: -0.0008, dLng:  0.0010 },
      { type: 'leine',  name: 'Beispiel: Park, Leinenpflicht', dLat: 0.0004, dLng: 0.0020 },
      { type: 'beutel', name: 'Beispiel: Kotbeutelspender', dLat: -0.0015, dLng: -0.0009 }
    ];
    demo.forEach(function (d) {
      places.push({
        id: newId(), type: d.type, name: d.name,
        note: 'Nur ein Beispiel zum Ausprobieren. Du kannst es löschen.',
        lat: c.lat + d.dLat, lng: c.lng + d.dLng, created: Date.now()
      });
    });
    persist();
    render();
    $('menuSheet').hidden = true;
    toast('Beispielorte eingefügt');
  });

  $('exportBtn').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(places, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'hunderoute-orte.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  $('importFile').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = sanitizeList(JSON.parse(reader.result));
        var known = {};
        places.forEach(function (p) { known[p.id] = true; });
        var added = 0;
        incoming.forEach(function (p) {
          if (!known[p.id]) { places.push(p); added++; }
        });
        persist();
        render();
        $('menuSheet').hidden = true;
        toast(added + ' Orte importiert');
      } catch (e) {
        toast('Die Datei konnte nicht gelesen werden.');
      }
    };
    reader.readAsText(file);
    ev.target.value = '';
  });

  $('clearBtn').addEventListener('click', function () {
    if (places.length && confirm('Wirklich alle ' + places.length + ' Orte löschen?')) {
      places = [];
      persist();
      render();
      $('menuSheet').hidden = true;
      toast('Alles gelöscht');
    }
  });

  // ---------- Hinweis-Meldung ----------
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  // ---------- Start ----------
  renderFilters();
  render();
  if (!savedView) locate(false);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ });
  }
})();
