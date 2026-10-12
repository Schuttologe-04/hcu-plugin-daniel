# Version 0.2.0 – Technischer Abschlussbericht

Stand: 12. Oktober 2026. Implementierung, Offline-Prüfungen und tatsächliches Linux/ARM64-Packaging abgeschlossen. Die reale HCU-/App-Abnahme steht aus; kein Upload oder Hardware-Write wurde durch Codex ausgeführt.

## Git und Review-Stand

- Branch: `feature/hmip-energy-devices`.
- Ausgang: clean, HEAD `62c7c63`, Tag `v0.1.0`.
- Ende: eigene Änderungen liegen uncommitted vor; HEAD weiterhin `62c7c63`.
- Kein Commit, Push, Merge, Rebase, neuer Tag oder GitHub-Release. Keine main-Änderung, kein Stash/Reset.
- `git diff --check` erfolgreich. `git status`, `git diff --stat` und `git diff --name-only` geprüft.
- Keine privaten `.env`-/Runtime-/Token-Dateien in Git aufgenommen; `.gitignore` unverändert.

## Architektur und Geräte

Vier kleine Module unter `src/hcu/devices/` ergänzen Registry, Feature-Typen, reine Datenprojektion und Inclusion-/Statuspublikation. Der vorhandene HCU-Decoder/Dispatcher wurde erweitert; der vorhandene Installed-Snapshot-Hook informiert den Service. Keine neuen Polls, Timer, WebSocket-Verbindungen, Dependencies oder Geräte-Persistenz. Kein Rückweg zum LoadManager/Actuator. Mit aktiver bzw. no-op Projektion liefern identische Messungen dieselben Engine-Snapshots, Actions und Ownership.

| Device-ID | DeviceType | Friendly Name | Features |
|---|---|---|---|
| `controller-grid` | GRID_CONNECTION_POINT | go-e Netz | CurrentPower, Maintenance |
| `controller-home` | ENERGY_METER | go-e Hausverbrauch | CurrentPower, Maintenance |
| `controller-solar` | INVERTER | go-e Solar | CurrentPower, Maintenance |
| `charger-garage` | EV_CHARGER | go-eCharger Garage, aus Config | CurrentPower, Maintenance |
| `charger-links` | EV_CHARGER | go-eCharger Links, aus Config | CurrentPower, Maintenance |
| `charger-rechts` | EV_CHARGER | go-eCharger Rechts, aus Config | Erst bei enabled + gültigem Host |

Aktuell fünf discoverable Geräte; Rechts ausgeschlossen. Discovery bleibt bei temporärem Offline erhalten und ist unabhängig von `liveControlEnabled`. Stabile IDs hängen nicht von IP, Name, Firmware oder Prozessstart ab. Kein Akku, EnergyCounter, Custom- oder künstliches Ladezustandsfeature.

Controller: Grid/Home/Solar werden dynamisch anhand `ccn` auf den passenden `ccp`-Index gemappt. Domain-Werte bleiben präzise und signiert; Home-/Solar-Zusatzfehler invalidieren gültiges Grid nicht. HmIP nutzt Grid direkt, Home direkt und Solar negiert, ausdrücklich kein Absolutwert. Nur die HmIP-Anzeige rundet ganze Watt.

Charger: `currentPowerW` ausschließlich aus endlichem `nrg[11]`. Echt 0 bleibt 0; missing/null/short/non-numeric/NaN/±Infinity bleibt unavailable, ohne Schätzwerte. Gültige rawNrg-Kopien bleiben erhalten; malformed Roharrays sind unavailable. Vorhandene Tests wurden nur hinsichtlich der ausdrücklich gewünschten Home-/Solar-/nrg-Zusatzfehlerisolation angepasst; essenzielle Grid-/Charger-Safety bleibt streng.

## HCU-Protokoll

