# Škálovatelné zpracování telemetrie zařízení

Řešení domácího úkolu podle zadání `main-spec/Domácí úkol BE.pdf`.

Emulovaná zařízení posílají telemetrii přes dlouhodobá WebSocket spojení. Služba **ingest** zprávy validuje a publikuje je do RabbitMQ. Služba **processing** je čte z fronty, ukládá je do MongoDB a udržuje aktuální stav každého zařízení. Obě služby se škálují horizontálně. Stav zařízení zůstává konzistentní i při duplicitních zprávách, zprávách mimo pořadí a souběžném zpracování ve více instancích.

Technologie: Node.js 24, striktní TypeScript, pnpm monorepo, RabbitMQ 4.3, MongoDB 8.0, Docker Compose, Vitest.

## Obsah

- [Architektura a tok dat](#architektura-a-tok-dat)
- [Spuštění systému](#spuštění-systému)
- [Škálování](#škálování)
- [Konfigurace emulátoru](#konfigurace-emulátoru)
- [Testy](#testy)
- [Metadata zpráv](#metadata-zpráv)
- [Datový model](#datový-model)
- [Pořadí, deduplikace, atomicita a race conditions](#pořadí-deduplikace-atomicita-a-race-conditions)
- [Chování při selhání](#chování-při-selhání)

## Architektura a tok dat

```text
  ┌──────────────────────────┐
  │ emulator                 │  N zařízení v jednom procesu,
  │ apps/emulator            │  každé s vlastním spojením a vlastním pořadím zpráv
  └────────────┬─────────────┘
               │  WebSocket ws://ingest:4000/telemetry
               │  jedna JSON zpráva = jedna textová WebSocket zpráva
               ▼
  ┌──────────────────────────┐
  │ ingest × N               │  validace sdíleným schématem,
  │ apps/ingest              │  žádný stav zařízení
  └────────────┬─────────────┘
               │  AMQP publish: persistent, publisher confirms
               ▼
  ┌──────────────────────────┐
  │ RabbitMQ 4.3             │  exchange telemetry (direct, routing key event)
  │                          │    → quorum fronta telemetry.events
  │                          │  odmítnutá zpráva nebo 5 pokusů o doručení
  │                          │    → exchange telemetry.dlx → fronta telemetry.dead
  └────────────┬─────────────┘
               │  competing consumers, prefetch 50,
               │  ruční ack až po zápisech do MongoDB
               ▼
  ┌──────────────────────────┐
  │ processing × M           │  validace, tři idempotentní zápisy,
  │ apps/processing          │  podmíněná aktualizace stavu
  └────────────┬─────────────┘
               │  write concern s journalem
               ▼
  ┌──────────────────────────┐
  │ MongoDB 8.0              │  events        jeden dokument na unikátní událost
  │ databáze telemetry       │  device_state  jeden dokument na zařízení
  │                          │  alerts        jeden dokument na chybovou diagnostiku
  └──────────────────────────┘

  packages/shared: kontrakt zprávy, pravidlo „novější“, názvy front a kolekcí,
  konfigurace z proměnných prostředí, logger. Používají ho všechny tři aplikace.
```

Struktura repozitáře:

```text
apps/emulator/      emulovaná zařízení: WebSocket klienti, generátor událostí, problémové scénáře
apps/ingest/        WebSocket server, validace, publikace do RabbitMQ
apps/processing/    consumer RabbitMQ, zápisy do MongoDB
packages/shared/    kontrakt zprávy, pravidlo „novější“, topologie, konfigurace, logger
test/integration/   integrační testy nad skutečným RabbitMQ a MongoDB
test/harness/       testovací prostředí: stack, virtual host a databáze na test, generátor zátěže
scripts/            ověření Docker Compose stacku
docs/specs/         návrhové dokumenty s rozhodnutími a kompromisy
docs/plans/         implementační plány
```

Cesta jedné zprávy:

1. Zařízení vytvoří zprávu s identitou `(deviceId, sessionId, seq)` a pošle ji ingestu.
2. Ingest zprávu dekóduje a ověří schématem. Textovou zprávu, která není platný JSON nebo neodpovídá schématu, zaloguje a zahodí. Spojení přitom zůstává otevřené.
3. Ingest publikuje ověřenou zprávu do exchange `telemetry` jako persistentní zprávu. Přidá `messageId` (identita jako text) a hlavičku `x-received-at` (čas přijetí). Pak čeká na publisher confirm, tedy na potvrzení, že broker zprávu uložil.
4. RabbitMQ uloží zprávu do fronty `telemetry.events`. Je to quorum fronta: ukládá zprávy na disk a počítá pokusy o doručení. Zprávy, které nejde zpracovat, broker přesune do dead-letter fronty `telemetry.dead`.
5. Zprávu dostane jedna z instancí processingu. Všechny instance čtou stejnou frontu a broker dá každou zprávu jen jedné z nich (competing consumers). Prefetch omezuje počet nepotvrzených zpráv na jednu instanci.
6. Processing zprávu znovu ověří a provede tři idempotentní zápisy. Idempotentní zápis má stejný výsledek, ať proběhne jednou, nebo vícekrát. Processing uloží událost, podmíněně upraví stav zařízení a u chybové diagnostiky vytvoří alert.
7. Až MongoDB potvrdí zápisy, processing potvrdí zprávu brokeru (`basic.ack`).

## Spuštění systému

### Požadavky

| Úkol                                 | Potřeba                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| spuštění celého systému              | Docker Engine 25 nebo novější a Docker Compose 2.20.2 nebo novější                                 |
| ověřovací skript `compose-check.mjs` | navíc Node.js 24; skript nemá závislosti, `pnpm install` není potřeba                              |
| testy a vývoj                        | navíc Node.js 24.10 nebo novější 24.x a pnpm 10 (`corepack enable` použije verzi z `package.json`) |

Minimální verze Dockeru plynou z health checků. Používají `start_interval`, který vyžaduje Compose 2.20.2 a Docker Engine 25. Pro běh systému nejsou Node ani pnpm na hostu potřeba, protože se aplikace sestaví uvnitř Docker image.

### Start

```bash
docker compose up -d --build --wait
```

Příkaz sestaví image aplikací a spustí RabbitMQ, MongoDB, ingest, processing a emulátor s 10 zařízeními. Ingest startuje až po zdravém RabbitMQ, processing po zdravém RabbitMQ i MongoDB a emulátor po zdravém ingestu. Příkaz skončí, až všechny služby běží a jejich health checky projdou.

### Ověření end-to-end

```bash
node scripts/compose-check.mjs
```

Skript sám spustí `docker compose up -d --build --wait` a pro každou kontrolu vypíše řádek `PASS` nebo `FAIL`:

- stack běží a služby jsou zdravé;
- data se uložila do MongoDB: počet dokumentů v `device_state` se rovná počtu zařízení a v `events` je aspoň jedna událost.

Skript porovnává počet dokumentů `device_state` s počtem zařízení přesně. Pokud v databázi zůstala data z běhu s jiným počtem zařízení, spusťte předtím `docker compose down -v`.

### Jak se podívat na data

Stav jednoho zařízení a počty dokumentů v MongoDB:

```bash
docker compose exec mongodb sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin telemetry --eval "printjson(db.device_state.findOne({ _id: \"dev-0001\" }))"'
docker compose exec mongodb sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin telemetry --eval "printjson({ state: db.device_state.countDocuments(), events: db.events.countDocuments(), alerts: db.alerts.countDocuments() })"'
```

Příkazy čtou jméno a heslo z proměnných uvnitř kontejneru. Na příkazové řádce hostitele se tak neobjeví.

Další možnosti:

- **RabbitMQ management UI** běží na <http://localhost:15672>. Přihlašovací údaje jsou vývojové hodnoty `RABBITMQ_USER` a `RABBITMQ_PASSWORD` v `docker-compose.yml`. U fronty `telemetry.events` je vidět počet consumerů. Fronta `telemetry.dead` obsahuje zprávy, které nešlo zpracovat.
- **Logy** jsou JSON řádky. Každá aplikace zapíše každých 10 sekund souhrnný řádek. Ingest (`summary`) počítá spojení a zprávy, processing (`summary`) výsledky zpracování a emulátor (`emulator fleet summary`) odeslané zprávy:

  ```bash
  docker compose logs ingest | grep '"msg":"summary"'
  ```

- **Readiness** říká, jestli služba může přijímat práci. Ingest i processing ji vrací na `GET /readyz` s kódem 200 nebo 503. Endpoint používá health check Compose:

  ```bash
  docker compose exec ingest wget -qO- http://127.0.0.1:8080/readyz
  ```

### Problémové scénáře

Emulátor umí posílat duplicity, prohazovat pořadí zpráv, přerušovat spojení a restartovat zařízení. Tento příkaz spustí emulátor znovu se všemi čtyřmi scénáři:

```bash
EMULATOR_CHAOS=duplicate,out-of-order,disconnect,restart docker compose up -d --wait emulator
docker compose logs processing | grep '"outcome":"stale"'
```

Processing loguje na úrovni `info` každou zprávu s výsledkem `stale` nebo s příznakem `duplicate`. Výsledek `"outcome":"stale"` znamená, že uložená sekce stavu je novější nebo stejná a zpráva stav nezměnila. Příznak `"duplicate":true` znamená, že událost už byla uložená. Ostatní zprávy s výsledky `created` a `applied` jsou na úrovni `debug`.

### Zastavení

```bash
docker compose down        # zastaví a odstraní kontejnery, data ve volumes zůstanou
docker compose down -v     # odstraní i data
```

## Škálování

```bash
docker compose up -d --build --wait --scale ingest=2 --scale processing=3
```

Ověření škálování:

```bash
node scripts/compose-check.mjs --scale --down
```

Skript s přepínačem `--scale` spustí stack sám se 2 instancemi ingestu a 3 instancemi processingu, takže první příkaz před ním není potřeba. Přidá dvě kontroly: každá instance processingu má na frontě jednoho consumera a zařízení jsou připojená ke všem instancím ingestu. Přepínač `--down` na konci odstraní stack i s daty.

Jak se práce rozdělí:

- **Ingest.** Služba nemá publikovaný port, takže `--scale` nenarazí na konflikt portů. Název `ingest` se v síti Compose přeloží na adresy všech replik. Emulátor přeloží přes DNS každou položku `INGEST_HOSTS` a všechny adresy spojí do jednoho seznamu. Každé zařízení si při každém připojení vybere jednu adresu náhodně. Rozdělení je proto statistické, ne přesně vyvážené. Existující spojení se po přidání repliky nepřesouvají. Nová replika dostane zařízení, která se připojí znovu. Ingest nedrží stav zařízení, takže se zařízení může při novém připojení dostat k jiné instanci bez jakékoli koordinace.
- **Processing.** Všechny instance konzumují stejnou frontu `telemetry.events`. Broker dá každou zprávu jen jednomu consumerovi s volným místem v prefetch. Zprávy se nedělí podle zařízení a instance nic nepřerozdělují. Konzistenci zajišťuje podmíněný zápis v MongoDB, ne pořadí zpracování. Propustnost roste s počtem instancí, dokud ji nezačne omezovat MongoDB.
- **Zařízení.** Počet zařízení se zvyšuje proměnnou, ne dalšími kontejnery emulátoru:

  ```bash
  EMULATOR_DEVICE_COUNT=200 docker compose up -d --build --wait
  ```

  `--scale emulator=N` nepoužívejte. Všechny repliky by měly stejný prefix, a tedy stejná id zařízení. Replika s vyšším `sessionId` by trvale vyhrávala a zprávy ostatních replik by byly zastaralé. Repliky spuštěné ve stejné milisekundě by vytvářely stejné identity zpráv a deduplikace by je zahodila.

## Konfigurace emulátoru

Emulátor čte konfiguraci jen z proměnných prostředí. Každou hodnotu ověří při startu. Neplatná hodnota ukončí proces s chybou, která jmenuje proměnnou. Prázdná hodnota znamená výchozí hodnotu.

| Proměnná                     | Výchozí       | Význam                                                                                                                                                                | Nastavitelná v Compose |
| ---------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `EMULATOR_DEVICE_COUNT`      | `10`          | Počet emulovaných zařízení v jednom procesu.                                                                                                                          | ano                    |
| `EMULATOR_EVENT_INTERVAL_MS` | `1000`        | Interval mezi událostmi `metrics` jednoho zařízení v milisekundách. Nižší hodnota znamená vyšší zátěž.                                                                | ano                    |
| `EMULATOR_CHAOS`             | prázdné       | Problémové scénáře: čárkami oddělená podmnožina `duplicate`, `out-of-order`, `disconnect`, `restart`. Neznámý název ukončí start.                                     | ano                    |
| `EMULATOR_SEED`              | `1`           | Seed generátoru náhodných čísel. Stejný seed dá stejnou flotilu, stejné hodnoty a stejná rozhodnutí scénářů.                                                          | ano                    |
| `LOG_LEVEL`                  | `info`        | `trace`, `debug`, `info`, `warn`, `error`, `fatal` nebo `silent`. V Compose platí pro všechny tři aplikace.                                                           | ano                    |
| `INGEST_HOSTS`               | `ingest:4000` | Adresy ingestu jako čárkami oddělené `host:port`. Všechny přeložené adresy se spojí a zařízení si při připojení vybere jednu náhodně. Cesta je `/telemetry`.          | pevně `ingest:4000`    |
| `EMULATOR_DEVICE_ID_PREFIX`  | `dev`         | Prefix id zařízení: `dev-0001`, `dev-0002` atd. Jen písmena, číslice a podtržítko.                                                                                    | ne                     |
| `EMULATOR_HEARTBEAT_MS`      | `30000`       | Když zařízení po tuto dobu neposlalo `status`, pošle ho znovu. Ztracený `status` se tak nahradí nejpozději po tomto intervalu.                                        | ne                     |
| `EMULATOR_OUTBOX_MAX`        | `1000`        | Velikost outboxu, tedy fronty neodeslaných zpráv v paměti zařízení. Při zaplnění zařízení zahodí nejstarší zprávu, která není diagnostika, a zapíše varování do logu. | ne                     |
| `EMULATOR_CHAOS_PERCENT`     | `5`           | Pravděpodobnost v procentech, že scénář `duplicate` nebo `out-of-order` zasáhne jednu zprávu.                                                                         | ne                     |
| `EMULATOR_CHAOS_INTERVAL_MS` | `60000`       | Průměrná doba mezi scénáři `disconnect` nebo `restart` u jednoho zařízení. Skutečná doba je náhodně 0,5× až 1,5× této hodnoty. Minimum je 1000.                       | ne                     |
| `SHUTDOWN_TIMEOUT_MS`        | `10000`       | Jak dlouho emulátor po SIGTERM dokončuje odesílání. Každé zařízení se při řízeném zastavení pokusí poslat `status: offline`.                                          | ne                     |

Proměnné s „ano“ lze nastavit v shellu nebo v souboru `.env` vedle `docker-compose.yml`. Soubor `docker-compose.yml` proměnné s „ne“ záměrně nepředává, aby výchozí hodnoty neměly dva zdroje. Pro jejich změnu je přidejte do sekce `environment` služby `emulator`. Konfiguraci ingestu a processingu (okna potvrzení, timeouty, prefetch) popisuje `.env.example` včetně výchozích hodnot.

Scénáře v `EMULATOR_CHAOS`:

| Scénář         | Co se stane                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate`    | Stejná zpráva se stejnou identitou odejde dvakrát.                                                                                                        |
| `out-of-order` | Zpráva se podrží a odejde až po následující zprávě. Dvě sousední hodnoty `seq` se tak prohodí.                                                            |
| `disconnect`   | Zařízení zavře spojení a znovu se připojí. Session, `seq` i outbox zůstávají.                                                                             |
| `restart`      | Simulovaný restart zařízení. Zařízení ztratí outbox, podrženou zprávu, čítače i naměřené hodnoty. Otevře novou session s vyšším `sessionId` a `seq` od 1. |

Co zařízení posílá:

| Typ          | Kdy                                                                                                                                                                                 | Obsah                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `metrics`    | každých `EMULATOR_EVENT_INTERVAL_MS`                                                                                                                                                | teplota, zátěž CPU a RAM                                       |
| `counters`   | s každou pátou událostí `metrics`                                                                                                                                                   | `operationsTotal` a `uptimeMs`, kumulativně od začátku session |
| `status`     | při startu (`online`), při změně mezi `online` a `degraded`, po `EMULATOR_HEARTBEAT_MS` bez jiného `status` a při řízeném zastavení (`offline`)                                     | stav zařízení                                                  |
| `diagnostic` | nejvýš jedna v intervalu, v tomto pořadí: `error` `E_OVERHEAT` při přechodu nad 85 °C; jinak `warning` `E_DEGRADED` při přechodu do `degraded`; jinak `info` s pravděpodobností 2 % | závažnost, kód a text                                          |

Přibližně 10 % zařízení má vyšší teplotu, aby se v krátkém demu objevily alerty.

## Testy

```bash
pnpm install --frozen-lockfile
pnpm test                  # unit a integrační testy, potřebuje Docker
pnpm test:unit             # jen unit testy, bez Dockeru
pnpm test:integration      # jen integrační testy
pnpm lint && pnpm typecheck && pnpm format:check
```

Stav 2026-09-15: 953 testů ve 49 souborech, z toho 32 integračních ve 4 souborech. Celá sada běží asi 75 sekund.

Integrační testy běží proti skutečnému RabbitMQ a MongoDB, ne proti mockům. Vitest v `globalSetup` spustí RabbitMQ a MongoDB z `docker-compose.test.yml`. Po testech stack odstraní, pokud ho tento běh spustil. Stack spuštěný ručně nechá běžet. Testovací stack má vlastní název projektu (`telemetry-test`), vlastní porty (5673, 15673, 27018) a žádné volumes. Může proto běžet současně s vývojovým stackem. Každý test dostane vlastní virtual host v RabbitMQ a vlastní databázi v MongoDB, takže se testy neovlivňují.

- Reset testovacího stacku: `docker compose -f docker-compose.test.yml down -v`.
- Dva běhy testů současně na jednom stroji potřebují pro druhý běh jiný `COMPOSE_PROJECT_NAME` a jiné hodnoty `TEST_AMQP_PORT`, `TEST_RABBITMQ_MANAGEMENT_PORT` a `TEST_MONGODB_PORT`.
- CI (GitHub Actions, `.github/workflows/ci.yml`) spouští při každém pushi `format:check`, `lint`, `typecheck` a `pnpm test` včetně integračních testů.

Co testy pokrývají:

| Oblast                    | Kde                                            | Co ověřují                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit testy                | `*.test.ts` vedle kódu v `apps/` a `packages/` | schéma a dekódování zpráv; pravidlo „novější“ a jeho shodu s výrazem pro MongoDB; klasifikaci chyb; stavové automaty publisheru a consumeru; generátor a scénáře emulátoru; konfiguraci                                                                                                                                 |
| pipeline P1–P6            | `test/integration/pipeline.test.ts`            | cestu od zařízení přes ingest, RabbitMQ a processing do MongoDB; duplicita nemá efekt; starší zpráva nepřepíše novější stav; pořadí po sekcích; restart session; 20 zařízení paralelně s duplicitami a prohozeným pořadím                                                                                               |
| ingest I1–I7              | `test/integration/ingest-publisher.test.ts`    | vlastnosti publikované zprávy; restart brokeru bez ztráty; smazaná fronta; resource alarm; SIGTERM; nevalidní zpráva se do fronty nedostane; zamrzlý broker                                                                                                                                                             |
| processing C6–C15         | `test/integration/processing-consumer.test.ts` | dvě instance nad jednou frontou; zprávy, které nelze zpracovat (poison), v dead-letter frontě; zastavená a zamrzlá MongoDB; chybné přihlašovací údaje k MongoDB; restart brokeru; řízené zastavení, i s čekající registrací consumera u zamrzlého brokeru; obnova po pádu mezi zápisy; trvalé uložení potvrzených zpráv |
| testovací prostředí H1–H7 | `test/integration/harness-recovery.test.ts`    | úklid prostředí po testu, který selhal uprostřed simulované poruchy                                                                                                                                                                                                                                                     |
| Docker Compose stack      | `scripts/compose-check.mjs`                    | end-to-end tok a škálování ve vývojovém stacku                                                                                                                                                                                                                                                                          |

Co testy nepokrývají:

- Náklady mechanismu konzistence na propustnost nejsou změřené benchmarkem.
- Žádný test nepošle SIGTERM skutečnému procesu, který právě zpracovává zprávy. Testy se samostatným procesem (I5, C11) posílají SIGTERM nečinné službě. Dokončení rozpracovaných zpráv při zastavení ověřuje C11b uvnitř testovacího procesu.
- Ověřovací skript Docker Compose stacku v CI neběží.

## Metadata zpráv

Každá zpráva je jeden JSON objekt:

```json
{
  "v": 1,
  "deviceId": "dev-0001",
  "sessionId": 1789481081072,
  "seq": 31,
  "occurredAt": 1789481102606,
  "type": "metrics",
  "payload": { "temperatureC": 87.19, "cpuPercent": 0.89, "ramPercent": 51.65 }
}
```

| Pole               | Význam                                                          | Proč                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`                | verze kontraktu, nyní `1`                                       | nekompatibilní změnu kontraktu lze rozpoznat u každé zprávy                                                                                            |
| `deviceId`         | id zařízení, 1–64 znaků `[A-Za-z0-9_-]`                         | určuje, čí stav zpráva mění; je první částí identity zprávy                                                                                            |
| `sessionId`        | čas startu session zařízení v milisekundách od epochy           | po restartu zařízení začne `seq` znovu od 1, ale nová session má vyšší `sessionId`, takže její zprávy jsou novější; zařízení nemusí nic trvale ukládat |
| `seq`              | pořadové číslo zprávy v session, od 1, o 1 vyšší u každé zprávy | logické pořadí vzniká na zařízení, ne podle pořadí příchodu; řada je souvislá, takže lze poznat mezeru                                                 |
| `occurredAt`       | čas vzniku podle hodin zařízení v milisekundách                 | jen pro zobrazení a diagnostiku; o pořadí nerozhoduje, protože hodiny zařízení nejsou synchronizované a mohou skočit                                   |
| `type` a `payload` | jeden ze čtyř typů událostí a jeho absolutní hodnoty            | viz níže                                                                                                                                               |

- **Identita zprávy** je trojice `(deviceId, sessionId, seq)`, v textové podobě `dev-0001:1789481081072:31`. Vzniká na zařízení. Znovu odeslaná zpráva má proto stejnou identitu a deduplikace ji pozná. Žádné UUID se negeneruje.
- **Klíč pořadí** je dvojice `(sessionId, seq)`. Porovnává se lexikograficky: nejdřív `sessionId`, při shodě `seq`.
- **`sessionId` nesmí klesnout.** Emulátor ho v rámci jednoho běhu počítá jako `max(Date.now(), předchozí sessionId + 1)`, takže dvě session jednoho zařízení nikdy nesdílí stejnou hodnotu. Mezi běhy emulátoru ho určují hodiny, se kterými souvisí kompromis v sekci limitů.
- **Ingest přidává** při publikaci AMQP property `messageId` s identitou v textové podobě, `timestamp` v sekundách a hlavičku `x-received-at` s časem přijetí v milisekundách. Processing čas přijetí ukládá jako `receivedAt`. Pro správnost výsledku potřeba nejsou.
- **Schéma je striktní.** Neznámé klíče se odmítnou na každé úrovni. `sessionId` musí ležet mezi roky 2017 a 2099, takže hodiny v sekundách nebo nenastavené hodiny se odmítnou hned při validaci. TypeScript typy jsou odvozené ze zod schématu v `packages/shared`.

Typy událostí:

| `type`       | `payload`                                                     |
| ------------ | ------------------------------------------------------------- |
| `status`     | `state`: `online`, `degraded` nebo `offline`                  |
| `metrics`    | `temperatureC`, `cpuPercent`, `ramPercent`                    |
| `counters`   | `operationsTotal`, `uptimeMs`, kumulativně od začátku session |
| `diagnostic` | `severity` (`info`, `warning`, `error`), `code`, `message`    |

Každá zpráva nese celou aktuální hodnotu svého typu, nikdy rozdíl. Stejná zpráva použitá dvakrát dá stejný výsledek. Starší zprávu stačí zahodit. Ztracenou periodickou zprávu opraví další zpráva stejného typu. Čítače jsou kumulativní, takže duplicitní zpráva nemůže čítač zvýšit dvakrát. Processing nikdy nesčítá, jen uloží nejnovější hodnotu.

Co by se stalo bez těchto metadat:

| Varianta                         | Důsledek                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| pořadí podle příchodu, bez `seq` | Starší zpráva, která přijde později, přepíše novější stav.                                                                            |
| jen `seq`, bez `sessionId`       | Po restartu zařízení začne `seq` od 1. Nové zprávy vypadají starší než staré a stav zamrzne. Zařízení by muselo `seq` trvale ukládat. |
| časové razítko místo `seq`       | Dvě události ve stejné milisekundě kolidují a posun hodin přehází pořadí.                                                             |
| náhodné UUID jako identita       | Znovu odeslaná zpráva dostane nové UUID a deduplikací projde.                                                                         |
| čítače jako přírůstky            | Duplicita zvýší čítač dvakrát a ztracená zpráva je trvalá chyba. Bylo by potřeba zpracování přesně jednou.                            |

## Datový model

### RabbitMQ

| Objekt             | Druh     | Vlastnosti                                                                                                 |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `telemetry`        | exchange | `direct`, durable                                                                                          |
| `telemetry.events` | fronta   | quorum, `x-delivery-limit: 5`, dead-letter exchange `telemetry.dlx`, vazba na `telemetry` s klíčem `event` |
| `telemetry.dlx`    | exchange | `fanout`, durable                                                                                          |
| `telemetry.dead`   | fronta   | quorum, vazba na `telemetry.dlx`                                                                           |

Topologii deklarují obě služby při startu. Deklarace je idempotentní. Quorum fronta je typ fronty, který RabbitMQ doporučuje pro bezpečnost dat. Počet pokusů o doručení, který quorum fronta počítá, používá `x-delivery-limit`. Frontu `telemetry.dead` nic nekonzumuje. Zprávy v ní se prohlížejí v management UI.

### MongoDB

Databáze `telemetry` má tři kolekce. Processing při startu vytvoří unikátní index a consumera zaregistruje až potom, protože deduplikace unikátní index potřebuje.

**`events`** obsahuje jeden dokument na každou unikátní událost. Je to úplná historie.

```text
{ _id: ObjectId, deviceId, sessionId, seq, type, occurredAt, receivedAt, processedAt, payload }

unikátní index { deviceId: 1, sessionId: 1, seq: 1 }   deduplikační klíč; prefix slouží dotazům na jedno zařízení
```

**`device_state`** obsahuje aktuální stav: jeden dokument na zařízení s `_id` rovným `deviceId`. Každý typ události má vlastní sekci. Sekce nese hodnoty události svého typu s nejvyšším klíčem `(sessionId, seq)` a tento klíč jako vlastní watermark. Watermark je klíč pořadí události, ze které sekce pochází. Skutečný dokument z běžícího systému:

```json
{
  "_id": "dev-0001",
  "lastEvent": {
    "sessionId": 1789481081072,
    "seq": 31,
    "type": "metrics",
    "receivedAt": 1789481102607
  },
  "status": {
    "state": "degraded",
    "sessionId": 1789481081072,
    "seq": 3,
    "occurredAt": 1789481081522,
    "receivedAt": 1789481081522
  },
  "metrics": {
    "temperatureC": 87.19,
    "cpuPercent": 0.89,
    "ramPercent": 51.65,
    "sessionId": 1789481081072,
    "seq": 31,
    "occurredAt": 1789481102606,
    "receivedAt": 1789481102607
  },
  "counters": {
    "operationsTotal": 50,
    "uptimeMs": 19522,
    "sessionId": 1789481081072,
    "seq": 29,
    "occurredAt": 1789481100594,
    "receivedAt": 1789481100595
  },
  "diagnostic": {
    "severity": "info",
    "code": "E_NET_RETRY",
    "message": "network request retried",
    "sessionId": 1789481081072,
    "seq": 24,
    "occurredAt": 1789481096575,
    "receivedAt": 1789481096578
  }
}
```

**`alerts`** obsahuje jeden dokument na diagnostiku se `severity: "error"`. `_id` je identita zprávy, například `dev-0001:1789481081072:20`. Dokument nese `deviceId`, `sessionId`, `seq`, `code`, `message`, `occurredAt` a `createdAt`. Alert se nikam neposílá. Je to odvozený business efekt, na kterém lze ukázat, že duplicita nevytvoří druhý alert.

Proč má každá sekce vlastní watermark:

- Typy událostí se mohou předběhnout. Když se uloží `metrics` se `seq` 5 a potom přijde `status` se `seq` 4, je to pořád nejnovější známý status. S jedním watermarkem na zařízení by se zahodil.
- Watermark po sekcích dá správný konečný stav každé sekce. Celý dokument se přitom mění jednou atomickou operací.
- `lastEvent` je watermark celého zařízení. Posune se jen u zprávy, která je novější než všechno uložené. Čtenář z něj pozná, k jakému okamžiku stav platí. Podle `now - lastEvent.receivedAt` pozná zařízení, které přestalo posílat.
- Dokument záměrně nemá nepodmíněné `updatedAt`. Měnilo by se při každém zápisu, i u zastaralé zprávy.
- Čítače patří k session, ze které pocházejí. První `counters` nové session sekci nahradí, takže čítače začínají v každé session od nuly. Součet přes session lze spočítat z `events`.

## Pořadí, deduplikace, atomicita a race conditions

Race condition je chyba, kdy výsledek závisí na tom, která ze souběžných operací doběhne dřív. V tomto systému hrozí všude, kde dvě zprávy stejného zařízení zpracovávají souběžně dva handlery, nebo kde stejná zpráva přijde dvakrát.

### Pravidlo „novější“

Aktuální stav zařízení je dokument v `device_state`. Pro každý typ události nese hodnoty z události s nejvyšším klíčem `(sessionId, seq)`. Novost určuje jen tento klíč, ne čas příchodu ani `occurredAt`.

Událost typu `T` se použije pro sekci `T`, když sekce ještě neexistuje nebo když je klíč události lexikograficky větší než watermark sekce. Stejný klíč je duplicita a nepoužije se. Pravidlo má jedinou definici, funkci `isNewer` v `packages/shared`. Unit test ověřuje, že výraz pro MongoDB v processingu dává ve stejných případech stejný výsledek.

### Atomický podmíněný zápis

Porovnání neprobíhá v aplikaci po přečtení dokumentu. Vyhodnotí ho MongoDB uvnitř jedné operace nad jedním dokumentem. Operace je upsert, tedy update, který dokument vytvoří, když ještě neexistuje. Zjednodušeně podle `apps/processing/src/state-update.ts`:

```js
// Výraz „zpráva je novější než to, co je uložené na cestě path“.
const newer = (path) => ({
  $or: [
    { $eq: [{ $type: `$${path}` }, 'missing'] }, // nic uloženého
    { $lt: [`$${path}.sessionId`, sessionId] }, // uložená session je starší
    { $and: [{ $eq: [`$${path}.sessionId`, sessionId] }, { $lt: [`$${path}.seq`, seq] }] },
  ],
});

const before = await deviceState.findOneAndUpdate(
  { _id: deviceId }, // jediná rovnost na unikátním _id
  [
    {
      $set: {
        [type]: { $cond: { if: newer(type), then: { $literal: section }, else: `$${type}` } },
        lastEvent: {
          $cond: { if: newer('lastEvent'), then: { $literal: lastEvent }, else: '$lastEvent' },
        },
      },
    },
  ],
  { upsert: true, returnDocument: 'before' },
);
```

Proč je to bezpečné:

- MongoDB vyhodnotí `$cond` proti dokumentu tak, jak je v okamžiku zápisu, a výsledek zapíše atomicky. Mezi čtením a zápisem není žádné okno. Starší klíč nemůže přepsat novější ani při souběžných zápisech, protože pozdější zápis vidí sekci, kterou zapsal dřívější.
- Filtr je jen `_id`, takže upsert nového zařízení nevytvoří druhý dokument. Když dvě první zprávy nového zařízení současně vkládají dokument, server kolizi převede na update. Kdyby přesto vrátil chybu duplicitního klíče (kód 11000), handler zápis jednou zopakuje. Dokument už existuje a rozhodne `$cond`.
- Varianta s podmínkou ve filtru (`{ _id, 'metrics.seq': { $lt: seq } }` s upsertem) byla zamítnuta. U zastaralé zprávy filtr nic nenajde, upsert zkusí vložit druhý dokument se stejným `_id` a skončí chybou 11000. Každá zastaralá zpráva by stála chybu a další round trip (dotaz a odpověď).
- `$literal` zabrání tomu, aby MongoDB četl text začínající znakem `$` (například `message` diagnostiky) jako cestu k poli.
- Výsledek `created`, `applied` nebo `stale` určí processing z dokumentu před zápisem (`returnDocument: 'before'`) stejnou funkcí `isNewer`.

### Deduplikace

Deduplikace je v databázi, ne v paměti procesu. Duplicitní zpráva totiž může přijít do jiné instance, o minuty později nebo po restartu. Každý ze tří zápisů duplicitu odmítne sám:

| Zápis                                        | Co udělá s duplicitou                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `events.insertOne`                           | unikátní index `(deviceId, sessionId, seq)` vrátí chybu 11000; handler to bere jako „už uloženo“ a pokračuje |
| podmíněný zápis do `device_state`            | stejný klíč není novější, nic se nezmění (`stale`)                                                           |
| `alerts.insertOne` (jen diagnostika `error`) | `_id` je identita zprávy, druhý insert vrátí chybu 11000                                                     |

Každý efekt je idempotentní. Handler se proto před zápisem nemusí ptát, jestli zprávu už viděl. Události se ukládají bez časového limitu, takže deduplikace funguje i po dlouhé době.

### Atomicita celého zpracování

Atomicky musí proběhnout porovnání klíče se zápisem sekce stavu. To zajišťuje podmíněný zápis výše. Vložení události a vložení alertu jsou samostatné atomické operace.

Handler jedné zprávy postupuje v pevném pořadí:

1. ověří tělo zprávy: nejvýš 64 KiB, platné UTF-8 a schéma; chybné tělo odmítne do dead-letter fronty; chybějící nebo neplatnou hlavičku `x-received-at` nahradí vlastním časem a zapíše varování;
2. `events.insertOne`;
3. podmíněný zápis do `device_state`;
4. u diagnostiky se `severity: "error"` `alerts.insertOne`;
5. `basic.ack`.

Každý zápis je jedna operace nad jedním dokumentem, a MongoDB ji proto provede atomicky. Celé zpracování není jedna transakce a nemusí být. Každý krok je idempotentní, takže pád mezi kroky opraví opakované doručení (redelivery). Hotové kroky se nezmění a chybějící se doplní. Transakce přes více dokumentů by potřebovala replica set, stála by víc na každou zprávu a nic by nepřidala.

Zápisy používají write concern `{ w: MONGODB_WRITE_W, journal: true }`. Processing potvrdí zprávu brokeru, až když je zápis v journalu na disku. Pád MongoDB tak nesmaže zápis, který broker už považuje za hotový.

### Paralelismus a pořadí v rámci zařízení

Všechny zprávy jdou do jedné fronty a čte ji libovolný počet instancí. Zprávy se nesměrují podle zařízení. Dvě instance nebo dva handlery jedné instance tedy mohou zpracovávat dvě zprávy stejného zařízení současně. Nevadí to, protože výsledek neurčuje pořadí zpracování, ale porovnání klíčů při zápisu. Pozdější zápis buď má novější klíč a stav změní, nebo má starší či stejný klíč a nic nezmění. Není tu zámek, směrování ani koordinace mezi instancemi. Zastaralá zpráva stojí jeden update, který nic nezmění. Žádná zpráva nečeká na jinou.

Zamítnutá alternativa je směrování podle zařízení: `x-modulus-hash` exchange rozdělí zprávy do front podle hashe id zařízení a každou frontu čte vždy jen jeden consumer (single active consumer). Dala by sériové zpracování na zařízení, které tento návrh nepotřebuje. Stála by ale propustnost. Zařízení s velkým počtem zpráv by vytížilo jednoho consumera, počet consumerů by omezoval počet front a změna počtu front by přeskupila zařízení. Je to cesta dál pro případ, že přibude typ události, který sériové zpracování opravdu potřebuje, například přírůstkové hodnoty.

### Doručovací sémantika

| Úsek                  | Sémantika       | Jak                                                                               |
| --------------------- | --------------- | --------------------------------------------------------------------------------- |
| zařízení a ingest     | fire-and-forget | zařízení nedostává potvrzení (vědomý kompromis, viz limity)                       |
| ingest a RabbitMQ     | at-least-once   | publisher confirms; nepotvrzené zprávy ingest po obnovení spojení publikuje znovu |
| RabbitMQ a processing | at-least-once   | ruční `basic.ack` až po zápisech do MongoDB                                       |
| efekt v MongoDB       | přesně jednou   | idempotentní zápisy a deduplikace                                                 |

At-least-once znamená, že se zpráva neztratí, ale může přijít vícekrát. Efekt přesně jednou znamená, že i vícekrát doručená zpráva změní data jen jednou. RabbitMQ a MongoDB nesdílejí transakci, takže doručení přesně jednou mezi nimi zaručit nelze. Návrh proto kombinuje at-least-once doručení s idempotentními zápisy.

### Kde hrozí race conditions a jak jsou pokryté

| Situace                                                                                                | Co by se mohlo pokazit                                                               | Řešení                                                                      | Test                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------- |
| dvě instance zapisují dvě zprávy stejné sekce jednoho zařízení                                         | starší zpráva přepíše novější                                                        | porovnání klíčů uvnitř atomického zápisu                                    | C6                              |
| souběžné handlery jedné instance zapisují zprávy stejného zařízení                                     | starší zpráva přepíše novější                                                        | porovnání klíčů uvnitř atomického zápisu                                    | P6                              |
| první zprávy nového zařízení přijdou současně                                                          | dva dokumenty stavu nebo chyba duplicitního klíče                                    | filtr jen na `_id`; při chybě 11000 jedno opakování                         | P1, P6                          |
| zpráva přijde mimo pořadí                                                                              | starší zpráva přepíše novější                                                        | watermark po sekcích                                                        | P3, P4                          |
| restart zařízení a pak opožděná zpráva staré session                                                   | nová session vypadá starší, nebo stará zpráva přepíše novou                          | `sessionId` v klíči pořadí                                                  | P5                              |
| duplicitní nebo znovu doručená zpráva                                                                  | druhá událost, druhý alert, čítač zvýšený dvakrát                                    | unikátní index, `_id` alertu, striktní porovnání, kumulativní čítače        | P2, P6, C6, C13, C14            |
| pád mezi zápisy                                                                                        | chybí stav nebo alert                                                                | idempotentní kroky; redelivery chybějící doplní                             | C13, C14                        |
| handler běží déle než consumer timeout brokeru (výchozí 30 minut) a broker zprávu doručí jiné instanci | dva handlery zapisují stejnou zprávu; potvrzení neplatného delivery tagu zavře kanál | idempotentní zápisy; handler po zrušení consumera skončí a zprávu nepotvrdí | unit testy handleru a consumeru |
| řízené zastavení instance se zprávami v rozpracovaném stavu                                            | potvrzení se při zavření kanálu ztratí a zpráva přijde znovu                         | redelivery se zpracuje jako `duplicate` a `stale` bez efektu                | C11b                            |
| restart nebo zamrznutí brokeru během publikace                                                         | nepotvrzené zprávy se ztratí                                                         | ingest je publikuje znovu                                                   | I2, I7                          |

## Chování při selhání

| Selhání                                         | Co se stane                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| zařízení ztratí spojení                         | Zařízení se připojuje znovu s exponenciálním backoffem s náhodným rozptylem: čekání je náhodné mezi 0 a hranicí, která roste od 500 ms do 10 s. Pokaždé znovu přeloží DNS a vybere adresu. Zprávy mezitím čekají v outboxu.                                                                                                                                              |
| nevalidní zpráva od zařízení                    | Textovou zprávu, která není platný JSON nebo neodpovídá schématu, ingest zaloguje a zahodí. Spojení zůstává otevřené. Binární zprávu ingest odmítne a spojení zavře s kódem 1003. Když zpráva přesáhne 64 KiB nebo obsahuje neplatné UTF-8, knihovna `ws` spojení ukončí. Do fronty se nevalidní zpráva nedostane.                                                       |
| pád instance ingestu                            | Její zařízení se připojí k jiné instanci. Zprávy, které ingest přijal a broker ještě nepotvrdil, se ztratí. Okno nepotvrzených zpráv instance (`INGEST_MAX_UNCONFIRMED_TOTAL`, výchozí 20 000) ztrátu přibližně omezuje, protože jedna přečtená dávka ho může překročit. Zprávy, které zařízení zapsalo do už mrtvého spojení, žádná hranice neomezuje.                  |
| výpadek RabbitMQ                                | Ingest přestane číst ze socketů zařízení, hlásí not-ready, připojuje se znovu s backoffem a pak znovu publikuje nepotvrzené zprávy. Zaplní se TCP buffery a zařízení přestanou posílat (backpressure). Zprávy čekají v jejich outboxu. Processing se připojí znovu. Nepotvrzené zprávy broker mezitím vrátil do fronty.                                                  |
| výpadek MongoDB                                 | Handler opakuje zápis s backoffem a zpráva zůstává nepotvrzená. Když jeden handler 5krát po sobě selže na přechodné chybě, instance pozastaví consumera. Ostatní rozpracované handlery přeruší a držené zprávy vrátí do fronty (`basic.nack` s requeue, bez zvýšení počtu pokusů). Hlásí not-ready a po úspěšném pingu MongoDB pokračuje. Fronta mezitím roste na disku. |
| trvalá chyba zápisu                             | Chyba, která není přechodná, zprávu hned odmítne do `telemetry.dead`.                                                                                                                                                                                                                                                                                                    |
| pád instance processingu                        | Broker nepotvrzené zprávy doručí jiné instanci. Idempotentní zápisy zajistí, že nevznikne druhý efekt.                                                                                                                                                                                                                                                                   |
| zpráva ve frontě, kterou nelze zpracovat        | Processing ji odmítne bez vrácení do fronty (`basic.reject`). Broker ji přesune do `telemetry.dead`.                                                                                                                                                                                                                                                                     |
| zpráva, jejíž zpracování opakovaně shodí proces | Broker ji po každém pádu vrátí do fronty a zvýší počet pokusů. Po pátém pokusu ji přesune do `telemetry.dead`.                                                                                                                                                                                                                                                           |
| SIGTERM na ingest                               | Ingest přestane přijímat spojení, pošle zařízením close kód 1001 a čeká, až se spojení zavřou a broker potvrdí přijaté zprávy. Po `SHUTDOWN_TIMEOUT_MS` (výchozí 10 s) zbylá spojení ukončí a nepotvrzené zprávy se ztratí. Celé zastavení trvá nejvýš asi 12 s.                                                                                                         |
| SIGTERM na processing                           | Processing zruší consumera, dokončí a potvrdí rozpracované zprávy. Po `SHUTDOWN_TIMEOUT_MS` zbylé handlery přeruší bez potvrzení a broker jejich zprávy doručí znovu. Celé zastavení včetně zavření spojení k MongoDB trvá nejvýš asi 17 s.                                                                                                                              |

Každá operace se socketem, AMQP a MongoDB má timeout. Obě služby se po výpadku připojují znovu s backoffem a svůj stav hlásí přes `/readyz`.
