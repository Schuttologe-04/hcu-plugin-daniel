# Version 0.2.0 – Homematic-IP-Messgeräte

Diese Version ist technisch vorbereitet und noch nicht auf der realen HCU/App abgenommen. Die vom Nutzer bereits installierte und funktional geprüfte Version 0.1.0 bleibt die Referenz für Lastmanagement und Safety. Plugin-ID `com.psd.hcu.goe.loadmanagement`, Issuer PSD, HCU mindestens 1.4.7 und Scope LOCAL bleiben unverändert.

## Architektur und Datenquellen

Der vorhandene Installed-Poll liefert weiterhin genau einen validierten Controller-/Charger-Snapshot. Die Engine verwendet ihn wie bisher. Der bereits vorhandene Abschluss-Hook informiert zusätzlich `PluginDeviceService`; die Geräteprojektion besitzt weder einen eigenen Poll noch einen Timer. Sie importiert keinen LoadManager, Actuator oder go-e Control Client. Entfernen oder ein Fehler der Projektion verändert keine Regelentscheidung.

Die vier kleinen Module unter `src/hcu/devices/` trennen wire types, Registry, reine Datenprojektion und Inclusion/Publikation. Der bestehende HCU-WebSocket, Decoder und Dispatcher werden weiterverwendet. Es gibt keine zweite Verbindung, neue Dependency oder neue HCUweb-Einstellung.

| Stabile Device-ID | Friendly Name | DeviceType | Quelle für CurrentPower |
|---|---|---|---|
| `controller-grid` | go-e Netz | GRID_CONNECTION_POINT | Originaler signierter Grid-Wert |
| `controller-home` | go-e Hausverbrauch | ENERGY_METER | Originaler Home-Wert |
| `controller-solar` | go-e Solar | INVERTER | Negation des originalen Solar-Werts |
| `charger-garage` | Konfigurierter Garage-Name | EV_CHARGER | `currentPowerW` ausschließlich aus `nrg[11]` |
| `charger-links` | Konfigurierter Links-Name | EV_CHARGER | Ebenso `nrg[11]` |
| `charger-rechts` | Konfigurierter Rechts-Name | EV_CHARGER | Ebenso, nur wenn enabled und Host gültig |

Alle Geräte verwenden ausschließlich CurrentPower und Maintenance. Die wire-Tags lauten `currentPower` und `maintenance`. Controller-Geräte sind immer definiert; Charger ergeben sich aus der vorhandenen Konfiguration. Temporäre Nichterreichbarkeit entfernt keine Definition. Rechts ist aktuell deaktiviert und daher nicht discoverable. Kein Akku, EnergyCounter, Custom-Kanal, Phasen- oder künstliches Ladezustandsfeature wird exponiert.

Die IDs sind feste logische Controller-IDs und `charger-` plus bestehende Charger-ID. Sie enthalten keine IP, Firmware, Zeit oder Prozess-Zufallskennung. Host- und Friendly-Name-Änderungen erhalten die Identität. Der Device-Friendly-Name ist gemäß Connect API ein String; nur Plugin-/Nachrichtentexte verwenden Sprachmaps. Firmware wird nur aus tatsächlich vorliegender Charger-Telemetrie ausgegeben; kein Controller-Firmwarewert oder modelType wird erfunden.

## Messwertsemantik

Grid, Home und Solar werden anhand der exakten Kanalnamen in `ccn` gefunden; derselbe Index wird aus `ccp` gelesen. Grid bleibt sicherheitskritisch: fehlende, ungültige oder mehrdeutige Grid-Messungen ergeben weiterhin einen Fehler. Home/Solar sind Zusatzmessungen; deren fehlende oder ungültige Werte werden `null`, ohne gültiges Grid zu invalidieren. Der Filter `ccn,ccp,cpc` bleibt unverändert.

Die Domäne bewahrt Vorzeichen und Float-Präzision. Nur die HmIP-Anzeige rundet mit `Math.round` auf ganze Watt; negatives Rundungs-Null wird als normale Null serialisiert. Grid wird weder auf positiven Netzbezug geclamped noch absolutiert. Solar wird ausschließlich negiert: -5000 → +5000, +500 → -500, 0 → 0. Kein `Math.abs`.

