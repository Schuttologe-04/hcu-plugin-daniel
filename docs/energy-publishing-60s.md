# Version 0.2.2 – Zeitgewichtete HCU-Leistungswerte

Status: **Entwicklung, nicht veröffentlicht und noch nicht auf einer realen HCU abgenommen.** Plugin-ID `com.psd.hcu.goe.loadmanagement`, Issuer PSD, Scope LOCAL und HCU-Mindestversion 1.4.7 bleiben unverändert. Ein ARM64-Testpaket gehört in einen separaten Packaging-Auftrag.

## Anlass und gesicherte Beobachtungen

Der Nutzer beobachtete nach etwa 14 Tagen rund 1,8 Millionen Messdatensätze sowie Probleme bei App-Synchronisierung und Energieauswertungen. Ein kausaler Zusammenhang ist nicht nachgewiesen. Die alten Datensätze wurden laut Nutzer inzwischen manuell erfolgreich gelöscht. Diese Version enthält keine Datenbereinigung, Historienverwaltung oder Löschfunktion.

Die bisherige [Gerätepublikation](../src/hcu/devices/plugin-device-service.ts) erhielt den bestehenden schnellen Runtime-Snapshot und sendete jede Änderung eines auf ganze Watt gerundeten CurrentPower-Werts. Schon 1 W Unterschied konnte ein neues Ereignis erzeugen. Drei ständig schwankende Messreihen mit einer Änderung je zwei Sekunden entsprechen rechnerisch 1.814.400 Meldungen in 14 Tagen. Diese Rechnung erklärt eine plausible Größenordnung, beweist aber keine einzelne HCU-Historienquelle.

## Trennung von Messung und Veröffentlichung

Der [Installed-Scheduler](../src/orchestration/installed-runtime.ts) und [LiveRuntime](../src/orchestration/live-runtime.ts) liefern weiterhin ihre unveränderten schnellen Telemetrie-Snapshots. Der normale zwei Sekunden lange Geräteabstand folgt dem vorhandenen viersekündigen Frischebudget; das konfigurierte viersekündige Regelaktionsintervall ist ein anderer Vertrag. Die vorhandene Frischegrenze, Engine und Write-Prüfung werden nicht verändert.

Erst an der HCU-Gerätegrenze wird jede logische Messreihe getrennt aggregiert. Der reine [PowerWindowAggregator](../src/hcu/devices/power-window.ts) verarbeitet bestehende Beobachtungen; [PluginDeviceService](../src/hcu/devices/plugin-device-service.ts) begrenzt die Veröffentlichung. Es gibt keinen zweiten Poll, keinen neuen Timer, keine weitere Verbindung und keine zusätzliche HTTP-Abfrage. Ausschließlich neue Beobachtungen treiben den Fensterabschluss; HCU-Requests integrieren nichts, schließen kein Fenster und erneuern keine Messwertgültigkeit. Das Lastmanagement erhält niemals HCU-Mittelwerte als Eingang.

Der ursprüngliche [Gerätevertrag](phase6-hmip-plugin-devices.md), die [Registry](../src/hcu/devices/device-registry.ts), [Featuretypen](../src/hcu/devices/device-types.ts) und physikalischen Quellen bleiben erhalten:

| Gerät | ID / DeviceType | Wattquelle |
|---|---|---|
| Netz | `controller-grid` / GRID_CONNECTION_POINT | signierter Grid-Rohwert |
| Hausverbrauch | `controller-home` / ENERGY_METER | Home-Rohwert |
| Solar | `controller-solar` / INVERTER | negierter Solar-Rohwert |
| Aktiver Charger | `charger-<konfigurierte ID>` / EV_CHARGER | `currentPowerW` ausschließlich aus `nrg[11]` |

Damit bleiben die bisherigen Garage-/Links-Geräte und ihre HCU-Zuordnungen erhalten; Rechts wird nur bei aktivierter gültiger Konfiguration angeboten. IP und Anzeigename sind keine neuen Identitäten. CurrentPower und Maintenance bleiben die einzigen Features; Sensor-Controls bleiben abgelehnt.

## Zeitgewichtete Berechnung

