# Homematic IP HCU / go-e – Version 0.2.0

Dieses TypeScript-/Node.js-Plugin läuft als Installed-ARM64-Container auf der Homematic IP HCU. Der go-e Controller misst den Netzbezug; die bewährte Lastmanagement-Engine regelt aktivierte Charger über den geschützten `tcl`-/`frc`-Actuator. **Version 0.1.0 wurde vom Nutzer auf der realen HCU installiert und funktional geprüft.** Sie bleibt die unveränderte Referenz für Regelung, Ownership und Safety.

**Version 0.2.0 ergänzt ausschließlich eine read-only HmIP-Geräteprojektion:** Netz, Hausverbrauch, Solar sowie aktivierte Charger stellen CurrentPower und Maintenance bereit. Sie verwenden denselben bestehenden Telemetrie-Snapshot, ohne zusätzliche Hardwarepolls oder Timer. Aus einem HmIP-Geräte-ControlRequest kann keine Wallbox-Steuerung entstehen. Die reale Geräteinklusion und Anzeige in HCU/App stehen für diese Erweiterung noch aus. [Technik und Abnahme](docs/phase6-hmip-plugin-devices.md), [Changelog](CHANGELOG.md).

## Sicherheitsgrenze

**Phase 1 performs no write requests to any go-e device**

**Phase 2 calculates control actions but does not execute them against real go-e devices.**

**Phase 3 calculates control actions but does not execute them against real go-e devices.**

Der bestehende `GoEHttpClient` bietet weiterhin nur `readStatus()` und erzeugt ausschließlich `GET /api/status` mit einem validierten Feldfilter. Aufrufer können weder einen anderen Pfad noch eine HTTP-Methode oder einen Request-Body übergeben. Weiterleitungen werden nicht verfolgt. In Phase 4 darf ausschließlich `src/goe/control/charger-control-client.ts` einen schreibenden `/api/set`-Request erzeugen, und nur für `tcl` beziehungsweise `frc`. `amp`, `loe` und andere Geräteparameter werden niemals geschrieben. `SET_TEMPORARY_CURRENT_LIMIT`, `PAUSE`, `RESUME` und `CLEAR_TEMPORARY_CURRENT_LIMIT` bleiben Domänenobjekte; die Engine selbst führt keine HTTP-Requests aus.

`hcu:dev`, `hcu:dry-run`, `hcu:test-message` und `probe` besitzen keinen realen go-e-Schreibpfad, auch bei versehentlich gesetztem `GOE_REAL_WRITES_ENABLED=true`. `simulate` bleibt vollständig offline und alle Netzwerkzugriffe in Tests sind gemockt. Der Remote-LIVE-Pfad verlangt **gleichzeitig** `executionMode=LIVE` und `GOE_REAL_WRITES_ENABLED=true`; HCUweb kann diese Freigabe nicht aktivieren. Das Installed-Image besitzt eine feste Schreibfähigkeit; autonome Aktionen benötigen zusätzlich den bewusst gesetzten persistenten Schalter `loadManagement.liveControlEnabled=true`.

HCU-Verbindung, Konfiguration, produktive JA/NEIN-Fragen und deren Persistenz sind vorhanden. Die Engine erhält Messungen und Zeitstempel weiterhin explizit. `hcu:dev` startet keinen Regellauf; Remote `hcu:live` bleibt PREPARED. Der Installed-Orchestrator führt die automatische Regelung nur bei operativer Aktivierung aus. Nach Erstinstallation läuft Telemetrie bei ausgeschalteter Steuerung; HmIP-Sensorgeräte werden unabhängig von diesem Schalter angeboten.

## Voraussetzungen und Installation

