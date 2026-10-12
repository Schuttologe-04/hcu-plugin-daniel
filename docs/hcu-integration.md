# HCU Connect API – Phase 3 Dry-Run und Phase 4 Actuator-Vorbereitung

Die technische Grundlage ist die vom Nutzer bereitgestellte **Homematic IP Connect API 1.0.1** (`connect-api-documentation-1.0.1.html`). Nachrichten, Feldnamen und Enum-Werte stammen aus dieser Version. Die Dokumentation ist eine Protokollquelle; ihre Container-, Geräteexpositions- und Token-Beispiele sind keine automatisch auszuführenden Arbeitsschritte.

**Phase 3 calculates and records control actions but does not execute them against real go-e devices.** Die bisherigen DEV-/Dry-Run-Kommandos bleiben auf `GET /api/status` beschränkt. Phase 4 ergänzt einen getrennten, doppelt gesperrten Actuator für `tcl`/`frc`. Der vorbereitete LIVE-Modus startet keine automatische Geräteaktion. [Phase-4-Sicherheitsvertrag](phase4-actuator-safety.md).

## Architektur

| Komponente | Verantwortung |
| --- | --- |
| `HcuEnvironment` | Credentials und Datenverzeichnis unabhängig von der fachlichen Konfiguration auflösen |
| `RemoteDevelopmentEnvironment` | lokal explizit konfigurierte WSS-Verbindung und Umgebungsvariablen |
| `InstalledHcuEnvironment` | liest HCU-Mounts `/TOKEN`, `/CLIENTID`, `/SGTIN`; Installed-Einstieg verwendet `/data` |
| `HcuWebSocketClient` | Authentifizierung, Verbindung, JSON-Validierung, Korrelation, Timeout und Reconnect |
| `PluginStateService` | dokumentiertes `PLUGIN_STATE_REQUEST`/`PLUGIN_STATE_RESPONSE` mit `READY` |
| `HcuConfigService` | HCUweb-Template, vollständige Validierung und atomare Updates |
| `ConfigStore` | ausschließlich validierte fachliche Konfiguration persistent speichern |
| `HcuUserMessageService` | dokumentiertes Create/Delete/List für eigene Plugin-App-Meldungen |
| `OverrideInteractionCoordinator` | eine TEST-Frage je expliziter Session, ID-Zuordnung und Bereinigung |
| `DryRunRuntime` | echte read-only Messungen, simulierte Einschränkungen, Engine und Diagnosesnapshot |
| `ActionJournal` | begrenzte In-Memory-Historie abstrakter Aktionen ohne rohe Netzwerkantworten |
| `LiveRuntime` | explizite Messentscheidung und Ausführung mit frischer Grid-Prüfung; kein automatischer LIVE-Loop |
| `ChargerActuator` | persistierte Baseline, Pre-Write-Checks, Readback und konservative Ownership |
| `FileOwnershipStore` | atomarer, gesonderter Zustand in `actuator-state.json`, ohne Credentials |

Die Engine bleibt ohne HCU-, HTTP-, Logging- oder Dateisystemabhängigkeit. Im Dry-Run werden ihre Aktionen nur in einem eigenen In-Memory-Chargermodell quittiert. Die echten Gerätesnapshots bleiben für Diagnose getrennt erhalten; tatsächliche Ladeleistung und Grid-Reaktionen werden daraus nicht erfunden.

## Transport und Plugin-State

Remote-Verbindung: `wss://hcu1-XXXX.local:9001`. Die Header heißen gemäß Connect API `authtoken` und `plugin-id`. Die verbindliche Projektidentität und zentrale Standard-ID ist `com.psd.hcu.goe.loadmanagement`, definiert in `src/hcu/plugin-identity.ts`. Der WebSocket-Header `plugin-id` und der dafür bestätigte Token müssen zu dieser Identität gehören. Homematic-IP-Systemevents werden nicht abonniert, da sie hier nicht benötigt werden.

Ein `PluginMessage` enthält `id`, `pluginId`, `type` und optional `body`. Die eigene Request-ID identifiziert die zugehörige Response; Antworten auf HCU-Requests verwenden deren ID. Eingehende Daten werden erst als `unknown` behandelt und dann nach Nachrichtentyp validiert. Unbekannte zukünftige Types werden ignoriert. Malformed JSON erzeugt einen sicheren Fehler ohne vollständige Payload- oder Token-Logs.

