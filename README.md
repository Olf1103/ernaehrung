# Ernährung – persönliche Makro-App (Prototyp)

Eine reine Web-App (PWA) ohne Server und ohne Konto. Alle Daten bleiben im Browser des Geräts.

## Funktionen
- Foto einer Mahlzeit aufnehmen oder wählen, optional mit Hinweis
- Gemini (Google) schätzt Lebensmittel, Gramm, kcal, Eiweiß, Kohlenhydrate und Fett
- Ergebnis prüfen und korrigieren, dann speichern
- Tagesübersicht mit Makros und optionalen Zielen
- Backup als JSON exportieren und importieren

## Einrichtung

### 1. API-Schlüssel
Kostenlosen Schlüssel auf https://aistudio.google.com/apikey erstellen. Den Schlüssel trägst du später in der App unter „Einstellungen“ ein. Er wird nicht in den Code geschrieben.

### 2. GitHub Pages
1. Neues Repository anlegen, z. B. `ernaehrung`, und diese Dateien hochladen.
2. Repository → Settings → Pages → Source: „Deploy from a branch“, Branch `main`, Ordner `/ (root)`.
3. Nach ein bis zwei Minuten ist die App unter `https://<dein-name>.github.io/ernaehrung/` erreichbar.

Hinweis: Mit einem kostenlosen GitHub-Konto funktionieren Pages nur bei öffentlichen Repositories. Der Code enthält keine Daten und keinen Schlüssel, aber das Repository ist dann für alle sichtbar. Alternative für private Repos: Cloudflare Pages.

### 3. Auf dem iPhone installieren
1. Die URL in Safari öffnen.
2. Teilen-Symbol → „Zum Home-Bildschirm“.

## Wichtige Hinweise
- Fotos gehen zur Analyse an Google Gemini. Die Datenschutzregeln hängen vom Tarif ab.
- Die Schätzungen sind Näherungen. Portionsgröße und Öl sind auf Fotos schwer zu erkennen, deshalb bitte prüfen und korrigieren.
- Browserdaten können nach längerer Nichtnutzung gelöscht werden. Mach regelmäßig ein Backup unter „Einstellungen“.
- Die Schlüssel- und Datenspeicherung liegt nur im Browser dieses Geräts.

## Geplant
- Import des Apple-Health-Exports (Puls, Schritte, Schlaf, Training)
- Ziele aus Körperdaten berechnen
- Essensvorschläge zum Erreichen der Ziele
