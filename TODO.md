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

- [ ] Definovat metadata telemetrické zprávy: identita zařízení, jednoznačná identita zprávy pro deduplikaci, informace pro určení pořadí a novosti.
- [ ] Definovat, co znamená „aktuální stav zařízení“ a podle čeho se rozhoduje, zda je příchozí zpráva novější než uložený stav.
- [ ] Rozhodnout strategii deduplikace: jak poznat opakovanou zprávu a jak zajistit, že nezpůsobí duplicitní business efekt (čítače, alerty, stav).
- [ ] Rozhodnout, jak zajistit pořadí zpracování v rámci jednoho zařízení a zároveň paralelní zpracování různých zařízení napříč instancemi processing služby.
- [ ] Identifikovat operace, které musí být atomické, a rozhodnout, jak bude atomicita zaručena.
- [ ] Rozhodnout chování při selhání: výpadek instance, nedoručitelná zpráva, restart. Vědomě zvolit doručovací sémantiku a popsat její důsledky.
- [ ] Rozhodnout, jak se zařízení rozdělují mezi více instancí ingest služby (bezstavovost ingestu).
- [ ] Založit průběžný seznam kompromisů a věcí „s více času jinak“ – doplňovat v každém dalším kroku.

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

- [ ] Definovat typy telemetrických událostí: provozní stav, naměřené hodnoty, čítače, diagnostika/chyby.
- [ ] Definovat společnou obálku zprávy s metadaty z kroku 0.
- [ ] Definovat validační schéma zpráv – použije ingest při příjmu i testy.
- [ ] Definovat typ „aktuální stav zařízení“ tak, jak bude uložen v MongoDB.
- [ ] Definovat sdílené konvence pro pojmenování front/exchange v RabbitMQ a kolekcí v MongoDB.
- [ ] Sdílená konfigurace (načítání env proměnných, logování).
- [ ] Unit testy validace a helperů.

## 3. Emulátor zařízení

- [ ] Konfigurovatelný počet zařízení a frekvence událostí (env / argumenty).
- [ ] Každé zařízení naváže dlouhodobé socketové spojení k ingest službě.
- [ ] Generování všech typů událostí v realistickém rytmu.
- [ ] Zařízení udržuje vlastní logické pořadí událostí, aby bylo možné na straně zpracování ověřit správnost.
- [ ] Reconnect při ztrátě spojení.
- [ ] Volitelný režim simulace problémových scénářů: duplicitní zprávy, zprávy mimo pořadí, výpadek spojení. Poslouží testům i demu.
- [ ] Unit testy generátoru událostí.

## 4. Socket ingest služba

- [ ] Socket server přijímající dlouhodobá spojení od zařízení.
- [ ] Parsování a validace příchozích zpráv sdíleným schématem. Nevalidní zprávu odmítnout a zalogovat, nikoli shodit spojení nebo službu.
- [ ] Publikace validních zpráv do RabbitMQ včetně metadat potřebných pro směrování a pořadí.
- [ ] Bezstavovost – žádný stav vázaný na instanci, aby šlo škálovat horizontálně.
- [ ] Odolnost vůči výpadku RabbitMQ (reconnect, chování vůči zařízením během výpadku).
- [ ] Graceful shutdown: dokončit rozpracované zprávy, korektně zavřít spojení.
- [ ] Health/readiness signál pro Docker Compose.
- [ ] Unit testy: validace, mapování zprávy do fronty.

## 5. Processing service

- [ ] Konzumace zpráv z RabbitMQ způsobem, který zaručí pořadí v rámci zařízení a rozloží zátěž mezi instance.
- [ ] Deduplikace podle strategie z kroku 0 – opakovaná zpráva nesmí mít žádný business efekt.
- [ ] Ukládání zpracovaných eventů do MongoDB.
- [ ] Aktualizace aktuálního stavu zařízení: atomicky a pouze pokud je zpráva novější než uložený stav.
- [ ] Idempotentní zpracování čítačů a alertů.
- [ ] Zpracování chyb: retry, dead-letter pro nezpracovatelné zprávy, potvrzení zprávy až po úspěšném uložení.
- [ ] Potřebné indexy a unikátní omezení v MongoDB (deduplikace, vyhledání stavu).
- [ ] Graceful shutdown a health/readiness signál.
- [ ] Unit testy rozhodovací logiky: novost, deduplikace, atomicita update.

## 6. Docker Compose (vývojový)

- [ ] Služby: RabbitMQ (s management UI), MongoDB, ingest, processing, emulátor.
- [ ] Dockerfile pro každou aplikaci, build z monorepa.
- [ ] Závislosti a health checky – aplikace startují až po připravenosti infrastruktury.
- [ ] Snadné navýšení počtu instancí ingest a processing standardním mechanismem Compose. Ověřit, že zařízení se rozdělují mezi více ingest instancí.
- [ ] Snadné navýšení počtu emulovaných zařízení přes env.
- [ ] Ověřit end-to-end: spuštění celého systému jedním příkazem, data dotečou do MongoDB.

## 7. Integrační testy

- [ ] Infrastruktura pro integrační testy nad skutečnými instancemi MongoDB a RabbitMQ (oddělená od vývojového běhu).
- [ ] Test: zpráva projde z ingestu přes RabbitMQ do MongoDB.
- [ ] Test: duplicitní zpráva nezpůsobí duplicitní efekt (čítač, alert, stav).
- [ ] Test: starší zpráva nepřepíše novější stav.
- [ ] Test: paralelní zpracování více zařízení bez vzájemných konfliktů.
- [ ] Test: více instancí processing služby souběžně nad stejnou frontou dává konzistentní výsledek.
- [ ] Test: nevalidní zpráva je odmítnuta a nedostane se do fronty.
- [ ] Zapojit integrační testy do rootového `test` skriptu.
- [ ] Volitelně: CI pipeline pro automatický běh testů.

## 8. Dokumentace (README.md)

- [ ] Stručný popis architektury a toku dat.
- [ ] Diagram architektury (textový diagram přímo v README stačí).
- [ ] Návod na spuštění systému a testů.
- [ ] Konfigurace emulátoru – všechny env proměnné s výchozími hodnotami.
- [ ] Jak spustit více instancí ingest a processing.
- [ ] Datový model a zvolená metadata zpráv s odůvodněním.
- [ ] Řešení race conditions, pořadí, deduplikace a atomicity.
- [ ] Známé limity a vědomé kompromisy.
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
