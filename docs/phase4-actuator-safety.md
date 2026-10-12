# Phase 4 – Actuator, Ownership und sicherer LIVE-Gate

Phase 4 implementiert erstmals die Möglichkeit, reale go-e-Regelwerte zu schreiben. **Während der Entwicklung und automatisierten Tests wurden keine echten Charger-Writes ausgeführt. Der erste Hardware-Canary ist ausschließlich geplant.** Der vorbereitete LIVE-Modus startet keinen unbeaufsichtigten Regellauf und führt keine erste Aktion automatisch aus.

Die verbindliche Projektidentität bleibt `com.psd.hcu.goe.loadmanagement`. Die bestehenden Phasen 1–3, Engine-Zustände, Prioritäten und Round Robin bleiben erhalten. HCU-Nachrichten und Geräteaktionen sind getrennte Schnittstellen.

## Architektur und erlaubte Operationen

| Komponente | Verantwortung |
| --- | --- |
| `GoEChargerControlClient` | fester Statusendpunkt und genau vier typisierte Control-Operationen; Transportfehler kapseln |
| `ChargerActuator` | serialisierte Aktionen, Baseline, frische Prechecks, Persistenz, Readback, Ownership und expliziter Refresh |
| `OwnershipState` | belegbare eigene Einschränkungen, Baseline, beobachteter Zustand, Bestätigung und offene Write-Absicht |
| `FileOwnershipStore` | atomare Speicherung in `actuator-state.json` mit Schema- und Konsistenzprüfung |
| `reconcileOwnership()` | reine Prüfung gespeicherter Evidenz gegen aktuellen Status; niemals Geräte verändern |
| `TelemetryHealthGuard` | frische Grid-Messwerte und 10 Sekunden stabile Wiederkehr vor Freigaben |
| `LiveRuntime` | getrennte explizite Messentscheidung und Ausführung; Engine-Ack erst nach bestätigtem Actuator-Ergebnis |
| `ActionJournal` | maximal 50 sanitierte Diagnoseereignisse ohne Rohantworten oder Credentials |

Die Engine bleibt unabhängig von HTTP, HCU, Persistenz und Logging. Abstrakte `ControlAction`s werden ausschließlich durch den getrennten Actuator übersetzt. Der bestehende `GoEHttpClient`, `GoEControllerClient` und `GoEChargerClient` bleiben read-only.

Der produktive Schreibendpunkt `/api/set` darf ausschließlich in `src/goe/control/charger-control-client.ts` vorkommen. Es gibt keine öffentliche generische Key-, Pfad- oder HTTP-Methode. Zulässig sind nur:

| Öffentliche Operation | Erlaubter Gerätewert |
| --- | --- |
| `setTemporaryCurrentLimit(config, amps)` | `tcl` als validierte ganzzahlige Stromgrenze |
| `clearTemporaryCurrentLimit(config)` | nur nach gesondert verifizierter Clear-Capability |
| `pause(config)` | `frc=1` |
| `resume(config)` | `frc=0` |

`amp`, `loe`, `ama`, `mca`, `acp`, `mcpd` und alle übrigen Keys werden niemals geschrieben. `amp` bleibt der normale Benutzer-Sollwert. Die private Write-Funktion enthält zusätzlich eine Runtime-Whitelist, sodass untypisierte Aufrufer keine fremden Keys einschleusen können. Hosts werden als reine Host-Autorität validiert, Requests folgen keinen Redirects und tragen keine Credentials.