```text
HCU -> PLUGIN_STATE_REQUEST (id=A)
Plugin -> PLUGIN_STATE_RESPONSE (id=A, pluginReadinessStatus=READY)
```

Die Transportzustände sind `DISCONNECTED`, `CONNECTING`, `CONNECTED`, `READY`, `RECONNECTING` und `STOPPED`. Verbindungsverlust beendet offene Requests mit einem sicheren Fehler. Reconnect verwendet exponentiellen Backoff mit begrenzter Wartezeit und begrenzten Versuchen; Shutdown löscht Timer und offene Requests. Nach Wiederverbindung werden die Authentifizierungsheader erneut gesendet. Token und native WebSocket-Fehlertexte werden nicht ausgegeben.

## Credentials und TLS

| Variable | Zweck |
| --- | --- |
| `HCU_WS_URL` | konkrete WSS-Adresse der HCU |
| `HCU_AUTHTOKEN` | manuell eingerichteter und bestätigter Connect-API-Token |
| `HCU_PLUGIN_ID` | optional; Standard `com.psd.hcu.goe.loadmanagement`, bei Angabe ebenfalls diese ID verwenden |
| `HCU_ALLOW_SELF_SIGNED` | explizit `true` oder `false`; Standard `false` |
| `HCU_DATA_DIR` | optionales lokales Datenverzeichnis; Standard `./data` |
| `GOE_REAL_WRITES_ENABLED` | sichere Vorgabe `false`; nur exakt `true` erlaubt den zusätzlichen expliziten LIVE-Modus |

Die go-e-Freigabe wird ausschließlich außerhalb von HCUweb gesetzt. `hcu:dev`, `hcu:dry-run`, `hcu:test-message`, `probe` und `simulate` nutzen sie nicht für Geräte-Writes. Der LIVE-Modus benötigt außerdem seinen eigenen `executionMode=LIVE`; das Flag allein kann keinen bestehenden DEV-/Dry-Run-Prozess umschalten.

Die HCU verwendet ein selbstsigniertes Zertifikat. `HCU_ALLOW_SELF_SIGNED=true` betrifft ausschließlich diesen HCU-WebSocket; es verändert weder globale Node-TLS-Prüfung noch go-e-Zugriff. Es wird kein `NODE_TLS_REJECT_UNAUTHORIZED=0` gesetzt. Ein bereits lokal vertrauenswürdiges HCU-Zertifikat ermöglicht die normale TLS-Prüfung.

Lokale `.env`-Dateien und `data/` sind ignoriert; `.env.example` enthält nur Platzhalter. Credentials werden weder in `AppConfig` noch in HCUweb-Templates oder `plugin-config.json` übernommen. Die HCU-npm-Startkommandos laden eine vorhandene lokale `.env` mit der nativen Node.js-Option `--env-file-if-exists=.env`; es gibt keine zusätzliche Dotenv-Abhängigkeit. Bereits gesetzte Prozessvariablen haben Vorrang.

**Identitätsmigration:** Ein bereits für die frühere Plugin-ID erzeugter Connect-API-Client und dessen `authToken` beziehungsweise `clientId` dürfen nicht für `com.psd.hcu.goe.loadmanagement` weiterverwendet werden. Ein neuer Connect-API-Client benötigt einen neuen Aktivierungskey und einen neuen, manuell angeforderten und bestätigten Token. Alte Tokens und Client-IDs werden nicht übernommen. Die Software führt weiterhin keine automatische Registrierung durch.

## HCUweb und Persistenz

```text
HCU -> CONFIG_TEMPLATE_REQUEST (id=B, languageCode=de)
Plugin -> CONFIG_TEMPLATE_RESPONSE (id=B, groups + properties)

HCU -> CONFIG_UPDATE_REQUEST (id=C, properties)
Plugin: Kopie -> komplette AppConfig-Validierung -> atomar speichern -> Runtime übernehmen
Plugin -> CONFIG_UPDATE_RESPONSE (id=C, status=APPLIED)
```

