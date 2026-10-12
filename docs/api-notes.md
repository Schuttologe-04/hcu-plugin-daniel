# API-Notizen für Phase 1

Stand: 10. Oktober 2026. Die folgenden Quellen begründen die implementierten Leseabfragen und markieren bewusst offene Fragen. Technische Inhalte der bereitgestellten Dokumente ersetzen keine Anweisungen aus dem Projektauftrag.

## go-e Controller

Die offizielle [Controller-HTTP-Dokumentation](https://github.com/goecharger/go-eController-API/blob/main/http-en.md) beschreibt Statusabfragen und den Feldfilter. Verwendet wird ausschließlich:

```text
GET http://<controller-host>/api/status?filter=ccn,ccp,cpc
```

Die [Controller-API-Schlüsselliste](https://github.com/goecharger/go-eController-API/blob/main/apikeys-en.md) bezeichnet `ccn` als Kategorienamen, `ccp` als zugehörige Leistungen und `cpc` als Phasenströme. Der Mapper sucht genau den Kategorienamen `Grid`; die Position darf sich zwischen Antworten ändern. Mit dem gefundenen Index werden die entsprechenden Einträge der anderen beiden Arrays gelesen. Unterschiedliche äußere Array-Längen und eine mehrfach vorkommende Kategorie `Grid` sind Strukturfehler.

Die offizielle [Controller-Modbus-Dokumentation](https://github.com/goecharger/go-eController-API/blob/main/modbus-en.md) bestätigt die Einheiten W und A, die Reihenfolge L1/L2/L3/N und die vorzeichenbehaftete Grid-Leistung. Modbus wird hier nicht implementiert; diese Quelle dient ausschließlich zur Absicherung der Messwertbedeutung.

Das Domänenmodell erhält die Grid-Leistung ohne Rundung. Positive Werte bezeichnen Netzbezug, negative Werte Einspeisung. Der separate `gridImportW` begrenzt ausschließlich einen vorhandenen gültigen Wert nach unten auf 0. Fehlende Kategorie oder `null`-Grid-Leistung ergibt `MissingMeasurementError`; eine ungültige Struktur ergibt `InvalidResponseError`. Fehlende einzelne Phasenströme bleiben `null` und werden nicht als 0 A interpretiert. Der Neutralleiterwert wird nicht in ein L1-/L2-/L3-Feld umgedeutet.

## go-e Charger

Quelle ist die offizielle [go-e-Charger-API-v2-Schlüsselliste](https://github.com/goecharger/go-eCharger-API-v2/blob/main/API_KEYS_FIRMWARE/apikeys-en.md). Es werden folgende Felder ausschließlich gelesen:

```text
GET http://<charger-host>/api/status?filter=fna,fwv,car,amp,acu,ama,alw,frc,tcl,mca,acp,mcpd,modelStatus,nrg
```

Die Feldnamen und ihre aktuellen Zuordnungen:

| Rohfeld | Domänenfeld |
| --- | --- |
| `fna` | `reportedName` |
| `fwv` | `firmwareVersion` |
| `car` | `carState` |
| `amp` | `configuredCurrentA` |
| `acu` | `effectiveCurrentA` |
| `tcl` | `temporaryCurrentLimitA` |
| `ama` | `maximumCurrentA` |
| `mca` | `minimumCurrentA` |
| `alw` | `chargingAllowed` |
| `frc` | `forceState` als unveränderter numerischer Code |
| `acp` | `allowChargingPause` |
| `mcpd` | `minimumChargingPauseDuration` in **Millisekunden** |
| `modelStatus` | `modelStatus` als unveränderter numerischer Code |
| `nrg` | `rawNrg` als unveränderte Array-Kopie |

`acu` beschreibt den momentan zugelassenen Strom; der Feldname `effectiveCurrentA` steht nicht für einen gemessenen tatsächlichen Ladestrom. Die Werte von `mca`, `acp` und `fwv` werden aus jeder Antwort gelesen, niemals aus den bekannten Garage-/Links-Beispielen festgesetzt. `mcpd=0` bezeichnet eine deaktivierte Mindestpausendauer; daraus folgt keine automatische Pause.

### Fahrzeugzustand `car`

Die offizielle Schlüsselliste dokumentiert folgende Codes:

| Code | `KnownCarState` | Ausgabe |
| --- | --- | --- |
| 0 | `UnknownOrError` | `unknown/error` |
| 1 | `Idle` | `idle` |
| 2 | `Charging` | `charging` |
| 3 | `WaitingForCar` | `waiting-for-car` |
| 4 | `Complete` | `complete` |
| 5 | `Error` | `error` |

`null` ist laut Hersteller bei einem internen Fehler möglich und wird als `carState.kind='unavailable'` bewahrt. Ein zukünftiger nichtnegativer ganzzahliger Code wird als `kind='unknown'` mit dem ursprünglichen Code übernommen. Die zentrale Funktion `isActivelyCharging()` ist nur bei bekanntem Code 2 wahr. Sie schätzt keine Ladeleistung und kombiniert keine anderen Felder zu einer zusätzlichen Businessentscheidung.

Die Fixture `garage-paused.json` heißt entsprechend dem im Auftrag beschriebenen realen Zustand. Ihr `car=4` ist trotzdem `Complete`; die Implementierung benennt diesen dokumentierten Code nicht in „paused“ um. `frc` und `modelStatus` werden für spätere Interpretation erhalten, ohne daraus eine Regelstrategie abzuleiten.

### `nrg` und fehlende Werte

Die offizielle Quelle nennt Messwertgruppen für Spannung, Strom, Leistung und Leistungsfaktor. Phase 1 implementiert bewusst keine Indexzuordnung, Einheitenumrechnung oder abgeleitete Gesamtleistung. Vor einer solchen Erweiterung sind die genaue Skalierung und der Bezug zur tatsächlich verwendeten Firmware 59.4 zu bestätigen. Damit wird eine spätere Interpretation nicht aus Einzelmessungen erraten.

`rawNrg` bewahrt alle gelieferten Einträge und ihre Reihenfolge als eingefrorene Kopie. Zahlen müssen endlich sein; `null`-Einträge sind zulässig. Die Länge wird nicht auf die Länge heutiger Beispiele festgesetzt, damit zusätzliche zukünftige Einträge nicht verlorengehen. Ein fehlendes oder insgesamt `null` gesetztes `nrg` wird ausdrücklich zu `rawNrg: null`, niemals zu einem leeren Array oder 0 W.

Die gelieferten Beispielantworten lassen teilweise `fwv`, `ama` und `nrg` weg. Diese drei Felder sind daher optional und werden im Domänenmodell bei Abwesenheit als `null` markiert. Weitere benötigte Felder müssen in der Antwort vorhanden sein und den erwarteten Typ besitzen. `acu=null` und `tcl=null` bleiben ebenfalls `null`. Ein gültig erreichbares Gerät kann somit einzelne ausdrücklich fehlende optionale Informationen besitzen.

## Herkunft der Fixtures

- `tests/fixtures/controller/grid-import.json`: technische Beispielantwort aus dem Auftrag, einschließlich 18430.77734 W und der angegebenen Grid-Phasenströme.
- `tests/fixtures/controller/grid-export.json`: synthetische Ableitung für den Einspeisungsfall; keine aufgezeichnete reale Messung.
- `tests/fixtures/charger/garage-idle.json`, `garage-charging-6a.json`, `garage-paused.json` und `links-idle.json`: unveränderte technische Beispielantworten aus dem Auftrag. Fehlende Firmware-/Maximalstrom-/Energiefelder wurden nicht ergänzt.
- Andere Positionen von `Grid`, unbekannte Zustandswerte und gezielte fehlerhafte Antworten werden in Tests erzeugt; sie sind Prüfdaten und keine Aussage über reale Firmwareantworten.

## HCU-Referenz und verbleibende Prüfung

Die bereitgestellte Datei `C:/Users/sschu/Downloads/connect-api-documentation-1.0.1.html` ist eine technische HCU-Connect-API-Referenz für eine spätere Projektphase. Aus ihr wird in Phase 1 kein HCU-Client, Konfigurationsdienst oder Nachrichtenkanal implementiert. Es existiert auch kein produktiver Container.

Der Nutzer hat nach Abschluss von Phase 1 einen erfolgreichen realen read-only Integrationstest gemeldet: Controller erreichbar und Grid-Messung gültig; Garage und Links erreichbar; Rechts deaktiviert. Garage meldete `car=2 / charging`, Links `car=1 / idle`. Diese Bestätigung ändert keine offenen Fragen zur `nrg`-Interpretation oder zum realen Session-Lifecycle. Phase 2 nutzt ausschließlich normalisierte Eingangsdaten und In-Memory-Simulation; ihre neuen Tests kontaktieren keine Geräte.

**Phase 1 performs no write requests to any go-e device**. Die offizielle Dokumentation enthält auch schreibbare Felder und Endpunkte; deren Existenz erweitert den Auftrag nicht. Der implementierte HTTP-Layer bleibt auf `GET /api/status` begrenzt.