Das feste Veröffentlichungsfenster beträgt **60.000 ms**. Jede Reihe verankert ihre Fenster am ersten Beobachtungszeitpunkt nach Verbindungsaufbau beziehungsweise Reset, nicht an der vollen Uhrzeitminute. Innerhalb eines Fensters gilt der zuletzt gültig erfasste rohe Wattwert abschnittsweise konstant. Der Mittelwert entspricht `Summe(Watt × Dauer) / Summe(gültige Dauer)`; die Implementierung verwendet normalisierte Dauergewichte, damit die Zwischenrechnung mit großen endlichen Werten nicht durch `Watt × Millisekunden` überläuft. Erst nach der Mittelung wird mit `Math.round` auf ganze Watt gerundet. Negative Rundungsnull wird zu normaler 0. Echte 0 W sind gültig; fehlend, null, NaN und ±Infinity sind keine 0-Watt-Messung.

Beispiel: 20 Sekunden mit 1.000 W, 20 Sekunden mit 2.000 W und 20 Sekunden mit 3.000 W ergeben 2.000 W, sofern die Werte durch entsprechend frische Messungen bestätigt werden. Eine einzelne Messung je 20-Sekunden-Abschnitt reicht ausdrücklich nicht: Jeder Messwert darf nur höchstens **4.000 ms** vorwärts gelten. Ein neuer gültiger Messwert beendet den vorherigen Abschnitt früher. Das erhält Messwertsemantik bei unregelmäßigen Intervallen und vermeidet unbegrenzte Fortschreibung.

Ein auswertbares Fenster benötigt mindestens **90 % Abdeckung = 54.000 ms** gültige Zeit. Bei beispielsweise zwei Sekunden Lücke und ansonsten gültiger Telemetrie entsteht der zeitgewichtete Mittelwert ausschließlich aus den gültigen 58 Sekunden; die Lücke fließt nicht als künstliche Null ein. Die Mindestabdeckung ist eine konservative Darstellungsregel, keine Änderung des sicherheitskritischen Telemetrievertrags.

Die drei benannten Konstanten in `power-window.ts` sind `POWER_PUBLISH_INTERVAL_MS = 60_000`, `POWER_SAMPLE_MAX_AGE_MS = 4_000` und `POWER_MIN_WINDOW_COVERAGE_MS = 54_000`. Sie konfigurieren ausschließlich die HCU-Darstellung; keine dieser Größen wird an den LoadManager oder TelemetryHealthGuard übergeben.

## Zeitstempel, Fehler und unvollständige Fenster

Die go-e-Antworten liefern hier keinen verwendeten geräteeigenen Messzeitstempel. `LiveRuntime` ergänzt im bestehenden [RuntimeSnapshot](../src/orchestration/runtime-snapshot.ts) daher das optionale `probeStartedAtMs`: den bereits erfassten gemeinsamen Start des parallelen Controller-/Charger-Polls. `observedAtMs` bleibt der vorhandene Abschlusszeitpunkt. [HcuPluginApplication](../src/orchestration/hcu-plugin-application.ts) reicht beide Zeitpunkte ausschließlich an die Geräteprojektion weiter. Die Engine-Zeitpunkte und Scheduler-Entscheidungen ändern sich nicht.

Der Pollstart ist eine **konservative Näherung**, keine behauptete exakte physische Messzeit: Eine Antwort kann erst später innerhalb des Requests erfasst worden sein. Die HCU-Projektion begrenzt die Gültigkeit trotzdem vom früheren Pollstart aus und prüft sie zusätzlich gegen die aktuelle injizierbare Service-Uhr. HTTP-/Callback-Latenz wird somit nicht als neue Frische addiert. Falls der Gesamtpoll länger als vier Sekunden benötigt, ist sein Leistungswert für die HCU-Projektion zu alt. Diese Darstellungsentscheidung lockert keine Engine-Frischegrenze.

Wiederholte HCU-Abfragen oder erneut zugestellte Snapshots sind keine neue Hardwaremessung und verlängern ihre Gültigkeit nicht. Ungültige, rückwärts laufende, zukünftige oder zu alte Zeitangaben erzeugen keine scheinbar frische Leistung. Ein fehlgeschlagener Geräte-Poll zählt nicht als weitere Messung des vorherigen Werts; der vorangegangene gültige Abschnitt endet spätestens nach seinem viersekündigen Gültigkeitsbudget.

Unter 54 Sekunden Abdeckung, bei vollständig ungültigem Fenster oder zu alten Daten fehlt `CurrentPower.currentPower`. Der optionale Connect-API-Vertrag bleibt `{ "type": "currentPower" }`; keine Null und kein erfundener Ersatzwert. Ein Fehlerstatus hat Vorrang vor einer alten Durchschnittsanzeige.

