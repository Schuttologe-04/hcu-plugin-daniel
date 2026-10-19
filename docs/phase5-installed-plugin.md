# Phase 5 – Installed HCU Plugin 0.1.0

**Fortschreibung 0.2.1:** Paketnamen und Testzahlen weiter unten beschreiben den historischen 0.1.0-Stand. Der aktuelle Packaging-Pfad verwendet 0.2.1. Für Erstinstallation in einem anderen Netz enthält [initial-configuration.md](initial-configuration.md) den eng begrenzten Rebinding-Hotfix, die unveränderte Seed-Entscheidung und die weiterhin geschützten Ownership-Fälle. Persistiertes `/data` bleibt erhalten; es wird keine automatische Live-Aktivierung oder pauschale Gerätefreigabe ergänzt.

Plugin-ID: `com.psd.hcu.goe.loadmanagement`, Herausgeber: `PSD`, Mindestversion der HCU: `1.4.7`, Scope: `LOCAL`.

Diese Distribution besitzt reale go-e-Schreibfähigkeit. **Nach erster Installation ist die automatische Wallbox-Steuerung ausgeschaltet.** Installation, Start, Reconnect und Update erzeugen für sich allein keine Wallbox-Freigabe. Bestehende Einschränkungen werden niemals blind gelöscht. Bei bereits bewusst aktivierter persistierter Konfiguration bleiben nach Neustart Reconciliation und Telemetrie-Stabilisierung vorgeschaltet.

Build, Unit-Tests und Container-Smoke-Test kontaktieren keine realen Wallboxen. Codex installiert dieses Paket nicht auf der HCU und führt keinen Hardware-Canary durch.

## Installed Architektur

Der dedizierte Einstieg ist `dist/cli/hcu-installed.js`; das Image startet ihn direkt mit Node. Er verwendet `InstalledHcuEnvironment` und liest die von der HCU bereitgestellten Dateien `/TOKEN`, `/CLIENTID` und `/SGTIN`. Der WebSocket-Endpunkt ist ausschließlich `wss://host.containers.internal:9001`. Remote-Development-Variablen `HCU_WS_URL` und `HCU_AUTHTOKEN` werden dafür nicht benötigt. Ein alter Remote-Client bzw. dessen Token wird nicht übernommen oder automatisch registriert.

Die Ausnahme für das lokale HCU-Zertifikat ist auf diese WebSocket-Verbindung begrenzt. Es gibt keine globale TLS-Deaktivierung. Das Plugin bietet keinen eigenen Webserver und exponiert keinen Port.

`InstalledRuntime` besitzt einen sequenziellen Poll-/Decision-Loop. Es verwendet die vorhandenen Komponenten `LiveRuntime`, `TelemetryHealthGuard`, `LoadManager` und `ChargerActuator`. Zwischen Geräteaktionen gilt weiterhin `controlIntervalSeconds`, im Seed vier Sekunden. Telemetrie wird spätestens nach der Hälfte ihres viersekündigen Frischebudgets erneut gelesen, standardmäßig also nach zwei Sekunden. Dieser Abstand lässt Raum für Timer-Verzögerungen und HTTP-Latenz, ohne die bestehende Frischegrenze oder das Aktionsintervall aufzuweichen. Eine Runde liest Controller und aktivierte Charger, aktualisiert Telemetrie und Engine, prüft eine geplante Aktion, führt sie gegebenenfalls über den Actuator aus, prüft Readback und bestätigt erst anschließend die Engine. Pro Regelentscheidung bleibt es bei höchstens einer Charger-Aktion. Der bestehende Remote-LIVE-Einstieg bleibt `PREPARED` ohne automatischen Regel-Loop.

## Zwei getrennte Freigaben

1. Die installierte Distribution besitzt die feste Schreibfähigkeit. Das Image setzt `GOE_REAL_WRITES_ENABLED=true`; diese Capability ist kein HCUweb-Konfigurationsfeld.
2. `loadManagement.liveControlEnabled` ist die bewusst vom Benutzer gesetzte und persistierte operative Freigabe. Der Standard ist **false**. Zusätzlich muss Lastmanagement aktiviert sein.

