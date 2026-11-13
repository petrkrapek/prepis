import type { Config } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_CONTEXT_CHARS, MAX_TERMS, MAX_TERM_CHARS, checkAuth, fail, json,
} from "../lib/shared.mts";
import {
  MAX_BEFORE_CHARS, MAX_CORRECT_CHARS, findTemplate, systemPrompt, userPrompt,
} from "../lib/correction.mts";

// Funkce musí odpovědět dřív, než ji Netlify po 60 s ukončí.
const TIMEOUT_MS = 50_000;

// Chyba, po které má prohlížeč zkusit totéž s kratší částí textu.
const splitFail = (message: string, status: number) => json({ error: message, split: true }, status);

// Opraví jednu část přepisu podle zvolené šablony. Nic neukládá: text přijde,
// projde modelem a vrátí se. Dlouhý přepis posílá prohlížeč po částech,
// protože běžná funkce na Netlify nesmí běžet déle než minutu.
export default async (req: Request) => {
  const denied = await checkAuth();
  if (denied) return denied;

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return fail("AI korektura není zapnutá: na serveru chybí proměnná ANTHROPIC_API_KEY.", 503);

  let b: any;
  try { b = await req.json(); } catch { return fail("Neplatný požadavek."); }

  const template = findTemplate(b.template);
  if (!template) return fail("Neznámá šablona korektury.");
  const text = String(b.text ?? "").trim();
  if (!text) return fail("Chybí text k opravě.");
  if (text.length > MAX_CORRECT_CHARS) {
    return splitFail(`Část textu má ${text.length} znaků, najednou lze opravit nejvýš ${MAX_CORRECT_CHARS}.`, 413);
  }
  const language = typeof b.language === "string" && /^(auto|[a-z]{2,3})$/.test(b.language) ? b.language : "auto";
  const context = String(b.context ?? "").trim().slice(0, MAX_CONTEXT_CHARS);
  const terms: string[] = (Array.isArray(b.terms) ? b.terms : [])
    .map((t: unknown) => String(t).trim().slice(0, MAX_TERM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TERMS);
  const before = String(b.before ?? "").slice(-MAX_BEFORE_CHARS).trim();

  // Opakování při chybě řídí prohlížeč, tady by se nevešlo do časového limitu funkce.
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  try {
    const response = await client.beta.messages.create({
      model: Netlify.env.get("ANTHROPIC_MODEL") || "claude-opus-5-5",
      max_tokens: 8000,
      // Korektura je jednoduchá úloha a musí být rychlá, proto nízké úsilí.
      output_config: { effort: "low" },
      // Když model odmítne odpovědět (např. citlivé téma nahrávky), zkusí to záložní model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: systemPrompt(template),
      messages: [{ role: "user", content: userPrompt({ text, before, context, terms, language }) }],
    });

    if (response.stop_reason === "refusal") {
      return fail("Model odmítl tuto část přepisu opravit. Původní přepis zůstává beze změny.", 422);
    }
    if (response.stop_reason === "max_tokens") return splitFail("Oprava se nevešla do jedné odpovědi.", 413);

    const fixed = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    if (!fixed) return fail("Model nevrátil žádný text.", 502);
    return json({ text: fixed });
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionTimeoutError) {
      return splitFail("Model nestihl část přepisu opravit včas.", 504);
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return fail("Anthropic odmítl klíč ANTHROPIC_API_KEY. Zkontrolujte ho v nastavení Netlify.", 502);
    }
    if (e instanceof Anthropic.RateLimitError) {
      return json({ error: "Anthropic teď přijímá méně požadavků. Zkuste to za chvíli.", busy: true }, 429);
    }
    if (e instanceof Anthropic.APIConnectionError) {
      return json({ error: "Nepodařilo se spojit s Anthropic.", busy: true }, 502);
    }
    if (e instanceof Anthropic.APIError) {
      const overloaded = typeof e.status === "number" && e.status >= 500;
      return json({ error: `Anthropic vrátil chybu ${e.status ?? ""}: ${e.message}`, busy: overloaded }, 502);
    }
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
};

export const config: Config = { path: "/api/correct", method: "POST" };
