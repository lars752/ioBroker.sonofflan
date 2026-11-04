![Logo](admin/sonofflan.png)

# ioBroker.sonofflan

Steuert Sonoff- und andere eWeLink-Geräte **lokal im LAN** und/oder über die **eWeLink-Cloud** – ohne Umflashen. Der Adapter ist eine Portierung der Home-Assistant-Integration [AlexxIT/SonoffLAN](https://github.com/AlexxIT/SonoffLAN) (MIT) nach ioBroker/Node.js.

## Installation

Admin → Adapter → „Benutzerdefiniert installieren“ (GitHub-Symbol) → Reiter „Beliebig“ → URL:

```
https://github.com/lars752/ioBroker.sonofflan
```

Alternativ auf der Konsole: `iobroker url https://github.com/lars752/ioBroker.sonofflan`

Der Adaptername ist `sonofflan` (Instanz `sonofflan.0`).

> **Wichtig:** Die URL immer **kleingeschrieben** (`ioBroker.sonofflan`) angeben. js-controller leitet den Adapternamen aus der URL ab und sucht danach `node_modules/iobroker.<name>` – bei `sonoffLAN` schlägt die Installation unter Linux mit „Cannot install …: 0“ fehl.

## Funktionen

- **Modus `auto`** (empfohlen): Befehle gehen zuerst per LAN (1 s Timeout), sonst über die Cloud. Statusmeldungen kommen über beide Wege.
- **Modus `local`**: nur LAN. Die Geräteschlüssel (`devicekey`) werden einmalig aus dem Konto geladen und lokal zwischengespeichert – danach läuft alles ohne Internet.
- **Modus `cloud`**: nur eWeLink-Cloud (WebSocket, Push-Updates).
- **LAN-Verschlüsselung** (AES-128-CBC) für Geräte im normalen eWeLink-Modus, unverschlüsselt für **DIY-Geräte** (werden automatisch per mDNS erkannt, auch ganz ohne Konto).
- **mDNS-Discovery** (`_ewelink._tcp`), alternativ feste IP pro Gerät.
- **Rund 120 Gerätetypen (UIIDs) – die komplette Liste aus SonoffLAN**: Schalter 1–4 Kanäle, POW/POWR2/POWR3/S40/S60/DualR3/SPM (Leistung, Spannung, Strom, Energie), TH16/THR316D/THR320D, Lampen B02/B05/L1/L3/D1, iFan, Rollläden/Tore, Zigbee-Bridge-Geräte (Sensoren, Taster, Lampen, Vorhänge, TRVZB …), NSPanel, TX Ultimate.
- **Universell**: Für jedes Gerät gibt es `raw.params` (alle Parameter als JSON) und `raw.command` (beliebige eWeLink-Parameter senden) – damit sind auch nicht gemappte Geräte voll nutzbar.

## Konfiguration

| Feld | Bedeutung |
|---|---|
| Modus | `auto`, `cloud` oder `local` |
| E-Mail/Telefon, Passwort, Land | eWeLink-Zugangsdaten; das Land bestimmt die Cloud-Region (Deutschland = `+49` → EU) |
| Home-IDs | optional: nur Geräte bestimmter Homes |
| Geräte-Tabelle | optional: `devicekey`, feste IP oder abweichende UIID je Geräte-ID |
| Erweitert | mDNS-Schnittstelle, Sensor-Refresh, Energie-Intervall, eigene App-ID/Secret |

> **Wichtig:** eWeLink erlaubt pro App-ID nur eine aktive Cloud-Sitzung je Konto. Am besten ein **zweites eWeLink-Konto** für ioBroker anlegen und die Geräte aus dem Hauptkonto dorthin teilen. Sonst trennt der Login der App den Adapter (Fehler 406) oder umgekehrt.

Mit „Login testen“ lassen sich die Zugangsdaten direkt in der Admin-Oberfläche prüfen.

## Datenpunkte

```
sonofflan.0.<deviceid>.
  info.name / model / brand / uiid / firmware
  info.cloudOnline / local / reachable / connection (local|cloud|offline) / host / lastUpdate
  raw.params            – alle Parameter (JSON, nur lesen)
  raw.command           – JSON senden, z. B. {"switch":"on"}
  switch | channel1…4   – Schalter
  startup | startup1…4  – Einschaltverhalten (off/on/stay)
  led, pulse, pulseWidth
  power, voltage, current, energy_day, energy_month, energy, energy_history …
  temperature, humidity, battery, rssi …
  light.on / brightness (%) / colorTemp (K) / rgb (#RRGGBB) / effect
  fan.on / fan.speed
  cover.position (0 = zu, 100 = offen) / open / close / stop / state
  detach | detach1…n    – Relais vom Taster abgekoppelt (nur lesen, M5 u. ä.)
  action                – letzte Tastenaktion (single, double, hold, button_2_single …)
```

Adapterweit: `info.connection`, `info.cloud`, `info.lanDiscovered` (im LAN gefundene Geräte mit IP).

## Hinweise zum LAN-Betrieb

- mDNS (Multicast) muss zwischen ioBroker und den Geräten funktionieren. In Docker den Netzwerkmodus `host` verwenden; VLAN-Grenzen blockieren mDNS. Notfalls die IP im Reiter „Geräte“ fest eintragen.
- Manche POW-/TH-Geräte liefern Messwerte nur, wenn sie angefragt werden. Die Option „Messwerte … alle ~5 s anfordern“ übernimmt das (wie im Original).
- Der Gerätecache mit den Schlüsseln liegt in `iobroker-data/sonofflan.0/devices.json` (Rechte 600), **nicht** in den Objekten.

## Unterschiede zum Original

Bewusst nicht portiert: IR/RF-Fernbedienungen als eigene Entitäten (Rohzugriff über `raw.*` möglich), Klima-Entitäten (Werte erscheinen als Sensoren, Steuerung per `raw.command`), Kameras, Lichtübergänge (`transition`).

## Changelog

### 1.1.0 (2026-11-04)
- Neu: Datenpunkt `detach` bzw. `detach1…n` (Relais abgekoppelt, aus `relaySeparations`) für Sonoff M5 (UIID 160/161/162/275)

### 1.0.0 (2026-11-04)
- Tasten-Ereignisse (`action`) von Geräten mit `localKeyPass` (z. B. Sonoff M5 mit abgekoppeltem Relais) werden jetzt auch aus dem LAN-Vollzustand erkannt, nicht nur aus der kurzen Cloud-Nachricht
- LAN und Cloud melden denselben Druck kurz nacheinander: eine Wiederholung innerhalb von 1,5 s zählt nicht doppelt

### 0.1.3 (2026-11-03)
- URL-Installation korrigiert: Repository-URL kleingeschrieben (`ioBroker.sonofflan`)

### 0.1.2 (2026-11-03)
- Repository in lars752/ioBroker.sonoffLAN umbenannt

### 0.1.1 (2026-11-03)
- Repository nach lars752/ioBrokerSonoffLAN umgezogen

### 0.1.0 (2026-11-03)
- Erste Version auf Basis von AlexxIT/SonoffLAN

## Lizenz

MIT – siehe [LICENSE](LICENSE). Protokoll, Gerätespezifikationen und Kryptografie basieren auf [AlexxIT/SonoffLAN](https://github.com/AlexxIT/SonoffLAN), Copyright (c) 2020 AlexxIT, MIT-Lizenz.
