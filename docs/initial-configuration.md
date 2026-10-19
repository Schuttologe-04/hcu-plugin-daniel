# Version 0.2.1 – Erstkonfiguration in einem anderen Netzwerk

Stand: 19. Oktober 2026. Dieser Hotfix korrigiert eine Konfigurationsblockade im Installed-Modus. Die bestehende Lastmanagement-Engine, HCU-Geräteprojektion, Schreibfreigabe und go-e-Control-Operationen bleiben erhalten.

## Fehlerbild und belegte Ursache

Der [Installed-Seed](../config.installed.json) enthält die lokalen Geräteadressen des ursprünglichen Standorts: Controller `192.168.0.89`, Garage `192.168.0.94`, Links `192.168.0.144`; Rechts ist deaktiviert. Auf einer zweiten HCU in einem anderen Netz sind diese Adressen möglicherweise nicht erreichbar.

Version 0.2.0 erzeugt beim Startup für einen nicht erreichbaren aktivierten Charger einen Ownership-Record `UNKNOWN` mit `CHARGER_STATUS_UNAVAILABLE`. Dieser Status kann bereits vor jedem eigenen Eingriff entstehen. Die bisherige globale Bindungssperre behandelt aber jeden Status ungleich `NONE` als ausstehende Ownership. Dadurch kann auch eine gültige neue Controller-/Charger-Adresse abgelehnt werden. Der Config-Service versucht dann die alte Konfiguration wiederherzustellen und antwortet mit `FAILED` und dem Text „Runtime konnte Konfiguration nicht übernehmen …“.

Diese Kette ist am Quellcode nachvollziehbar; sie beweist nicht allein die Ursache jeder HCUweb-Speicherfehlermeldung. Gültige `10.0.0.x`-Adressen sind im zentralen [Hostvalidator](../src/goe/device-host.ts) zulässig. Es gibt keine Einschränkung auf `192.168.0.x` und keinen Erreichbarkeitstest als Voraussetzung der AppConfig-Validierung.

## Eng begrenzte Freigabe im Hotfix

Eine neue Gerätebindung bleibt im Installed-Modus nur ohne geschützte Ownership-Evidenz zulässig:

- Ein gültiger `NONE`-Record darf keine Baseline, keinen Konflikt, kein aktives eigenes Limit, keine eigene Pause und keinen Pending-Write besitzen. Ohne Write-/Readback-Historie bleibt er freigabefähig. Vorhandene Historie muss eine vollständig und konsistent bestätigte Freigabe mit passendem Readback, letzter Beobachtung und Zeitfolge belegen; verwaiste oder widersprüchliche Nachweise bleiben gesperrt. Ein zuletzt bestätigtes PAUSE ist keine Freigabe. Eine bestätigte Rückgabe eines fremden numerischen Limits bleibt wie bisher möglich.
- Ein `UNKNOWN`-Record ist ausschließlich beim Grund `CHARGER_STATUS_UNAVAILABLE` freigabefähig. Baseline, bestätigter Write, Readback, Pending-Write, eigenes Limit und eigene Pause müssen vollständig fehlen. Eine vorhandene letzte Beobachtung muss außerdem `tcl=null`, `frc=0` und `loe=false` ausweisen; ohne letzte Beobachtung wird kein Gerätewert erfunden.
- Andere UNKNOWN-Gründe, `CONFLICT`, `RECONCILING`, bestehende Baselines, offene Writes und aktive eigene Einschränkungen bleiben geschützt. Die globale Sperre bei solcher Evidenz bleibt bewusst bestehen, auch wenn nur die Controller-Adresse geändert werden soll.

Ein reiner Telemetrieausfall eines anderen Chargers darf damit die Erstkonfiguration nicht blockieren. Ein nie beobachteter Charger wird dadurch nicht als erreichbar oder schreibberechtigt erklärt. Neue Geräte werden read-only reconciliert; ein fehlgeschlagener Read bleibt unavailable/UNKNOWN. Erreichbarkeit ist keine Voraussetzung dafür, syntaktisch gültige Konfigurationswerte zu speichern. Reale Steuerung benötigt weiterhin alle bisherigen Gates, frische Telemetrie, sichere Ownership und Precheck/Readback.