Connect API `PropertyTemplate.currentValue` und die Update-Properties sind Strings, auch bei `BOOLEAN`, `INTEGER` und `NUMBER`. HCUweb-Werte werden an der Grenze in die vorhandene fachliche Konfiguration übertragen. Ungültige, unbekannte oder schreibgeschützte Properties verwerfen das gesamte Update; die alte gültige Konfiguration bleibt bestehen. Die Response verwendet ausschließlich die dokumentierten Statuswerte und sichere verständliche Fehlertexte. Für diese lokalen Updates wird kein unnötiges `PENDING` gesendet.

Die Gruppen sind `controller`, `loadManagement`, `chargerGarage`, `chargerLinks`, `chargerRechts`, `notifications` und `diagnostics`. Diagnosefelder projizieren ausschließlich den letzten Runtime-Snapshot und lösen keine synchrone Geräteabfrage aus. Ein fehlender Messwert erscheint als `unavailable`. Regelziel und Recovery-Schwelle werden aus den validierten Parametern berechnet und nicht zusätzlich persistent gespeichert. BOOLEAN-Properties tragen kein `required`; `false` bleibt ein gültiger Checkboxwert. Die vollständige AppConfig-Validierung bei Updates bleibt verpflichtend.

Phase 4 ergänzt im vorhandenen Diagnosebereich: Ausführungsmodus, echte Schreibfreigabe, Controller-Telemetriegesundheit, Engine-/Actuator-Zustand, Ownership/Konflikt je Charger, eigenes `tcl` und eigene Pause, letzten bestätigten Write, Readback, letzten Actuator-Fehler sowie `FAULT`/`LIMIT_UNACHIEVABLE`. Diese Felder sind read-only. HCUweb kann weder das Sicherheitsflag noch die unbestätigte JSON-null-Clear-Capability aktivieren.

`FileConfigStore` schreibt eine temporäre Datei im selben Verzeichnis, synchronisiert und schließt sie und ersetzt dann `plugin-config.json` per Rename. Erst eine erfolgreiche Persistenz erlaubt die Übernahme. Beschädigte Persistenz ist ein ausdrücklicher Konfigurationsfehler, kein stiller gültiger Standard. Im Remote-Betrieb liegt die Datei unter `./data/plugin-config.json` oder dem gewählten `HCU_DATA_DIR`; der vorbereitete installierte Betrieb nutzt `/data/plugin-config.json`.

Ohne bereits gespeicherte Konfiguration validiert und speichert der erste CLI-Start die lokale `config.json` oder die mit `--config` gewählte Seed-Datei. Sobald `plugin-config.json` existiert, ist dieser persistierte Stand maßgeblich. Die Seed-Datei wird dann nicht erneut geladen. HCUweb dient für weitere Änderungen; ein anderer `HCU_DATA_DIR` ermöglicht einen getrennten Teststand ohne Veränderung des bisherigen Datenverzeichnisses.

## TEST-App-Meldung und YES/NO

Im vom Nutzer bestätigten Live-Test erschien die Meldung auf dem Home-Screen der Homematic-IP-App. Eine OS-Push-Benachrichtigung wurde nicht beobachtet. Alle Familienbenutzer konnten die Meldung sehen und beantworten; das ACK enthält keine Benutzeridentität. **JA eines beliebigen berechtigten Familienbenutzers aktiviert Override.** Create bietet keinen dokumentierten Empfängerfilter, und eine Owner-only-Funktion ist nicht vorhanden.

Die Benachrichtigungen sind standardmäßig ausgeschaltet. `notifications.interactive` ist standardmäßig `true`; ohne aktiviertes `notifications.intervention` wird trotzdem keine Frage gesendet. Auch bei eingeschalteter Benachrichtigung erzeugt ein normaler Programmstart keine TEST-Frage. Die erste relevante abstrakte Intervention im ausdrücklich gestarteten Dry-Run kann genau eine Frage erzeugen:

