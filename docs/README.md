# Hunderoute

Eine kleine Handy-App (PWA) für hundefreundliche Orte: Freilaufflächen, Leinenpflicht,
Wasserstellen, Kotbeutelspender, Hundeverbot und Gefahrenstellen. Eigene Orte werden auf
der Karte gespeichert, bleiben auf dem Gerät und lassen sich filtern, exportieren und importieren.
Die Suche (🔍 oben) durchsucht Name, Notiz und Ortstyp. Sie ignoriert Groß-/Kleinschreibung und
Umlaute, versteht mehrere Wörter (alle müssen passen) und sortiert nach Entfernung.
Das Gassi-Protokoll (🐾 unten rechts) zeichnet Spaziergänge auf: Route, Zeit, Strecke und Zähler für
Häufchen und Pfützen, dazu eine Notiz. Der Bildschirm bleibt dabei an (Wake Lock), die App muss geöffnet
bleiben, sonst pausiert die Aufzeichnung. Ein laufender Spaziergang übersteht ein Neuladen. Ungenaue
GPS-Punkte, Rauschen und Ausreißer werden herausgefiltert. Das Protokoll lässt sich im Menü exportieren
und importieren.
Erinnerungen (🩺 oben) für Tierarzt-Termine, Impfungen, Entwurmung und Zeckenschutz: mit Datum, optional
Uhrzeit, Wiederholung (z. B. jedes Jahr) und Vorlaufzeit. Ein roter Punkt am Button zeigt Fälliges und
Überfälliges, beim Start der App kommt ein Hinweis. Wer eine Erinnerung als erledigt abhakt, bekommt bei
wiederkehrenden Terminen automatisch den nächsten. Die App kann nicht benachrichtigen, wenn sie geschlossen
ist (dafür bräuchte es einen Server). Deshalb lässt sich jeder Termin als Kalenderdatei (.ics) mit Wecker an den
Handy-Kalender übergeben.
Zu jedem Ort kann ein Foto gehören. Es wird beim Aufnehmen auf maximal 1280 Pixel verkleinert
und in IndexedDB gespeichert (nicht in localStorage, dafür sind Fotos zu groß). Der Export
enthält die Fotos, der Import stellt sie wieder her.

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