Automatische Writes benötigen außerdem gesunde und stabile Controller-Telemetrie, einen erreichbaren kompatiblen Charger, sichere Ownership, `loe=false`, eine gültige Aktion und einen laufenden Prozess ohne Shutdown. HCUweb zeigt Schreibfähigkeit und operative Freigabe getrennt sowie den Modus `INSTALLED_LIVE`.

Bei Aktivierung werden Geräte, Firmware und Ownership erneut geprüft. Mindestens zehn Sekunden kontinuierlich frische Grid-Telemetrie müssen vorliegen. Erst danach lässt der Installed-Loop Regelaktionen zu; der bestehende 30-Sekunden-Überlast-Trigger wird nicht umgangen.

Bei Deaktivierung werden keine neuen automatischen Reduktionen geplant. Bereits eigene Einschränkungen werden nur kontrolliert nach den bestehenden Ownership- und Telemetrie-Regeln zurückgenommen. Bei Fault, Konflikt oder unbekannter Ownership bleibt die Freigabe gesperrt. Das Umschalten ist keine pauschale CLEAR-/RESUME-Anweisung.

## First-install Seed und Persistenz

`config.installed.json` liegt unveränderlich im Image und enthält die vom Nutzer bereits validierten lokalen Adressen:

| Gerät | Host | Enabled | Priorität |
|---|---|---|---|
| Controller | `192.168.0.89` | Messquelle | – |
| Garage | `192.168.0.94` | true | 1 |
| Links | `192.168.0.144` | true | 20 |
| Rechts | leer | false | 20 |

Der Seed enthält `enabled=true`, `liveControlEnabled=false`, Grid-Grenzwert 19.000 W, Sicherheitsreserve 500 W, Triggerdauer 30 s, Regelintervall 4 s und Stromschritt 1 A. Damit ergeben sich das Regelziel 18.500 W und die bestehende Recovery-Schwelle 18.000 W. Benachrichtigungen sind vorbereitet; es wird keine OS-Push-Funktion behauptet.

Fehlt `/data/plugin-config.json`, wird der validierte Seed atomar als erste Konfiguration persistiert. Danach ist die persistierte Konfiguration autoritativ. Ein Image-Update überschreibt sie nicht. Beschädigte persistierte Daten werden nicht durch einen frischen Seed verdeckt.

| Persistente Datei | Inhalt |
|---|---|
| `/data/plugin-config.json` | Validierte HCUweb-Konfiguration einschließlich operativer Aktivierung |
| `/data/actuator-state.json` | Versionierte Baseline, Ownership, Write-Intents und bestätigte Readbacks |
| `/data/user-message-state.json` | Versionierte Session- und HCU-Frage-IDs, Zweck, Zeit und Antwortzustand |

Config, Ownership und Message-Schema sind unabhängig von der Plugin-Metadata-Version. Credential-Dateien und vollständige Netzwerkpayloads gehören in keine dieser Persistenzen. Beim Update muss die HCU `/data` erhalten; ein Löschen des Datenverzeichnisses würde die Ownership-Evidenz entfernen.

## Geräte-Sicherheitsgrenzen

Nur `tcl` und `frc` sind schreibbar. `amp` und `loe` werden niemals geschrieben. Native go-e-Regelung mit `loe=true` führt zu einem Konflikt statt zu einer parallelen eigenen Steuerung.

Eine eigene Pause wird erst nach bestätigtem Readback als Ownership betrachtet. Recovery hebt zunächst ausschließlich eine eigene Pause durch `frc=0` auf, behält das temporäre Limit bei und erhöht erst in späteren Regelzyklen. Fremde temporäre Limits und fremde Pausen bleiben geschützt. Eine unstimmige Baseline, ein ausstehender Write-Intent oder ein abweichender Readback führen zu `UNKNOWN` bzw. `CONFLICT`.

Die vom Nutzer manuell verifizierte Clear-Syntax `tcl=null` ist gezielt für das Firmware-Profil **59.4** freigegeben. Die aktuelle Firmware wird gelesen und vor dem Clear erneut geprüft. Unmittelbar vor dem Senden werden außerdem Shutdown-/Abbruchzustand, Telemetrie-Frische und unveränderte Geräteeinstellungen geprüft; auch eine Fremdänderung während der Firmware-Abfrage blockiert den Clear. Unbekannte oder inkompatible Firmware erhält keine allgemeine Clear-Zusage. Die Diagnose zeigt Firmware und Clear-Capability `VERIFIED`, `BLOCKED` oder `UNKNOWN`. Die Hardwareverifikation stammt aus den manuellen Tests des Nutzers; automatisierte Projekt-Tests ersetzen keine Hardwareprüfung.