- Discovery: konfigurierte Devices, Success und gleiche Request-ID.
- Inclusion: aktueller vollständiger Included-Set-Snapshot; bekannte inkludierte Devices per proaktivem StatusResponse bereitstellen.
- Exclusion: rein logische Entfernung; keine Config-/Prioritäts-/Geräteänderung und keine weiteren unsolicited Updates.
- StatusRequest: optionaler ID-Filter, sonst alle bekannten konfigurierten Geräte; Response korreliert mit Request-ID. Unknown-only bzw. disabled-Rechts ergibt keine spekulativen Devices.
- StatusResponse: vollständige Device-/Feature-Daten; das optionale CurrentPower-Double wird bei missing weggelassen, kein null/NaN/künstliches 0.
- StatusEvent: einzelnes Device, nur geänderte projizierte Features; erfolgreicher Send bestimmt den Cache. Offline sendet nur Maintenance, bei Wiederkehr können Reachability und neue Leistung zusammen übertragen werden.
- Reconnect: Inclusion zunächst unbekannt, keine spekulativen unsolicited Events bis frischem InclusionEvent. Keine Queue und kein Inclusion-Persistence-Layer.
- ControlRequest: validiert, dann read-only `success=false` mit Request-ID; kein Poll, Actuator- oder Write-Aufruf.

Maintenance unterscheidet physische Connection-/Timeout-Fehler von empfangenen ungültigen Messungen. Fehlende Leistung bei erreichbarem Gerät ergibt nicht unreach=true. Vor erstem Poll/bei unbekanntem Zustand werden optionale Werte weggelassen. Der HmIP-Cache ersetzt niemals Engine-Eingangsdaten.

## Safety- und Update-Audit

- Genau ein produktiver `/api/set`-Ort im unveränderten `charger-control-client.ts`; ausschließlich bestehende `tcl`-/`frc`-Operationen. Keine neuen Set-Methoden.
- Kein `amp`- oder `loe`-Write. Native `loe=true`-Blockierung und Firmware-59.4-Null-Clear bleiben unverändert.
- Git-Diff für LoadManager, Actuator/Control/Ownership, LiveRuntime, InstalledRuntime, TelemetryHealthGuard, UserMessages, Config/Persistenz, Read-only-Clients und Seed ist leer.
- Keine fetch-/Timer-/Control-/Engine-Abhängigkeit in den neuen Device-Modulen. Keine `.skip`/`.only`-Tests.
- Publish-Fehler bleiben sekundär: nächster Telemetriezyklus, Engine-Entscheidung und Ownership funktionieren weiter.
- Update-Regressionsfälle laden tatsächliche temporäre 0.1.0-Config-/Ownership-/Message-Dateien. `liveControlEnabled=false` **und** `true` bleiben erhalten; eigener `tcl=6`, eigene Pause, Bestätigungsevidenz und Session bleiben erhalten. Kein Seed-Overwrite, Clear, Resume oder zusätzliche Persistenzdatei.

## Prüfungen

| Prüfung | Ergebnis |
|---|---|
| Baseline | 1.429 Tests in 53 Dateien bestanden |
| Finales npm test | **1.585 Tests in 59 Dateien bestanden** |
| npm run typecheck | Erfolgreich |
| npm run build | Erfolgreich, auch im ARM64-Builder |
| npm run simulate | Erfolgreich und offline: 22.839 W, bis 29,999 s keine Action; 30 s Garage 13 A; 34 s 12 A; fehlendes Grid → FAULT ohne Action |
| Packaging-/Syntaxprüfungen | 36 Packaging-Tests, JS-/PowerShell-Syntax und Metadata-Konsistenz erfolgreich |
| Container-Smoke | Tatsächlich linux/arm64, Node 24.21.0; Installed-Entry, Erststart/Restart, nichtleere Ownership-/Session-Persistenz, fünf Devices, Deduplizierung und read-only Control geprüft |
| Hardwarefreiheit | Smoke mit `--network none`, MOCK-Mounts, 4 gemockten Charger-Reads, 0 Netzwerkversuchen, 0 Hardware-Writes |
| Secret-Sanity | 72 erlaubte Build-Eingaben; private Entwicklungsdateien nicht gelesen. Keine eingebetteten Entwicklungs-Credentials; Runtime-App, Dev-Tooling und native Abhängigkeiten geprüft |
| Export-Prüfung | Docker-save-Manifest mit einem 0.2.0-Image, linux/arm64-Config und korrektem Installed-Entrypoint; SHA-256 unabhängig neu berechnet |

