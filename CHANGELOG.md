# Changelog

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
