# Changelog

## 0.2.2 – Released 06.11.2026

### Changed

- Reguläre HCU-CurrentPower-Meldungen verwenden zeitgewichtete 60-Sekunden-Mittelwerte aus den bestehenden schnellen Telemetrie-Snapshots statt jeder gerundeten Live-Wertänderung. Geräte-IDs, Gerätetypen und Features bleiben erhalten.
- Pro Messreihe begrenzte In-Memory-Aggregation: höchstens vier Sekunden Gültigkeit je Messung, mindestens 54 von 60 Sekunden gültige Fensterabdeckung, keine künstlichen Nullwerte und keine Nachholung alter Fenster nach Unterbrechungen.
- HCU-Statusantworten und Inclusion verwenden ausschließlich fachlich gültige aggregierte Leistungswerte; Maintenance-/Erreichbarkeitsänderungen bleiben zeitnah und übertragen keinen zusätzlichen schnellen Leistungswert.
- Energie-Dashboard und HmIP-Automationen erhalten Minutenmittel statt Momentanwerten. Die daraus folgende langsamere Automationsreaktion ist beabsichtigt; Mittelwerte sind keine sicherheitskritische Echtzeittelemetrie.
- Version und Packaging-Metadaten auf 0.2.2 vorbereitet; kein ARM64-Paket, Upload oder Release in diesem Entwicklungsauftrag.

### Safety und Grenzen

- Installed-Polling, Telemetriefrische, LoadManager, Trigger, Prioritäten, Round Robin, Recovery, Ownership/Rebinding, JA/NEIN-Override und go-e-Write-Gates bleiben unverändert. Die Mittelwerte fließen ausschließlich zur HCU-Geräteprojektion.
- Kein neuer go-e-Steuerpfad, keine zusätzlichen Polls oder Timer und keine neue persistente Datei.
- Der Nutzer hat die bisherigen rund 1,8 Millionen Messdatensätze bereits manuell erfolgreich gelöscht. 0.2.2 implementiert keine historische Datenlöschung und behauptet keinen belegten Zusammenhang zwischen Datenmenge und App-Synchronisierungsfehlern.
- HCU-eigene Statusanfragen können weiterhin zusätzliche Historieneinträge auslösen; die reale Plattformwirkung ist noch abzunehmen. Faktor 30 beschreibt den kontrollierten Offline-Vergleich regulärer Veröffentlichungen, keine Garantie für sämtliche HCU-Datensätze.

### Prüfung

- **1.785 Tests in 65 Dateien bestanden**, insgesamt 77 zusätzliche Fälle gegenüber dem 0.2.1-Stand. Typecheck, Build und Offline-Simulation erfolgreich; die 38 Packaging-Regressionen sind enthalten.
- Zwei vollständig offline simulierte 14-Tage-Durchläufe mit jeweils 604.801 internen Snapshots: im stabilen Fall 3.024.000 bisherige gegenüber 100.800 neuen regulären Power-Ereignissen für fünf Geräte, exakt Faktor 30. Der Ausfall-/Reconnect-Fall wahrt mindestens 60 Sekunden Abstand und erzeugt keinen Nachholburst.
- Sicherheitsprüfung: 34 geschützte Quellcodedateien bytegleich erhalten; keine neuen Write-Pfade, Poll-Loops oder Timer. Build-Eingabe-/Secret-Sanity erfolgreich. Kein ARM64-Containerlauf, Hardwarezugriff, Deployment oder Git-Vorgang. [Vollständiger Nachweis und offene HCU-Abnahme](docs/energy-publishing-60s.md).

## 0.2.1 – Released 19.10.2026

### Fixed