## Tatsächliches Paket

- Image-Tag: `com.psd.hcu.goe.loadmanagement:0.2.0`.
- Image-ID: `sha256:744f2b02e0e04bfbfaccb71051c9fef09d04a4d914a7e214c33b014ddad9a274`.
- Image laut Docker: 59.472.911 Bytes; Archiv: 59.158.196 Bytes.
- Plattform: `linux/arm64`; gepinntes offizielles Node 24.21.0 / Alpine 3.24, unverändert.
- Metadata: Plugin-ID `com.psd.hcu.goe.loadmanagement`, Version 0.2.0, Issuer PSD, HCU mindestens 1.4.7, LOCAL, logsEnabled=true.
- Archiv: `dist-package/com.psd.hcu.goe.loadmanagement-0.2.0.tar.gz`.
- Prüfsumme: `dist-package/com.psd.hcu.goe.loadmanagement-0.2.0.sha256`.
- SHA-256: `69b0b2f79481412aea0854a789d796ee3d427763c928208c63725bb9e76b43ed`.
- Vorhandenes 0.1.0-Archiv bleibt unverändert; dessen SHA-256 weiterhin `f2101d7a6aec5d069b1a73bdaaa51bbf861f1b666caae4ff5070d59569cba271`. Alte Inspection zusätzlich als `image-inspect-0.1.0.json` bewahrt; `image-inspect.json` beschreibt jetzt 0.2.0.

## Neue/geänderte Dateien

Geändert:

```text
Dockerfile
README.md
package.json
package-lock.json
scripts/check-package-inputs.mjs
scripts/container-smoke.mjs
scripts/package-hcu.ps1
scripts/validate-hcu-image.mjs
src/domain/charger.ts
src/domain/controller.ts
src/goe/charger-mapper.ts
src/goe/controller-mapper.ts
src/hcu/message-codec.ts
src/hcu/message-types.ts
src/hcu/plugin-identity.ts
src/index.ts
src/orchestration/hcu-plugin-application.ts
tests/unit/diagnostics/probe-service.test.ts
tests/unit/goe/charger-mapper.test.ts
tests/unit/goe/controller-mapper.test.ts
tests/unit/packaging/packaging.test.ts
```

Neu:

```text
CHANGELOG.md
docs/phase6-hmip-plugin-devices.md
docs/version-0.2.0-completion-report.md
src/hcu/devices/device-projection.ts
src/hcu/devices/device-registry.ts
src/hcu/devices/device-types.ts
src/hcu/devices/plugin-device-service.ts
tests/unit/goe/charger-power-mapper.test.ts
tests/unit/goe/controller-energy-mapper.test.ts
tests/unit/hcu/device-codec.test.ts
tests/unit/hcu/devices/device-projection.test.ts
tests/unit/hcu/devices/helpers.ts
tests/unit/hcu/devices/plugin-device-service.test.ts
tests/unit/orchestration/hmip-device-application.test.ts
```

Historische Phase-5-Dokumente und vorhandener Seed bleiben unverändert. CHANGELOG kennzeichnet 0.2.0 als Unreleased mit ausstehender realer Abnahme.

## Offen für die manuelle Abnahme

Nach Benutzerreview das neue Paket in HCUweb installieren und `/data` erhalten. Zuerst READY, Version, Config, Firmware, Ownership und unveränderte Safety prüfen. Danach fünf Devices entdecken/inkludieren und Grid/Home/Solar-Vorzeichen sowie reale Charger-Leistung während Laden und natürlicher Drosselung vergleichen. Maintenance bei sicher beobachtbarer Nichterreichbarkeit prüfen. CurrentPower als numerische Bedingung im Smartphone-Automationseditor und tatsächliche Push-Zustellung separat verifizieren; keine Garantie und keine Ersatzwarnungslogik.

Die genauen Schritte stehen in `phase6-hmip-plugin-devices.md`. Kein realer Deploy, künstlicher Lasttest, Hardware-Write oder Freigabe-Tag erfolgte während dieses Auftrags.