Grid `null`, unavailable, ungültig oder veraltet bedeutet niemals 0 W. In diesem Fall gibt es keine Recovery. Auch nach Fehler oder Restart benötigt eine Freigabe die durchgängige Telemetrie-Stabilisierung. Einzelne Charger-Ausfälle lösen keinen Container-Restart aus.

Eigene temporäre Limits werden innerhalb des Installed-Orchestrators bei Bedarf nach 300 Sekunden erneuert. Override, Fault, Konflikt, verlorene Ownership, deaktivierte reale Regelung oder Shutdown stoppen Refresh. Die bestehenden begrenzten Status-Retries und die Vermeidung blinder Write-Retries bleiben erhalten.

## Produktive HCU-Fragen

Der erste bestätigte automatische Eingriff einer Session erzeugt bei aktivierter Benachrichtigungspräferenz eine JA/NEIN-Frage ohne TEST-/Dry-Run-Text. JA eines beliebigen berechtigten Familienbenutzers aktiviert Override für die aktuelle Session; NEIN hält die Begrenzung aufrecht. Der ACK enthält keine User-ID.

Frage-ID, Session-ID, Zweck, Erstellzeit und Zustand werden atomar persistiert. Beim Start bzw. Reconnect wird `LIST_USER_MESSAGES_REQUEST` mit diesem State abgeglichen. Eine bekannte noch offene Frage wird wiederverwendet; es wird keine zweite Frage derselben Session erzeugt. Bereits beantwortete bekannte Fragen bleiben beantwortet. Sicher diesem Plugin zugeordnete persistierte TEST-/stale Nachrichten werden begrenzt und ohne Delete-Schleife bereinigt. Nicht ausreichend zuordenbare Nachrichten werden nicht spekulativ gelöscht. Die API-Liste enthält IDs/Zeitstempel, nicht die vollständigen historischen Nachrichtentexte.

Die Zustellung von Fragen und Warnungen läuft unabhängig vom lokalen Telemetrie-Loop. Eine ausbleibende HCU-Antwort blockiert keine neue Grid-Messung und erzeugt keinen Override; nur ein ausdrücklich verarbeiteter JA-ACK kann diesen freigeben. Zustellfehler werden ohne Netzwerkpayload protokolliert.

Ein kontrollierter Shutdown persistiert den Message-State und löscht eine aktuelle Frage nicht pauschal. Die tatsächliche automatische Erkennung eines realen Session-Endes bleibt eine spätere Hardware-Integrationsfrage; `car=4` ist weiterhin kein Session-End-Beweis.

## Container-Basis und Dateirechte