```text
CREATE_USER_MESSAGE_REQUEST
  userMessageId = injizierte eindeutige ID
  title.de = "TEST: go-e Lastmanagement"
  behaviorType = ACKNOWLEDGEABLE_BY_YES_NO
  messageCategory = WARN
  message.de = Dry-Run; keine Wallbox-Einstellungen verändert;
               JA = Simulations-Override; NEIN = Automatik fortsetzen

HCU -> CREATE_USER_MESSAGE_RESPONSE (gleiche Request-ID, success, userMessageId)
HCU -> USER_MESSAGE_ACK_EVENT (eigene Event-ID, userMessageId, ackType=YES/NO)
```

Nur die passende noch offene `userMessageId` wird akzeptiert. Der Coordinator markiert die Antwort vor asynchroner Bereinigung als erledigt, damit doppelte oder widersprüchliche ACKs die Engine nicht zweimal verändern. `YES` ruft die vorhandene Engine-Override-Schnittstelle auf; im Dry-Run bleiben deren `RESUME`/`CLEAR_TEMPORARY_CURRENT_LIMIT` simuliert. Der vorbereitete LIVE-Pfad darf ausschließlich belegbare eigene Einschränkungen zurücknehmen und führt auch ein Override nicht automatisch als Write aus. `NO`, keine Antwort oder HCU-Ausfall aktivieren kein Override. Anschließend entfernt `DELETE_USER_MESSAGE_REQUEST` die Frage. Bei Löschfehler bleibt eine Bereinigung für den nächsten Reconnect vorgemerkt.

Weitere Reduktionsschritte erzeugen keine neuen Fragen derselben Session. Ein explizites `endSession()`-Domänenereignis beendet die Session und ermöglicht eine neue eindeutige Frage. Es gibt keine automatische reale Session-End-Erkennung; insbesondere ist `car=4` dafür kein hinreichender Beleg.

## Reconnect und Protokollunsicherheiten

Nach Reconnect wird eine intern bekannte Frage mit `LIST_USER_MESSAGES_REQUEST` abgeglichen. Ist die ID bereits vorhanden, wird keine neue Meldung erstellt. Fehlt sie, wird dieselbe ID wiederverwendet: Connect API 1.0.1 §6.3.4 dokumentiert, dass Create mit identischer ID eine bestehende App-Meldung ersetzt. Dadurch wird auch ein verlorener Create-Response nach tatsächlicher HCU-Annahme sicher behandelt. Antworten auf alte oder unbekannte IDs ändern die Engine nicht.

Zwei Dokumentationspunkte bleiben ausdrücklich sichtbar:

- §6.4.12 beschreibt `userMessageMap` in der Feldtabelle als `Map<String, Long>`, während das JSON-Beispiel einen einzelnen String zeigt. Die Implementierung folgt der Feldtabelle und validiert eine Map von IDs zu ganzzahligen Zeitstempeln. Die tatsächliche Firmwareantwort muss beim Live-Test bestätigt werden.
- `CreateUserMessageRequest.timestamp` ist als `long` dokumentiert; eine Zeiteinheit wird dort nicht ausdrücklich genannt. Die CLI liefert Unix-Millisekunden aus ihrer injizierten Uhr. Einheit und Anzeige der App müssen live bestätigt werden. Die Service-Logik erhält Zeit und IDs von außen und erzeugt keine versteckten Echtzeit- oder Zufallswerte.

Im DEV-/Dry-Run-Modus bleiben Frage-/Antwort-IDs und Action-Journal im aktuellen Prozess. Im Installed-Modus werden Session, Frage-ID und bestätigte Antworten in `/data/user-message-state.json` gespeichert. Startup gleicht ausschließlich die authentifizierte pluginbezogene HCU-Liste ab und erhält die bekannte aktive Frage. Beantwortete/stale Meldungen und ältere pluginbezogene Orphans werden bereinigt; Cleanup wird begrenzt erneut versucht. Ein gespeichertes produktives JA wirkt auch nach Neustart, ein alter TEST-JA niemals. Phase-4-Ownership bleibt gesondert persistent: Unklare Writes werden nicht durch ein zufällig passendes Statusbild nachträglich zu sicherer Ownership erklärt.

## Erster manueller HCU-Test

Diese Schritte werden **nicht automatisch ausgeführt**. Der Nutzer entscheidet über Developer Mode, Token und tatsächlichen TEST-Versand.

