# TODO – Škálovatelné zpracování telemetrie zařízení

Pořadí kroků pro splnění zadání v `main-spec/Domácí úkol BE.pdf`.
Záměrně bez implementačních detailů – konkrétní knihovny, datový model a formát zpráv se rozhodnou až v příslušném kroku.

Proč toto pořadí:

- Návrhová rozhodnutí jdou první, protože z nich vychází kontrakt zpráv, obě služby, testy, README i technická diskuze.
- Sdílený balíček vzniká před službami, aby všechny mluvily stejným jazykem.
- Docker Compose je hotový před integračními testy, protože jim poskytuje infrastrukturu.
- Dokumentace se píše průběžně (poznámky ke kompromisům), ale finalizuje se až nad hotovým systémem.

Legenda: `[ ]` nehotovo · `[x]` hotovo

---

## 0. Návrhová rozhodnutí (před psaním kódu)

Výstup: krátký návrhový dokument (později se stane základem README a podkladů pro diskuzi).

Rozhodnuto 2026-09-11 ve specu `docs/specs/2026-09-11-telemetry-consistency-design.md` (čísla odkazují na jeho Decisions Log).

- [x] Definovat metadata telemetrické zprávy: identita zařízení, jednoznačná identita zprávy pro deduplikaci, informace pro určení pořadí a novosti. (rozhodnutí 1–5)
- [x] Definovat, co znamená „aktuální stav zařízení“ a podle čeho se rozhoduje, zda je příchozí zpráva novější než uložený stav. (rozhodnutí 6–8)
- [x] Rozhodnout strategii deduplikace: jak poznat opakovanou zprávu a jak zajistit, že nezpůsobí duplicitní business efekt (čítače, alerty, stav). (rozhodnutí 9, 16, 17)
- [x] Rozhodnout, jak zajistit pořadí zpracování v rámci jednoho zařízení a zároveň paralelní zpracování různých zařízení napříč instancemi processing služby. (rozhodnutí 11, 19)
- [x] Identifikovat operace, které musí být atomické, a rozhodnout, jak bude atomicita zaručena. (rozhodnutí 10, 20)
- [x] Rozhodnout chování při selhání: výpadek instance, nedoručitelná zpráva, restart. Vědomě zvolit doručovací sémantiku a popsat její důsledky. (rozhodnutí 12–14, 18, tabulka selhání)
- [x] Rozhodnout, jak se zařízení rozdělují mezi více instancí ingest služby (bezstavovost ingestu). (rozhodnutí 15)
- [x] Založit průběžný seznam kompromisů a věcí „s více času jinak“ – doplňovat v každém dalším kroku. (sekce „Trade-offs (running list)“, řádky T1–T10)

## 1. Založení projektu

