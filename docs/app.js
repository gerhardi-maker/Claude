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
        created: Number(p.created) || Date.now(),
        photo: p.photo === true
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

  var map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView([start.lat, start.lng], start.zoom);
  // Zoom-Buttons unten links, damit sie keine Marker-Fenster überdecken
  L.control.zoom({ position: 'bottomleft', zoomInTitle: 'Vergrößern', zoomOutTitle: 'Verkleinern' }).addTo(map);

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

  // ---------- Fotos (liegen in IndexedDB, nicht in localStorage) ----------
  var MAX_SIDE = 1280;       // längste Bildkante in Pixel
  var JPEG_QUALITY = 0.8;
  var dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('IndexedDB fehlt')); return; }
        var req = indexedDB.open('hunderoute', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('photos'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return dbPromise;
  }

  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('photos', mode);
        var req = fn(t.objectStore('photos'));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = t.onabort = function () { reject(t.error); };
      });
    });
  }

  function readBlob(blob, as) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      if (as === 'url') r.readAsDataURL(blob); else r.readAsArrayBuffer(blob);
    });
  }

  // Als ArrayBuffer speichern, das ist auf iPhones zuverlässiger als ein Blob.
  function putPhoto(id, blob) {
    return readBlob(blob, 'buf').then(function (buf) {
      return withStore('readwrite', function (s) {
        return s.put({ type: blob.type || 'image/jpeg', data: buf }, id);
      });
    });
  }
  function getPhoto(id) {
    return withStore('readonly', function (s) { return s.get(id); }).then(function (rec) {
      return rec ? new Blob([rec.data], { type: rec.type }) : null;
    });
  }
  function deletePhoto(id) {
    return withStore('readwrite', function (s) { return s.delete(id); }).catch(function () {});
  }
  function clearPhotos() {
    return withStore('readwrite', function (s) { return s.clear(); }).catch(function () {});
  }

  // Verkleinert ein Foto und macht ein JPEG daraus (spart Platz).
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { reject(new Error('Bild leer')); return; }
        var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Umwandeln fehlgeschlagen')); },
          'image/jpeg', JPEG_QUALITY);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Bild nicht lesbar')); };
      img.src = url;
    });
  }

  // Foto eines Orts in ein <img> laden
  var openPopup = null;
  map.on('popupopen', function (e) { openPopup = e.popup; });
  map.on('popupclose', function () { openPopup = null; });
  function refreshPopup() { if (openPopup) openPopup.update(); }  // Größe neu berechnen und ins Bild schieben

  function showPhoto(imgEl, id) {
    getPhoto(id).then(function (blob) {
      if (!blob) { imgEl.hidden = true; refreshPopup(); return; }
      var url = URL.createObjectURL(blob);
      imgEl.onload = function () { URL.revokeObjectURL(url); imgEl.hidden = false; refreshPopup(); };
      imgEl.src = url;
    }).catch(function () { imgEl.hidden = true; refreshPopup(); });
  }

  // Foto im Marker-Fenster hinzufügen oder ersetzen
  var attachCb = null;
  function attachPhoto(p, file, imgEl, btn) {
    compressImage(file).then(function (blob) {
      return putPhoto(p.id, blob);
    }).then(function () {
      p.photo = true;
      persist();
      btn.textContent = '📷 Neu';
      showPhoto(imgEl, p.id);
      toast('Foto gespeichert ✓');
    }).catch(function () {
      toast('Das Foto konnte nicht gespeichert werden.');
    });
  }
  $('photoAttach').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file || !attachCb) return;
    var cb = attachCb;
    attachCb = null;
    cb(file);
  });

  // Großansicht
  var viewerUrl = null;
  function openViewer(id) {
    getPhoto(id).then(function (blob) {
      if (!blob) return;
      viewerUrl = URL.createObjectURL(blob);
      $('viewerImg').src = viewerUrl;
      $('photoView').hidden = false;
    }).catch(function () { toast('Das Foto konnte nicht geladen werden.'); });
  }
  function closeViewer() {
    $('photoView').hidden = true;
    $('viewerImg').removeAttribute('src');
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  }
  $('photoView').addEventListener('click', closeViewer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeViewer(); });

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

    var photo = document.createElement('img');
    photo.className = 'pop-photo';
    photo.alt = 'Foto von ' + (p.name || t.label);
    photo.hidden = !p.photo;   // Platz von Anfang an reservieren, damit das Fenster nicht nachträglich wächst
    photo.addEventListener('click', function () { openViewer(p.id); });
    box.appendChild(photo);
    if (p.photo) showPhoto(photo, p.id);

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

    var cam = document.createElement('button');
    cam.textContent = p.photo ? '📷 Neu' : '📷 Foto';
    cam.addEventListener('click', function () {
      attachCb = function (file) { attachPhoto(p, file, photo, cam); };
      $('photoAttach').click();
    });
    actions.appendChild(cam);

    var del = document.createElement('button');
    del.className = 'del';
    del.textContent = '🗑';
    del.setAttribute('aria-label', 'Ort löschen');
    del.title = 'Ort löschen';
    del.addEventListener('click', function () {
      if (confirm('Diesen Ort löschen?')) {
        deletePhoto(p.id);
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

  var markersById = {};   // Ort-ID -> Marker (für die Suche)

  function render() {
    markerLayer.clearLayers();
    markersById = {};
    places.forEach(function (p) {
      if (activeFilter.indexOf(p.type) === -1) return;
      var marker = L.marker([p.lat, p.lng], { icon: makeIcon(p.type), title: p.name || TYPES[p.type].label })
        .bindPopup(document.createElement('div'), {
          minWidth: 230, maxWidth: 270,
          autoPanPaddingTopLeft: [16, 84],      // nicht unter die Filterleiste schieben
          autoPanPaddingBottomRight: [16, 96]
        });
      // Inhalt genau einmal pro Öffnen bauen. Als Funktion würde popup.update() ihn jedes Mal
      // neu bauen, und das Foto-Laden würde wieder update() auslösen (Endlosschleife).
      marker.on('popupopen', function (e) { e.popup.setContent(popupFor(p)); });
      marker.addTo(markerLayer);
      markersById[p.id] = marker;
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

  // Foto, das gerade im Formular ausgewählt ist (noch nicht gespeichert)
  var pendingPhoto = null;
  var pendingUrl = null;
  function setPendingPhoto(blob) {
    if (pendingUrl) { URL.revokeObjectURL(pendingUrl); pendingUrl = null; }
    pendingPhoto = blob;
    if (blob) {
      pendingUrl = URL.createObjectURL(blob);
      $('photoThumb').src = pendingUrl;
    } else {
      $('photoThumb').removeAttribute('src');
    }
    $('photoPreview').hidden = !blob;
    $('photoBtn').textContent = blob ? '📷 Ändern' : '📷 Foto hinzufügen';
  }
  $('photoBtn').addEventListener('click', function () { $('photoInput').click(); });
  $('photoRemove').addEventListener('click', function () { setPendingPhoto(null); });
  $('photoInput').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    compressImage(file).then(setPendingPhoto).catch(function () {
      toast('Das Foto konnte nicht gelesen werden.');
    });
  });

  function openAdd() {
    $('toast').hidden = true;
    setPendingPhoto(null);
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
    setPendingPhoto(null);
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
    var blob = pendingPhoto;
    var place = {
      id: newId(),
      type: selectedType,
      name: $('nameInput').value.trim().slice(0, 60),
      note: $('noteInput').value.trim().slice(0, 300),
      lat: ll.lat,
      lng: ll.lng,
      created: Date.now(),
      photo: false
    };
    places.push(place);
    if (activeFilter.indexOf(selectedType) === -1) {
      activeFilter.push(selectedType);
      save(KEY_FILTER, activeFilter);
      renderFilters();
    }
    persist();
    render();
    closeAdd();
    if (blob) {
      putPhoto(place.id, blob).then(function () {
        place.photo = true;
        persist();
        toast('Gespeichert ✓');
      }).catch(function () {
        toast('Ort gespeichert, aber das Foto nicht.');
      });
    } else {
      toast('Gespeichert ✓');
    }
  });

  // ---------- Suche ----------
  // Ohne Groß-/Kleinschreibung und ohne Umlaut-Unterschiede: "grun" findet "Grün", "strasse" findet "Straße".
  function norm(s) {
    return String(s || '').toLowerCase().replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function searchOrigin() { return meMarker ? meMarker.getLatLng() : map.getCenter(); }

  function fmtDist(m) {
    if (m < 10) return '< 10 m';
    if (m < 1000) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
  }

  var SEARCH_LIMIT = 100;

  function runSearch() {
    var words = norm($('searchInput').value).split(/\s+/).filter(Boolean);
    var origin = searchOrigin();

    var hits = places.map(function (p) {
      return { p: p, d: map.distance(origin, [p.lat, p.lng]) };
    }).filter(function (h) {
      if (!words.length) return true;
      var hay = norm(h.p.name + ' ' + h.p.note + ' ' + TYPES[h.p.type].label);
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    }).sort(function (a, b) { return a.d - b.d; });

    var info = $('searchInfo');
    var list = $('searchList');
    list.textContent = '';

    if (!places.length) {
      info.textContent = '';
    } else {
      var count = words.length ? hits.length + ' Treffer' : places.length + (places.length === 1 ? ' Ort' : ' Orte');
      info.textContent = count + ', nach Entfernung von ' + (meMarker ? 'deinem Standort' : 'der Kartenmitte') +
        (hits.length > SEARCH_LIMIT ? ' (die ersten ' + SEARCH_LIMIT + ')' : '') + '.';
    }

    if (!hits.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = places.length
        ? 'Nichts gefunden. Probier einen anderen Begriff.'
        : 'Noch keine Orte gespeichert. Lege den ersten mit dem ＋ an.';
      list.appendChild(empty);
      return;
    }

    hits.slice(0, SEARCH_LIMIT).forEach(function (h) {
      var p = h.p, t = TYPES[p.type];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'result';
      b.setAttribute('role', 'listitem');

      var ico = document.createElement('div');
      ico.className = 'ico';
      ico.style.background = t.color;
      ico.textContent = t.emoji;
      b.appendChild(ico);

      var txt = document.createElement('div');
      txt.className = 'txt';
      var nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = p.name || t.label;
      var sub = document.createElement('div');
      sub.className = 'sub';
      var parts = [t.label];
      if (p.note) parts.push(p.note.replace(/\s+/g, ' '));
      if (p.photo) parts.push('📷');
      sub.textContent = parts.join(' · ');
      txt.appendChild(nm);
      txt.appendChild(sub);
      b.appendChild(txt);

      var dist = document.createElement('div');
      dist.className = 'dist';
      dist.textContent = fmtDist(h.d);
      b.appendChild(dist);

      b.addEventListener('click', function () { goToPlace(p); });
      list.appendChild(b);
    });
  }

  function goToPlace(p) {
    // Ist der Typ ausgefiltert, wieder einschalten, sonst gäbe es keinen Marker zum Anzeigen.
    if (activeFilter.indexOf(p.type) === -1) {
      activeFilter.push(p.type);
      save(KEY_FILTER, activeFilter);
      renderFilters();
      render();
    }
    closeSearch();
    map.closePopup();
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17), { animate: false });
    var m = markersById[p.id];
    if (m) m.openPopup();
  }

  function openSearch() {
    closeAdd();
    $('menuSheet').hidden = true;
    $('toast').hidden = true;
    map.closePopup();
    $('searchInput').value = '';
    $('searchView').hidden = false;
    runSearch();
    // Sofort fokussieren (nicht per Timeout): Nur direkt beim Tippen öffnet iOS die Tastatur.
    $('searchInput').focus();
  }

  function closeSearch() {
    $('searchView').hidden = true;
    $('searchInput').blur();
  }

  $('searchBtn').addEventListener('click', openSearch);
  $('searchClose').addEventListener('click', closeSearch);
  $('searchInput').addEventListener('input', runSearch);
  $('searchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') e.target.blur();   // Tastatur einklappen, damit man die ganze Liste sieht
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('searchView').hidden) closeSearch();
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
    toast('Export wird vorbereitet …');
    Promise.all(places.map(function (p) {
      var item = Object.assign({}, p);
      if (!p.photo) return item;
      return getPhoto(p.id)
        .then(function (blob) { return blob ? readBlob(blob, 'url') : null; })
        .then(function (data) { if (data) item.photoData = data; return item; })
        .catch(function () { return item; });
    })).then(function (items) {
      var blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'hunderoute-orte.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  });

  $('importFile').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var raw = JSON.parse(reader.result);
        // Fotos aus der Datei merken (nur JPEG, mit Größenlimit)
        var photoById = {};
        if (Array.isArray(raw)) raw.forEach(function (r) {
          if (r && r.id && typeof r.photoData === 'string' &&
              r.photoData.indexOf('data:image/jpeg;base64,') === 0 && r.photoData.length < 4000000) {
            photoById[String(r.id).slice(0, 40)] = r.photoData;
          }
        });
        var incoming = sanitizeList(raw);
        var known = {};
        places.forEach(function (p) { known[p.id] = true; });
        var added = 0;
        var withPhoto = [];
        incoming.forEach(function (p) {
          if (known[p.id]) return;
          p.photo = false;
          places.push(p);
          added++;
          if (photoById[p.id]) withPhoto.push(p);
        });
        persist();
        render();
        $('menuSheet').hidden = true;
        toast(added + ' Orte importiert');
        Promise.all(withPhoto.map(function (p) {
          return fetch(photoById[p.id])
            .then(function (r) { return r.blob(); })
            .then(function (b) { return putPhoto(p.id, b); })
            .then(function () { p.photo = true; })
            .catch(function () { /* dieses Foto überspringen */ });
        })).then(function () {
          if (withPhoto.length) { persist(); render(); }
        });
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
      clearPhotos();
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