1. In HCUweb (`https://hcu1-XXXX.local`) Developer Mode aktivieren und den Connect-API-WebSocket im LAN freigeben. `XXXX` bezeichnet die letzten vier SGTIN-Ziffern. Laut Dokumentation kann Developer Mode nach Erstellung eines Connect-API-Clients nicht mehr deaktiviert werden.
2. In HCUweb einen neuen Aktivierungskey für den neuen Connect-API-Client erzeugen. Dieser ist zeitlich begrenzt und nur einmal verwendbar; ein Client der früheren Identität wird nicht wiederverwendet.
3. Mit einem lokalen API-Werkzeug, etwa Postman, manuell `POST https://hcu1-XXXX.local:6969/hmip/auth/requestConnectApiAuthToken` mit Header `VERSION: 12` senden. Body gemäß §2.4: der neue `activationKey`, `pluginId: "com.psd.hcu.goe.loadmanagement"` und `friendlyName` als Sprachmap mit deutschem Eintrag.
4. Den neu erhaltenen `authToken` gemäß §2.4 manuell mit `POST https://hcu1-XXXX.local:6969/hmip/auth/confirmConnectApiAuthToken`, ebenfalls `VERSION: 12`, bestätigen. Body: der neue `activationKey` und `authToken`. Erst danach ist der neue Token gültig. Die Software implementiert keinen dieser POST-Schritte.
5. URL, den neuen bestätigten Token und gegebenenfalls die explizite lokale Self-Signed-Option sicher in der Startumgebung setzen. `HCU_PLUGIN_ID` kann entfallen, weil der zentrale Standard verwendet wird; bei expliziter Angabe `com.psd.hcu.goe.loadmanagement` setzen. Keinen alten Token und keine alte `clientId` übernehmen. Eine gültige lokale `config.json` mit echter Controller-Adresse vorbereiten.
6. `npm run hcu:dev` starten. In HCUweb `READY`, die sieben Konfigurationsgruppen sowie atomare gültige/ungültige Updates prüfen. Dieses Kommando startet keinen kontinuierlichen go-e-Regellauf und sendet keine TEST-Frage.
7. Nur wenn ein tatsächlicher App-Test beabsichtigt ist, `npm run hcu:test-message` separat starten. Der Prozess wartet auf eine Antwort oder `Ctrl+C`; dieses Kommando führt keine Engine aus. Die TEST-Frage auf Smartphone und gegebenenfalls bei Familienbenutzern prüfen, zunächst `NEIN` wählen. Der bestätigte bisherige Test ergab Sichtbarkeit und Antwortmöglichkeit für alle Familienbenutzer, ohne OS-Push.
8. Für den Live-Dry-Run den vorherigen Prozess beenden und `npm run hcu:dry-run` starten. Erst dort erfolgen read-only go-e-Polling und Engine-Simulation. Für die Frage zusätzlich in HCUweb Eingriffsbenachrichtigung und interaktive Abfrage aktivieren. `JA` beeinflusst nur die Simulation.
9. HCUweb-Diagnose, abstrakte Action-Historie und `Real charger writes: disabled` prüfen. Eine HCU-Verbindungsunterbrechung und Wiederverbindung darf keine zweite identische offene Frage erzeugen. Controller-Ausfall muss zu `FAULT` ohne Recovery-Freigabe führen.

Der aus Phase 1 bekannte Testfall mit Grid 22.839 W, Garage charging bei 14 A, Links idle und Rechts disabled bleibt bis 29,999 s ohne Aktion. Ab 30 s entsteht abstrakt `SET_TEMPORARY_CURRENT_LIMIT garage 13 A`; eine echte Wallboxänderung wird nicht vorgenommen. Die Tests modellieren diesen Verlauf samt genau einer optionalen TEST-Frage.

## Phase 4 – vorbereiteter LIVE-Pfad

```powershell
npm run hcu:live
```

