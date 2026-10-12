# Phase 5 – Abschlussbericht 0.1.0

Verifiziert am 11. Oktober 2026 unter Windows. Das tatsächliche ARM64-Image und das Docker-save-Gzip-Archiv wurden erzeugt. Die erste HCU-Installation und jede Hardware-Aktivierung bleiben beim Nutzer. Codex hat keine realen HCU- oder go-e-Verbindungen und keine Hardware-Writes für diese Phase ausgeführt.

## Dateien

Neu:

- `src/cli/hcu-installed.ts`
- `src/orchestration/installed-runtime.ts`
- `src/hcu/messages/interaction-state.ts`, `interaction-state-store.ts`
- `Dockerfile`, `.dockerignore`, `config.installed.json`
- `scripts/package-hcu.ps1`, `check-package-inputs.mjs`, `validate-hcu-image.mjs`, `container-smoke.mjs`
- `docs/phase5-installed-plugin.md`, dieser Bericht
- Tests: `tests/unit/orchestration/installed-runtime.test.ts`, `hcu-installed-application.test.ts`; `tests/unit/hcu/installed-cli.test.ts`; `tests/unit/hcu/messages/interaction-state-store.test.ts`, `persistent-interactions.test.ts`; `tests/unit/goe/control/firmware-clear.test.ts`; `tests/unit/packaging/packaging.test.ts`

Geändert:

- Konfiguration: `src/config/config-types.ts`, `config-schema.ts`, `config.example.json`
- HCU: `src/hcu/runtime/installed-environment.ts`, `src/hcu/config/config-template-builder.ts`, `hcu-config-service.ts`, `src/hcu/plugin-state-service.ts`, `src/hcu/messages/acknowledgement-router.ts`
- Orchestrierung: `src/orchestration/live-runtime.ts`, `hcu-plugin-application.ts`, `runtime-snapshot.ts`, `src/index.ts`
- Actuator: `src/goe/control/charger-control-client.ts`, `charger-actuator.ts`, `control-types.ts`, `ownership-state.ts`, `actuator-reconciler.ts`; bestehender `charger-control-client.test.ts`
- Packaging und Dokumentation: `package.json`, `.gitignore`, `README.md`, `docs/hcu-integration.md`, `docs/phase4-actuator-safety.md`

## Ergebnisse der 30 Abschlussprüfpunkte

