# Přepis zvuku

Webová aplikace na Netlify: nahrání zvuku (mikrofon nebo soubor), kontext a odborné výrazy, přepis přes Soniox nebo ElevenLabs Scribe a zobrazení výsledku s tlačítkem pro kopírování.

Do aplikace se přihlašuje účtem Google přes Netlify Identity. Pustí jen e-maily uvedené v `ALLOWED_EMAILS`.

## Jak to funguje

1. Prohlížeč založí úlohu (`/api/jobs`) a nahraje zvuk po kouscích do 4 MB (`/api/upload`) do Netlify Blobs ve Frankfurtu (`eu-central-1`, nastaveno v `store()` v `netlify/lib/shared.mts`). Netlify má limit 6 MB na jeden požadavek.
2. `/api/start` kousky poskládá a předá službě. Zvuk se pak z Netlify Blobs hned smaže.
   - **Soniox:** soubor jde do Soniox Files API a vytvoří se asynchronní přepis.
   - **ElevenLabs:** požadavek se pošle s `webhook=true` a výsledek přijde na `/api/elevenlabs-webhook`.
3. Prohlížeč se každé 3 s ptá `/api/status`. Hotový přepis se vydá jednou a poté se smaže ze serveru (u Sonioxu se smaže i soubor a přepis na jejich straně).

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

## Arch s přepisem

U Sonioxu vrací `/api/status` kromě prostého textu i repliky (`segments`): mluvčího, čas začátku a úseky textu. Slova, u kterých Soniox udává jistotu pod 0,6 (`LOW_CONFIDENCE` v `netlify/lib/segments.mts`), jsou na archu podtržená ke kontrole. Do kopírovaného a staženého textu se podtržení ani časy nedostanou.