- [x] Inicializovat git (2026-09-08, větev `main`).
- [x] Vytvořit vzdálený repozitář (GitHub nebo GitLab) a pushnout (2026-09-08, https://github.com/robertanton81/signage-os-task, private).
- [x] Založit pnpm monorepo se strukturou pro sdílený balíček a tři aplikace: emulátor, ingest, processing.
- [x] Nastavit striktní TypeScript konfiguraci sdílenou napříč balíčky.
- [x] Nastavit lint, formátování a testovací runner na úrovni monorepa.
- [x] Nastavit rootové skripty: build, typecheck, lint, test.
- [x] Přidat `.gitignore` a `.env.example` (bez hodnot).
- [x] První commit. Od začátku udržovat smysluplnou commit historii – malé, popisné commity po každém logickém kroku.

## 2. Sdílený balíček (kontrakt zpráv a domény)

Opraveno 2026-09-12 podle `docs/plans/2026-09-12-review-fixes-plan.md` (10 commitů `7b27df8..b88abae`, 202 unit testů). Položky níže zůstávají hotové; opravy se týkaly redakce hesel v logu, hranic kontraktu, dekodéru rámců a konfigurace.

- [x] Definovat typy telemetrických událostí: provozní stav, naměřené hodnoty, čítače, diagnostika/chyby.
- [x] Definovat společnou obálku zprávy s metadaty z kroku 0.
- [x] Definovat validační schéma zpráv – použije ingest při příjmu i testy.
- [x] Definovat typ „aktuální stav zařízení“ tak, jak bude uložen v MongoDB.
- [x] Definovat sdílené konvence pro pojmenování front/exchange v RabbitMQ a kolekcí v MongoDB.
- [x] Sdílená konfigurace (načítání env proměnných, logování).
- [x] Unit testy validace a helperů.

## 3. Emulátor zařízení

Hotovo 2026-09-12 podle `docs/specs/2026-09-12-emulator-design.md` a `docs/plans/2026-09-12-emulator-plan.md` (13 commitů `a1f3736..`, 98 nových testů, celkem 300).

Opraveno 2026-09-13 podle `docs/plans/2026-09-13-emulator-delivery-fixes-plan.md` (4 commity `8931fc4..02d3c17`, testy emulátoru 100 → 104). Položky níže zůstávají hotové; opravy se týkaly dvojího odeslání zprávy při backpressure, ukončení procesu uprostřed shutdown drainu a obnovy ztraceného statusu během provozu.

Změněno 2026-09-13 podle `docs/specs/2026-09-13-websocket-transport-design.md`: spojení zařízení → ingest je WebSocket (klient `ws`, cesta `/telemetry`, jedna zpráva na jeden textový WebSocket message). Položky níže zůstávají hotové; změnil se pouze transport.

- [x] Konfigurovatelný počet zařízení a frekvence událostí (env / argumenty).
- [x] Každé zařízení naváže dlouhodobé socketové spojení k ingest službě.
- [x] Generování všech typů událostí v realistickém rytmu.
- [x] Zařízení udržuje vlastní logické pořadí událostí, aby bylo možné na straně zpracování ověřit správnost.
- [x] Reconnect při ztrátě spojení.
- [x] Volitelný režim simulace problémových scénářů: duplicitní zprávy, zprávy mimo pořadí, výpadek spojení. Poslouží testům i demu.
- [x] Unit testy generátoru událostí.

## 4. Socket ingest služba

Hotovo 2026-09-13 podle `docs/specs/2026-09-13-ingest-design.md` a `docs/plans/2026-09-13-ingest-plan.md` (30 commitů `56c8dc7..`, 209 testů ingest, celkem 538). Skriptovaný běh proti RabbitMQ 4.3 prošel všemi šesti scénáři; výsledky jsou v hlavičce plánu.

Změněno 2026-09-13 podle `docs/specs/2026-09-13-websocket-transport-design.md`: socket server je WebSocket server (`ws` 8.21.3 nad `http.Server`, cesta `/telemetry`); idle timeout nahradil WebSocket ping, shutdown posílá close code 1001. Položky níže zůstávají hotové; změnil se pouze transport.

- [x] Socket server přijímající dlouhodobá spojení od zařízení.
- [x] Parsování a validace příchozích zpráv sdíleným schématem. Nevalidní zprávu odmítnout a zalogovat, nikoli shodit spojení nebo službu.
- [x] Publikace validních zpráv do RabbitMQ včetně metadat potřebných pro směrování a pořadí.
- [x] Bezstavovost – žádný stav vázaný na instanci, aby šlo škálovat horizontálně.
- [x] Odolnost vůči výpadku RabbitMQ (reconnect, chování vůči zařízením během výpadku).
- [x] Graceful shutdown: dokončit rozpracované zprávy, korektně zavřít spojení.
- [x] Health/readiness signál pro Docker Compose.
- [x] Unit testy: validace, mapování zprávy do fronty.

## 5. Processing service

Hotovo 2026-09-14 podle `docs/specs/2026-09-13-processing-design.md` a `docs/plans/2026-09-13-processing-plan.md` (41 commitů `5cdd8aa..`, 288 testů processing, celkem 855). Skriptovaný běh proti RabbitMQ 4.3 a MongoDB 8.0 prošel všemi dvanácti scénáři; výsledky jsou v hlavičce plánu.

- [x] Konzumace zpráv z RabbitMQ způsobem, který zaručí pořadí v rámci zařízení a rozloží zátěž mezi instance.
- [x] Deduplikace podle strategie z kroku 0 – opakovaná zpráva nesmí mít žádný business efekt.
- [x] Ukládání zpracovaných eventů do MongoDB.
- [x] Aktualizace aktuálního stavu zařízení: atomicky a pouze pokud je zpráva novější než uložený stav.
- [x] Idempotentní zpracování čítačů a alertů.
- [x] Zpracování chyb: retry, dead-letter pro nezpracovatelné zprávy, potvrzení zprávy až po úspěšném uložení.
- [x] Potřebné indexy a unikátní omezení v MongoDB (deduplikace, vyhledání stavu).
- [x] Graceful shutdown a health/readiness signál.
- [x] Unit testy rozhodovací logiky: novost, deduplikace, atomicita update.

## 6. Docker Compose (vývojový)

Hotovo 2026-09-14 podle `docs/specs/2026-09-14-docker-compose-design.md` a `docs/plans/2026-09-14-docker-compose-plan.md` (9 commitů `5bd6b96..`, 874 testů: 855 původních beze změny a 19 nových pro čisté pomocné funkce ověřovacího skriptu). Skript `scripts/compose-check.mjs` prošel ve výchozím režimu, ve škálovaném režimu (2 ingest, 3 processing) a s 25 emulovanými zařízeními; výsledky jsou v hlavičce plánu.

- [x] Služby: RabbitMQ (s management UI), MongoDB, ingest, processing, emulátor.
- [x] Dockerfile pro každou aplikaci, build z monorepa.
- [x] Závislosti a health checky – aplikace startují až po připravenosti infrastruktury.
- [x] Snadné navýšení počtu instancí ingest a processing standardním mechanismem Compose. Ověřit, že zařízení se rozdělují mezi více ingest instancí.
- [x] Snadné navýšení počtu emulovaných zařízení přes env.
- [x] Ověřit end-to-end: spuštění celého systému jedním příkazem, data dotečou do MongoDB.

## 7. Integrační testy

Hotovo 2026-09-15 podle `docs/specs/2026-09-14-integration-tests-design.md` a `docs/plans/2026-09-15-integration-tests-plan.md` (25 commitů `d5d858d..`, 25 integračních testů ve 3 souborech nad skutečným RabbitMQ 4.3 a MongoDB 8.0 z `docker-compose.test.yml`, plus 34 unit testů harnessu (generátor zátěže, parser konfigurace Compose, zachytávání logů, orákulum koncového stavu); celkem 939 testů). Testovací stack (projekt `telemetry-test`, porty 5673/15673/27018) spouští a odstraňuje `globalSetup` projektu `integration`; každý test má vlastní virtual host a databázi. Celá integrační sada trvala 68 s (měřeno 2026-09-15); `pnpm test:unit` běží bez Dockeru. CI: `.github/workflows/ci.yml` (GitHub Actions, ubuntu-latest) spouští format:check, lint, typecheck a `pnpm test` včetně integračních testů. Oprava T70 (`1f0a783`, `d1be9f9`): consumer při zastavení zavře kanál a počká na jeho close-ok před zavřením spojení, takže poslední potvrzení nezmizí; C11b znovu tvrdí přesný zbytek 150.

- [x] Infrastruktura pro integrační testy nad skutečnými instancemi MongoDB a RabbitMQ (oddělená od vývojového běhu). Vývojový stack fixuje název projektu Compose `telemetry`, názvy front a publikované porty 15672 a 27017, takže testy potřebují jiný název projektu nebo vlastní Compose soubor (compose spec 2026-09-14, sekce Scaling).
- [x] Test: zpráva projde z ingestu přes RabbitMQ do MongoDB.
- [x] Test: duplicitní zpráva nezpůsobí duplicitní efekt (čítač, alert, stav).
- [x] Test: starší zpráva nepřepíše novější stav.
- [x] Test: paralelní zpracování více zařízení bez vzájemných konfliktů.
- [x] Test: více instancí processing služby souběžně nad stejnou frontou dává konzistentní výsledek.
- [x] Test: nevalidní zpráva je odmítnuta a nedostane se do fronty.
- [x] Test: ingest publisher proti skutečnému RabbitMQ — restart brokeru s připojenými zařízeními (znovupublikace nepotvrzených zpráv), smazaná fronta (return → recyklace → nová deklarace topologie), blokované spojení (resource alarm), SIGTERM s připojenými zařízeními, zamrzlý broker (`docker pause`: heartbeat timeout → znovupublikace všech nepotvrzených zpráv) (ingest spec 2026-09-13, rozhodnutí 25).
- [x] Test: processing consumer proti skutečnému RabbitMQ a MongoDB — dvanáct scénářů skriptovaného běhu: normální tok, duplicita, pořadí uvnitř sekce i napříč sekcemi, restart session, dvě instance, poison zprávy, zastavená a zamrzlá MongoDB (pauza a obnovení konzumace), restart brokeru, SIGTERM s rozpracovanými zprávami, špatné přihlašovací údaje (processing spec 2026-09-13, rozhodnutí 27). Navíc zastavení s čekající registrací konzumenta u zamrzlého brokeru — scénář C11c (integration spec 2026-09-14, rozhodnutí 24), doplněný po opravě `stop()` z 2026-09-14.
- [x] Zapojit integrační testy do rootového `test` skriptu.
- [x] Volitelně: CI pipeline pro automatický běh testů.

## 8. Dokumentace (README.md)

- [ ] Stručný popis architektury a toku dat.
- [ ] Diagram architektury (textový diagram přímo v README stačí).
- [ ] Návod na spuštění systému a testů. Uvést minimální verze na hostu: Docker Engine 25 a Docker Compose 2.20.2 (health checky používají `start_interval`; compose spec 2026-09-14, rozhodnutí 13); Node ani pnpm na hostu nejsou potřeba, ověřovací skript je čistý Node bez závislostí.
- [ ] Konfigurace emulátoru – všechny env proměnné s výchozími hodnotami.
- [ ] Jak spustit více instancí ingest a processing.
- [ ] Datový model a zvolená metadata zpráv s odůvodněním.
- [ ] Řešení race conditions, pořadí, deduplikace a atomicity.
- [ ] Známé limity a vědomé kompromisy. Uvést, že přihlašovací údaje v `docker-compose.yml` jsou vývojové zástupné hodnoty (compose spec 2026-09-14, rozhodnutí 20 a 21): platí jen uvnitř sítě Compose, publikované porty 15672 a 27017 jsou vázané na loopback hostitele, hodnoty lze přepsat v `.env` a skener tajemství je hlásí záměrně; produkční nasazení dodává skutečné údaje z prostředí. Uvést také, že mezi zařízením a ingestem se zprávy nepotvrzují (kompromis T3): ztracená periodická zpráva se nahradí další, ztracená hranová diagnostika (`error` při přechodu do přehřátí) ne, takže její alert chybí až do dalšího výskytu stavu.
- [ ] Co byste při více času doplnili nebo řešili jinak.

## 9. Finální kontrola a odevzdání

- [ ] Čistý clone repozitáře → spuštění systému jedním příkazem → systém běží, testy projdou.
- [ ] Projít commit historii: smysluplná, bez balastu, odpovídá standardní týmové práci.
- [ ] Zkontrolovat, že v repozitáři nejsou secrets ani zbytečné soubory (`.env` s hodnotami, `.DS_Store`, `node_modules`).
- [ ] Odevzdat odkaz na repozitář.

## 10. Příprava na technickou diskuzi

U každého bodu mít připravenou odpověď, zdůvodnění a alternativy:

- [ ] Architektura a datový model – proč právě takto.
- [ ] Zvolená metadata telemetrických zpráv – co by se stalo bez nich.
- [ ] Řešení race conditions – kde přesně hrozí a jak je pokryto.
- [ ] Škálování a odolnost při selhání – pád instance, ztráta spojení, výpadek RabbitMQ nebo MongoDB.
- [ ] Testovací strategie – co je pokryto unit, co integračně, co pokryto není.
- [ ] Kompromisy a možné alternativy – co by se dělalo jinak v produkci.