Ein abgeschlossener Mittelwert darf höchstens bis **Fensterende + 60 Sekunden + 4 Sekunden Poll-Jitter** verwendet werden. Zusätzlich muss für jede Antwort eine aktuell gültige rohe Messung derselben Quelle mit einem Alter von höchstens vier Sekunden vorliegen. Eine ungültige aktuelle Beobachtung löscht den zwischengespeicherten Mittelwert sofort. Auch eine Lücke von mehr als vier Sekunden zwischen Messungen verwirft ihn, ohne zwangsläufig das noch auswertbare Teilintegral des laufenden Fensters zu verlieren. Ein alter Mittelwert ist also niemals Ersatz für aktuelle Quellevidenz und wird nicht mit einem neuen Messzeitstempel versehen.

## HCU-Protokoll und Statusänderungen

DISCOVER_RESPONSE, STATUS_RESPONSE und Inclusion behalten Request-Korrelation, vollständige Gerätestruktur und optionale Features. Sie erhalten keinen schnellen Live-Leistungswert. Soweit ein fachlich gültiger abgeschlossener Mittelwert vorliegt, kann dieser verwendet werden; andernfalls fehlt der optionale Wert. Ein HCU-Request erzeugt keinen zusätzlichen Poll und keine künstliche neue Messung.

Reguläre proaktive CurrentPower-Meldungen sind auf höchstens einen Sendeversuch je Gerät und abgeschlossenem Minutenfenster begrenzt; identische gerundete Werte erzeugen keine wiederholten Änderungsereignisse. Der Fensterabschluss erfolgt erst, wenn der Pollstart einer neuen tatsächlichen Beobachtung die Grenze erreicht beziehungsweise überschreitet. Die Übermittlung kann deshalb um den vorhandenen Pollabstand und seine Antwortlatenz nach der nominellen Grenze liegen. Es gibt keinen zusätzlichen exakt zur Sekunde 60 laufenden Timer.

Maintenance-/Erreichbarkeitsänderungen werden über den bestehenden Snapshot-Hook zeitnah übertragen. Solche partiellen Statusereignisse enthalten keine aktuelle schnelle Leistung; fällt gleichzeitig eine reguläre Mittelwertveröffentlichung an, darf derselbe Event den gültigen Mittelwert enthalten. Eine explizite negative Erreichbarkeitsbeobachtung (`unreach=true`) bleibt auch nach einem langsamen Timeout sichtbar. Ein veraltetes `unreach=false` wird dagegen weggelassen, damit eine alte erfolgreiche Antwort keine aktuelle Erreichbarkeit vortäuscht. Fehlende Leistung allein bedeutet nicht automatisch `unreach=true`.

Nur erfolgreich gesendete Featurewerte aktualisieren die Deduplizierung. Ein fehlgeschlagener regulärer Power-Event wird nicht bei jedem folgenden schnellen Poll wiederholt; erst ein neues abgeschlossenes Fenster kann erneut einen regulären Sendeversuch erzeugen. Fehlgeschlagene Maintenance-Änderungen können beim nächsten vorhandenen Poll erneut versucht werden. Pflichtantworten auf HCU-Anfragen bleiben unabhängig davon erforderlich und dürfen einen noch gültigen Mittelwert erneut enthalten.

Ein erfolgreiches Senden bestätigt nur die Übermittlung an die HCU. Wie oft die HCU Pflichtantworten, Inclusion und wiederholte gleiche Werte in ihrer Messhistorie speichert, ist nicht durch den Plugin-Code bewiesen. Deshalb gilt der Nachweis von Faktor 30 ausschließlich für reguläre proaktive Leistungsereignisse im kontrollierten Szenario. Pflichtantworten werden niemals ignoriert, um eine scheinbare Historienbegrenzung zu erzwingen.

Das Weglassen des optionalen Leistungswerts garantiert **nicht**, dass die HCU oder App eine zuvor angezeigte Zahl sofort aus ihrer eigenen Anzeige oder ihrem Cache entfernt. Der Plugin-Code sendet bei fehlender Messung weder eine falsche 0 W noch eine erfundene physische Nichterreichbarkeit, um einen solchen Anzeigeeffekt zu erzwingen. Die konkrete Darstellung bleibt ein realer Abnahmepunkt.

## Start, Ausfall, Wiederkehr und Reconnect

