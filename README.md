# Přepis zvuku

Webová aplikace na Netlify: nahrání zvuku (mikrofon nebo soubor), kontext a odborné výrazy, přepis přes Soniox nebo ElevenLabs Scribe a zobrazení výsledku s tlačítkem pro kopírování.

Do aplikace se přihlašuje účtem Google přes Netlify Identity. Pustí jen e-maily uvedené v `ALLOWED_EMAILS`.

## Jak to funguje

1. Prohlížeč založí úlohu (`/api/jobs`) a nahraje zvuk po kouscích do 4 MB (`/api/upload`) do Netlify Blobs ve Frankfurtu (`eu-central-1`, nastaveno v `store()` v `netlify/lib/shared.mts`). Netlify má limit 6 MB na jeden požadavek.
2. `/api/start` kousky poskládá a předá službě. Zvuk se pak z Netlify Blobs hned smaže.
   - **Soniox:** soubor jde do Soniox Files API a vytvoří se asynchronní přepis.
   - **ElevenLabs:** požadavek se pošle s `webhook=true` a výsledek přijde na `/api/elevenlabs-webhook`.
3. Prohlížeč se každé 3 s ptá `/api/status`. Hotový přepis se vydá jednou a poté se smaže ze serveru (u Sonioxu se smaže i soubor a přepis na jejich straně).

4. Je-li zapnutá **AI korektura**, prohlížeč pak pošle hotový přepis po částech na `/api/correct` (viz níže).

Každá funkce kromě webhooku si přes `@netlify/identity` ověří přihlášeného uživatele (cookie `nf_jwt`). Projde jen účet přihlášený přes Google, jehož e-mail je v `ALLOWED_EMAILS`. Účty s heslem neprojdou, protože jejich e-mail nemusí být ověřený.

Úloha se smaže hned, jak prohlížeč dostane přepis nebo chybu. Funkce `cleanup` každou hodinu (v 17. minutě UTC) smaže úlohy starší než 6 hodin i s jejich daty u Sonioxu, osiřelé kousky zvuku a cokoli v původním úložišti v USA (`us-east-2`), kam se ukládalo do 12. 11. 2026. Co smazala, zapíše do logu funkce.

Žádná funkce nečeká na dokončení přepisu, takže stačí běžné (synchronní) funkce a aplikace běží i na bezplatném plánu Netlify.

## Proměnné prostředí (Netlify → Site configuration → Environment variables)

| Proměnná | Povinná | Význam |
|---|---|---|
| `ALLOWED_EMAILS` | ano | E-maily oddělené čárkou, které smí aplikaci používat |
| `SONIOX_API_KEY` | pro Soniox | API klíč ze Soniox Console |
| `SONIOX_MODEL` | ne | Výchozí `stt-async-v6` |
| `SONIOX_REGION` | ne | Kde Soniox zpracuje a uloží data: `us` (výchozí), `eu`, `jp` nebo `in`. Klíč musí být z projektu ve stejném regionu |
| `ELEVENLABS_API_KEY` | pro ElevenLabs | API klíč s oprávněním Speech to Text |
| `ELEVENLABS_WEBHOOK_SECRET` | pro ElevenLabs | Tajemství webhooku z nastavení ElevenLabs |
| `ELEVENLABS_WEBHOOK_ID` | ne | ID webhooku, pokud jich máte víc |
| `ELEVENLABS_MODEL` | ne | Výchozí `scribe_v2` |
| `ANTHROPIC_API_KEY` | pro AI korekturu | API klíč z Claude Console. Bez něj se korektura v aplikaci vůbec nenabídne |
| `ANTHROPIC_MODEL` | ne | Model pro korekturu, výchozí `claude-opus-5-5` |

## Nastavení přihlášení (Netlify Identity)

Nastavuje se jen v administraci Netlify, API pro to neexistuje.

1. Projekt → **Identity** → **Enable Identity**.
2. **Registration preferences** nechte **Open**. Kdo smí dovnitř, hlídá `ALLOWED_EMAILS`.
3. **External providers** → **Add provider** → **Google** → **Use default configuration**.
4. Do `ALLOWED_EMAILS` zapište svůj Google e-mail a web znovu nasaďte.

## Soniox v EU

Ve výchozím stavu jdou nahrávky přes `api.soniox.com` (USA). V regionu EU zůstává zvuk i přepis v EU.

