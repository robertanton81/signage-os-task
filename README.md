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
