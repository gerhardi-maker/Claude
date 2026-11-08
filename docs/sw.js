// Einfacher Offline-Cache: Die App selbst startet auch ohne Netz.
// Kartenkacheln werden bewusst nicht gecacht (Nutzungsregeln von OpenStreetMap).
var CACHE = 'hunderoute-v6';
// Kalenderdateien, die die App kurzzeitig unter einer eigenen Adresse (".../_ics/...") bereitstellt.
// Safari übergibt nur echte Web-Adressen mit dem Typ text/calendar an den Kalender.
var ICS_CACHE = 'hunderoute-ics';
var SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'lib/leaflet.js', 'lib/leaflet.css',
  'lib/images/marker-icon.png', 'lib/images/layers.png',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== ICS_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Kalenderdatei aus dem Zwischenspeicher ausliefern (nie aus dem Netz, dort gibt es sie nicht)
  if (url.pathname.indexOf('/_ics/') !== -1) {
    e.respondWith(
      caches.open(ICS_CACHE).then(function (c) { return c.match(req); }).then(function (res) {
        return res || new Response('Kalenderdatei nicht gefunden. Bitte in der App erneut auf "In den Kalender" tippen.',
          { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      })
    );
    return;
  }

  // Netz zuerst (damit Updates ankommen), sonst Cache
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () { return caches.match(req); })
  );
});