`currentPowerW` eines Chargers kommt allein aus dem endlichen Zahlenwert an `nrg[11]`. Fehlendes/kürzeres Array, null, String, NaN oder ±Infinity liefern keine Leistung. Ampere, Limits, Spannungen, andere Phasenwerte und Car-State sind keine Fallbacks. Vollständig gültige `rawNrg`-Arrays bleiben als unabhängige unveränderte Kopie erhalten; malformed Roharrays sind ausdrücklich unavailable. Die essenziellen Charger-Felder werden weiterhin streng validiert.

Ein echter Messwert 0 ergibt 0 W. Ein fehlender Wert ergibt nie eine erfundene Null. Connect API 1.0.1 §6.7.9 definiert `CurrentPower.currentPower` als **optionales Double**. Discovery und vollständiger Status enthalten daher bei fehlender Messung `{ "type": "currentPower" }` ohne Wert. Es werden weder null noch NaN übertragen.

Maintenance.unreach ist gemäß §6.7.16 ein optionales Boolean. ConnectionError/TimeoutError bedeuten `true`. Empfangene, aber ungültige JSON-/Messdaten (InvalidResponseError/MissingMeasurementError) bedeuten keine physische Nichterreichbarkeit und werden als `false` projiziert. Vor der ersten Beobachtung, nach einem Hostwechsel ohne frischen Snapshot oder bei einem Konfigurationsfehler bleibt `unreach` unbekannt und wird weggelassen. Eine erreichbare Wallbox mit fehlendem `nrg[11]` bleibt erreichbar.

Der bestehende Result-Typ verwirft bei ungültigem Grid den erfolgreichen Controller-Domänensnapshot. Dann sind auch Home/Solar in diesem Snapshot nicht verfügbar; die Projektion erfindet sie nicht und fragt nicht erneut ab. Der HmIP-Cache wird niemals als Eingang der Engine benutzt.

## Connect-API-Lifecycle

Quelle ist die bereitgestellte Connect API 1.0.1, insbesondere §6.3.3/6.3.6/6.3.10/6.3.11, §6.4.3/6.4.8/6.4.11/6.4.14 und §6.5.1. Eingehende Nachrichten werden weiterhin als unknown geparst und im vorhandenen Codec validiert. Device-ID-Listen sind begrenzt und dedupliziert, unbekannte IDs werden nicht in den Cache aufgenommen. Unbekannte zukünftige Nachrichtentypen bleiben robust ignorierbar.

| Nachricht | Verhalten |
|---|---|
| DISCOVER_REQUEST | DISCOVER_RESPONSE mit Erfolg und aktuell konfigurierten Definitionen, auch offline. Gleiche Request-ID. |
| INCLUSION_EVENT | `body.deviceIds` ersetzt den gesamten Included-Set-Snapshot. Unbekannte IDs werden ignoriert. Anschließend vollständiger STATUS_RESPONSE für bekannte inkludierte Geräte mit neuer proaktiver Message-ID. |
| EXCLUSION_EVENT | IDs aus Included-Set und Publikationscache entfernen; keine weiteren unsolicited Zustände für diese IDs. Kein Eingriff in physische Geräte oder Konfiguration. |
| STATUS_REQUEST | Ohne deviceIds alle aktuell bekannten konfigurierten Geräte; mit Liste nur bekannte angeforderte Geräte. Leere/unknown-only Liste ergibt leere erfolgreiche Antwort. Gleiche Request-ID. |
| STATUS_RESPONSE | Vollständige bekannte Devices mit CurrentPower/Maintenance; fehlende optionale Werte werden weggelassen. |
| STATUS_EVENT | Partielle Features für genau ein inkludiertes Gerät; nur Änderungen gegenüber zuletzt erfolgreich publizierten Werten. Neue Event-ID. |
| CONTROL_REQUEST | Validierte Sensor-Anfrage wird mit CONTROL_RESPONSE `success=false` und gleicher Request-ID abgelehnt; READ_ONLY_DEVICE bzw. UNKNOWN_DEVICE. Keine Steuerung. |

Nach Disconnect, Prozessstart oder Reconnect ist Inclusion unbekannt. Bis zu einem frischen INCLUSION_EVENT werden keine unsolicited Events gesendet. Explizite Requests bleiben beantwortbar. READY nach CONNECTED verwirft eine bereits bekannte Inclusion nicht erneut. Inclusion wird nicht separat persistiert, da die HCU ihren aktuellen Set-Snapshot liefert.

Der Cache ist durch bekannte konfigurierte Identitäten begrenzt. Es gibt keine Warteschlange, Historie, Datenbank oder Publish-Timer. HCU-Sends warten keine Response ab; Fehlschläge werden separat sanitisiert diagnostiziert. Ein fehlgeschlagener Send markiert den neuen Wert nicht als zugestellt. Der nächste vorhandene Snapshot kann ihn erneut versuchen; Fehler eines Devices blockieren andere Devices nicht.

