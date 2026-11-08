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
      marker.on('popupopen', function (e) {
        // Läuft ein Spaziergang, verdeckt die Anzeige unten einen Teil der Karte.
        e.popup.options.autoPanPaddingBottomRight = L.point(16, document.body.classList.contains('walking') ? 190 : 96);
        e.popup.setContent(popupFor(p));
      });
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
  // Blauer Punkt für die eigene Position
  function setMe(ll) {
    if (meMarker) meMarker.setLatLng(ll);
    else meMarker = L.circleMarker(ll, {
      radius: 9, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1
    }).addTo(map);
  }

  function locate(userInitiated) {
    if (!navigator.geolocation) {
      if (userInitiated) toast('Standort wird von diesem Gerät nicht unterstützt.');
      return;
    }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var ll = [pos.coords.latitude, pos.coords.longitude];
      setMe(ll);
      map.setView(ll, Math.max(map.getZoom(), 16));
    }, function () {
      if (userInitiated) toast('Standort nicht verfügbar. Bitte in den Einstellungen erlauben.');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }
  // Während eines Spaziergangs folgt die Karte dem Läufer, bis man sie selbst verschiebt.
  var followMe = false;
  map.on('dragstart', function () { followMe = false; });
  $('locateBtn').addEventListener('click', function () { followMe = true; locate(true); });

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

  // ---------- Gassi-Protokoll ----------
  var KEY_WALKS = 'hunderoute.walks.v1';
  var KEY_ACTIVE = 'hunderoute.walk.active.v1';   // laufender Spaziergang (übersteht ein Neuladen)
  var STALE_MS = 3 * 60 * 60 * 1000;              // so lange ohne Lebenszeichen: Spaziergang gilt als vergessen
  var MAX_ACCURACY = 40;                          // Meter, ungenauere GPS-Punkte werden ignoriert
  var MIN_STEP = 8;                               // Meter, kleinere Bewegungen gelten als GPS-Rauschen
  var MAX_SAVED_POINTS = 1500;                    // längere Routen werden beim Speichern ausgedünnt

  var walks = sanitizeWalks(load(KEY_WALKS, []));
  var walk = null;                                // laufender Spaziergang: {id, start, points:[[lat,lng,t]], dist, poo, pee}
  var watchId = null, tickTimer = null, wakeLock = null, centered = false;
  var walkLine = null;                            // Linie des laufenden Spaziergangs
  var viewLayer = L.layerGroup().addTo(map);      // Route eines alten Spaziergangs
  var openWalkId = null;

  function clampInt(v) {
    v = Math.round(Number(v));
    return isFinite(v) ? Math.min(99, Math.max(0, v)) : 0;
  }

  function sanitizeWalks(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (w) {
      if (!w) return;
      var start = Number(w.start), end = Number(w.end);
      if (!isFinite(start) || !isFinite(end) || end < start) return;
      var pts = [];
      if (Array.isArray(w.points)) w.points.slice(0, 3000).forEach(function (q) {
        if (!Array.isArray(q)) return;
        var la = Number(q[0]), lo = Number(q[1]);
        if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) pts.push([la, lo]);
      });
      out.push({
        id: String(w.id || newId()).slice(0, 40),
        start: start,
        end: end,
        dist: Math.max(0, Number(w.dist) || 0),
        poo: clampInt(w.poo),
        pee: clampInt(w.pee),
        note: String(w.note || '').slice(0, 300),
        points: pts
      });
    });
    return out;
  }

  // Wie save(), meldet aber zurück, ob es geklappt hat (z. B. Speicher voll).
  function saveChecked(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function persistWalks() {
    var ok = saveChecked(KEY_WALKS, walks);
    updateWalkCount();
    return ok;
  }
  function updateWalkCount() {
    $('walkCountInfo').textContent = walks.length ? walks.length + (walks.length === 1 ? ' Spaziergang' : ' Spaziergänge') + ' im Protokoll.' : '';
  }

  // ----- Formate -----
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function fmtKm(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2).replace('.', ',') + ' km'; }
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + pad2(m) : String(m)) + ':' + pad2(x);
  }
  function fmtDur(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return '< 1 Min.';
    if (m < 60) return m + ' Min.';
    return Math.floor(m / 60) + ' Std.' + (m % 60 ? ' ' + (m % 60) + ' Min.' : '');
  }
  function fmtWalkDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ', ' +
      d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }
  function walkWord(n) { return n + (n === 1 ? ' Spaziergang' : ' Spaziergänge'); }

  // ----- Bildschirm anlassen (damit die Aufzeichnung nicht pausiert) -----
  function requestWake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; });
    }).catch(function () { /* nicht möglich, dann geht der Bildschirm eben aus */ });
  }
  function releaseWake() {
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }
  // Ein Wake Lock endet, wenn die App in den Hintergrund geht. Beim Zurückkommen neu holen.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && walk && !wakeLock) requestWake();
  });

  // ----- Aufzeichnung -----
  function startWalk() {
    if (walk) return;
    if (!navigator.geolocation) { toast('Standort wird von diesem Gerät nicht unterstützt.'); return; }
    walk = { id: newId(), start: Date.now(), points: [], dist: 0, poo: 0, pee: 0 };
    saveChecked(KEY_ACTIVE, walk);
    followMe = true;
    beginTracking();
  }

  function beginTracking() {
    centered = false;
    document.body.classList.add('walking');
    $('walkBtn').classList.add('on');
    $('walkPanel').hidden = false;
    walkLine = L.polyline(walk.points.map(function (q) { return [q[0], q[1]]; }),
      { color: '#1a73e8', weight: 6, opacity: 0.85 }).addTo(map);
    updatePanel();
    tickTimer = setInterval(updatePanel, 1000);
    watchId = navigator.geolocation.watchPosition(onWalkPos, onWalkErr,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    requestWake();
  }

  function endTracking() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
    releaseWake();
    if (walkLine) { map.removeLayer(walkLine); walkLine = null; }
    document.body.classList.remove('walking');
    $('walkBtn').classList.remove('on');
    $('walkPanel').hidden = true;
    try { localStorage.removeItem(KEY_ACTIVE); } catch (e) { /* ignorieren */ }
    followMe = false;
  }

  function onWalkPos(pos) {
    if (!walk) return;
    var c = pos.coords;
    var ll = [c.latitude, c.longitude];
    var t = pos.timestamp || Date.now();
    setMe(ll);
    if (followMe && !centered) { centered = true; map.setView(ll, Math.max(map.getZoom(), 16)); }
    if (c.accuracy > MAX_ACCURACY) return;                       // zu ungenau
    var last = walk.points[walk.points.length - 1];
    if (last) {
      var d = map.distance([last[0], last[1]], ll);
      var dt = Math.max(1, (t - last[2]) / 1000);
      if (d < Math.max(MIN_STEP, c.accuracy / 2)) return;        // nur Rauschen
      if (d > 50 && d / dt > 20) return;                         // GPS-Ausreißer (über 70 km/h)
      walk.dist += d;
    }
    walk.points.push([ll[0], ll[1], t]);
    walkLine.addLatLng(ll);
    saveChecked(KEY_ACTIVE, walk);
    updatePanel();
    if (followMe) map.panTo(ll);
  }

  function onWalkErr(err) {
    // Standort verweigert und noch kein einziger Punkt: dann hat die Aufzeichnung keinen Sinn.
    if (walk && err && err.code === 1 && !walk.points.length) {
      endTracking();
      walk = null;
      toast('Ohne Standort kann ich keinen Weg aufzeichnen. Bitte erlaube den Standort.');
    }
    // Zeitüberschreitungen und kurze Aussetzer ignorieren wir, der nächste Punkt kommt.
  }

  function updatePanel() {
    if (!walk) return;
    $('walkTime').textContent = fmtClock(Date.now() - walk.start);
    $('walkDist').textContent = walk.points.length ? fmtKm(walk.dist) : 'GPS wird gesucht …';
    $('pooBtn').textContent = '💩 ' + walk.poo;
    $('peeBtn').textContent = '💧 ' + walk.pee;
  }

  $('pooBtn').addEventListener('click', function () {
    if (!walk) return;
    walk.poo = clampInt(walk.poo + 1);
    saveChecked(KEY_ACTIVE, walk);
    updatePanel();
  });
  $('peeBtn').addEventListener('click', function () {
    if (!walk) return;
    walk.pee = clampInt(walk.pee + 1);
    saveChecked(KEY_ACTIVE, walk);
    updatePanel();
  });

  // Fertigen Eintrag bauen (Route ausdünnen und Koordinaten auf ca. 1 m runden, spart Platz)
  function buildRecord(w, endTs, note) {
    var pts = w.points;
    if (pts.length > MAX_SAVED_POINTS) {
      var step = Math.ceil(pts.length / MAX_SAVED_POINTS), thin = [];
      for (var i = 0; i < pts.length; i += step) thin.push(pts[i]);
      if (thin[thin.length - 1] !== pts[pts.length - 1]) thin.push(pts[pts.length - 1]);
      pts = thin;
    }
    return {
      id: w.id,
      start: w.start,
      end: Math.max(endTs, w.start),
      dist: Math.round(w.dist),
      poo: clampInt(w.poo),
      pee: clampInt(w.pee),
      note: String(note || '').slice(0, 300),
      points: pts.map(function (q) { return [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5]; })
    };
  }

  // Speichert einen Eintrag. Ist der Speicher knapp, wird es zumindest ohne Route versucht.
  function storeWalk(rec) {
    walks.push(rec);
    if (persistWalks()) return 'ok';
    rec.points = [];
    if (persistWalks()) return 'ohne Route';
    walks.pop();
    updateWalkCount();
    return 'fehler';
  }

  function toastStored(res) {
    toast(res === 'ok' ? 'Spaziergang gespeichert ✓'
      : res === 'ohne Route' ? 'Gespeichert, aber ohne Route (Speicher knapp).'
      : 'Speicher voll, der Spaziergang konnte nicht gespeichert werden.');
  }

  // Nach einem Neuladen: laufenden Spaziergang fortsetzen, einen vergessenen abschließen.
  function restoreWalk() {
    var d = load(KEY_ACTIVE, null);
    if (!d || !isFinite(Number(d.start))) return;
    var pts = [];
    if (Array.isArray(d.points)) d.points.forEach(function (q) {
      if (Array.isArray(q) && isFinite(q[0]) && isFinite(q[1]) && isFinite(q[2])) pts.push([+q[0], +q[1], +q[2]]);
    });
    walk = { id: String(d.id || newId()).slice(0, 40), start: Number(d.start), points: pts,
      dist: Math.max(0, Number(d.dist) || 0), poo: clampInt(d.poo), pee: clampInt(d.pee) };
    var lastT = pts.length ? pts[pts.length - 1][2] : walk.start;
    if (Date.now() - lastT > STALE_MS) {
      var w = walk;
      walk = null;
      try { localStorage.removeItem(KEY_ACTIVE); } catch (e) { /* ignorieren */ }
      if (w.points.length >= 2) {
        toast(storeWalk(buildRecord(w, lastT, '')) === 'fehler'
          ? 'Ein früherer Spaziergang konnte nicht gespeichert werden.'
          : 'Ein früherer, nicht beendeter Spaziergang wurde gespeichert.');
      }
      return;
    }
    followMe = true;
    beginTracking();
  }

  // ----- Beenden -----
  function openEnd() {
    if (!walk) return;
    $('walkEndStats').textContent = fmtClock(Date.now() - walk.start) + ' · ' +
      (walk.points.length ? fmtKm(walk.dist) : 'noch keine Strecke');
    $('endPoo').value = walk.poo;
    $('endPee').value = walk.pee;
    $('endNote').value = '';
    $('walkPanel').hidden = true;
    $('walkEndSheet').hidden = false;
  }
  function closeEnd() {
    $('walkEndSheet').hidden = true;
    if (walk) $('walkPanel').hidden = false;
  }

  $('walkStop').addEventListener('click', openEnd);
  $('endContinue').addEventListener('click', closeEnd);
  $('endDiscard').addEventListener('click', function () {
    if (!confirm('Diesen Spaziergang verwerfen? Die Aufzeichnung geht verloren.')) return;
    endTracking();
    walk = null;
    $('walkEndSheet').hidden = true;
    toast('Verworfen');
  });
  $('endSave').addEventListener('click', function () {
    if (!walk) return;
    walk.poo = clampInt($('endPoo').value);
    walk.pee = clampInt($('endPee').value);
    var rec = buildRecord(walk, Date.now(), $('endNote').value.trim());
    endTracking();
    walk = null;
    $('walkEndSheet').hidden = true;
    toastStored(storeWalk(rec));
  });

  // ----- Protokoll-Liste -----
  function openWalkView() {
    closeAdd();
    closeSearch();
    $('menuSheet').hidden = true;
    $('toast').hidden = true;
    map.closePopup();
    renderWalkView();
    $('walkView').hidden = false;
  }
  function closeWalkView() { $('walkView').hidden = true; }

  function renderWalkView() {
    var sorted = walks.slice().sort(function (a, b) { return b.start - a.start; });

    var weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    var week = sorted.filter(function (w) { return w.start >= weekAgo; });
    var sum = function (list) { return list.reduce(function (s, w) { return s + w.dist; }, 0); };
    var stats = $('walkStats');
    stats.textContent = '';
    [['Letzte 7 Tage: ', week], ['Insgesamt: ', sorted]].forEach(function (row) {
      var div = document.createElement('div');
      div.textContent = row[0] + walkWord(row[1].length) + ', ' + fmtKm(sum(row[1]));
      stats.appendChild(div);
    });

    var start = $('walkStart');
    start.disabled = !!walk;
    start.textContent = walk ? 'Ein Spaziergang läuft gerade' : '▶ Spaziergang starten';

    var list = $('walkList');
    list.textContent = '';
    if (!sorted.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Noch kein Spaziergang aufgezeichnet. Tipp oben auf „Spaziergang starten“.';
      list.appendChild(empty);
      return;
    }
    sorted.forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'walk-item';
      b.setAttribute('role', 'listitem');

      var ico = document.createElement('div');
      ico.className = 'ico';
      ico.textContent = '🦮';
      b.appendChild(ico);

      var txt = document.createElement('div');
      txt.className = 'txt';
      var nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = fmtWalkDate(w.start);
      var sub = document.createElement('div');
      sub.className = 'sub';
      var parts = [fmtDur(w.end - w.start), fmtKm(w.dist)];
      if (w.poo) parts.push('💩 ' + w.poo);
      if (w.pee) parts.push('💧 ' + w.pee);
      if (w.note) parts.push(w.note.replace(/\s+/g, ' '));
      sub.textContent = parts.join(' · ');
      txt.appendChild(nm);
      txt.appendChild(sub);
      b.appendChild(txt);

      var go = document.createElement('div');
      go.className = 'go';
      go.textContent = '›';
      b.appendChild(go);

      b.addEventListener('click', function () { showWalk(w); });
      list.appendChild(b);
    });
  }

  // ----- Einzelner Spaziergang auf der Karte -----
  function showWalk(w) {
    closeWalkView();
    openWalkId = w.id;
    viewLayer.clearLayers();
    $('walkSheetTitle').textContent = fmtWalkDate(w.start);
    var info = fmtDur(w.end - w.start) + ' · ' + fmtKm(w.dist);
    if (w.poo) info += ' · 💩 ' + w.poo;
    if (w.pee) info += ' · 💧 ' + w.pee;
    if (w.points.length < 2) info += '. Für diesen Spaziergang gibt es keine Route.';
    $('walkSheetStats').textContent = info;
    $('walkNote').value = w.note;
    $('walkPanel').hidden = true;
    $('fabs').hidden = true;
    $('walkSheet').hidden = false;
    if (w.points.length >= 2) {
      var line = L.polyline(w.points, { color: '#8e44ad', weight: 6, opacity: 0.9 }).addTo(viewLayer);
      var first = w.points[0], lastPt = w.points[w.points.length - 1];
      L.circleMarker(first, { radius: 8, color: '#fff', weight: 3, fillColor: '#2e9e5b', fillOpacity: 1 })
        .bindTooltip('Start').addTo(viewLayer);
      L.circleMarker(lastPt, { radius: 8, color: '#fff', weight: 3, fillColor: '#d0453b', fillOpacity: 1 })
        .bindTooltip('Ziel').addTo(viewLayer);
      map.fitBounds(line.getBounds(), { paddingTopLeft: [28, 90], paddingBottomRight: [28, 330], maxZoom: 18, animate: false });
    }
  }

  function closeWalkSheet(saveNote) {
    var w = walks.filter(function (x) { return x.id === openWalkId; })[0];
    if (saveNote && w) {
      var note = $('walkNote').value.trim().slice(0, 300);
      if (note !== w.note) {
        w.note = note;
        if (!persistWalks()) toast('Speicher voll, die Notiz konnte nicht gespeichert werden.');
      }
    }
    openWalkId = null;
    viewLayer.clearLayers();
    $('walkSheet').hidden = true;
    $('fabs').hidden = false;
    if (walk) $('walkPanel').hidden = false;
  }

  $('walkSheetClose').addEventListener('click', function () { closeWalkSheet(true); });
  $('walkDel').addEventListener('click', function () {
    if (!confirm('Diesen Spaziergang aus dem Protokoll löschen?')) return;
    walks = walks.filter(function (x) { return x.id !== openWalkId; });
    persistWalks();
    closeWalkSheet(false);
    toast('Gelöscht');
  });

  $('walkBtn').addEventListener('click', openWalkView);
  $('walkViewClose').addEventListener('click', closeWalkView);
  $('walkStart').addEventListener('click', function () {
    if (walk) return;
    closeWalkView();
    startWalk();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('walkView').hidden) closeWalkView();
  });

  // ----- Export und Import des Protokolls -----
  $('walkExportBtn').addEventListener('click', function () {
    if (!walks.length) { toast('Noch keine Spaziergänge im Protokoll.'); return; }
    downloadJson('hunderoute-gassi-protokoll.json', { hunderoute: 'walks', version: 1, walks: walks });
  });

  $('walkImportFile').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var raw = JSON.parse(reader.result);
        var incoming = sanitizeWalks(Array.isArray(raw) ? raw : raw && raw.walks);
        var known = {};
        walks.forEach(function (w) { known[w.id] = true; });
        var before = walks.slice();
        var added = 0;
        incoming.forEach(function (w) {
          if (!known[w.id]) { walks.push(w); known[w.id] = true; added++; }
        });
        if (added && !persistWalks()) {
          walks = before;
          updateWalkCount();
          toast('Speicher voll, der Import war nicht möglich.');
          return;
        }
        $('menuSheet').hidden = true;
        toast(added === 1 ? '1 Spaziergang importiert' : added + ' Spaziergänge importiert');
      } catch (e) {
        toast('Die Datei konnte nicht gelesen werden.');
      }
    };
    reader.readAsText(file);
  });

  // ---------- Erinnerungen (Tierarzt, Impfung, ...) ----------
  var KEY_REM = 'hunderoute.reminders.v1';

  // lead = Tage vorher erinnern, repeat = Monate bis zum nächsten Termin (0 = einmalig)
  var REM_TYPES = {
    tierarzt: { emoji: '🩺', label: 'Tierarzt-Termin',        lead: 1, repeat: 0,  ph: 'z. B. Kontrolle bei Dr. Meier' },
    impfung:  { emoji: '💉', label: 'Impfung',                lead: 7, repeat: 12, ph: 'z. B. Tollwut oder Staupe' },
    wurm:     { emoji: '💊', label: 'Entwurmung',             lead: 3, repeat: 3,  ph: 'z. B. Wurmkur' },
    zecke:    { emoji: '🪲', label: 'Zecken- und Flohschutz', lead: 3, repeat: 1,  ph: 'z. B. Spot-on erneuern' },
    sonst:    { emoji: '📌', label: 'Sonstiges',              lead: 1, repeat: 0,  ph: 'z. B. Hundesteuer zahlen' }
  };
  var REM_TYPE_KEYS = Object.keys(REM_TYPES);
  var REPEATS = [[0, 'Einmalig'], [1, 'Jeden Monat'], [3, 'Alle 3 Monate'], [6, 'Alle 6 Monate'],
    [12, 'Jedes Jahr'], [24, 'Alle 2 Jahre'], [36, 'Alle 3 Jahre']];
  var LEADS = [[0, 'Am Tag selbst'], [1, '1 Tag vorher'], [3, '3 Tage vorher'], [7, '1 Woche vorher'], [14, '2 Wochen vorher']];

  var reminders = sanitizeReminders(load(KEY_REM, []));
  var editingRemId = null;   // null = neue Erinnerung
  var remType = 'tierarzt';

  function pickOpt(opts, v, dflt) {
    v = Number(v);
    return opts.some(function (o) { return o[0] === v; }) ? v : dflt;
  }

  // ----- Datumsrechnung (Daten als "JJJJ-MM-TT", ohne Zeitzonen-Fallen) -----
  function isDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  function isTimeStr(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
  function dateStrOf(date) { return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()); }
  function todayStr() { return dateStrOf(new Date()); }
  function dayNum(s) { return Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5); }
  function daysFromToday(s) { return dayNum(s) - dayNum(todayStr()); }
  function addDaysStr(s, n) {
    return new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) + n * 864e5).toISOString().slice(0, 10);
  }
  // Monate dazurechnen, am Monatsende abschneiden (31.01. + 1 Monat = 28.02. bzw. 29.02.)
  function addMonthsStr(s, n) {
    var y = +s.slice(0, 4), m = +s.slice(5, 7) - 1 + n, d = +s.slice(8, 10);
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return y + '-' + pad2(m + 1) + '-' + pad2(Math.min(d, last));
  }
  function localDate(s) { return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function fmtDateLong(s) {
    return localDate(s).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtDateShort(s) { return localDate(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  function relLabel(days) {
    if (days < -1) return 'seit ' + (-days) + ' Tagen überfällig';
    if (days === -1) return 'seit gestern überfällig';
    if (days === 0) return 'heute';
    if (days === 1) return 'morgen';
    if (days <= 60) return 'in ' + days + ' Tagen';
    return 'in ca. ' + Math.round(days / 30.4) + ' Monaten';
  }
  function repeatLabel(n) {
    var o = REPEATS.filter(function (x) { return x[0] === n; })[0];
    return o ? o[1] : '';
  }

  function sanitizeReminders(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (r) {
      if (!r || !isDateStr(r.due)) return;
      out.push({
        id: String(r.id || newId()).slice(0, 40),
        type: REM_TYPES[r.type] ? r.type : 'sonst',
        title: String(r.title || '').slice(0, 60),
        due: r.due,
        time: isTimeStr(r.time) ? r.time : '',
        repeat: pickOpt(REPEATS, r.repeat, 0),
        lead: pickOpt(LEADS, r.lead, 1),
        note: String(r.note || '').slice(0, 300),
        done: r.done === true,
        doneAt: isDateStr(r.doneAt) ? r.doneAt : '',
        next: String(r.next || '').slice(0, 40)
      });
    });
    return out;
  }

  // Speichert die neue Liste. Klappt das nicht (Speicher voll), bleibt die alte Liste unverändert.
  function commitReminders(next) {
    var old = reminders;
    reminders = next;
    if (!saveChecked(KEY_REM, reminders)) {
      reminders = old;
      toast('Speicher voll, die Erinnerung konnte nicht gespeichert werden.');
      return false;
    }
    updateRemBadge();
    return true;
  }

  function byDue(a, b) {
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    var ta = a.time || '', tb = b.time || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }
  function remTitle(r) { return r.title || REM_TYPES[r.type].label; }
  // "Braucht Aufmerksamkeit": überfällig oder innerhalb der Vorlaufzeit
  function needsAttention(r) { return !r.done && daysFromToday(r.due) <= r.lead; }
  function attentionList() { return reminders.filter(needsAttention).sort(byDue); }

  function updateRemBadge() {
    var n = attentionList().length;
    var el = $('remBadge');
    el.hidden = n === 0;
    el.textContent = n > 9 ? '9+' : String(n);
    $('remBtn').setAttribute('aria-label', n ? 'Erinnerungen, ' + n + ' fällig' : 'Erinnerungen');
  }

  // Beim Öffnen der App kurz auf Fälliges hinweisen
  function remindOnStart() {
    var list = attentionList();
    if (!list.length) return;
    var first = list[0];
    var msg = '🩺 ' + remTitle(first) + ': ' + relLabel(daysFromToday(first.due));
    if (list.length > 1) msg += ' (+' + (list.length - 1) + ' weitere)';
    setTimeout(function () { toast(msg); }, $('toast').hidden ? 500 : 3000);
  }

  // Ein neuer Tag beginnt, während die App offen liegt: Punkt und Liste auffrischen
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    updateRemBadge();
    if (!$('remView').hidden) renderRemView();
  });

  // ----- Liste -----
  function openRemView() {
    closeAdd();
    closeSearch();
    closeWalkView();
    map.closePopup();
    $('toast').hidden = true;
    $('remEdit').hidden = true;
    renderRemView();
    $('remView').hidden = false;
    document.body.classList.add('rem-list');   // Hinweise rutschen über die Schaltflächen unten
  }
  function closeRemView() {
    $('remView').hidden = true;
    document.body.classList.remove('rem-list');
  }

  function remItemEl(r) {
    var days = daysFromToday(r.due);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'rem-item' + (r.done ? ' done' : days < 0 ? ' late' : needsAttention(r) ? ' soon' : '');
    b.setAttribute('role', 'listitem');

    var ico = document.createElement('div');
    ico.className = 'ico';
    ico.textContent = REM_TYPES[r.type].emoji;
    b.appendChild(ico);

    var txt = document.createElement('div');
    txt.className = 'txt';
    var nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = remTitle(r);
    var sub = document.createElement('div');
    sub.className = 'sub';
    if (r.done) {
      sub.textContent = 'Erledigt am ' + fmtDateShort(r.doneAt || r.due);
    } else {
      sub.appendChild(document.createTextNode(fmtDateLong(r.due) + (r.time ? ', ' + r.time + ' Uhr' : '') + ' · '));
      var rel = document.createElement('span');
      rel.className = 'rel';
      rel.textContent = relLabel(days);
      sub.appendChild(rel);
      if (r.repeat) sub.appendChild(document.createTextNode(' · ' + repeatLabel(r.repeat)));
    }
    txt.appendChild(nm);
    txt.appendChild(sub);
    b.appendChild(txt);

    var go = document.createElement('div');
    go.className = 'go';
    go.textContent = '›';
    b.appendChild(go);

    b.addEventListener('click', function () { openRemEdit(r); });
    return b;
  }

  function renderRemView() {
    var list = $('remList');
    list.textContent = '';
    var open = reminders.filter(function (r) { return !r.done; }).sort(byDue);
    var done = reminders.filter(function (r) { return r.done; }).sort(function (a, b) {
      var da = a.doneAt || a.due, db = b.doneAt || b.due;
      return da < db ? 1 : da > db ? -1 : 0;
    }).slice(0, 10);
    $('remCal').disabled = !open.length;
    $('remExport').disabled = !reminders.length;

    if (!reminders.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Noch keine Erinnerungen. Lege Impfungen, Tierarzt-Termine oder Wurmkuren an, die App zeigt dir dann an, was fällig ist.';
      list.appendChild(empty);
      return;
    }
    if (!open.length) {
      var none = document.createElement('div');
      none.className = 'empty';
      none.textContent = 'Keine offenen Erinnerungen.';
      list.appendChild(none);
    }
    [
      ['Überfällig', 'late', open.filter(function (r) { return daysFromToday(r.due) < 0; })],
      ['In den nächsten 30 Tagen', '', open.filter(function (r) { var d = daysFromToday(r.due); return d >= 0 && d <= 30; })],
      ['Später', '', open.filter(function (r) { return daysFromToday(r.due) > 30; })],
      ['Zuletzt erledigt', '', done]
    ].forEach(function (g) {
      if (!g[2].length) return;
      var h = document.createElement('div');
      h.className = 'rem-h' + (g[1] ? ' ' + g[1] : '');
      h.textContent = g[0];
      list.appendChild(h);
      g[2].forEach(function (r) { list.appendChild(remItemEl(r)); });
    });
  }

  // ----- Bearbeiten -----
  function fillSelect(sel, opts) {
    sel.textContent = '';
    opts.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0];
      op.textContent = o[1];
      sel.appendChild(op);
    });
  }
  fillSelect($('remRepeat'), REPEATS);
  fillSelect($('remLead'), LEADS);

  function renderRemTypes() {
    var box = $('remTypes');
    box.textContent = '';
    REM_TYPE_KEYS.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (remType === k ? ' sel' : '');
      b.textContent = REM_TYPES[k].emoji + ' ' + REM_TYPES[k].label;
      b.addEventListener('click', function () { setRemType(k, !editingRemId); });
      box.appendChild(b);
    });
  }

  // Bei einer neuen Erinnerung setzt der Typ sinnvolle Vorgaben (z. B. Impfung: jedes Jahr, 1 Woche vorher)
  function setRemType(k, applyDefaults) {
    remType = k;
    if (applyDefaults) {
      $('remRepeat').value = REM_TYPES[k].repeat;
      $('remLead').value = REM_TYPES[k].lead;
    }
    $('remTitle').placeholder = REM_TYPES[k].ph;
    renderRemTypes();
  }

  function openRemEdit(r) {
    editingRemId = r ? r.id : null;
    $('remEditTitle').textContent = r ? 'Bearbeiten' : 'Neu';
    $('remTitle').value = r ? r.title : '';
    $('remDue').value = r ? r.due : todayStr();
    $('remTime').value = r ? r.time : '';
    $('remNote').value = r ? r.note : '';
    setRemType(r ? r.type : 'tierarzt', !r);
    if (r) { $('remRepeat').value = r.repeat; $('remLead').value = r.lead; }
    $('remEditActions').hidden = !r;
    $('remDone').hidden = !!(r && r.done);
    $('remReopen').hidden = !(r && r.done);
    updateRemSave();
    closeRemView();
    $('remEdit').hidden = false;
    $('remEditBody').scrollTop = 0;
  }
  function closeRemEdit() { $('remEdit').hidden = true; }

  // Liest das Formular, null bei ungültigem Datum
  function collectRemForm() {
    var due = $('remDue').value;
    if (!isDateStr(due)) return null;
    var time = $('remTime').value;
    return {
      type: remType,
      title: $('remTitle').value.trim().slice(0, 60),
      due: due,
      time: isTimeStr(time) ? time : '',
      repeat: pickOpt(REPEATS, $('remRepeat').value, 0),
      lead: pickOpt(LEADS, $('remLead').value, 1),
      note: $('remNote').value.trim().slice(0, 300)
    };
  }
  function updateRemSave() {
    var ok = !!collectRemForm();
    $('remSave').disabled = !ok;
    $('remDone').disabled = !ok;
    $('remIcs').disabled = !ok;
  }
  ['remDue', 'remTime', 'remRepeat', 'remLead'].forEach(function (id) {
    $(id).addEventListener('input', updateRemSave);
    $(id).addEventListener('change', updateRemSave);
  });

  function findRem(id) { return reminders.filter(function (r) { return r.id === id; })[0]; }

  $('remBtn').addEventListener('click', openRemView);
  $('remViewClose').addEventListener('click', closeRemView);
  $('remNew').addEventListener('click', function () { openRemEdit(null); });
  $('remCancel').addEventListener('click', function () { closeRemEdit(); openRemView(); });

  $('remSave').addEventListener('click', function () {
    var f = collectRemForm();
    if (!f) return;
    var next = editingRemId
      ? reminders.map(function (r) { return r.id === editingRemId ? Object.assign({}, r, f) : r; })
      : reminders.concat([Object.assign({ id: newId(), done: false, doneAt: '', next: '' }, f)]);
    if (!commitReminders(next)) return;
    closeRemEdit();
    openRemView();
    toast('Gespeichert ✓');
  });

  // Erledigt: Bei wiederkehrenden Terminen entsteht der nächste ab heute (Impfung heute + 12 Monate)
  $('remDone').addEventListener('click', function () {
    var f = collectRemForm();
    var cur = editingRemId && findRem(editingRemId);
    if (!f || !cur) return;
    var today = todayStr();
    var updated = Object.assign({}, cur, f, { done: true, doneAt: today, next: '' });
    var successor = null;
    if (updated.repeat > 0) {
      successor = Object.assign({}, updated, { id: newId(), due: addMonthsStr(today, updated.repeat), done: false, doneAt: '', next: '' });
      updated.next = successor.id;
    }
    var next = reminders.map(function (r) { return r.id === cur.id ? updated : r; });
    if (successor) next.push(successor);
    if (!commitReminders(next)) return;
    closeRemEdit();
    openRemView();
    toast(successor ? 'Erledigt ✓ Nächste Erinnerung: ' + fmtDateShort(successor.due) : 'Erledigt ✓');
  });

  // Wieder öffnen: den automatisch angelegten Folgetermin entfernen, wenn er noch offen ist
  $('remReopen').addEventListener('click', function () {
    var cur = editingRemId && findRem(editingRemId);
    if (!cur) return;
    var next = reminders.filter(function (r) { return !(cur.next && r.id === cur.next && !r.done); })
      .map(function (r) { return r.id === cur.id ? Object.assign({}, r, { done: false, doneAt: '', next: '' }) : r; });
    if (!commitReminders(next)) return;
    closeRemEdit();
    openRemView();
    toast('Wieder offen');
  });

  $('remDel').addEventListener('click', function () {
    if (!editingRemId || !confirm('Diese Erinnerung löschen?')) return;
    if (!commitReminders(reminders.filter(function (r) { return r.id !== editingRemId; }))) return;
    closeRemEdit();
    openRemView();
    toast('Gelöscht');
  });

  // ----- Kalenderdatei (.ics): So meldet sich das Handy auch bei geschlossener App -----
  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  // Zeilen dürfen höchstens 75 Byte lang sein, längere werden mit Leerzeichen am Anfang fortgesetzt
  function icsFold(line) {
    var enc = new TextEncoder(), out = [], cur = '', bytes = 0;
    Array.from(line).forEach(function (ch) {
      var b = enc.encode(ch).length;
      if (bytes + b > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch;
      bytes += b;
    });
    out.push(cur);
    return out.join('\r\n');
  }
  function icsLocal(date) {
    return date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate()) + 'T' + pad2(date.getHours()) + pad2(date.getMinutes()) + '00';
  }
  function buildIcs(list) {
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hunderoute//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    list.forEach(function (r) {
      var summary = REM_TYPES[r.type].emoji + ' ' + remTitle(r);
      var desc = (r.note ? r.note + '\n' : '') + 'Erinnerung aus Hunderoute';
      L.push('BEGIN:VEVENT', 'UID:' + r.id + '@hunderoute', 'DTSTAMP:' + stamp);
      if (r.time) {
        var st = new Date(+r.due.slice(0, 4), +r.due.slice(5, 7) - 1, +r.due.slice(8, 10), +r.time.slice(0, 2), +r.time.slice(3, 5));
        L.push('DTSTART:' + icsLocal(st), 'DTEND:' + icsLocal(new Date(st.getTime() + 3600e3)));
      } else {
        L.push('DTSTART;VALUE=DATE:' + r.due.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + addDaysStr(r.due, 1).replace(/-/g, ''));
      }
      L.push('SUMMARY:' + icsEscape(summary), 'DESCRIPTION:' + icsEscape(desc));
      // Wecker: mit Uhrzeit relativ zum Termin, ohne Uhrzeit um 9 Uhr am Vorlauftag und am Tag selbst
      var alarms = [];
      if (r.time) {
        if (r.lead > 0) alarms.push('-P' + r.lead + 'D');
        alarms.push('-PT1H');
      } else {
        if (r.lead > 0) alarms.push(r.lead === 1 ? '-PT15H' : '-P' + (r.lead - 1) + 'DT15H');
        alarms.push('PT9H');
      }
      alarms.forEach(function (trigger) {
        L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape(summary), 'TRIGGER;RELATED=START:' + trigger, 'END:VALARM');
      });
      L.push('END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.map(icsFold).join('\r\n') + '\r\n';
  }

  // Teilen-Menü des Handys (da gibt es "Kalender"), sonst normaler Download
  function offerIcs(filename, text) {
    var file = null;
    try { file = new File([text], filename, { type: 'text/calendar' }); } catch (e) { /* ältere Browser */ }
    if (file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Hunderoute' }).catch(function (e) {
        if (!e || e.name !== 'AbortError') downloadText(filename, text, 'text/calendar;charset=utf-8');
      });
      return;
    }
    downloadText(filename, text, 'text/calendar;charset=utf-8');
  }

  $('remIcs').addEventListener('click', function () {
    var f = collectRemForm();
    if (!f) return;
    offerIcs('hunderoute-erinnerung.ics', buildIcs([Object.assign({ id: editingRemId || newId() }, f)]));
  });
  $('remCal').addEventListener('click', function () {
    var open = reminders.filter(function (r) { return !r.done; }).sort(byDue);
    if (!open.length) return;
    offerIcs('hunderoute-erinnerungen.ics', buildIcs(open));
  });

  // ----- Export und Import -----
  $('remExport').addEventListener('click', function () {
    if (!reminders.length) { toast('Noch keine Erinnerungen.'); return; }
    downloadJson('hunderoute-erinnerungen.json', { hunderoute: 'reminders', version: 1, reminders: reminders });
  });
  $('remImportFile').addEventListener('change', function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var raw = JSON.parse(reader.result);
        var incoming = sanitizeReminders(Array.isArray(raw) ? raw : raw && raw.reminders);
        var known = {};
        reminders.forEach(function (r) { known[r.id] = true; });
        var fresh = incoming.filter(function (r) { if (known[r.id]) return false; known[r.id] = true; return true; });
        if (fresh.length && !commitReminders(reminders.concat(fresh))) return;
        renderRemView();
        toast(fresh.length === 1 ? '1 Erinnerung importiert' : fresh.length + ' Erinnerungen importiert');
      } catch (e) {
        toast('Die Datei konnte nicht gelesen werden.');
      }
    };
    reader.readAsText(file);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('remEdit').hidden) { closeRemEdit(); openRemView(); }
    else if (!$('remView').hidden) closeRemView();
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
      downloadJson('hunderoute-orte.json', items);
    });
  });

  function downloadJson(filename, data) {
    downloadText(filename, JSON.stringify(data, null, 2), 'application/json');
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

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
  updateWalkCount();
  restoreWalk();
  updateRemBadge();
  remindOnStart();
  if (!savedView) locate(false);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ });
  }
})();