- Node.js **24.x LTS** mit npm; `package.json` und `.node-version` legen diese Major-Version fest. Node 24 ist am 10. Oktober 2026 die aktuelle LTS-Linie laut [offiziellem Node.js-Releaseplan](https://github.com/nodejs/Release/blob/main/schedule.json).
- Für einen manuellen Gerätetest: Netzwerkzugriff auf die lokalen go-e-HTTP-APIs. Unit-Tests benötigen keine erreichbaren Geräte.

Im Projektverzeichnis:

```sh
npm ci
```

Direkte Laufzeitabhängigkeiten sind Pino und `ws`; `ws` ermöglicht die von der HCU benötigten Header und verbindungsspezifischen TLS-Optionen. TypeScript, Typdefinitionen und Vitest sind Entwicklungsabhängigkeiten. go-e-HTTP verwendet die native Node.js-`fetch`-API; ein Webframework wird nicht benötigt. `package-lock.json` hält die tatsächlich installierten Versionen fest.

## Konfiguration

Kopiere die Beispielkonfiguration in eine lokale `config.json`.

PowerShell:

```powershell
Copy-Item -LiteralPath config.example.json -Destination config.json
```

POSIX-Shell:

```sh
cp config.example.json config.json
```

Ersetze anschließend **`<GO_E_CONTROLLER_IP>`** in `controller.host` durch den tatsächlichen Controller-Host. Der Platzhalter ist absichtlich kein gültiger Host; die Diagnose weist die unveränderte Beispieldatei zurück. Die Controller-Adresse wird nicht geraten und ist im Quellcode nicht hinterlegt.

`config.example.json` enthält die vorgegebenen Charger:

| ID | Name | Host | Aktiv | Priorität |
| --- | --- | --- | --- | --- |
| `garage` | go-eCharger Garage | `192.168.0.94` | ja | 1 |
| `links` | go-eCharger Links | `192.168.0.144` | ja | 20 |
| `rechts` | go-eCharger Rechts | leer | nein | 20 |

Adressen stammen ausschließlich aus der Konfiguration. Eine kleinere Prioritätszahl bezeichnet die höhere Ladepriorität. Gleichrangige Charger sind erlaubt. Die Prioritäten beeinflussen in Phase 1 keine Geräteabfrage; die Phase-2-Engine nutzt sie ausschließlich für abstrakte Entscheidungen.

| Einstellung | Beispiel | Validierung |
| --- | --- | --- |
| `controller.host` | `<GO_E_CONTROLLER_IP>` ersetzen | immer ein gültiger Host |
| `loadManagement.enabled` | `true` | Boolean; aktiviert in Phase 1 keine Regelung, schaltet die Phase-2-Entscheidungen frei |
| `loadManagement.gridLimitW` | `19000` | endliche Zahl größer als 0 |
| `loadManagement.safetyReserveW` | `500` | endliche Zahl ab 0, kleiner als `gridLimitW` |
| `loadManagement.triggerDurationSeconds` | `30` | positive ganze Zahl |
| `loadManagement.controlIntervalSeconds` | `4` | positive ganze Zahl |
| `loadManagement.ampStep` | `1` | positive ganze Zahl |
| `chargers[].id` | `garage` | eindeutig, nicht leer, keine umgebenden Leerzeichen |
| `chargers[].name` | `go-eCharger Garage` | nicht leer |
| `chargers[].enabled` | `true` | Boolean |
| `chargers[].host` | `192.168.0.94` | aktiver Charger: gültiger Host; deaktivierter Charger: leer erlaubt |
| `chargers[].priority` | `1` | positive ganze Zahl |
| `http.timeoutMs` | `3000` | positive ganze Zahl bis 2147483647; ohne `http`: 3000 ms |

Hosts dürfen IPv4-Adressen, DNS-Namen oder IPv6-Adressen in eckigen Klammern sein, jeweils optional mit Port zwischen 1 und 65535, etwa `charger.local:8080` oder `[2001:db8::1]:8080`. Schema, Pfad, Query, Fragment, Zugangsdaten und Leerzeichen sind nicht erlaubt. Auch ein deaktivierter Charger muss einen gültigen Host haben, sobald sein Host nicht leer ist.

19.000 W Grenzwert minus 500 W Reserve ergibt das Regelziel 18.500 W. Die Phase-2-Engine leitet Ziel, Recovery-Schwelle und Zeitintervalle zentral aus dieser Konfiguration ab. Phase 1 berechnet weiterhin keine Stellbefehle.

`ConfigProvider.load()` liefert untypisierte Daten. `loadConfig()` validiert diese unabhängig von ihrer Herkunft. `FileConfigProvider` lädt lokale Dateien. Phase 3 ergänzt einen `ConfigStore` und `StoredConfigProvider`; HCUweb-Updates durchlaufen denselben zentralen Validator. HCU-Credentials sind kein Bestandteil dieser Konfiguration.

## Tests, Typecheck und Build

```sh
npm test
npm run typecheck
npm run build
```

Der Build erzeugt ESM-JavaScript unter `dist/`. `npm run test:watch` startet Vitest im Watch-Modus. Ein separater Linter ist nicht eingerichtet.

Die Tests prüfen Konfigurationsfehler, Hostvalidierung, dynamische Grid-Zuordnung, negative und fehlende Messwerte, Controller-Strukturfehler, Charger-Normalisierung, zukünftige Zustandswerte, deaktivierte Geräte, isolierte Geräteausfälle und das HTTP-Fehlerverhalten. Zusätzlich prüfen sie Triggergrenzen, Prioritäten, Round Robin, einzelne Stromschritte, Mindestströme, Pause/Recovery, Hysterese, Override, Aktionsquittierung und sichere Fehlerzustände. Phase 4 ergänzt Write-Gates, Whitelist, Ownership, Konflikte, atomare Persistenz, Reconciliation, Readback, begrenzte Lese-Retries und Telemetrie-Stabilisierung. Netzwerkzugriffe in Unit-Tests sind vollständig gemockt; Engine und Simulation benötigen keine Netzwerkfunktion. Beispiele aus dem Auftrag liegen unverändert unter `tests/fixtures`; abgeleitete Testdaten sind in den [API-Notizen](docs/api-notes.md) gekennzeichnet.

## Read-only-Diagnose

Mit der lokalen `config.json`:

```sh
npm run probe
```

Mit anderem Konfigurationspfad oder zur Hilfe:

```sh
npm run probe -- --config ./config.json
npm run probe -- --help
```

`probe` baut das Projekt und fragt danach den Controller und jeden aktivierten Charger einmal ab. Deaktivierte Charger werden als `disabled` angezeigt und erzeugen keinen Netzwerkzugriff. Die Abfragen laufen unabhängig; ein defekter Charger verhindert nicht die Auswertung der anderen Geräte oder des Controllers.

Der lesbare Bericht enthält Netzleistung, Netzbezug und Grid-Phasenströme sowie Charger-Firmware, Fahrzeugzustand, Stromgrenzen, Ladefreigabe und die unveränderten `frc`-/`modelStatus`-/`nrg`-Werte. Nicht vorhandene optionale Werte erscheinen als `none`, fehlgeschlagene Geräte als `unavailable` mit Fehlercode und verständlicher Meldung. Die Anzeige rundet Messwerte zur Lesbarkeit; im Domänenmodell bleiben die eingelesenen Werte erhalten.

| Exit-Code | Bedeutung |
| --- | --- |
| `0` | alle aktivierten Geräte liefern gültige Statusantworten; auch `--help` |
| `1` | mindestens ein Gerät ist nicht erreichbar oder liefert eine unbrauchbare Antwort |
| `2` | Konfigurations- oder Aufruffehler |

Für Skripte kann nach `npm run build` unmittelbar `node dist/cli/probe.js --config ./config.json` verwendet werden. Der Prozess schreibt den Diagnosebericht auf stdout und strukturierte JSON-Logs auf stderr.

## Logging und Fehler

`LOG_LEVEL` erlaubt `debug`, `info`, `warn` und `error`; ohne gültigen Wert gilt `info`.

PowerShell:

```powershell
$env:LOG_LEVEL = 'debug'
npm run probe
```

POSIX-Shell:

```sh
LOG_LEVEL=debug npm run probe
```

Info-Logs beschreiben die geladene Konfiguration und die Erreichbarkeit der einmalig geprüften Geräte. Messwertdetails erscheinen auf `debug`. Logs enthalten keine kompletten Geräteantworten, Konfigurationen oder ungefilterten nativen Fehlermeldungen. Pino erzeugt zeilenweise JSON und ist damit für die spätere Container-Laufzeit geeignet.

An den Geräte- und Konfigurationsgrenzen wird `Result<T>` verwendet: entweder `{ ok: true, value }` oder `{ ok: false, error }`. Die Fehlercodes sind `ConfigurationError`, `ConnectionError`, `TimeoutError`, `InvalidResponseError` und `MissingMeasurementError`. Der HTTP-Layer prüft HTTP-Status und JSON, kapselt Netzwerkfehler, bricht per `AbortController` ab und hält den Timeout auch während des Empfangs des Antwort-Bodys aktiv. Die HTTP-Clients wiederholen Requests nicht. Der Phase-4-Actuator kann ausschließlich sichere Statuslesungen begrenzt wiederholen; ein unklarer Write wird niemals blind wiederholt.

## Architektur

```text
src/
  config/       Typen, Laufzeitvalidierung und austauschbare ConfigProvider
  domain/       Controller-/Charger-Modelle, Fahrzeugzustände und Result-Fehler
  goe/          read-only HTTP-Layer, Geräteclients und validierende Mapper
    control/    gekapselter Write-Client, Actuator, Ownership und Reconciliation
  diagnostics/  einmalige Abfrage und Isolation der einzelnen Geräteausfälle
  load-management/ deterministische Engine, Zustände, Policy, Scheduler, Aktionen
  simulation/   explizite Messsequenzen und In-Memory-Chargermodelle
  hcu/          Connect-API-Transport, Plugin-State, HCUweb, Meldungen, Umgebungen
  orchestration/ Dry-Run/LIVE-Runtime, Telemetriegesundheit und Action-Journal
  logging/      strukturiertes Pino-Logging
  cli/          Argumente, Ausgabeformat und Exit-Codes
  index.ts      öffentliche Exporte ohne Start-Nebeneffekte
tests/
  fixtures/     technische Beispielantworten und gekennzeichnete Ableitungen
  unit/         gemockte HTTP- sowie Konfigurations-/Domänentests
docs/
  api-notes.md  Quellen, Zuordnungen und bewusst offene API-Fragen
  load-management.md Engine-Vertrag, Aktionsbesitz und Simulationsgrenzen
  hcu-integration.md HCU-Protokoll, Message-Flows und manuelle Live-Testschritte
  phase4-actuator-safety.md Write-Gate, Ownership, Fail-safe und geplanter Canary
```

`GoEControllerClient` und `GoEChargerClient` kennen weder HCU noch Regelstrategien. Beide nutzen den kleinen `StatusReader`-Vertrag und geben validierte Domänenmodelle zurück. Die Mapper erhalten externe JSON-Daten als `unknown` und prüfen deren Form und Werte vor der Normalisierung. `probeDevices()` in `src/diagnostics/probe-service.ts` koordiniert die Abfragen und stellt pro Charger die Zustände `reachable`, `unavailable` oder `disabled` bereit. Die CLI enthält Ausgabeformatierung und Prozesssteuerung, keine Laderegelung.

Der Controller-Mapper findet `Grid` anhand des Namens in `ccn` und verwendet denselben gefundenen Index in `ccp` und `cpc`. `gridPowerW` bleibt vorzeichenbehaftet; `gridImportW` ist nur bei gültiger Grid-Leistung `Math.max(gridPowerW, 0)`. Ein fehlender, `null` oder ungültiger Grid-Leistungswert wird niemals zu 0 W. Einzelne fehlende Phasenströme bleiben `null`.

Die dokumentierten Charger-`car`-Zustände sind zentral abgebildet. Unbekannte zukünftige numerische Werte bleiben erhalten; `isActivelyCharging()` prüft ausschließlich den gemeldeten Zustand `Charging`. Dieser Helper liefert keine Aussage über eine tatsächlich gemessene Ladeleistung. `car=4` wird als `complete` dargestellt und beweist für sich allein weder eine Ladepause noch das Ende einer Ladesession. Die Engine erkennt ihre eigenen simulierten Pausen durch ihren internen Aktionsbesitz.

## Phase 2 – Load-Management-Engine

`LoadManager` erhält validierte Konfiguration, normalisierte Controller-/Charger-Ergebnisse, einen expliziten `timestampMs` und eine `measurementId`. `evaluate()` liefert den Zustand, einen strukturierten Status und **höchstens eine** abstrakte Aktion. Die Engine importiert weder HTTP noch HCU, CLI, Logging oder Dateisystem. Es gibt keinen internen Echtzeittimer und keinen direkten Zugriff auf `Date.now()`.

| Zustand | Bedeutung |
| --- | --- |
| `NORMAL` | keine eigenen Einschränkungen, kein Eingriff |
| `TRIGGER_PENDING` | kontinuierliche Überschreitung wird anhand der Zeitstempel gemessen |
| `LIMITING` | aktive Begrenzungsphase; reduzieren oder im Hystereseband halten |
| `PAUSED` | eigene Pausen gehören weiterhin zur aktuellen Begrenzungsphase |
| `RECOVERING` | eigene Einschränkungen werden kontrolliert zurückgenommen |
| `OVERRIDE` | explizite Freigabe; eigene Einschränkungen zurücknehmen und neue Trigger sperren |
| `LIMIT_UNACHIEVABLE` | trotz ausgeschöpfter steuerbarer Ladeleistung bleibt Grid über dem Ziel |
| `FAULT` | unsichere oder widersprüchliche Daten verhindern eine sichere Entscheidung |

Der Trigger startet nur bei `gridImportW > gridLimitW` und mindestens einem aktivierten, erreichbaren, regelbaren Charger mit `isActivelyCharging() === true`. Regelbar bedeutet hier: oberhalb seines Mindeststroms oder mit unterstützter Ladepause. Ein Charger am Minimum ohne Pausenunterstützung startet allein keinen Trigger. Genau 19.000 W löst nichts aus. Ein Rückgang auf höchstens 19.000 W oder der Wegfall regelbarer, aktiv ladender Charger verwirft die Auslösezeit vollständig. Nach 30 Sekunden ununterbrochener Überschreitung beginnt die Begrenzung; innerhalb derselben Phase ist keine weitere 30-Sekunden-Wartezeit nötig.

Die zentrale Policy leitet folgende Grenzen aus der Konfiguration ab:

| Bedingung während einer Regelphase | Entscheidung |
| --- | --- |
| `Grid > gridLimitW - safetyReserveW` | reduzieren; aktuell über 18.500 W |
| `gridLimitW - 2 × safetyReserveW < Grid <= gridLimitW - safetyReserveW` | halten; aktuell über 18.000 bis einschließlich 18.500 W |
| `Grid <= gridLimitW - 2 × safetyReserveW` | Recovery versuchen; aktuell höchstens 18.000 W |

Jede normale Stromregelentscheidung verändert höchstens einen Charger um höchstens `ampStep` A, bei der aktuellen Konfiguration 1 A. Zwischen Aktionen liegen mindestens `controlIntervalSeconds`, aktuell 4 Sekunden, und eine neue Messung. Einspeisung bleibt als vorzeichenbehafteter Rohwert erhalten und ergibt gültigen Netzbezug 0 W. Fehlende Werte ergeben dagegen `FAULT` und niemals eine vermeintliche 0-W-Freigabe.

Beim Reduzieren werden die größten Prioritätszahlen zuerst bedient: Links/Rechts vor Garage. Gleichrangige Kandidaten rotieren in der Reihenfolge der Konfiguration. Ein eigener Cursor je Priorität und Regelrichtung bleibt auch bei vorübergehend nicht berechtigten Chargern erhalten. Aktuell nicht ladende oder am Minimum befindliche Charger werden für Stromreduktionsschritte übersprungen. Erst wenn keine Stromreduktion in derselben Prioritätsgruppe mehr möglich ist, kommen unterstützte Pausen zum Zug; die schlechtere Prioritätsgruppe wird vor Garage ausgeschöpft. Beim Recovery gilt die umgekehrte Priorität: Garage zuerst.

`acu`, `tcl`, `amp`, `ama` und `mca` bestimmen den sicheren Regelstrom und die Freigabegrenze. `amp` bleibt ausschließlich Benutzer-Sollwert. `mca` wird aus dem jeweiligen Charger gelesen, nicht global auf 6 A festgesetzt. Am Minimum kann ein Charger mit `acp=true` eine abstrakte `PAUSE` erhalten. Eine eigene Pause wird nicht wiederholt ausgesendet; Recovery beginnt mit `RESUME` bei weiterbestehendem Mindestlimit und erhöht erst in späteren Zyklen. Die gemeldete Mindestpausendauer `mcpd` wird berücksichtigt.

Die Engine unterscheidet geplante, quittierte und beobachtete eigene Einschränkungen von fremden `tcl`-Werten. Ein Aktionsobjekt allein bedeutet noch keine Anwendung: `acknowledgeAction(actionId, 'applied')` bestätigt die Anwendung im Simulationsmodell; eine frische Statusmessung muss dazu passen. Ohne Bestätigung entstehen keine weiteren spekulativen Schritte. Fremde ursprüngliche Limits werden beim Freigeben mit `SET_TEMPORARY_CURRENT_LIMIT` auf ihren gespeicherten Ausgangswert zurückgesetzt; `CLEAR_TEMPORARY_CURRENT_LIMIT` gilt ausschließlich für ursprünglich fehlende Limits. `applyManualOverride()` hebt nur eigene Einschränkungen schrittweise auf und sperrt weitere Trigger bis zum expliziten `endSession()`-Ereignis. `car=4` beendet weder automatisch die Session noch das Override.

Auch die letzte Freigabe benötigt eine passende neue Statusmessung; noch offene Rückmeldungen stehen in `awaitingObservationChargerIds`. Eine blockierende Mindestpausendauer der höchsten erreichbaren Recovery-Priorität hält niedrigere Prioritäten zurück. Gleichrangige, bereits berechtigte Charger können währenddessen weiter berücksichtigt werden.

Bei fehlendem Controller-/Grid-Wert bleiben eigene Einschränkungen erhalten und die Engine erzeugt keine Recovery-Aktion. Einzelne unerreichbare Charger werden isoliert behandelt; andere gültige erreichbare Charger können weiter berücksichtigt werden. Fehlen essenzielle Daten für die nächste sichere Entscheidung oder widersprechen Messungen dem eigenen Modell, wird dies als `FAULT` ausgewiesen. Wenn nach Ausschöpfung der steuerbaren Ladeleistung Grid weiterhin über dem Ziel liegt, meldet `LIMIT_UNACHIEVABLE` diesen Zustand ohne identische Commandschleife. Spätere Reserve erlaubt wieder Recovery.

### Offline-Simulation

```sh
npm run simulate
npm run simulate -- --config ./config.example.json
npm run simulate -- --help
```

Die CLI liest nur Konfigurationsdaten, ersetzt alle Gerätehosts durch `.sim`-Namen und nutzt den bestehenden Validator. Der unveränderte Controller-Platzhalter der Beispieldatei ist hier erlaubt, weil er vor der Validierung ersetzt wird. Es werden keine Geräteclients erzeugt. Messsequenzen, Chargerantworten und Aktionsquittierungen existieren ausschließlich im Speicher. `probe` bleibt davon getrennt die reale read-only Diagnose.

Der voreingestellte Ablauf modelliert den gemeldeten realen Phase-1-Fall: Grid 22.839 W, Garage `car=2`, `amp=acu=14`, `tcl=null`, `mca=6`; Links idle, Rechts deaktiviert. Bis einschließlich 29,999 Sekunden gibt es keine Aktion. Bei 30 Sekunden entsteht `SET_TEMPORARY_CURRENT_LIMIT garage 13 A`; bei 34 Sekunden unter weiterhin hoher Last folgt 12 A. Weitere Samples demonstrieren Halten, Recovery und einen fehlenden Grid-Wert. Die Grid-Sequenz wird explizit vorgegeben; eine elektrische Leistungswirkung einzelner Ampere wird nicht geraten. [Details zum Engine-Vertrag](docs/load-management.md).

## Phase 3 – HCU Connect API und Dry-Run

Die bereitgestellte **Homematic IP Connect API 1.0.1** ist die maßgebliche Protokollquelle. `HcuWebSocketClient` verbindet sich per WSS, setzt `authtoken` und `plugin-id`, validiert externe JSON-Nachrichten, korreliert Requests/Responses über `id` und stellt den Verbindungszustand bereit. `PLUGIN_STATE_REQUEST` wird mit `PLUGIN_STATE_RESPONSE` und `pluginReadinessStatus=READY` beantwortet. Reconnect hat begrenzten exponentiellen Backoff; Shutdown beendet Timer und Requests.

Die zentrale und verbindliche Plugin-ID lautet `com.psd.hcu.goe.loadmanagement`. Sie ist in `src/hcu/plugin-identity.ts` definiert und wird als Standard verwendet. Remote-Development verwendet folgende sichere Startvariablen:

| Variable | Bedeutung |
| --- | --- |
| `HCU_WS_URL` | `wss://hcu1-XXXX.local:9001`; `XXXX` durch die eigene HCU-Kennung ersetzen |
| `HCU_AUTHTOKEN` | eigener manuell erstellter und bestätigter Token |
| `HCU_PLUGIN_ID` | optional; ohne Angabe gilt der zentrale Standard, bei Angabe `com.psd.hcu.goe.loadmanagement` verwenden |
| `HCU_ALLOW_SELF_SIGNED` | explizit `true` für diese Verbindung; sonst TLS-Prüfung aktiv |
| `HCU_DATA_DIR` | optionaler Datenpfad; ohne Angabe `./data` |

Token gehören weder in `config.json` noch in Git, HCUweb oder Logs. `.env` und `data/` sind ignoriert; `.env.example` enthält Platzhalter. Die HCU-npm-Kommandos laden eine vorhandene lokale `.env` über Nodes native Option `--env-file-if-exists=.env`; bereits gesetzte Prozessvariablen haben Vorrang. Es wird keine globale TLS-Prüfung deaktiviert. `RemoteDevelopmentEnvironment` und `InstalledHcuEnvironment` trennen Remote-Entwicklung vom vorbereiteten späteren Containervertrag mit `/TOKEN`, `/CLIENTID`, `/SGTIN`, `/data` und `wss://host.containers.internal:9001`.

**Identitätsmigration:** Ein Connect-API-Client für die frühere Plugin-ID sowie dessen `authToken` und `clientId` dürfen für die neue Identität nicht weiterverwendet werden. Für `com.psd.hcu.goe.loadmanagement` muss ein neuer Connect-API-Client mit neuem Aktivierungskey und neuem Token manuell angelegt und bestätigt werden. Alte Credentials werden nicht übernommen; die Software registriert keinen Client automatisch.

Die Startmodi sind bewusst getrennt:

```powershell
npm run hcu:dev
npm run hcu:dry-run
npm run hcu:test-message
```

- `hcu:dev`: HCU-Verbindung, Plugin-State und HCUweb; kein kontinuierlicher go-e-Regellauf und keine automatische TEST-Frage.
- `hcu:dry-run`: zusätzlich echte read-only go-e-Messungen, Engine, simulierte Einschränkungen und maximal 50 abstrakte Aktionen im In-Memory-Journal.
- `hcu:test-message`: ausdrücklicher manueller Versand einer als TEST gekennzeichneten YES/NO-App-Meldung; wartet auf Antwort oder `Ctrl+C`, führt keine Engine und keine Charger-Steuerung aus.

HCUweb enthält sieben Gruppen: **go-e Controller**, **Lastmanagement**, **Ladestation Garage**, **Ladestation Links**, **Ladestation Rechts**, **Benachrichtigungen** und **Diagnose**. Die festen Slot-IDs sind `garage`, `links`, `rechts`. Die bisherigen Geräte-/Regelparameter bleiben das fachliche Konfigurationsmodell. Der letzte Runtime-Snapshot liefert read-only Messwerte und Diagnose, ohne beim Öffnen des Dialogs Netzwerkabfragen anzustoßen. Fehlende Werte erscheinen als `unavailable`; Regelziel und Recovery-Schwelle werden berechnet. Die Diagnose zeigt den Modus und ausdrücklich deaktivierte echte Charger-Schreibzugriffe.

HCUweb-Updates werden serialisiert, auf einer Kopie angewendet, vollständig validiert und atomar nach `data/plugin-config.json` gespeichert. Dazu wird eine temporäre Datei geschrieben, synchronisiert, geschlossen und im selben Verzeichnis umbenannt. Erst danach wird die Runtime umgestellt. Fehler verwerfen das gesamte Update und behalten die alte gültige Konfiguration; Credentials werden nicht persistent gespeichert.

Beim ersten Start ohne Persistenz wird die gültige lokale `config.json` beziehungsweise `--config`-Datei als Ausgangskonfiguration gespeichert. Bei späteren Starts hat `plugin-config.json` Vorrang; Änderungen an der lokalen Seed-Datei überschreiben diesen Stand nicht. Weitere Änderungen erfolgen über HCUweb. Für einen getrennten manuellen Teststand kann ein eigenes `HCU_DATA_DIR` gewählt werden. Eine beschädigte Persistenz stoppt den Start mit Fehler.

Benachrichtigungen benötigen ein explizites Opt-in: `notifications.intervention`, `notifications.controllerConnectionError` und `notifications.chargerConnectionError` sind standardmäßig `false`; `notifications.interactive` ist `true`. Die erste simulierte Intervention kann eine einzige `ACKNOWLEDGEABLE_BY_YES_NO`-Frage mit Titel **TEST: go-e Lastmanagement** erzeugen. Der Text sagt ausdrücklich, dass keine Wallbox-Einstellungen verändert wurden. `JA` aktiviert nur das Engine-Override der Simulation, `NEIN` lässt die Automatik aktiv. Keine Antwort und HCU-Ausfall gelten niemals als Zustimmung.

Die injizierte `userMessageId` ordnet `USER_MESSAGE_ACK_EVENT` exakt der offenen Frage zu. Alte, unbekannte und doppelte Antworten werden ignoriert. Die erledigte Frage wird gelöscht; Löschfehler werden nach Reconnect bereinigt. `ListUserMessages` gleicht eine offene ID ab, bevor dieselbe ID gegebenenfalls wiederverwendet wird; weitere Regelzyklen erzeugen keine zweite Frage. Session-Ende bleibt ein explizites Domänenereignis und wird nicht aus `car=4` geraten.

Im vom Nutzer bestätigten Live-Test erschien die Meldung auf dem App-Home-Screen, ohne OS-Push. Alle Familienbenutzer konnten die Meldung sehen und beantworten; das ACK enthält keine Benutzeridentität. **JA eines beliebigen berechtigten Familienbenutzers aktiviert Override.** Eine Owner-only-Funktion ist nicht vorhanden. Im Dry-Run betrifft Override ausschließlich die Simulation; im getrennten LIVE-Pfad können nur eindeutig plugin-eigene Einschränkungen zurückgenommen werden. Konfiguration bleibt ausschließlich in HCUweb; es werden keine virtuellen HCU-Geräte angelegt.

Für den ersten Live-Test muss der Entwickler manuell Developer Mode und WebSocket-Freigabe in HCUweb aktivieren, einen neuen Aktivierungskey erzeugen, den Connect-API-Client für `com.psd.hcu.goe.loadmanagement` anlegen und den neuen Token bestätigen. WebSocket-Header und Token müssen zu dieser Plugin-ID gehören. Die Software automatisiert diese Schritte nicht. Danach zuerst `hcu:dev`, anschließend nur bei beabsichtigtem App-Test `hcu:test-message` und getrennt davon `hcu:dry-run` starten. **Die genaue Anleitung mit den dokumentierten Token-Endpunkten, Headern und offenen Prüfstellen steht in [docs/hcu-integration.md](docs/hcu-integration.md).** Es wurden bei der Implementierung keine Live-HCU-Meldungen versendet.

## Phase 4 – Actuator, Ownership und vorbereiteter LIVE-Modus

Der `GoEChargerControlClient` bietet genau vier typisierte Operationen: temporäres Limit setzen, temporäres Limit entfernen, pausieren und fortsetzen. Eine öffentliche `set(key, value)`- oder Pfad-API existiert nicht. Der `ChargerActuator` prüft vor jedem Write einen frischen Status samt `loe=false`, speichert den erwarteten Eingriff atomar und bestätigt ihn erst nach passendem Readback. HTTP 200 allein ist keine Aktionsbestätigung.

Vor dem ersten eigenen Eingriff werden `amp`, `tcl`, `frc`, `loe`, `car`, `mca`, `acu` und Zeitstempel als Baseline erfasst. Ownership liegt getrennt in `HCU_DATA_DIR/actuator-state.json`. Fremde Limits werden nicht gelockert; beim Zurücknehmen wird die fremde Baseline erhalten. Eine fremde Pause wird niemals mit `frc=0` aufgehoben. Externe Änderungen, unklare Writes und `loe=true` blockieren konkurrierende Befehle. Neustarts lesen reale Zustände zur Reconciliation, ohne automatisch CLEAR, RESUME oder PAUSE zu senden.

Fehlende, ungültige oder ältere Grid-Telemetrie ergibt `FAULT` und keine Freigabe. Nach Start beziehungsweise Controller-Fault verlangt die LIVE-Runtime 10 Sekunden kontinuierlich gültige Telemetrie vor Recovery. Eigene Restriktionen bleiben bestehen. Ein einzelner unerreichbarer Charger blockiert keine unabhängige Reduktionsentscheidung für einen anderen erreichbaren Charger. Die Engine, Prioritäten und Round Robin bleiben bestehen.

```powershell
npm run hcu:live
```

Dieser getrennte Start schlägt ohne `GOE_REAL_WRITES_ENABLED=true` geschlossen fehl. Mit Freigabe startet er **PREPARED**, ohne automatischen Regel- oder Refresh-Timer. Nur explizite Aufrufe der LIVE-Runtime lesen eine Entscheidung (`observe()`), führen eine noch aktuelle Aktion aus (`executePendingAction(actionId)`) oder prüfen fälligen Refresh (`refresh()`). Es gibt keinen CLI-Canary und keine automatische Ausführung der ersten Aktion. Die Freigabe allein führt keine Wallboxänderung aus.

Ein eindeutig eigenes aktives `tcl` kann nach 5 Minuten erneuert werden; dafür sind gesunde Telemetrie, gültige Ownership, ein erreichbarer Charger, `loe=false` und fehlender Override/Konflikt erforderlich. Phase 4 stellt diese Wartung explizit bereit und startet keinen unbeaufsichtigten Refresh-Loop. Normaler Shutdown persistiert den Zustand und löst weder CLEAR noch RESUME aus.

Gerätebindungen lassen sich im vorbereiteten LIVE-Prozess nur nach Stop und erneuter Startup-Reconciliation ändern; betroffene HCUweb-Updates werden vollständig abgelehnt. Regelparameter, Prioritäten und Anzeigenamen bleiben aktualisierbar. Ownership-Konflikte werden durch einen Neustart oder Hostwechsel nicht verworfen. Fehler beim abschließenden Speichern bleiben als Diagnose-/Journalfehler sichtbar und ergeben beim CLI-Shutdown einen Fehlerstatus.

**Offene API-Semantik:** Die offizielle Dokumentation nennt einen 10-Minuten-Reset für `tcl`, definiert dessen Löschwert aber nicht eindeutig. Deshalb ist JSON-null-Clear im Control Client standardmäßig blockiert. `JSON_NULL_VERIFIED` ist ein ausdrücklich zu verifizierender Geräteprofil-Vertrag; CLI und HCUweb aktivieren ihn nicht. Vor dem ersten Canary muss die sichere Rücknahme geklärt sein. Ein vorhandener numerischer fremder Baseline-Wert kann über die typisierte Limit-Operation erhalten werden.

HCUweb zeigt Modus, tatsächliche Schreibfreigabe, Telemetriegesundheit, Engine/Actuator-Zustand, Ownership/Konflikte je Charger, eigenes `tcl`, eigene Pause, letzten bestätigten Write, Readback und Fehler. Das Journal behält maximal 50 Einträge und unterscheidet abstrakte Aktion, blockierten/versuchten/bestätigten Write, Konflikt, Readback-Abweichung und Fault. Sicherheitsparameter bleiben Infrastruktur-Defaults und sind keine zusätzliche HCUweb-Schreibfreigabe.

Die historischen Phase-4-Einzelheiten stehen in [docs/phase4-actuator-safety.md](docs/phase4-actuator-safety.md). **Keine echten go-e-Writes wurden während der Entwicklung durch Codex ausgeführt.** Diese Vorbereitung wurde anschließend zur vom Nutzer installierten und funktional geprüften 0.1.0-Referenz erweitert.

## Phase 5 – Installed HCU Plugin

Das Image startet `/app/dist/cli/hcu-installed.js`, liest ausschließlich die HCU-Mounts `/TOKEN`, `/CLIENTID` und `/SGTIN` und verbindet `wss://host.containers.internal:9001`. `/data/plugin-config.json`, `/data/actuator-state.json` und `/data/user-message-state.json` bleiben über Updates erhalten. Eine Zertifikatsausnahme ist auf diese lokale WSS-Verbindung begrenzt; globaler TLS-Bypass ist gesperrt.

Der private Seed `config.installed.json` enthält den aus vorhandener gültiger Konfiguration verifizierten Controller `192.168.0.89`, Garage/Links und deaktivierten Rechts. `liveControlEnabled=false` verhindert jede automatische Erstinstallationsaktion. HCUweb zeigt Schreibfähigkeit und operative Aktivierung getrennt. Bei Aktivierung werden Geräte und Ownership geprüft; vor Writes sind mindestens zehn Sekunden frische Telemetrie erforderlich. Die bestehende 30-Sekunden-Auslösung, Stromschritte und Prioritäten bleiben unverändert.

Ein sequenzieller Installed-Loop übernimmt Regelung und fälligen 300-Sekunden-Refresh. Deaktivierung stoppt neue Reduktionen und Refresh; eigene Einschränkungen werden nur bei sicherer Reserve oder ausdrücklichem Override kontrolliert zurückgenommen. Fehlendes Grid und unklare Ownership erlauben keine Freigabe. Stoppen des Plugins setzt Geräte nicht pauschal zurück.

Der Nutzer hat Set/Pause/Resume/Clear außerhalb des Plugins für Firmware **59.4** manuell bestätigt. Nur dieses Installed-Geräteprofil erhält `JSON_NULL_VERIFIED`; Firmware wird frisch gelesen, andere Versionen bleiben für Null-Clear gesperrt. Offene Fragen, Antworten und explizite Session bleiben persistent. Startup gleicht die pluginbezogene HCU-Liste ab; alte TEST-/stale Meldungen werden kontrolliert bereinigt. Ein bestätigter JA-Override überlebt Neustart und normale Konfigurationsänderungen.

```powershell
npm run package:hcu
```

Der Befehl prüft Tests/Typen/Build, baut `linux/arm64`, prüft Metadata, Architektur und Secrets, führt einen Container-Smoke ausschließlich mit Mocks und `--network none` aus und erzeugt unter `dist-package/` ein Docker-save-Archiv plus SHA-256. Docker Desktop mit laufender Linux-Engine ist Voraussetzung. [Exakte Installation, Aktivierungscheckliste und Emergency-Verhalten](docs/phase5-installed-plugin.md).

Der Referenz-Build von Version 0.1.0, seine 1.429 bestandenen Tests, Paketgröße und Prüfsumme stehen im historischen [Phase-5-Abschlussbericht](docs/phase5-completion-report.md).

## Version 0.2.0 – HmIP-Messgeräte

Discovery bietet `controller-grid` (GRID_CONNECTION_POINT), `controller-home` (ENERGY_METER), `controller-solar` (INVERTER) und für jeden aktivierten Charger mit gültigem Host `charger-<id>` (EV_CHARGER). Aktuell sind Garage und Links dabei, Rechts bleibt ausgeschlossen. Alle Geräte besitzen CurrentPower und Maintenance. Temporäres Offline entfernt keine Definition; Name oder IP verändern keine Device-ID.

Grid bleibt signiert; Home wird direkt angezeigt; Solar wird negiert. Charger-Leistung kommt ausschließlich aus `nrg[11]`. Die Domäne bewahrt Float-Präzision, während die HmIP-Anzeige ganze Watt verwendet. Fehlende Werte werden protokollkonform weggelassen und niemals als 0 erfunden. Das Feature und tatsächliche Reachability bleiben getrennt.

Inclusion ersetzt den aktuellen Included-Set-Snapshot, Exclusion beendet ausschließlich logische Publikation. StatusRequests werden mit derselben Message-ID beantwortet. Laufende StatusEvents enthalten nur geänderte Features; nach Reconnect wartet die Projektion auf frische Inclusion. Sensor-ControlRequests werden mit `success=false` abgelehnt. Config, Ownership und Nachrichtensession aus 0.1.0 bleiben kompatibel; neue Geräte-Persistenz ist nicht nötig.

`npm run package:hcu` erzeugt das 0.2.0-ARM64-Paket neben vorhandenen 0.1.0-Archiven. Update zunächst mit erhaltenem `/data` prüfen. Die Verfügbarkeit von CurrentPower im Smartphone-Automationseditor und tatsächliche OS-Push-Zustellung müssen separat real abgenommen werden; die Erweiterung garantiert beides nicht. [Vollständiger Gerätevertrag und Abnahmeplan](docs/phase6-hmip-plugin-devices.md).

Der [technische 0.2.0-Abschlussbericht](docs/version-0.2.0-completion-report.md) enthält die 1.585 bestandenen Tests, tatsächliche ARM64-Image-ID, Archiv-Prüfsumme, Dateiliste und den Git-/Safety-Audit.

## Offene Punkte vor der ersten manuellen Aktivierung

- Der Nutzer hat den realen Phase-1-Test bestätigt: Controller/Grid sowie Garage und Links erreichbar, Rechts deaktiviert; Garage `car=2 / charging`, Links `car=1 / idle`. Die private Installed-Seed-Konfiguration übernimmt den bestätigten Controller-Host; die Engine selbst kontaktiert keine Geräte.
- Die gelieferten Beispielantworten enthalten nicht alle abgefragten Felder; fehlende `fwv`, `ama` und `nrg` bleiben ausdrücklich `null`, anstatt Werte aus anderen Fixtures zu übernehmen.
- Gültiges `rawNrg` bleibt vollständig erhalten. 0.2.0 nutzt ausschließlich die festgelegte Quelle `nrg[11]` für gemessene Watt; andere Indizes, EnergyCounter und Schätzwerte werden nicht neu interpretiert. Anzeige während realem Laden und Drosseln bleibt ein Abnahmepunkt.
- `frc` und `modelStatus` bleiben Rohcodes. Die Simulation bildet die vom Nutzer bestätigte Pause-/Resume-Sequenz nach; eine reale Session-End-Erkennung ist weiterhin offen. `car=4` darf dafür nicht allein verwendet werden.
- Actuator-Readback und Ownership sind gemockt getestet. Der Nutzer hat die Clear-Semantik für Firmware 59.4 manuell bestätigt; die Wirkung des installierten Plugins und der Session-Lifecycle benötigen weiterhin einen ausdrücklich gestarteten Hardwaretest. Eine Dry-Run-Quittierung beweist keine reale Gerätewirkung.
- Die konservative Recovery-Schwelle und das gemeinsame Lastverhalten mehrerer Charger müssen später real geprüft werden. Es gibt keine aus `nrg` abgeleitete Leistungsprognose für Stromerhöhung oder Wiederanlauf.
- HCU-Verbindung, HCUweb, Persistenz und Meldungen gehören zur vom Nutzer funktional geprüften Installed-0.1.0-Basis. Neue HmIP-Devices, Maintenance und der Automationseditor sind für 0.2.0 noch real zu prüfen; eine OS-Push-Garantie besteht nicht.
- Connect API 1.0.1 nennt für User-Message-Zeitstempel keine explizite Einheit; der Runtime-Adapter liefert Unix-Millisekunden. `ListUserMessages` wird nach der Feldtabelle als `Map<String, Long>` verarbeitet, obwohl das Dokumentationsbeispiel einen String zeigt. Beides ist beim Live-Test zu bestätigen.
- Installed-Frage-/Antwort-IDs und Override sind unter `/data` persistent und werden mit der HCU abgeglichen. Das begrenzte Action-Journal bleibt im Speicher; alte Simulationssessions werden nicht wiederhergestellt.

Die erste HCU-Installation und bewusste Aktivierung führt der Nutzer selbst durch. Dabei bleiben LAN-Erreichbarkeit, HCU-Mount-Konventionen, tatsächliche Gerätewirkung und gemeinsame Recovery mehrerer Charger zu prüfen. Ein Hardware-Canary wird durch Build oder Tests nicht automatisch gestartet.