| Punkt | Ergebnis |
|---|---|
| 1. Dateien | Obige Installed-Runtime-, Konfigurations-, Firmware-, Nachrichten-, Packaging- und Testdateien. |
| 2. Architektur | Ein sequenzieller Installed-Orchestrator verwendet die vorhandenen LiveRuntime-, TelemetryHealthGuard-, LoadManager- und Actuator-Komponenten; keine zweite Engine. HCU-Zustellung blockiert die lokale Telemetrie nicht. |
| 3. Basis / Node | Offizielles `node:24.21.0-alpine3.24`, Manifest-Pin `sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81`. Lokal Node 24.20.0, Container tatsächlich 24.21.0. Kein Major-Downgrade. Native `fetch`/AbortController geprüft; keine nativen App-Laufzeitabhängigkeiten. |
| 4. Entrypoint | Direkt `node /app/dist/cli/hcu-installed.js`; `/TOKEN`, `/CLIENTID`, `/SGTIN`, WSS `host.containers.internal:9001`; keine Remote-Credentials, kein eigener Webserver und kein EXPOSE. Zertifikatsausnahme nur für die lokale HCU-Verbindung. |
| 5. Seed | Controller 192.168.0.89; Garage .94 aktiv, Priorität 1; Links .144 aktiv, Priorität 20; Rechts ohne Host deaktiviert, Priorität 20. Parameter 19.000 W / 500 W / 30 s / 4 s / 1 A; reale Regelung AUS. |
| 6. Persistenz | `/data/plugin-config.json` autoritativ nach Erststart, `/data/actuator-state.json` und `/data/user-message-state.json` versioniert und atomar. Update überschreibt den Seed nicht über bestehende Config und löscht keine Ownership. |
| 7. LIVE-Capability | Feste Installed-Distribution-Capability; Image enthält `GOE_REAL_WRITES_ENABLED=true`. Kein HCUweb-Schalter für diese technische Capability. |
| 8. Operativer Schalter | `loadManagement.liveControlEnabled=false` bei Erstinstallation; explizite HCUweb-Aktivierung zusätzlich zu aktiviertem Lastmanagement erforderlich. BOOLEAN false bleibt gültig. |
| 9. Loop | Telemetrie standardmäßig alle 2 s, um innerhalb des unveränderten 4-s-Frischebudgets Timer-/HTTP-Verzögerungen abzufangen. Geräteaktionen weiterhin frühestens alle 4 s; mindestens 10 s stabile Telemetrie vor Writes, 30-s-Trigger und 1-A-Schritte erhalten. Prioritäten, Round Robin und Readback-ACK beibehalten. |
| 10. Refresh | Fällige eigene `tcl`-Limits nach 300 s im selben Orchestrator; kein Refresh bei Override, Fault, Konflikt, verlorener Ownership, Deaktivierung oder Shutdown. |
| 11. Firmware | `JSON_NULL_VERIFIED` ausschließlich im getesteten Profil 59.4. Frische Firmwareprüfung; vor Clear nochmals Stop/Generation, Grid-/Charger-Frische, Ownership und unveränderte Controls prüfen. Andere oder unbekannte Firmware erhält keine allgemeine Null-Clear-Freigabe. |
| 12. Nachrichten | Frage-ID, Session, Zweck, Erstellzeit, Zustand und JA-Override persistent. JA eines berechtigten Familienbenutzers genügt; produktive Texte ohne TEST/Dry-Run. |
| 13. Cleanup | Startup-/Reconnect-LIST und kontrollierter Abgleich eigener Nachrichten. Bekannte aktive Frage bleibt erhalten; pluginbezogene TEST-/stale/orphan IDs werden ohne Delete-Schleife bereinigt. Keine fremden Plugin-Nachrichten. |
| 14. Signale | SIGTERM/SIGINT stoppen Timer und neue Writes; laufende Übertragung wird konservativ abgeschlossen bzw. markiert und persistiert; WebSocket geschlossen. Kein pauschales CLEAR/RESUME beim Stop. |
| 15. Metadata | Plugin-ID `com.psd.hcu.goe.loadmanagement`, Issuer PSD, Version 0.1.0, HCU-Minimum 1.4.7, LOCAL, `logsEnabled=true`, deutscher Name und Beschreibung; kein erzwungenes Icon. |
| 16. ARM64 | Tatsächlicher Build, Image-Inspect, laufender Mock-Container und exportierte Image-Config bestätigen `linux/arm64`. |
| 17. Größe | Docker meldet 59.464.467 Bytes (56,71 MiB) Image-Größe; fertiges Gzip-Archiv 59.149.264 Bytes (56,41 MiB). |
| 18. Tests | Vor Phase 5: 1.250 Tests / 46 Dateien. Jetzt: 1.429 Tests / 53 Dateien. Alle bisherigen Tests erhalten; 179 zusätzliche Tests. |
| 19. npm test | 1.429 bestanden, 0 fehlgeschlagen. |
| 20. Typecheck | `npm run typecheck` erfolgreich. |
| 21. Build | `npm run build` erfolgreich; zusätzlich Typecheck/Build im ARM64-Builder erfolgreich. |
| 22. Simulation | `npm run simulate` erfolgreich und offline: Grid 22.839 W; bis 29,999 s keine Aktion; 30 s Garage 13 A; 34 s 12 A. Bei fehlendem Grid FAULT ohne Aktion. |
| 23. Container | `--network none`, gemountete MOCK-Dateien und reale File-Stores. Erststart/Restart mit gleicher Config/Session, nichtleerer Ownership, Node-APIs und Installed-Entrypoint geprüft. 4 gemockte Charger-Statuslesungen, 0 Netzwerkversuche, 0 Hardware-Writes. |
| 24. Secrets | 68 erlaubte Build-Eingabedateien geprüft. Private Entwicklungsdateien nicht gelesen und aus dem Kontext ausgeschlossen. Runtime-App und Abhängigkeiten auf unerlaubte Dateien, Credential-Literale, native Module und Dev-Tooling geprüft; keine eingebetteten Entwicklungs-Credentials festgestellt. |
| 25. Image-ID | `sha256:fd9a81b9f8c6e762b5beaa972047fbf2e0c8ca53286e9c11c16425f07756b7d3` |
| 26. Archiv | `dist-package/com.psd.hcu.goe.loadmanagement-0.1.0.tar.gz`; echtes `docker save --platform linux/arm64` plus Gzip, ein Docker-save-Manifest mit genau einem Image-Tag, keine Build-Attestations. |
| 27. SHA-256 | `f2101d7a6aec5d069b1a73bdaaa51bbf861f1b666caae4ff5070d59569cba271`; unabhängig per Node neu berechnet und mit `.sha256` verglichen. |
| 28. Installation | Unten beschrieben; detailliert in `phase5-installed-plugin.md`. Kein Upload durch Codex. |
| 29. Erstprüfung | READY, plausibles frisches Grid, Charger erreichbar, Rechts deaktiviert, Firmware kompatibel, `loe=false`, `tcl`/`frc` plausibel, Ownership NONE/valid, Message-Abgleich erfolgreich, automatische Regelung AUS. |
| 30. Offen | Reale HCU-LAN-/WSS-Erreichbarkeit, Mount-Rechte, Installed-Diagnose und tatsächliche Gerätewirkung; mehrere Charger und Recovery gemeinsam prüfen. Reales Session-Ende weiterhin explizites Ereignis, keine ungesicherte Ableitung aus `car=4`. Root-Containerbetrieb bis verifizierte HCU-UID-/Mount-Konvention dokumentiert. |