Ohne `GOE_REAL_WRITES_ENABLED=true` muss dieser Start geschlossen fehlschlagen. Mit Flag verbindet sich die Anwendung vorbereitet mit der HCU und reconciliiert den gespeicherten Actuator-Zustand anhand echter Statuslesungen. Es wird **kein automatischer Lastmanagement-, Refresh- oder Canary-Timer** gestartet. `observe()` liefert eine abstrakte Entscheidung; `executePendingAction(actionId)` ist eine zusätzliche explizite Operation mit erneuter Grid-Prüfung und frischem Charger-Precheck. Ein bloßer Start, eine Konfigurationsänderung oder ein HCU-ACK dürfen keinen ersten Write auslösen.

Die LIVE-Runtime bleibt von der Dry-Run-Runtime getrennt. Vor einem Eingriff werden Baseline und erwarteter Write atomar gespeichert. Nach der Übertragung ist ein neuer, passender Readback erforderlich. Persistierte `UNKNOWN`-/`CONFLICT`-Zustände sperren Freigaben. Normaler Shutdown persistiert Ownership und hebt Restriktionen nicht auf. Bei Grid-Fault gilt keine Recovery; nach Start oder Fault verlangt die Runtime mindestens 10 Sekunden kontinuierlich gültige Telemetrie. Ein HCU-Verbindungsverlust allein macht lokale Grid-Daten nicht ungültig; aus einer unbeantworteten Frage entsteht kein Override.

Das Journal enthält höchstens 50 Einträge und unterscheidet abstrakte Aktion, Write-Blockade, Write-Versuch, Bestätigung, Readback-Abweichung, Ownership-Konflikt und Fault. Ereignisse und HCUweb-Diagnose speichern keine Tokens, `clientId`, Aktivierungskeys oder Rohantworten. Die HCU-Verbindung führt weiterhin keine automatische Client-Registrierung durch.

Im Remote-Phase-4-Pfad bleibt JSON-null-Clear ohne ausdrücklich verifiziertes Profil gesperrt: Ein vorhandenes `tcl=null` öffnet keine Freigabe. Der geplante Garage-Test setzt einen Schritt von beispielsweise 14 auf 13 A, liest zurück und stellt die vorherige Baseline über einen verifizierten Rücknahmeweg wieder her. Phase 5 nutzt dafür ausschließlich das vom Nutzer manuell bestätigte Firmware-59.4-Profil. [Voraussetzungen, Ablauf und Grenzen](phase4-actuator-safety.md).

## Noch offen vor Hardwaresteuerung

- Neue Phase-4-Diagnosefelder auf der realen HCU prüfen; Verbindung, HCUweb, persistente Updates und Meldungen wurden vom Nutzer bereits live bestätigt.
- Timestamp-Einheit und die tatsächliche `ListUserMessages`-Map verifizieren.
- Sichere `tcl`-Clear-Semantik, Hardware-Readback, Ownership bei realen externen Änderungen und Session-Lifecycle gesondert absichern.
- Eine echte Leistungswirkung der simulierten Ampere-Schritte wird nicht prognostiziert; reale Grid-Werte werden weiter gelesen.

Es werden keine virtuellen HCU-Geräte exponiert. Während der Implementierung wurden keine realen Charger-Writes und kein Canary ausgeführt. Der Nutzer hat die lokale go-e-Sequenz außerhalb des Plugins manuell validiert; der neue Installed-Regelbetrieb muss durch ihn selbst auf Hardware geprüft werden.

## Phase 5 – Installation

Das separate Installed-Image startet ohne Remote-Entwicklungsclient. HCU stellt `/TOKEN`, `/CLIENTID`, `/SGTIN` und `/data` bereit. Verbindung: `wss://host.containers.internal:9001`, ausschließlich lokale verbindungsspezifische Zertifikatsausnahme; keine `.env` und keine Remote-Credentials im Image. Der feste Container-Gate und HCUweb-`liveControlEnabled` sind getrennt. Erstinstallation startet Telemetrie und HCUweb bei ausgeschalteter realer Regelung.

Der vorhandene Actuator schützt alle autonomen Aktionen mit frischem Precheck, persistierter Absicht und Readback. Aktivierung und Neustart benötigen stabile Telemetrie; normale HCUweb-Änderungen beenden keine Nachrichtensession. Der Installed-Profilpfad erlaubt Null-Clear nur bei frisch bestätigter Firmware 59.4. [Packaging, Upload, Erstprüfung und bewusste Aktivierung](phase5-installed-plugin.md).