1. V Soniox Console otevřete Security & compliance → Region access a požádejte o EU. Region je aktivní až po schválení.
2. Založte nový projekt s regionem EU a vytvořte v něm API klíč. Klíče z jiného regionu na EU adrese nefungují.
3. Na Netlify nastavte `SONIOX_REGION=eu` a do `SONIOX_API_KEY` dejte klíč z EU projektu. Pak web znovu nasaďte.

Rozpracované úlohy si pamatují region, ve kterém vznikly, takže je přepnutí nerozbije.

## Nastavení webhooku u ElevenLabs

1. Nasaďte web, ať znáte adresu (např. `https://prepis.netlify.app`).
2. V ElevenLabs otevřete Developers → Webhooks a vytvořte webhook pro Speech to Text s adresou `https://<váš-web>/api/elevenlabs-webhook`.
3. Zkopírujte tajemství webhooku do `ELEVENLABS_WEBHOOK_SECRET` a web znovu nasaďte.

## Nasazení

```bash
npm install
npx netlify deploy --prod
```

Build (`npm run build`) přibalí knihovnu `@netlify/identity` pro prohlížeč do `public/identity.js`.

Lokálně: `npm run dev`. Přihlášení přes Netlify Identity lokálně nefunguje, zkoušejte ho na nasazeném webu. Webhook ElevenLabs lokálně také nedorazí.

## Limity

- Max. velikost souboru 150 MB (`MAX_BYTES` v `netlify/lib/shared.mts`).
- Nahrávka z mikrofonu se ukládá v Opus 32 kb/s, hodina řeči má zhruba 15 MB.
- Volný kontext využívá jen Soniox. ElevenLabs použije jen odborné výrazy (keyterms).
- Kontext a odborné výrazy mají pro Soniox dohromady nejvýš 8 000 znaků. Soniox přijme 8 000 tokenů, u češtiny necháváme rezervu.
- Soniox zpracuje nejvýš 300 minut zvuku na jeden soubor.

## AI korektura

Hotový přepis může opravit Claude (Anthropic): pravopis, interpunkci, členění do odstavců a špatně rozpoznaná slova. Korektura se zapíná přepínačem **Korektura** pod volbou mluvčích a ve výchozím stavu je vypnutá. Zapnutí i šablonu si prohlížeč pamatuje. Přepínač se zobrazí jen tehdy, když je na Netlify nastavený `ANTHROPIC_API_KEY`; smazáním proměnné se funkce vypne pro všechny.

Šablona určuje, jak se text upraví:

| Šablona | Co dělá |
|---|---|
| Obecná | Opraví chyby, styl řeči nechá být |
| Schůzka | Věcný záznam bez vaty, důraz na jména, čísla, termíny a úkoly |
| Rozhovor | Otázky a odpovědi v odstavcích, osobitý projev zůstane |
| Diktát | Provede vyslovenou interpunkci („tečka“, „nový odstavec“) a opravy mluvčího |
| Přednáška | Souvislý výklad v odstavcích po myšlenkách |

Šablony jsou v `netlify/lib/correction.mts` (pole `TEMPLATES`). Novou přidáte dalším záznamem s `id`, názvem, popiskem a pokyny pro model; stránka si seznam načte sama.

Jak to běží:

- Prohlížeč rozdělí přepis na části po zhruba 3 000 znacích (`FIX_CHARS` v `public/index.html`) a posílá je na `/api/correct`, nejvýš tři najednou. Důvodem je časový limit běžné funkce na Netlify. Když se část nestihne opravit, rozdělí se napůl a zkusí znovu.
- Model dostane i kontext a odborné výrazy z formuláře a konec předchozí části pro souvislost.
- Na archu je pak opravený text a tlačítkem **Původní přepis** se dá přepnout zpět. Kopírování a stažení berou verzi, která je právě vidět. Když se korektura nepodaří, zůstane původní přepis a nabídne se **Zkusit znovu**.
- Funkce text nikam neukládá. Text přepisu ale odchází ke zpracování do Anthropic (USA); u citlivých nahrávek korekturu nechte vypnutou.
- Korektura neshrnuje, text jen opravuje. Může ale změnit formulace, důležitá místa proto porovnejte s původním přepisem.

## Arch s přepisem

U Sonioxu vrací `/api/status` kromě prostého textu i repliky (`segments`): mluvčího, čas začátku a úseky textu. Slova, u kterých Soniox udává jistotu pod 0,6 (`LOW_CONFIDENCE` v `netlify/lib/segments.mts`), jsou na archu podtržená ke kontrole. Do kopírovaného a staženého textu se podtržení ani časy nedostanou.