## Repository-Sicherheitsprüfung

- Genau ein produktiver `/api/set`-Endpunkt: `src/goe/control/charger-control-client.ts`. Vier typisierte Operationen verwenden ausschließlich JSON-kodierte `tcl`-/`frc`-Werte, mit LIVE-Gate, Ownership, Precheck und Readback. Das ist die ausdrücklich gewünschte Schreibfähigkeit von Phase 4/5; keine Hardware-Ausführung im Auftrag.
- Kein produktiver `amp=`-Write und kein `loe`-Write. Der `loe=`-Quelltexttreffer ist ausschließlich eine Diagnoseanzeige.
- Weitere `/api/set`-, `amp=`- und `loe=`-Treffer sind Mock-/Injection-/Sicherheitsprüfungen oder Dokumentation. Der Phase-1-HTTP-Layer bleibt GET-status-only.
- `HCU_AUTHTOKEN`/`activationKey` stehen in Remote-Konfiguration, leeren Beispielen, Redaction, Registrierungsdokumentation, Scannern und Dummy-Tests. Keine Entwicklungswerte wurden übernommen; Installed liest die HCU-Mounts.
- Der alte Projekt-Namensraum hat bei der abschließenden Suche 0 Treffer.
- DEV, Dry-Run, Probe und Simulation bleiben ohne produktive Schreibfähigkeit; Remote-LIVE bleibt PREPARED ohne automatischen Loop.

## Manuelle Installation und Aktivierung

1. Das bereitgestellte Archiv und die `.sha256` unter `dist-package/` verwenden. Bei eigenem Neubau `npm run package:hcu` mit laufender Docker-Linux-Engine ausführen.
2. HCU-Version mindestens 1.4.7 und SHA-256 prüfen.
3. HCUweb öffnen → Plugins → eigenes Plugin hochladen → das `.tar.gz` auswählen.
4. Installation abwarten und **go-e Lastmanagement** öffnen.
5. Diagnose, Konfiguration und obige Erstprüfliste kontrollieren; reale Regelung zunächst **AUS** lassen.
6. Controller-/Charger-Werte beobachten, Ownership und Firmware prüfen.
7. Erst danach bewusst **Reale Laderegelung aktiv** einschalten. Telemetrie-Stabilisierung, tatsächlichen 30-s-Trigger, 1-A-Schritt, bestätigten Readback und produktive JA/NEIN-Frage beobachten.

Bei unerwartetem Verhalten die reale Regelung deaktivieren. Neue Reduktionen und Refresh stoppen; eigene Einschränkungen werden nur mit sicheren Ownership-/Telemetrie-Bedingungen zurückgenommen. Stoppen oder Deinstallieren verspricht keine automatische Freigabe der Wallboxen. Bei Updates `/data` erhalten.