Der Actuator übernimmt einen neu aufgebauten Zustandsbestand erst nach erfolgreicher atomarer Persistenz. Bei Initialisierungs-/Persistenzfehlern darf eine teilweise vorbereitete Map den bisherigen In-Memory-Zustand nicht ersetzen. Es werden beim Rebinding keine CLEAR-, RESUME-, PAUSE- oder Limit-Writes gesendet.

Bereits bekannte geschützte Steuerungshistorie darf auch nicht durch einen fehlenden oder abweichenden Dateistand verdrängt werden. Eine solche Abweichung bleibt ein Initialisierungsfehler; der Actuator repariert die Datei nicht aus einer Vermutung. Reine Zeitaktualisierungen einer ansonsten unveränderten Statusbeobachtung sind keine neue Write-Historie. Ein bestehender Konflikt wird bei einem weiteren Leseausfall nicht in einen harmlosen Erstinstallationsausfall umbenannt.

## Fehlgeschlagene Updates und Rollback

Der bisherige Ablauf bleibt bestehen: vollständige Validierung, atomare Config-Speicherung, Runtime-Übernahme und erst danach `CONFIG_UPDATE_RESPONSE/APPLIED`. Lehnt die Runtime das Update ab, versucht der Config-Service zuerst die vorherige Config wieder zu speichern und anschließend die vorherige Runtime-Konfiguration zu übernehmen. Ein erfolgreicher Rollback erhält den bisherigen Stand; ein späteres gültiges Update bleibt möglich.

Der Hotfix prüft dabei auch ein explizites Fehlerresultat des Rollback-Stores. Kann die Disk-Konfiguration nicht wiederhergestellt werden, wird die Runtime nicht zuvor erneut aktiviert. Scheitert der Disk- oder Runtime-Rollback, stoppt die Applikation sofort den vorhandenen Regel-/Actuator-Pfad, lässt aber die HCU-Verbindung zur Diagnose offen. Weitere Config-Updates dieser Instanz werden abgewiesen. Die Antwort lautet „Konfiguration konnte nicht sicher wiederhergestellt werden. Regelung gesperrt; Persistenz prüfen und Plugin neu starten.“ Es gibt dabei kein pauschales CLEAR/RESUME.

Config und Ownership sind weiterhin getrennte atomare Dateien, keine gemeinsame Dateisystemtransaktion. Ein fehlgeschlagener Rollback kann daher unterschiedliche gespeicherte und angezeigte Configstände hinterlassen; dies wird nicht als erfolgreicher alter Zustand ausgegeben. Vor erneutem Start sind Persistenz und Diagnose gezielt zu prüfen. Beschädigte Daten werden nicht gelöscht oder mit dem Seed überschrieben.

Implementierung: [Ownership-Modell](../src/goe/control/ownership-state.ts), [Actuator](../src/goe/control/charger-actuator.ts), [LIVE-Reconfigure](../src/orchestration/live-runtime.ts), [Installed-Orchestrator](../src/orchestration/installed-runtime.ts), [Config-Service](../src/hcu/config/hcu-config-service.ts).

## Vorgehen auf der HCU

1. Auf der betroffenen 0.2.0-Installation zuerst den bestehenden Zustand festhalten: Garage/Links `UNKNOWN / CHARGER_STATUS_UNAVAILABLE`, kein ausgewiesenes eigenes Limit, keine eigene Pause, kein bestätigter Write. Den bereits vorhandenen persistenten Zustand für die Abnahme ausdrücklich erhalten; nicht durch Neuinstallation mit Datenlöschung ersetzen.
2. Nach Bereitstellung eines geprüften 0.2.1-Testpakets dieses mit erhaltenem `/data` installieren. Keine Ownership-/Session-Dateien als allgemeine Fehlerbehebung löschen.
3. In HCUweb Version, Installed-Modus und den bestehenden Schalter **Reale Laderegelung aktiv** prüfen. Auf dieser zweiten HCU bleibt er für den Konfigurationstest AUS. Ein Update erhält grundsätzlich auch einen zuvor eingeschalteten Wert; die reine Hoständerung ist keine Aufforderung, reale Steuerung zu aktivieren.
4. Controller und aktivierte Charger auf die tatsächlichen Adressen des neuen Standorts umstellen. Nur Host/IP mit optionalem Port eingeben, ohne `http://`, Pfad oder Rand-Leerzeichen. Nicht vorhandene Charger deaktivieren; nur deaktivierte Charger dürfen einen leeren Host haben.
5. Speichern: Erwartet wird `APPLIED` / „Konfiguration gespeichert und übernommen.“ Die vollständige AppConfig-Validierung bleibt bestehen. Nicht erreichbare neue Geräte verhindern die Config-Übernahme bei fehlender geschützter Evidenz nicht. Der Konfigurationswechsel darf keine SET-/PAUSE-/RESUME-/CLEAR-Aktion auslösen.
6. Dialog erneut öffnen und die gespeicherten Werte kontrollieren. Erreichbarkeit, Ownership/Konflikte und Telemetrie prüfen. Bei noch unerreichbaren neuen Geräten darf ein neuer rein telemetriebedingter UNKNOWN am neuen Host bestehen; er ist keine behauptete Erreichbarkeit oder Nullmessung.
7. Plugin kontrolliert neu starten und prüfen, dass die neuen Adressen und der ausgeschaltete operative Schalter erhalten bleiben. Der Seed darf den gespeicherten Stand nicht überschreiben. Auch der Restart darf keine pauschale Gerätefreigabe auslösen.
8. Erst nach dieser getrennten Konfigurationsabnahme sowie plausibler frischer Grid-Messung, erreichbaren kompatiblen Chargern, `loe=false`, sicherer Ownership und den bestehenden Betriebsprüfungen eine reale Regelung bewusst aktivieren. Die Telemetrie-Stabilisierung und der 30-Sekunden-Trigger bleiben erhalten.