Bei Offline wird nur Maintenance geändert; kein künstlicher 0-W-Power-Event überschreibt den zuletzt angezeigten Wert. Wenn eine gültige Messung mit geänderter Leistung wiederkehrt, werden CurrentPower und unreach=false im selben Event übertragen. Fehlende Leistungsdaten eines erreichbaren Geräts senden ebenfalls keinen Power-Ersatzwert. Ein vollständiger angeforderter Status zeigt nur aktuell verfügbare Messwerte.

## Unveränderte Safety und Update-Kompatibilität

Der bestehende kontrollierte `/api/set`-Pfad bleibt der einzige physische Write-Pfad und schreibt ausschließlich `tcl`/`frc`. Kein `amp`-/`loe`-Write. Firmware-59.4-Clear, Ownership, Precheck, Write-Intent, Readback, Trigger, Prioritäten, Round Robin, Override und TelemetryHealthGuard werden durch diese Erweiterung nicht verändert.

Geräteprojektion arbeitet unabhängig von `liveControlEnabled`: Sensoren werden auch bei ausgeschalteter realer Regelung angeboten. First-install Seed und Config-Schema bleiben unverändert. `/data/plugin-config.json`, `/data/actuator-state.json` und `/data/user-message-state.json` werden unverändert geladen; keine neue Geräte-Persistenz oder Migration. Nachrichtensession und JA/NEIN-Semantik bleiben erhalten. 0 W und `car=4` lösen kein Session-Ende und kein Aufheben des Override aus.

## Prüfung und Packaging

```powershell
npm test
npm run typecheck
npm run build
npm run simulate
npm run package:hcu
```

Tests bleiben vollständig offline. Die neuen Tests prüfen Mapping, Messwertgrenzen, stabile IDs, Discovery, Inclusion/Exclusion, Response-Korrelation, Status-Deduplizierung, Reachability, Wiederkehr, Disconnect/Reconnect und read-only Controls. Runtime-Regressionsfälle vergleichen die gleiche Telemetrie mit aktiver bzw. ausfallender/entfernter Geräteprojektion. Der Update-Test lädt bestehende 0.1.0-Dateiformate ohne Reset und ohne Clear/Resume.

Der vorhandene Windows-PowerShell-Packagingpfad erzeugt das Linux/ARM64-Image und `dist-package/com.psd.hcu.goe.loadmanagement-0.2.0.tar.gz` sowie `.sha256`. Alte 0.1.0-Archive bleiben erhalten. Architektur, Installed-Entrypoint, Metadata, Production-Dependencies, fehlende Secrets und neue Sensorgeräte werden im Container mit `--network none` und MOCK-Mounts geprüft. Keine echte HCU- oder Wallbox-Verbindung und kein Upload durch Codex.

## Manuelle HCU-/App-Abnahme

1. SHA-256 prüfen, 0.2.0 in HCUweb installieren und bestehendes `/data` erhalten.
2. READY, Version, Config, Firmware/Clear-Capability, Ownership und bisherige Diagnosen prüfen. Keine unerwarteten Writes.
3. Discovery/Inclusion in HCU/App ausführen: Netz, Hausverbrauch, Solar, Garage und Links; Rechts nicht anbieten lassen.
4. Signierten Grid-/Home-Wert und invertierten Solar-Wert mit tatsächlicher Controller-Telemetrie vergleichen.
5. Garage/Links während natürlichem Laden mit tatsächlichem `nrg[11]` vergleichen. Bei natürlicher Drosselung die gemessene Leistungsänderung beobachten.
6. Falls sicher möglich, temporäre Nichterreichbarkeit und unreach=true/false prüfen; keine künstliche Überlast erzeugen.
7. Im Smartphone-Automationseditor prüfen, ob CurrentPower als numerische Bedingung angeboten wird. Das ist eine reale Plattform-Abnahmefrage, keine Garantie.
8. Ein tatsächliches OS-Push-Verhalten separat sicher prüfen; die Geräteintegration verspricht keine Push-Zustellung und implementiert keinen Ersatzwarnungsmechanismus.

Codex führt diese reale Abnahme nicht aus. Kein Commit, Push, Merge, Tag oder Release erfolgt automatisch; v0.2.0 wird erst nach bewusster Benutzerprüfung freigegeben.
