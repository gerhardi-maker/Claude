# Hunderoute

Eine kleine Handy-App (PWA) für hundefreundliche Orte: Freilaufflächen, Leinenpflicht,
Wasserstellen, Kotbeutelspender, Hundeverbot und Gefahrenstellen. Eigene Orte werden auf
der Karte gespeichert, bleiben auf dem Gerät und lassen sich filtern, exportieren und importieren.

## Lokal ausprobieren

```
cd docs
python3 -m http.server 8000
```

Dann `http://localhost:8000` im Browser öffnen (am besten in der Handy-Ansicht).

## Aufs Handy bringen

Die App muss über **HTTPS** erreichbar sein, sonst funktionieren Standort und
"Zum Startbildschirm hinzufügen" nicht. Einfachster Weg: GitHub Pages
(Repository-Einstellungen, Pages, Branch `main`, Ordner `/docs`).

## Aufbau

- `index.html`, `style.css`, `app.js`: die App selbst, ohne Build-Schritt
- `lib/`: Leaflet 1.9.4 (Kartenbibliothek)
- `sw.js`, `manifest.webmanifest`, `icons/`: Installierbarkeit und Offline-Start

## Hinweis zu den Kartendaten

Die Kacheln kommen von openstreetmap.org. Das ist für Tests und kleine Nutzung in Ordnung.
Für eine größere oder kommerzielle Nutzung braucht es später einen eigenen Kartenanbieter.