Wenn geschützte Ownership vorliegt, ist eine abgelehnte Hoständerung weiterhin korrekt. Erst den tatsächlichen Zustand und die Herkunft der Einschränkung bewerten; keine fremden Limits/Pausen übernehmen oder pauschal zurücksetzen. [Betriebs- und Emergency-Verhalten](phase5-installed-plugin.md).

## Warum der Seed unverändert bleibt

`controller.host` ist im bestehenden [AppConfig-Schema](../src/config/config-schema.ts) immer verpflichtend, auch bei ausgeschaltetem Lastmanagement. Der Installed-Einstieg validiert den Seed vor dem Start von HCUweb. Ein leerer Host oder ein Platzhalter würde den Start verhindern; ein erfundener Dummyhost würde eine nicht vorhandene Messquelle vortäuschen.

Ein vollständig standortunabhängiger Onboarding-Modus benötigt einen ausdrücklich modellierten unkonfigurierten Zustand einschließlich Start-/Persistenz-/UI-Vertrag. Das ist nicht Teil dieses Hotfixes. Daher bleiben Seed, gültige vollständige AppConfig und `liveControlEnabled=false` bei Erstinstallation unverändert. Die Standortadressen können über HCUweb geändert werden, ohne erst die alten Geräte erreichen zu müssen. Benachrichtigungspräferenzen des Seeds werden ebenfalls nicht geändert.

Die drei vorhandenen Persistenzdateien und ihre 0.1.0-/0.2.0-Schemata bleiben kompatibel. Kein Reset, keine neue Datei und keine Schema-Migration. Bestehende Config, live true/false, Ownership-Evidenz und Nachrichtensession werden erhalten.

## Getrennter Befund: HCU-Meldungszustellung

`InvalidResponseError` mit „Installed HCU message could not be delivered“ ist ein eigener Fehlerpfad für HCU-Benutzermeldungen. Bei anhaltendem Telemetrie-FAULT kann ein Warnversuch alle 60 Sekunden entstehen. Die falschen Seed-Adressen sind dafür eine plausible FAULT-Ursache; weder der konkrete Zustand dieser HCU noch der Grund einer HCU-Nachrichtenablehnung ist durch den Logtext bewiesen.

Der Hotfix verändert weder Create/Delete/List, Nachrichtenkategorien, Timestamp-/Response-Validierung, den 60-Sekunden-Abstand noch die JA/NEIN-Verarbeitung. Ein Erfolg der Config-Übernahme ist deshalb kein Nachweis einer behobenen Meldungszustellung. Dafür werden die genaue HCU-Antwort bzw. `success`/Fehlercode, übereinstimmende Request-/Message-ID und HCU-Version ohne Zugangsdaten benötigt.

## Prüfung und verbleibende Abnahme

Am 19. Oktober 2026 wurden die folgenden Offline-Prüfungen erfolgreich abgeschlossen:

| Prüfung | Ergebnis |
| --- | --- |
| `npm test` | 1.708 Tests in 62 Dateien bestanden, Exit 0; 123 zusätzliche Tests gegenüber 0.2.0. |
| `npm run typecheck` | Erfolgreich, Exit 0. |
| `npm run build` | Erfolgreich, Exit 0. |
| `npm run simulate` | Erfolgreich, Exit 0: 22.839 W, bis 29,999 s keine Aktion; 30 s Garage 13 A; 34 s 12 A; 50 s fehlendes Grid → FAULT ohne Aktion. |
| Build-Eingaben-/Secret-Sanity | 72 erlaubte Dateien geprüft, `privateDevelopmentFilesRead=false`. |

Die neuen [Ownership-](../tests/unit/goe/control/ownership-rebinding.test.ts) und [Actuator-Regressionsdateien](../tests/unit/goe/control/actuator-rebinding.test.ts) enthalten zusammen 78 Fälle; die [Dateisystem-/App-Integration](../tests/unit/orchestration/initial-config-update.test.ts) umfasst 39 Fälle. Weitere fünf Fälle prüfen Config-Rollback und Fail-safe, ein zusätzlicher Packaging-Fall lehnt alte 0.2.0-Metadaten ab. Damit werden Erstkonfiguration mit unerreichbaren Seed-/Zielhosts, sichere und gesperrte Evidenz, Erhalt bestehender Persistenz, Rollbackfehler und null Geräte-Writes bei der Konfigurationsübernahme abgedeckt. Hardwarezugriffe sind vollständig gemockt; diese Nachweise ersetzen keine reale HCU-Abnahme.

Die Paketmetadaten und der bestehende Packaging-Pfad sind auf 0.2.1 ausgerichtet. Das beweist noch keinen erzeugten ARM64-Build oder eine reale HCU-Abnahme dieses Hotfixes. Ein neuer Paket-Build bzw. eine Installation ist gesondert auszuführen und mit tatsächlichem Archivhash zu belegen; alte 0.2.0-Paketnachweise gelten nicht als 0.2.1-Nachweis.

## Geänderte Dateien

| Bereich | Dateien |
| --- | --- |
| Zentrale Ownership-/Rebinding-Prüfung | [ownership-state.ts](../src/goe/control/ownership-state.ts), [charger-actuator.ts](../src/goe/control/charger-actuator.ts) |
| Runtime und Config-Recovery | [live-runtime.ts](../src/orchestration/live-runtime.ts), [hcu-config-service.ts](../src/hcu/config/hcu-config-service.ts), [hcu-plugin-application.ts](../src/orchestration/hcu-plugin-application.ts) |
| Versions-/Paketmetadaten | [plugin-identity.ts](../src/hcu/plugin-identity.ts), [package.json](../package.json), [package-lock.json](../package-lock.json), [Dockerfile](../Dockerfile) |
| Packaging-Prüfpfad | [check-package-inputs.mjs](../scripts/check-package-inputs.mjs), [package-hcu.ps1](../scripts/package-hcu.ps1), [validate-hcu-image.mjs](../scripts/validate-hcu-image.mjs) |
| Neue Regressionen | [ownership-rebinding.test.ts](../tests/unit/goe/control/ownership-rebinding.test.ts), [actuator-rebinding.test.ts](../tests/unit/goe/control/actuator-rebinding.test.ts), [initial-config-update.test.ts](../tests/unit/orchestration/initial-config-update.test.ts) |
| Erweiterte bestehende Tests | [hcu-config-service.test.ts](../tests/unit/hcu/hcu-config-service.test.ts), [packaging.test.ts](../tests/unit/packaging/packaging.test.ts) |
| Dokumentation | Diese [initial-configuration.md](initial-configuration.md), [README.md](../README.md), [CHANGELOG.md](../CHANGELOG.md), [hcu-integration.md](hcu-integration.md), [phase4-actuator-safety.md](phase4-actuator-safety.md), [phase5-installed-plugin.md](phase5-installed-plugin.md) |

Die Lastmanagement-Engine, TelemetryHealthGuard, Installed-Scheduler, read-only Statusclients/Mapper, typisierter HTTP-Control-Client, HmIP-Device-Projektion, HCU-Transport/UserMessages, Config-Validator und Erstinstallations-Seed sind gegenüber v0.2.0 unverändert. Insbesondere bleibt der bisherige `tcl`-/`frc`-Client der einzige produktive `/api/set`-Pfad; kein neuer HTTP-Write und kein neues Polling werden eingeführt.