- Installed-HCUweb darf Geräteadressen nach einem reinen Startup-Erreichbarkeitsfehler ohne Write-/Ownership-Evidenz ändern. Unerreichbare neue Hosts sind kein Grund, eine ansonsten gültige AppConfig zurückzurollen.
- Freigabe für UNKNOWN ausschließlich bei `CHARGER_STATUS_UNAVAILABLE`, vollständig fehlender Eingriffsevidenz und keiner unsicheren letzten Beobachtung. Andere UNKNOWN-Gründe, Konflikte, Baselines, aktive eigene Einschränkungen und offene Writes bleiben geschützt.
- Bereits freigegebene valide NONE-Records werden nicht allein wegen abgeschlossener bestätigter Historie erneut als aktive Ownership behandelt. Der vorbereitete Actuator-Zustand wird erst nach erfolgreicher atomarer Persistenz übernommen.

### Safety und Umfang

- Kein neuer go-e-Schreibpfad, kein Write beim Rebinding; globale Bindungssperre bei geschützter Evidenz bleibt bestehen. Engine, HCU-Geräteprojektion und reale Steuerungsgates bleiben erhalten.
- Vollständige AppConfig-Validierung, bestehender standortspezifischer Seed und ausgeschaltete reale Steuerung bei Erstinstallation unverändert. Kein Dummyhost oder neuer Onboarding-Lifecycle; [Begründung und Anleitung](docs/initial-configuration.md).
- Keine Schema-Migration oder Dateilöschung; bestehende Config einschließlich live true/false, Ownership und Nachrichtensession bleiben erhalten.
- HCU-Meldungsfehler `InvalidResponseError` wird separat untersucht; Nachrichten-API und Wiederholungslogik werden durch diesen Hotfix nicht geändert.
- Version und Packaging-Metadaten auf 0.2.1 ausgerichtet. ARM64-Paketnachweis und reale Hotfix-Abnahme stehen noch aus; kein Paket-/Hardwaretest wird aus älteren Versionsnachweisen übernommen.

### Prüfung

- 1.708 Tests in 62 Dateien bestanden, 123 zusätzliche Fälle gegenüber 0.2.0; Typecheck, Build und Offline-Simulation erfolgreich.
- Build-Eingaben-/Secret-Sanity: 72 erlaubte Dateien geprüft, keine privaten Entwicklungsdateien gelesen. Ergebnisse und verbleibende manuelle Abnahme in [initial-configuration.md](docs/initial-configuration.md).

## 0.2.0 – Released 13.10.2026

### Added

- Homematic-IP-Plugin-Geräte für Netz, Hausverbrauch, Solar und aktivierte Charger mit CurrentPower und Maintenance.
- Connect-API-Discovery, Inclusion, Exclusion, StatusRequest/Response und deduplizierte StatusEvents.
- Stabile logische Geräte-IDs sowie read-only ControlRequest-Ablehnung.
- Offline-Regressionsfälle für Projection-/Regelungsisolation und kompatible 0.1.0-Persistenz.

### Changed

- Controller-Telemetrie um dynamisch gemappte rohe Home-/Solar-Leistung ergänzt; Zusatzfehler invalidieren gültiges Grid nicht.
- Charger-Telemetrie um tatsächliche `currentPowerW` ausschließlich aus `nrg[11]` ergänzt.

### Safety

- Keine neuen go-e-Schreibpfade, Hardwarepolls oder periodischen Timer.
- Lastmanagement, Ownership, Firmware-Clear-Grenze, operative Aktivierung und bestehende Persistenz unverändert.
- Keine automatische Geräteinstallation, Hardware-Writes, Git-Commits, Tags oder Releases während der Entwicklung.

### Test

- Erfolgreiche Installation auf der realen HCU
- Fünf HmIP-Messgeräte eingebunden, Leistungswerte korrekt dargestellt
- Geräte im Homematic-IP-Energie-Dashboard sichtbar
- Numerische Automationsbedingungen funktionieren einschließlich Auslösung
- Bekannte Einschränkung: Keine Darstellung als Home-Favoriten
- Noch nicht gesondert abgenommene Hardware-/Fail-safe-Szenarien bleiben als solche gekennzeichnet

## 0.1.0

- Installed-HCU-Plugin mit ARM64-Packaging, guarded Actuator, Ownership, persistenter Konfiguration und UserMessage-Session.
- Vom Nutzer auf der realen HCU installiert und funktional geprüft; Referenz für Version 0.2.0.