Die [offizielle HTTP-API](https://github.com/goecharger/go-eCharger-API-v2/blob/main/http-en.md) beschreibt JSON-Werte als Query-Parameter in GET-Requests und eine Bestätigung `key: true` je geschriebenem Key. Der Client validiert diese Bestätigung; sie ersetzt keinen Readback. Die [offizielle Key-Tabelle](https://github.com/goecharger/go-eCharger-API-v2/blob/main/API_KEYS_FIRMWARE/apikeys-en.md) beschreibt `frc` Neutral/Off sowie `loe` als natives Load-Balancing und den Reset eines nicht erneuerten `tcl` nach zehn Minuten. Sie spezifiziert den `tcl`-Clear-Wert nicht eindeutig.

## Doppelter Live-Gate und Startmodi

Ein realer Write verlangt gleichzeitig:

```text
executionMode === LIVE
GOE_REAL_WRITES_ENABLED === true
```

Das Umgebungsflag akzeptiert ausschließlich den ausdrücklich gesetzten Wert `true`. HCUweb kann das Flag nicht setzen; auch die fachliche Konfiguration enthält keine solche Freigabe. Sowohl Actuator als auch Control Client prüfen den Gate. Ein DEV-/Dry-Run-Client kann nicht durch nachträgliche Mutation seines Gate-Objekts zu einem LIVE-Client werden.

| Kommando | go-e-Verhalten, auch mit gesetztem Write-Flag |
| --- | --- |
| `npm run hcu:dev` | HCU-Verbindung; keine go-e-Writes und kein Regeltimer |
| `npm run hcu:dry-run` | echte Status-GETs und ausschließlich simulierte Aktionen |
| `npm run hcu:test-message` | ausdrückliche HCU-TEST-Frage; keine Chargersteuerung |
| `npm run probe` | einmalige read-only Status-GETs |
| `npm run simulate` | vollständig offline, keine Geräteclients |
| `npm test` | Netzwerkzugriffe und Schreibtests vollständig gemockt |
| `npm run hcu:live` | ohne Flag Startup-Fehler; mit Flag vorbereiteter LIVE-Pfad ohne automatische Aktionen |

LIVE startet **PREPARED**. Der eigene Entry Point ist `src/cli/hcu-live.ts`; der DEV-Entry-Point akzeptiert kein `--live`. Explizite Aufrufe von `observe()` lesen Messungen und berechnen eine Aktion. `executePendingAction(actionId)` verlangt anschließend genau die noch gültige Aktion, erneute Grid-Prüfung und Charger-Precheck. Eine veraltete Entscheidung, ein Konfigurationswechsel oder ein Override verwirft alte Intents. `refresh()` ist ebenfalls explizite Wartung. `LiveRuntime.stop()` beendet die Vorbereitung und ruft den sicheren Actuator-Shutdown auf. Phase 4 enthält keinen automatischen LIVE-, Refresh- oder Canary-Timer.

Eine HCU-Verbindung im LIVE-Modus bedeutet daher keine automatische Wallboxänderung. Die normale CLI kann den späteren Canary nicht ausführen.

Im vorbereiteten LIVE-Prozess dürfen Gerätebindungen (Controller-Host sowie Charger-ID, Host und Aktivierung) nicht nachträglich verändert werden. Solche Updates werden vollständig abgelehnt und benötigen einen gestoppten Prozess mit anschließender Startup-Reconciliation. Bereits vorhandene unsichere oder eigene Ownership darf auch beim Neustart nicht durch einen Hostwechsel verschwinden. Regelparameter, Prioritäten und Anzeigenamen bleiben bei unveränderten Gerätebindungen aktualisierbar. DEV und Dry-Run behalten ihre bisherige Konfigurationsverarbeitung.

## Baseline und Ownership

Vor dem ersten eigenen Eingriff erfasst der Actuator eine frische Baseline mit `amp`, `tcl`, `frc`, `loe`, `car`, `mca`, `acu`, weiteren benötigten Statuswerten und Zeitstempeln. Der aktuelle Gerätehost und die Charger-ID gehören zur Evidenz. Die Baseline wird vor dem Write persistent gespeichert.

Je Charger werden mindestens gespeichert:

```text
chargerId, host, baseline
pluginOwnedTcl, pluginOwnedPause
lastObservedState, lastConfirmedWrite, lastReadback
ownershipStatus, conflictStatus, updatedAt, pendingWrite
```

`pluginOwnedTcl` ist der bestätigte numerische eigene Limitwert oder `null`; die gespeicherte Baseline unterscheidet ihn von einem ursprünglichen fremden Limit. `pluginOwnedPause` wird erst nach bestätigtem `frc=1` wahr. `pendingWrite` ist nur eine abgesicherte Write-Absicht und kein Eigentumsnachweis.

| Ownership-Status | Bedeutung |
| --- | --- |
| `NONE` | keine bestätigte eigene Einschränkung |
| `RECONCILING` | eine persistierte Write-Absicht wartet auf eindeutige Bestätigung |
| `OWNED` | eigene Einschränkung ist anhand der Evidenz und aktuellen Werte bestätigt |
| `CONFLICT` | externe Änderung oder natives Load-Balancing; keine konkurrierenden Writes |
| `UNKNOWN` | unklare Übertragung, fehlender Readback oder unzureichende Evidenz; keine automatische Freigabe |

### tcl-Regeln

Ein vorhandenes fremdes `tcl` wird nicht blind übernommen oder gelockert:

| Baseline | Eigener Wunsch | Verhalten |
| --- | --- | --- |
| `tcl=null` | 10 A | eigenes Limit nach Precheck und Readback möglich |
| `tcl=8` | 10 A | keine Lockerung auf 10 A; fremde 8 A bleiben erhalten |
| `tcl=12` | 10 A | Reduktion auf 10 A möglich; fremde 12 A bleiben Baseline |
| fremde 12 A, eigenes 10 A | Rücknahme | ursprüngliche 12 A erhalten, nicht pauschal clearen |

Eine beobachtete Abweichung vom erwarteten eigenen `tcl` ergibt `EXTERNAL_TCL_CHANGE`. Ein fremder restriktiverer Wert wird niemals wieder hochgeschrieben. Konflikte werden nicht dadurch automatisch aufgehoben, dass ein späteres Sample zufällig wieder zum alten Wert passt.

**Clear-Semantik bleibt offen:** `GoEChargerControlClient` blockiert JSON-null-Clear standardmäßig mit `TCL_CLEAR_SEMANTICS_UNVERIFIED`. Die optionale Capability `tclClearCapability: 'JSON_NULL_VERIFIED'` ist ein Vertrag für ein später ausdrücklich verifiziertes Geräteprofil. Sie ist weder CLI-Flag noch HCUweb-Konfiguration und wird im normalen LIVE-Start nicht aktiviert. Ein Statuswert `tcl=null` beweist nicht, dass das Schreiben von JSON-null der korrekte Löschvorgang ist. Der erste Canary muss vor seinem Start eine sichere Rücknahme besitzen.

### frc-Regeln und Override

Bei Baseline `frc=0` kann der Actuator eine eigene Pause setzen. Erst ein frischer Readback mit `frc=1` bestätigt `pluginOwnedPause=true`. Bei bereits fremdem `frc=1` erwirbt das Plugin keine Pause-Ownership und darf später niemals `frc=0` schreiben.

Bei bestätigter eigener Pause beginnt Recovery mit RESUME unter weiterhin bestehendem temporärem Limit. Erst danach darf eine weitere Aktion das eigene Limit schrittweise erhöhen oder zurücknehmen. Zusätzlich zur Engine prüft der Actuator die gemeldete Mindestpausendauer `mcpd` in Millisekunden anhand persistierter Bestätigung. Nach Refresh oder Neustart kann diese Prüfung konservativ länger warten; sie überspringt die Mindestpause nicht. Extern verändertes `frc` ergibt einen Konflikt und wird nicht zurückgeschrieben.

JA aktiviert das bestehende explizite Override-Ereignis. Im LIVE-Pfad müssen alle Aktionen trotzdem explizit ausgeführt werden und die gleichen Sicherheitschecks durchlaufen. Nur eigene Einschränkungen werden entfernt: eigene Pause zuerst RESUME, danach eigene `tcl`-Einschränkung zurücknehmen beziehungsweise fremde Baseline erhalten. Grid-Fault oder fehlende stabile Telemetrie erlauben auch bei Override keine unsichere Freigabe. Während Override stoppt Refresh und es entstehen keine neuen automatischen Begrenzungen bis `endSession()`.

`car=4` ist weiterhin kein Session-End-Nachweis. Eine verifizierte reale Session-Lifecycle-Erkennung ist offen; ausschließlich das explizite Domänenereignis beendet die Session.

### loe und externe Änderungen

`loe=true` ergibt `NATIVE_LOAD_BALANCING_CONFLICT`: keine eigenen `tcl`-/`frc`-Kommandos und keine automatische Deaktivierung des nativen Reglers. Fehlendes oder ungültiges `loe` bleibt `null`, ergibt `NATIVE_LOAD_BALANCING_UNKNOWN` und öffnet keinen Write-Pfad. Auch Änderungen an `amp` oder der gespeicherten Geräteidentität verhindern eine ungesicherte Fortsetzung. Das Plugin kämpft nicht gegen manuelle Änderungen.

## Pre-Write, Readback und begrenzte Retries

Jede einzelne reale Aktion durchläuft diese Reihenfolge:

1. Live-Gate, initialisierten Actuator, Lastmanagement-Freigabe und Grid-Gesundheit prüfen.
2. Status frisch lesen, Charger-ID/Host, Zeitstempel, `loe=false`, Ownership, erwartetes `tcl`/`frc` und die konkrete Aktion prüfen.
3. Baseline und Write-Absicht atomar persistieren. Bei Persistenzfehler keinen Write senden.
4. Nach der Persistenz Frische und Shutdown-Sperre erneut prüfen, dann genau eine erlaubte Operation übertragen.
5. Einen neuen Status lesen und Zielwerte sowie unveränderte Sicherheits-/Benutzerwerte vergleichen.
6. Bestätigte Ownership atomar persistieren. Erst dann `CONFIRMED` melden und die Engine-Aktion als angewendet quittieren.

Default-Maximalalter für Status und Grid ist 4 Sekunden. Die Readback-Lesung muss nach der Write-Absicht gestartet sein. Timeout, verlorene Antwort oder nicht passender Readback sind kein Erfolg. Diagnose unterscheidet `BLOCKED`, `CONFIRMED`, `FAILED`, `CONFLICT`, `UNREACHABLE`, `READBACK_FAILED` und `READBACK_MISMATCH`; `writeAttempted`, Leseversuche und Bestätigungszeit sind separate Felder.

Default sind **höchstens zwei Wiederholungen sicherer Statuslesungen**, also maximal drei Reads pro Lesephase, mit 100 ms kontrollierter Verzögerung. Konfigurationsfehler und ungültige Antwortstrukturen werden nicht durch Wiederholung übergangen. Der Client führt keine eigenen Retries aus. Ein Write wird pro expliziter Aktion höchstens einmal versucht; ein Timeout kann bedeuten, dass das Gerät den Write bereits angenommen hat. Deshalb gibt es keinen blinden Write-Retry und keine Command-Schleife. Unklare Outcomes bleiben `UNKNOWN` beziehungsweise Fault und verlangen gesonderte Bewertung.

Auch nach Write-Timeout, Verbindungsfehler oder ungültiger Bestätigung wird ein begrenzter diagnostischer Readback versucht. Selbst ein passender Zielwert macht diesen unklaren Write nicht nachträglich zu `CONFIRMED`: Die persistierte Absicht und `UNKNOWN` bleiben erhalten. Eine definitive Ablehnung vor dem Versand, etwa der gesperrte unbestätigte Clear-Wert, benötigt keinen Geräte-Readback und erhält die vorherige Ownership.

Der konkrete HTTP-Timeout ist standardmäßig 3 Sekunden und umfasst auch den Empfang des Antwort-Bodys. Native Fehlermeldungen, Geräteantworten und Credentials werden nicht ausgegeben.

## Persistenz und Startup-Reconciliation

`FileOwnershipStore` speichert im gewählten `HCU_DATA_DIR/actuator-state.json`, remote standardmäßig `./data/actuator-state.json`; der vorbereitete installierte Betrieb nutzt `/data/actuator-state.json`. Die Datei ist unabhängig von `plugin-config.json`.

Atomarer Ablauf: temporäre Datei im selben Verzeichnis exklusiv öffnen, bekannte validierte Felder schreiben, synchronisieren, schließen und per Rename ersetzen. Defekte, widersprüchliche oder nicht lesbare Daten führen zu einem ausdrücklichen Fehler. Eine fehlende Datei bedeutet keine bisher belegte eigene Einschränkung und löst weiterhin eine reale Statusprüfung aus. Credentials und vollständige Rohantworten werden nicht gespeichert.

Startup liest gespeicherten Zustand, liest die aktivierten Charger und vergleicht Evidenz und echte Werte. Es sendet dabei keine Writes:

| Persistierter Zustand und aktuelles Gerät | Ergebnis |
| --- | --- |
| bestätigte eigene Pause, gültige Baseline, real `frc=1` und passende Werte | belegbare Ownership kann rekonstruiert werden |
| eigene Pause gespeichert, real `frc=0` | Konflikt; niemals erneut pausieren |
| eigenes 10-A-Limit gespeichert, real `tcl=8` | Konflikt; niemals auf 10 A lockern |
| offene Write-Absicht ohne bestätigten Readback | `UNKNOWN`, auch bei momentan passenden Werten |
| unvollständige/defekte Evidenz oder Charger nicht erreichbar | konservativer Fehler/`UNKNOWN`; keine automatische Freigabe |

Records entfernter oder deaktivierter Charger werden nicht still gelöscht, damit ihre möglichen Einschränkungen nicht vergessen werden. Die Engine darf ausschließlich reconciliierte, bestätigte eigene Zustände übernehmen. Unbekannte oder konfliktbehaftete Records sind keine Grundlage für CLEAR oder RESUME.

Ein reiner Erreichbarkeitsausfall vor jedem eigenen Eingriff darf sich nach einer neuen gültigen Statuslesung mit `loe=false` auflösen, wenn Baseline, eigene Flags, Write-Absicht, bestätigter Write und Readback vollständig leer sind. Dann entsteht wieder `NONE`; aktuelle fremde Limits und Pausen werden nicht übernommen. Jede Write- oder Ownership-Historie hält einen unklaren Zustand weiterhin gesperrt.

## Grid-Fault und lokale Verfügbarkeit

`TelemetryHealthGuard` unterscheidet `UNKNOWN`, `FAULT`, `STABILIZING` und `HEALTHY`. Fehlendes, ungültiges oder veraltetes Grid wird niemals als 0 W verwendet. Vor einer Freigabe muss eine echte frische Messung vorliegen; stale gespeicherte Reserve reicht nicht aus.

Nach Start und nach jedem Controller-Fault müssen neue gültige Samples über **10 Sekunden kontinuierlich frisch** bleiben. Lücken über dem zulässigen Messalter setzen die Stabilisierung zurück. Währenddessen dürfen sichere Reduktionen vorbereitet werden; keine Stromerhöhung, kein RESUME und kein CLEAR. Eigene Einschränkungen bleiben erhalten. Der Fault pausiert nicht blind alle Charger und gibt sie nicht blind frei.

Ein unerreichbarer Charger erhält keine spekulative Bestätigung und keine spekulative Freigabe. Seine Ownership bleibt konservativ. Andere erreichbare Charger können bei echtem hohen Grid unabhängig weiter begrenzt werden, wenn die bestehende Engine das verlangt. Ein HCU-Verbindungsverlust allein ist kein Grid-Fault: explizite lokale Entscheidungen bleiben möglich, Meldungen und Antworten fallen bis Reconnect aus. Keine Antwort bedeutet kein Override. Der vorhandene Reconnect-Abgleich vermeidet doppelte offene Fragen.

## tcl-Refresh, LIMIT_UNACHIEVABLE und Shutdown

Default-Refreshintervall ist **300 Sekunden**, deutlich unter der dokumentierten temporären Ablaufzeit. Der Actuator erneuert nur einen eindeutig eigenen aktiven Wert nach fälligem Intervall und erneutem Precheck/Readback. Bedingungen: `OWNED`, kein Konflikt, kein Override, gesunde Telemetrie, aktiviertes Lastmanagement, erreichbarer Charger und `loe=false`.

Refresh stoppt bei Override, Fault, Ownership-Verlust, Limitrücknahme, Deaktivierung und Shutdown. Ein bestätigter Refresh aktualisiert die Fälligkeitszeit; zwischen fälligen Intervallen gibt es keine identischen Refresh-Kommandos. **In dieser Vorbereitung wird Refresh ausschließlich explizit aufgerufen. Wer später einen LIVE-Betrieb orchestriert, muss eine sichere Wartung gesondert implementieren; Phase 4 startet keinen solchen Loop.**

Wenn die bestehende Engine keine weitere verfügbare Ladeleistung begrenzen kann und Grid über dem Ziel bleibt, meldet sie `LIMIT_UNACHIEVABLE`. Keine identischen Pause-Kommandos und kein Oscillation-Spam. Diagnosen zeigen diesen Zustand; eine optionale Warnung darf nur bei Zustandswechsel beziehungsweise mit begrenzter Rate entstehen, niemals bei jedem Poll.

Normaler Shutdown sperrt neue Writes und Refresh und persistiert Ownership. Bereits übertragene Requests werden nicht zu angeblichen Erfolgen erklärt; ihr Readback und die konservative Persistenz bleiben maßgeblich. Shutdown sendet weder CLEAR noch RESUME. Nach Neustart ist erneute Reconciliation verpflichtend.

Ein fehlgeschlagener finaler Ownership-Save wird als Fehler zurückgegeben, im Journal und in der Actuator-Diagnose sichtbar und beim CLI-Shutdown mit Fehlerstatus gemeldet. Ein fehlgeschlagener Startup überschreibt keine beschädigte Ownership-Datei. In beiden Fällen gibt es keine automatische Gerätefreigabe.

## HCUweb, Journal und Familienbenutzer

Die bisherigen sieben HCUweb-Gruppen bleiben bestehen. Diagnose projiziert den gespeicherten Runtime-Snapshot ohne synchrone Geräteabfrage. Sichtbar sind Ausführungsmodus, echte Schreibfreigabe, Telemetriegesundheit, Engine-/Actuator-Zustand, Ownership/Konflikt je Charger, eigenes `tcl`, eigene Pause, letzter bestätigter Write, Readback, letzter Fehler, `FAULT` und `LIMIT_UNACHIEVABLE`.

Das begrenzte Journal unterscheidet `ABSTRACT_ACTION`, `WRITE_BLOCKED`, `WRITE_ATTEMPTED`, `WRITE_CONFIRMED`, `READBACK_MISMATCH`, `OWNERSHIP_CONFLICT` und `FAULT`. Logs verwenden Charger-ID, Aktion, Ergebnis, Ownership, Konflikt und Retry-Anzahl. Keine `authToken`, `clientId`, Aktivierungskeys oder kompletten Netzwerkpayloads.

Der vom Nutzer bestätigte HCU-Live-Test ergab: App-Meldung sichtbar, kein beobachteter OS-Push, alle Familienbenutzer können antworten, ACK ohne Benutzeridentität, Meldung verschwindet nach Antwort. **JA eines beliebigen berechtigten Familienbenutzers aktiviert Override.** Es existiert keine Owner-only-Funktion. Eine Live-Interaktion allein umgeht weder die Ownership- noch die Telemetrieprüfung.

## Geplanter erster Canary – nicht ausgeführt

Der erste reale Write darf ausschließlich als separat beschlossener und ausdrücklich vom Nutzer gestarteter Garage-Test erfolgen. Codex startet diesen Test nicht; es gibt keine automatische Canary-Ausführung.

Voraussetzungen:

- Nur `garage`; `links` und `rechts` erhalten keine Writes.
- Auto lädt, Garage erreichbar, native Lastregelung `loe=false`, Ausgangszustand `frc=0`.
- Grid frisch und über mindestens 10 Sekunden stabil, keine externe Änderung und keine unklare Ownership.
- Kein fremdes `tcl` oder eine eindeutig dokumentierte fremde Baseline, die sicher erhalten werden kann.
- LIVE plus explizites Write-Flag und gesonderter Canary-Start.
- **Sichere Rücknahme ist vor dem ersten Set verifiziert.** Die noch unbestätigte JSON-null-Clear-Semantik blockiert den Standardfall mit fehlendem Baseline-Limit bis zur gesonderten Klärung.
- Kein paralleles automatisches Lastmanagement und kein `frc` im ersten Canary.

Geplanter Ablauf, noch nicht ausgeführt:

1. Frischen Status lesen und Baseline persistent sichern.
2. Genau 1 A unter dem tatsächlichen aktuellen Ladelevel setzen, ohne unter `mca` zu gehen, etwa 14 A → `tcl=13`.
3. Readback prüfen; ein HTTP-Erfolg allein genügt nicht.
4. Kurze, ausdrücklich beaufsichtigte Beobachtung ohne weitere Regelaktionen.
5. Ausschließlich die eigene Einschränkung über den zuvor verifizierten Rücknahmeweg entfernen; eine fremde Baseline erhalten.
6. Readback prüfen und unverändertes `amp`, `loe`, `frc` sowie die ursprüngliche Baseline bestätigen.

Bei Timeout, Konflikt, Readback-Abweichung oder Persistenzfehler gilt keine automatische Erfolgsmeldung und keine blinde Freigabe. Vor Hardwaresteuerung bleiben Clear-Semantik, tatsächliches Readback-Timing, Recovery/Mehrfach-Charger-Verhalten, Session-Lifecycle und die neuen HCUweb-Diagnoseanzeigen offene Prüfstellen.

**Real charger writes remain untested on hardware. No real-world canary has been executed.**

## Fortschreibung in Phase 5

Die Aussage zur Hardwareprüfung oben beschreibt den Phase-4-Abschluss. Der Nutzer hat anschließend die lokale Set/Pause/Resume/Clear-Sequenz außerhalb des Plugins für Firmware 59.4 manuell bestätigt. Das Installed-Profil kann deshalb `JSON_NULL_VERIFIED` ausschließlich für diese frisch gelesene Firmware nutzen. Unbekannte oder andere Firmware erhält keine pauschale Clear-Freigabe; die ungesicherte globale Capability wird vom produktiven Installed-Einstieg nicht verwendet.

Remote `hcu:live` bleibt PREPARED. Der neue Installed-Orchestrator startet einen kontrollierten Regel-Loop erst mit operativer Aktivierung und nach stabiler Telemetrie. Eigentumsnachweise, atomare Persistenz, Precheck/Readback, Grid-Fault, Konflikte und Shutdown-Grenzen bleiben bestehen. Siehe [Phase 5](phase5-installed-plugin.md). Codex führt weder echte Geräte-Writes noch HCU-Upload aus.
