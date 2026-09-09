# Jak je tento projekt vyvíjen s Claude Code

Tento adresář je součástí repozitáře záměrně: ukazuje, jakým způsobem pracuji s AI nástroji. Zadání použití AI výslovně povoluje a očekává, že autor umí každé rozhodnutí vysvětlit. Harness níže je nastavený tak, aby to platilo: plán před kódem, review před commitem, knihovny ověřené z aktuální dokumentace, ne z paměti modelu.

## Princip

Každý krok má vstupní dokument, výstupní dokument a adversariální review. Nic se nespouští samo: skills volám ručně, review agenty spouští skills. Nálezy jsou BLOCKING (musí se opravit, max. dvě iterace) nebo SUGGESTION.

## Obsah

| Cesta                     | Co to je                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../CLAUDE.md`            | Kontext projektu pro Claude: stack, invarianty ze zadání, konvence, příkazy, workflow.                                                                                              |
| `../TODO.md`              | Seřazený seznam kroků; první neodškrtnutá položka je vždy další akce.                                                                                                               |
| `skills/design-spec`      | Prozkoumání problému, 2–3 přístupy s trade-offs, spec do `docs/specs/`. Spec musí explicitně odpovědět na otázky ze zadání (metadata zpráv, novost stavu, atomicita, paralelismus). |
| `skills/plan`             | Revidovaný implementační plán do `docs/plans/`: úkoly, verify příkazy, kritéria ověření. Každý úkol, který zapisuje stav, pojmenuje invariant a test, který ho dokazuje.            |
| `skills/implement`        | Provedení plánu po úkolech, dvoustupňové review (shoda s plánem → kvalita kódu + kvalita testů), atomické commity.                                                                  |
| `skills/verify`           | Ověření hotové implementace proti kritériím z plánu a proti stálým požadavkům zadání, s důkazy.                                                                                     |
| `skills/test-review`      | Audit testů mimo `/implement`.                                                                                                                                                      |
| `agents/*-reviewer.md`    | Read-only review agenti. `test-quality-reviewer` odmítá tautologické, mock-only a sleep-driven testy.                                                                               |
| `hooks/session-orient.sh` | Při startu session vypíše další neodškrtnutý krok z `TODO.md` a varuje před necommitnutými změnami.                                                                                 |
| `settings.json`           | Allowlist příkazů (pnpm, docker compose, git jen pro čtení) a registrace hooku.                                                                                                     |

## Odkud to je

Skills a agenti jsou převzaté z mého staršího TypeScript projektu a zbavené všeho, co se týkalo jeho domény. Vědomě vynechávám samo-upravující části (experience wiki, automatické návrhy změn skills): harness má být čitelný a stabilní po celou dobu úkolu.

## Tok práce

```
TODO.md krok  →  /design-spec (spec)  →  /plan (plán)  →  /implement (kód + review + commity)  →  /verify (důkazy)
```

Commit historie je běžná týmová: malé imperativní commity s imperativním předmětem. Commit message popisuje změnu, nic jiného — bez patičky s atribucí nástroje.