Die Aggregation ist ausschließlich im Speicher und beginnt nach Prozessstart ohne historischen Mittelwert. Zunächst müssen ausreichend gültige Messabschnitte für ein vollständiges Fenster gesammelt werden. Ausfälle erzeugen keine künstlichen Nullwerte. Eine explizite physische Nichterreichbarkeit verwirft die betroffene Reihe einschließlich des Teilintegrals; nach Wiederkehr beginnt für diese Reihe ein neues 60-Sekunden-Fenster. Bei einer kurzen Messdatenlücke ohne physische Nichterreichbarkeit bleibt das Teilintegral erhalten, sofern die Fensterabdeckung weiterhin mindestens 54 Sekunden erreicht. Kurze Dateninseln werden nicht als vollständiger Minutenmittelwert ausgegeben.

Nach längerer Pause werden alte abgeschlossene Fenster in konstanter Arbeit verworfen und nicht einzeln nachgesendet. Pro bekannter Messreihe bleiben lediglich der laufende Akkumulator, eine begrenzte vorige Beobachtung und höchstens ein abgeschlossener Mittelwert im Speicher; es gibt keinen historischen Nachholpuffer und keinen Reconnect-Burst.

Ein HCU-Socket-Disconnect oder neuer Verbindungsaufbau verwirft alle Geräteintegrale, alten Reports und Publikationscaches. Während der HCU-Trennung sammelt der Gerätedienst keine weiteren Fenster; die interne Regelung pollt unverändert weiter. Nach Reconnect beginnt die nächste frische reale Beobachtung ein neues Fenster. Unsolicited Events warten wie bisher auf den frischen vollständigen Inclusion-Snapshot. `READY` nach `CONNECTED` setzt einen bereits laufenden Verbindungszustand nicht erneut zurück.

Ein Inclusion-Ereignis allein setzt das Integral nicht zurück; seine vollständige Statusantwort verwendet denselben noch gültigen Mittelwert wie ein StatusRequest. Exclusion beendet unsolicited Publikation und entfernt den Zustellcache, verändert aber nicht die physische Konfiguration. Nach Entfernung oder Deaktivierung einer Konfiguration wird auch deren Aggregationsreihe gelöscht. Ein Quellenbindungs-/Hostwechsel verwirft nur die betroffene Reihe und deren Cache; reine Namens- und Prioritätsänderungen erhalten das Integral. Es werden keine Werte eines vorherigen Hosts auf ein neues Gerät übertragen.

## Auswirkungen und Kompatibilität

Das Energie-Dashboard und CurrentPower-Automationen erhalten etwa einmal pro Minute einen **Minutenmittelwert**, keinen Momentanwert. Automationen können entsprechend später reagieren; ein Minutenmittelwert darf nicht als sicherheitskritische Echtzeitmessung verwendet werden. Die interne go-e-Regelung behält ihre kurzen Reaktionszeiten, Trigger, Prioritäten, Round Robin, Stromschritte, Recovery und FAULT-Semantik.

Es gibt keine HCUweb-Option für das Intervall, keine neue Dependency, Datenbank oder Persistenzdatei. Die vollständige AppConfig-Validierung, vorhandene v0.1.0-/v0.2.0-/v0.2.1-Konfiguration, [Rebinding-Schutz aus 0.2.1](initial-configuration.md), Ownership- und Nachrichtensessions bleiben unverändert. Bestehendes `/data` muss bei einem späteren Update erhalten bleiben. Es gibt keine automatische CLEAR-/RESUME-Aktion, keinen neuen produktiven `/api/set`-Pfad und weiterhin keine `amp`-/`loe`-Writes.

## Offline-Nachweise

Die vollständig offline ausgeführten Prüfungen sind erfolgreich:

| Prüfung | Ergebnis |
|---|---|
| `npm test` | **1.785 Tests in 65 Dateien bestanden**, insgesamt 77 zusätzliche Fälle gegenüber 0.2.1 |
| `npm run typecheck` | bestanden |
| `npm run build` | bestanden |
| `npm run simulate` | bestanden; unveränderte Demonstration mit erstem 13-A-Schritt nach 30 Sekunden, danach 12 A / 11 A nach 34 / 38 Sekunden |
| Packaging-Regressionen | **38 Tests bestanden**, Teil der Gesamtsuite |
| Build-Eingabe-/Secret-Sanity | 73 erlaubte Dateien geprüft, `privateDevelopmentFilesRead=false` |
| Geschützte Quellcodedateien | 34 unverändert per Inhalts-Hash geprüft, darunter Engine, go-e-Control, Config, Telemetrie-Guard, Scheduler sowie HCU-Transport und Nachrichten |
| Container-Smoke-Skript | an den Minutenvertrag angepasst, Syntax-/Packaging-Regressionen bestanden; **kein tatsächlicher Containerlauf in diesem Auftrag** |