Das Dockerfile verwendet einen Multi-Stage-Build mit dem offiziellen Image `node:24.21.0-alpine3.24`, zusätzlich über den Multi-Arch-Manifest-Digest festgehalten. Das ist Node 24 LTS mit einem Patch-Update gegenüber der lokalen 24.20.0-Runtime; es findet kein Major-Downgrade statt. Die [offizielle Node-Image-Konfiguration](https://github.com/nodejs/docker-node/blob/main/versions.json) unterstützt Alpine 3.24 auf ARM64; der [gepinnten offiziellen Manifest-Beschreibung](https://github.com/docker-library/repo-info/blob/master/repos/node/remote/24-alpine3.24.md) sind Node-Version und ARM64-Plattform zugeordnet.

Builder und Production-Dependencies verwenden `npm ci` mit dem Lockfile. Das Runtime-Image enthält nur `dist/`, Produktionsabhängigkeiten, Package-Metadaten und den Seed. Vitest, TypeScript und deren native Build-Werkzeuge gehören nicht ins Runtime-Image. Pino und ws benötigen hier keine native Laufzeitabhängigkeit. Die produktiven Node-APIs einschließlich `fetch` und `AbortController` werden im Smoke-Test geprüft. Es werden keine zusätzlichen Betriebssystempakete installiert.

Das Image läuft zunächst mit dem vom Basisimage übernommenen Benutzer root. Der Grund ist die HCU-eigene Bereitstellung von `/TOKEN` mit möglicherweise 0600-Rechten und `/data` mit unbekannter numerischer Eigentümerschaft. Das Plugin ändert keine Rechte der HCU-Mounts. Ein eigener nicht privilegierter Benutzer setzt eine vorher verifizierte HCU-UID-/Mount-Konvention voraus. Das ist ein dokumentierter offener Hardening-Punkt.

`.dockerignore` ist eine Allowlist. `.env`, `.env.*`, lokale Config, lokale `/data`-Inhalte, `.git`, Tests, Coverage, IDE-Dateien und neu hinzugefügte unbekannte Dateien gelangen nicht in den Build-Kontext. Das Image enthält keinen Token, keine Client-ID und keinen Aktivierungskey. HCU-Mounts werden erst beim Betrieb bereitgestellt.

Node ist der direkte Container-Hauptprozess. SIGTERM und SIGINT stoppen Timer und neue Writes, schließen bzw. markieren laufende Aktionen konservativ, persistieren Zustand und schließen den WebSocket. Stoppen oder Deinstallieren setzt Wallboxen **nicht automatisch** auf ihren Ausgangszustand zurück. Ein absichtlicher Prozess-Healthcheck, der Wallbox-Erreichbarkeit voraussetzt, ist nicht vorhanden: `FAULT` ist ein Pluginzustand und kein Anlass für endlose Container-Neustarts.

## Windows Packaging

Voraussetzungen: Node 24, npm, Windows PowerShell und Docker Desktop mit gestarteter Linux-Engine. Auf einem x64-PC muss ARM64-Ausführung über die Docker-Desktop-Emulation funktionieren. Das Packaging installiert oder aktiviert Docker nicht selbst.

```powershell
npm run package:hcu
```

Das Skript `scripts/package-hcu.ps1` führt Tests, Typecheck und Build aus, prüft die erlaubten Build-Eingaben, baut explizit `linux/arm64` und validiert `docker image inspect`: Architektur, Linux-OS, Installed-Entrypoint, Plugin-ID, Version, Scope, Issuer, Mindestversion und `logsEnabled=true`. Falsche Architektur oder Metadaten brechen Packaging ab.

Der Build verwendet `--provenance=false`, damit das HCU-Paket keine zusätzlichen Build-Attestations enthält. `docker save --platform linux/arm64` exportiert ausschließlich die geprüfte Zielplattform; hierfür wird Docker API 1.48 oder neuer benötigt. Ohne explizite Plattformwahl könnte Docker weitere im lokalen Image-Store vorhandene Varianten exportieren. Siehe [Docker Build-Optionen](https://docs.docker.com/reference/cli/docker/buildx/build/) und [Docker-save-Plattformauswahl](https://docs.docker.com/reference/cli/docker/image/save/).

Danach startet es einen **netzwerkisolierten** Container-Mocktest mit `--network none` und gemounteten Testdateien `/TOKEN`, `/CLIENTID`, `/SGTIN` und `/data`. Dabei wird der produktive Entrypoint ausschließlich als importierbare Funktion mit gemockten Socket-/Gerätegrenzen verwendet. Default-disabled Erststart, Restart, tatsächliche nicht-leere Ownership-/Session-Persistenz, unveränderte Session-ID beim Restart, Runtime-APIs, Produktionsabhängigkeiten und fehlende Secrets werden geprüft. Es werden keine echten HCU- oder LAN-Verbindungen geöffnet und keine realen Charger-Writes gesendet.

Erst nach diesen Prüfungen erfolgt `docker save`, binäre Gzip-Kompression über .NET und SHA-256-Berechnung. Keine Text-Pipeline verändert die Tar-Daten. Das Ergebnis ist ein Docker-save-Archiv, kein Archiv des Projektordners.

```text
dist-package/
  com.psd.hcu.goe.loadmanagement-0.1.0.tar.gz
  com.psd.hcu.goe.loadmanagement-0.1.0.sha256
  image-inspect.json
```

Das Tag lautet `com.psd.hcu.goe.loadmanagement:0.1.0`. `image-inspect.json` enthält die konkrete Image-ID, Größe, Architektur und Metadaten. Ein erfolgreicher Buildbericht nennt die tatsächlichen Werte; ohne gestartete Docker-Engine werden weder ein fertiges ARM64-Image noch ein fertiges Paket behauptet. Die feste Rezeptur und Dependency-/Image-Pins ermöglichen denselben geprüften Buildpfad; sie versprechen keine byteidentischen Image-Zeitstempel oder Archiv-Checksummen über unabhängige Builds.

Die Checksummenprüfung unter PowerShell:

```powershell
node -e "const fs=require('node:fs'),crypto=require('node:crypto');const h=crypto.createHash('sha256');fs.createReadStream('dist-package/com.psd.hcu.goe.loadmanagement-0.1.0.tar.gz').on('data',c=>h.update(c)).on('end',()=>console.log(h.digest('hex')))"
Get-Content .\dist-package\com.psd.hcu.goe.loadmanagement-0.1.0.sha256
```

## Manuelle HCU-Installation

1. `npm run package:hcu` ausführen und den erfolgreichen Abschluss einschließlich ARM64-Smoke-Test prüfen.
2. Das erzeugte `.tar.gz` unter `dist-package/` finden; SHA-256 prüfen.
3. HCUweb öffnen.
4. **Plugins** auswählen.
5. Eigenes Plugin hochladen und das Docker-save-`.tar.gz` wählen.
6. Installation abwarten.
7. **go-e Lastmanagement** öffnen.
8. Diagnose einschließlich Modus, Firmware, Ownership und Message-Reconciliation prüfen.
9. Controller-/Charger-Konfiguration und Regelparameter prüfen.
10. **Reale Laderegelung zunächst AUS lassen.**
11. Controller- und Charger-Werte beobachten.
12. Erst nach den folgenden Prüfungen die reale Regelung bewusst aktivieren.

### Vor der ersten Aktivierung

- Plugin `READY`, Installed Mode und Version 0.1.0 sichtbar.
- Controller verfügbar, Grid-Messung plausibel und aktuell.
- Garage und Links erreichbar; Rechts deaktiviert.
- Firmware-Profil kompatibel; Clear-Capability nachvollziehbar.
- `loe=false`; `frc` und `tcl` entsprechen dem tatsächlichen Zustand.
- Ownership `NONE` oder vollständig reconciliert, kein `UNKNOWN`/`CONFLICT`.
- Persistierte Fragen abgeglichen; bekannte TEST-/stale Meldungen bereinigt.
- Reale Schreibfähigkeit verfügbar, automatische Regelung weiterhin AUS.

### Nach bewusster Aktivierung

Mindestens zehn Sekunden Telemetrie-Stabilisierung beobachten. Bei tatsächlicher kontinuierlicher Überlast sollten anschließend `TRIGGER_PENDING`, die 30-Sekunden-Frist, ein erster 1-A-Schritt, `WRITE_CONFIRMED`, passender Readback und die produktive HCU-Frage nachvollziehbar sein. Charger mit niedrigerer Priorität werden zuerst reduziert; gleichrangige Charger wechseln sich weiter per Round Robin ab. Keine künstliche Überlast oder echte Hardware-Aktion wird durch das Packaging erzeugt.

## Emergency, Rollback und Update

Bei unerwartetem Verhalten `liveControlEnabled=false` in HCUweb setzen. Das beendet neue automatische Reduktionen. Danach Ownership, Grid-Health und Readback prüfen; eine sichere Rücknahme benötigt weiterhin diese Evidenz. Alternativ Plugin stoppen bzw. deinstallieren. **Stoppen verspricht keine automatische Wallbox-Freigabe.** Eine manuelle Geräteänderung kann einen Ownership-Konflikt auslösen und muss bewusst beurteilt werden.

Bei späteren Updates `/data` erhalten. Nach Update/Reboot werden vorhandene Config, Ownership und Fragen geladen und reconciliert. Ein Plugin-Neustart ersetzt keine Hardwareprüfung. Die erste echte Installation und Aktivierung führt der Nutzer selbst durch; LAN-Erreichbarkeit von `host.containers.internal:9001`, Controller, Garage und Links wird erst dort geprüft.
