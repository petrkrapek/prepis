# Přepis zvuku

Webová aplikace na Netlify: nahrání zvuku (mikrofon nebo soubor), kontext a odborné výrazy, přepis přes Soniox nebo ElevenLabs Scribe a zobrazení výsledku s tlačítkem pro kopírování.

## Jak to funguje

1. Prohlížeč založí úlohu (`/api/jobs`) a nahraje zvuk po kouscích do 4 MB (`/api/upload`) do Netlify Blobs. Netlify má limit 6 MB na jeden požadavek.
2. `/api/start` kousky poskládá a předá službě. Zvuk se pak z Netlify Blobs hned smaže.
   - **Soniox:** soubor jde do Soniox Files API a vytvoří se asynchronní přepis.
   - **ElevenLabs:** požadavek se pošle s `webhook=true` a výsledek přijde na `/api/elevenlabs-webhook`.
3. Prohlížeč se každé 3 s ptá `/api/status`. Hotový přepis se vydá jednou a poté se smaže ze serveru (u Sonioxu se smaže i soubor a přepis na jejich straně).

Žádná funkce nečeká na dokončení přepisu, takže stačí běžné (synchronní) funkce a aplikace běží i na bezplatném plánu Netlify.

## Proměnné prostředí (Netlify → Site configuration → Environment variables)

| Proměnná | Povinná | Význam |
|---|---|---|
| `APP_PASSWORD` | ano | Heslo pro vstup do aplikace |
| `SONIOX_API_KEY` | pro Soniox | API klíč ze Soniox Console |
| `SONIOX_MODEL` | ne | Výchozí `stt-async-v4` |
| `ELEVENLABS_API_KEY` | pro ElevenLabs | API klíč s oprávněním Speech to Text |
| `ELEVENLABS_WEBHOOK_SECRET` | pro ElevenLabs | Tajemství webhooku z nastavení ElevenLabs |
| `ELEVENLABS_WEBHOOK_ID` | ne | ID webhooku, pokud jich máte víc |
| `ELEVENLABS_MODEL` | ne | Výchozí `scribe_v2` |

## Nastavení webhooku u ElevenLabs

1. Nasaďte web, ať znáte adresu (např. `https://prepis.netlify.app`).
2. V ElevenLabs otevřete Developers → Webhooks a vytvořte webhook pro Speech to Text s adresou `https://<váš-web>/api/elevenlabs-webhook`.
3. Zkopírujte tajemství webhooku do `ELEVENLABS_WEBHOOK_SECRET` a web znovu nasaďte.

## Nasazení

```bash
npm install
npx netlify deploy --prod
```

Lokálně: `npx netlify dev` (webhook ElevenLabs lokálně nedorazí, Soniox funguje).

## Limity

- Max. velikost souboru 150 MB (`MAX_BYTES` v `netlify/lib/shared.mts`).
- Nahrávka z mikrofonu se ukládá v Opus 32 kb/s, hodina řeči má zhruba 15 MB.
- Volný kontext využívá jen Soniox. ElevenLabs použije jen odborné výrazy (keyterms).
