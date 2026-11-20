# OpenHAB – Powunity / Biketraxx

Konfiguration für Arm/Disarm und Auto-Arm des Powunity Bike-Trackers (Device `8710019504`).

## Kurz-Setup (Deutsch)

### 1. Dateien ablegen

| Datei | Ziel auf dem OpenHAB-Host |
| --- | --- |
| `things/powunity.things` | `$OPENHAB_CONF/things/` |
| `items/powunity.items` | `$OPENHAB_CONF/items/` |
| `automation/js/powunity-autoarm.js` | `$OPENHAB_CONF/automation/js/` |

Typisch: `/etc/openhab/` (Linux-Paket) oder `/openhab/conf/` (Docker).

### 2. Bindings / Add-ons

- **HTTP Binding** (Things/Channels)
- **JavaScript Scripting** (`openhab-js`) für die Auto-Arm-Regel
- Optional: **JSONPath Transformation** (falls du Status-Channels per Transformation parsen willst)

### 3. Token setzen (einmalig, nie committen)

Der API-Token gehört **nur** in die OpenHAB-Konfiguration, nicht ins Git.

1. Öffne die Thing `http:url:powunity` in der Main UI **oder** editiere `powunity.things`.
2. Ersetze überall den Platzhalter `%powunity.token%` durch deinen Token  
   (Query-Parameter `?token=…` – Powunity unterstützt kein Bearer-Header-Auth für diese URLs).
3. Speichern. Bei Datei-basiertem Config: OpenHAB lädt die Thing neu.

**Empfehlung:** Token nur in der Main-UI am Thing setzen und die `.things`-Datei danach als Vorlage belassen (oder Platzhalter lokal ersetzen, Datei nicht versionieren). Token, der je in Chat/Logs stand, in der Powunity-Admin-Oberfläche rotieren.

### 4. Idle-Timeout und Auto-Arm

| Item | Default | Bedeutung |
| --- | --- | --- |
| `Biketraxx_IdleTimeoutMinutes` | `12` | Minuten ohne Bewegung → Auto-Arm |
| `Biketraxx_DisarmGraceMinutes` | `30` | Nach manuellem Disarm: Auto-Arm pausiert |
| `Biketraxx_AutoArmEnabled` | `ON` | Master-Schalter für Auto-Arm |
| `Biketraxx_Home` | `OFF` | Optional: zu Hause → kein Auto-Arm (später Presence) |

Timeout anpassen: Item `Biketraxx_IdleTimeoutMinutes` in der UI oder per Sitemap/MainUI ändern (z. B. `10` oder `15`).

### 5. Bedienung

- `Biketraxx_Armed` **ON** → POST `/arm`, **OFF** → POST `/disarm`
- Status wird periodisch gepollt (`refresh` am Thing, Default 60 s)
- Regel wertet Bewegung aus Status-JSON aus und arm’t automatisch, wenn Bedingungen erfüllt sind

Details zur Regel-Logik: siehe Repo-Root-Hinweise und die User-Doku im Projekt-Store.