Die additive Weitergabe von `probeStartedAtMs` in `LiveRuntime` ändert keine vorhandene Engine- oder Schedulerentscheidung. Die Geräteaggregation ist pro konfigurierter Identität begrenzt und hält keinen Rohdatenpuffer; neue Timer, Subscriptions, Persistenz oder Poll-Loops wurden nicht eingeführt. Keine reale HCU, Cloud, Wallbox oder Controllerverbindung gehörte zu den Prüfungen. Kein ARM64-Paket, Deployment oder Hardwaretest wurde ausgeführt. Entsprechend dem Nutzerauftrag wurden auch keine Git-Befehle einschließlich lesender Branch-/Status-Abfragen ausgeführt.

Gezielte Regressionen liegen in [power-window.test.ts](../tests/unit/hcu/devices/power-window.test.ts) für Zeitgewichtung, Grenzwerte, Ausfälle, ungültige Zeiten und begrenzten Speicherzustand sowie [energy-publishing.test.ts](../tests/unit/hcu/devices/energy-publishing.test.ts) für sämtliche HCU-Veröffentlichungswege, Maintenance, unveränderte IDs, Reconnect und ausbleibende neue Timer. Die bestehenden Geräte-Lifecycle-, Runtime-, Config-/Ownership-, Rebinding- und Packaging-Prüfungen bleiben Teil der Gesamtsuite.

Der reproduzierbare [14-Tage-Offlinetest](../tests/unit/hcu/devices/energy-volume.test.ts) verwendet fünf Messgeräte und **604.801 interne Snapshots** im Zwei-Sekunden-Abstand einschließlich des Startpunkts. Die absichtlich jede Beobachtung veränderlichen Werte vermeiden Deduplizierungseffekte im Vergleich des bisherigen und neuen Verhaltens:

| Reguläre Meldungen / 14 Tage | Bisher | 60-Sekunden-Fenster |
|---|---:|---:|
| Alle fünf Messgeräte | 3.024.000 | 100.800 |
| Drei Controller-Messgeräte | 1.814.400 | 60.480 |
| Verhältnis | 30 | 1 |
| Reduktion regulärer Meldungen | – | rund 96,7 % |

Die interne Messfrequenz wird dabei nicht reduziert. Im stabilen Szenario entstehen **0 zusätzliche Maintenance-Ereignisse** und eine initiale vollständige Statusantwort ohne Leistungswert.

Ein zweiter 14-Tage-Durchlauf enthält eine Minute Controllerausfall an Tag 7 und eine Minute HCU-Trennung an Tag 10. Er verarbeitet weiterhin **604.801 interne Snapshots** und erzeugt **100.784 reguläre Power-Ereignisse** für alle fünf Geräte, davon **60.468** für die drei Controller-Geräte, sowie **6 Maintenance-Ereignisse** (drei Kanäle down/up) und **2 vollständige Statusantworten** (Start-/Reconnect-Inclusion). Der kleinste Abstand regulärer Power-Ereignisse je Gerät beträgt weiterhin **60.000 ms**. Es entsteht kein Fenster-Nachholburst.

Die im zweiten Test zusätzlich gezählte alte Referenz beträgt 3.023.910 reine Quellwertänderungen. Sie berücksichtigt den Controllerausfall, modelliert aber absichtlich keinen früheren Socket-Reconnect-Transport und ist daher kein vollständiger Vergleich alter HCU-Ereigniszahlen bei Unterbrechungen. Der exakte Faktor-30-Nachweis stammt ausschließlich aus dem stabilen Szenario. Diese Meldungszahlen sind gemessene Offline-Publizierungen, keine Zusage für die von der realen HCU gespeicherte Gesamtzahl.

## Geänderte und neue Dateien

Dieser Entwicklungsauftrag umfasst 25 Dateien. Neue Dateien sind ausdrücklich markiert; Versionsanpassungen in Packaging-Skripten erzeugen noch kein Paket.

| Datei | Änderung |
|---|---|
| [Dockerfile](../Dockerfile) | ausschließlich HCU-Metadatenversion 0.2.2 |
| [package.json](../package.json) | Projektversion 0.2.2 |
| [package-lock.json](../package-lock.json) | ausschließlich Versionen des Wurzelprojekts |
| [plugin-identity.ts](../src/hcu/plugin-identity.ts) | zentrale Version, unveränderte Plugin-ID |
| [package-hcu.ps1](../scripts/package-hcu.ps1) | Paket-/Image-Namen 0.2.2 |
| [check-package-inputs.mjs](../scripts/check-package-inputs.mjs) | erwartete Version 0.2.2 |
| [validate-hcu-image.mjs](../scripts/validate-hcu-image.mjs) | erwartete Image-Metadatenversion 0.2.2 |
| [packaging.test.ts](../tests/unit/packaging/packaging.test.ts) | Versionskonsistenz, alte 0.2.1-Metadaten weiterhin abweisen |
| [README.md](../README.md) | aktueller Stand, geänderte Anzeige-/Automationssemantik |
| [CHANGELOG.md](../CHANGELOG.md) | 0.2.2 – Unreleased |
| [phase6-hmip-plugin-devices.md](phase6-hmip-plugin-devices.md) | historische Aussagen mit aktuellem Vertrag verknüpft |
| [energy-publishing-60s.md](energy-publishing-60s.md) | **neu:** Berechnung, Grenzen, Nachweise und Abnahme |
| [phase5-installed-plugin.md](phase5-installed-plugin.md) | ausschließlich aktuelle Fortschreibungsnotiz |
| [power-window.ts](../src/hcu/devices/power-window.ts) | **neu:** reine begrenzte zeitgewichtete Aggregation |
| [power-window.test.ts](../tests/unit/hcu/devices/power-window.test.ts) | **neu:** Aggregationsregressionen |
| [plugin-device-service.ts](../src/hcu/devices/plugin-device-service.ts) | Fenster-/Status-Veröffentlichung und Lifecycle |
| [device-projection.ts](../src/hcu/devices/device-projection.ts) | ungerundete physikalische Wattquelle für Mittelwertbildung |
| [runtime-snapshot.ts](../src/orchestration/runtime-snapshot.ts) | optionaler bereits vorhandener Pollstart als Darstellungsmetadatum |
| [live-runtime.ts](../src/orchestration/live-runtime.ts) | additive Weitergabe dieses Pollstart-Zeitstempels |
| [hcu-plugin-application.ts](../src/orchestration/hcu-plugin-application.ts) | Zeitstempel-/Clock-Weitergabe an Geräteprojektion |
| [plugin-device-service.test.ts](../tests/unit/hcu/devices/plugin-device-service.test.ts) | bestehende Lifecycle-Regressionen an Minutenvertrag angepasst |
| [energy-volume.test.ts](../tests/unit/hcu/devices/energy-volume.test.ts) | **neu:** zwei reproduzierbare 14-Tage-Durchläufe |
| [energy-publishing.test.ts](../tests/unit/hcu/devices/energy-publishing.test.ts) | **neu:** sämtliche HCU-Veröffentlichungswege und Fehlerfälle |
| [hmip-device-application.test.ts](../tests/unit/orchestration/hmip-device-application.test.ts) | Runtime-/Projektionsisolation und frühe Engine-Reaktion |
| [container-smoke.mjs](../scripts/container-smoke.mjs) | bestehende Offline-Smoke-Rezeptur auf Minutenmittel-/Maintenance-Vertrag angepasst |

## Noch ausstehende reale Abnahme

Nach separatem Packaging und bewusstem Update mit erhaltenem `/data` sind dieselben logischen Geräte ohne neue Inclusion zu prüfen, soweit die HCU ihre vorhandene Zuordnung erhält. Zunächst reale Regelung ausgeschaltet lassen, Initialisierung und Ownership kontrollieren, anschließend den neuen Leistungstakt und die Vorzeichen über mehrere Minuten beobachten. Keine künstliche Überlast erzeugen.

Die HCU-/App-Wirkung von StatusRequests, Live-Ansicht und Historienablage, etwaige Aggregation im Energie-Dashboard und die tatsächlich langsamere Automation sind reale Plattformfragen. Die bestehenden gelöschten 1,8 Millionen Datensätze werden nicht wiederhergestellt oder vom Plugin verwaltet. App-Synchronisierungsprobleme dürfen ohne neuen Nachweis nicht als durch 0.2.2 behoben bezeichnet werden.
