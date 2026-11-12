import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";
import { speakerName } from "./segments.mts";

// Velikost jednoho kousku audia. Netlify má limit 6 MB na požadavek
// (binární data se přenášejí v base64, tj. +33 %), proto 4 MB s rezervou.
export const CHUNK_BYTES = 4_000_000;
export const MAX_BYTES = 150 * 1024 * 1024;
export const MAX_CONTEXT_CHARS = 8000;
// Soniox přijme kontext nejvýš 8 000 tokenů (podle něj asi 10 000 znaků) za celý
// objekt context. Text a výrazy proto hlídáme dohromady, s rezervou na češtinu.
export const MAX_CONTEXT_TOTAL = 8000;
export const MAX_TERMS = 100;
export const MAX_TERM_CHARS = 50;

export type Provider = "soniox" | "elevenlabs";

export interface Job {
  id: string;
  provider: Provider;
  language: string; // "auto" nebo ISO kód, např. "cs"
  context: string;
  terms: string[];
  diarize: boolean;
  mime: string;
  filename: string;
  size: number;
  chunks: number;
  status: "uploading" | "processing" | "completed" | "error";
  providerId?: string;
  sonioxFileId?: string;
  sonioxBase?: string; // adresa API v regionu, kde úloha vznikla
  error?: string;
  createdAt: number;
}

// Úlohy a kousky nahrávek leží ve Frankfurtu (EU). Region je nutné předat
// při každém otevření úložiště, jinak @netlify/blobs použije USA (us-east-2).
export const BLOBS_REGION = "eu-central-1" as const;

export function store() {
  return getStore({ name: "prepisy", consistency: "strong", region: BLOBS_REGION });
}

/** Původní úložiště v USA. Používá ho jen úklid (cleanup.mts), aby v něm nic nezůstalo. */
export function legacyStore() {
  return getStore({ name: "prepisy", consistency: "strong", region: "us-east-2" });
}

export const jobKey = (id: string) => `job/${id}`;
export const chunkKey = (id: string, i: number) => `audio/${id}/${i}`;
export const resultKey = (id: string) => `result/${id}`;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Zjistí přihlášeného uživatele (Netlify Identity, cookie nf_jwt) a ověří,
 * že smí aplikaci používat. Vrací jeho e-mail, nebo chybovou odpověď.
 */
export async function currentUser(): Promise<{ email: string } | Response> {
  const allowed = (Netlify.env.get("ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) return fail("Na serveru chybí proměnná ALLOWED_EMAILS.", 500);

  const user = await getUser();
  if (!user) return fail("Nejste přihlášeni.", 401);

  // Pouštíme jen účty přihlášené přes Google: Google e-mail ověřil.
  // U účtu s heslem v Netlify Identity by e-mail ověřený být nemusel.
  const email = user.email?.toLowerCase() ?? "";
  if (user.provider !== "google" || !allowed.includes(email)) {
    return fail(`Účet ${user.email || "bez e-mailu"} nemá do aplikace přístup.`, 403);
  }
  return { email };
}

/** Vrátí chybovou odpověď, pokud uživatel není přihlášený nebo nemá přístup; jinak null. */
export async function checkAuth(): Promise<Response | null> {
  const user = await currentUser();
  return user instanceof Response ? user : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validId(id: string | null): id is string {
  return !!id && UUID.test(id);
}

export async function loadJob(id: string): Promise<Job | null> {
  return (await store().get(jobKey(id), { type: "json" })) as Job | null;
}

export async function saveJob(job: Job): Promise<void> {
  await store().setJSON(jobKey(job.id), job);
}

export async function deleteAudio(job: Job): Promise<void> {
  const s = store();
  await Promise.all(
    Array.from({ length: job.chunks }, (_, i) => s.delete(chunkKey(job.id, i))),
  );
}

/** Smaže úlohu se vším, co k ní u nás patří: záznam, kousky zvuku a výsledek z webhooku. */
export async function deleteJob(job: Job): Promise<void> {
  const s = store();
  await Promise.allSettled([deleteAudio(job), s.delete(jobKey(job.id)), s.delete(resultKey(job.id))]);
}

// Region určuje, kde Soniox zpracuje a uloží zvuk i přepis. Klíč musí být
// z projektu ve stejném regionu (EU projekt se zakládá v Soniox Console).
const SONIOX_HOSTS: Record<string, string> = {
  us: "https://api.soniox.com",
  eu: "https://api.eu.soniox.com",
  jp: "https://api.jp.soniox.com",
  in: "https://api.in.soniox.com",
};

export function sonioxBase(): string {
  const region = (Netlify.env.get("SONIOX_REGION") || "us").trim().toLowerCase();
  const host = SONIOX_HOSTS[region];
  if (!host) throw new Error(`Neznámá hodnota SONIOX_REGION „${region}“. Použijte us, eu, jp nebo in.`);
  return `${host}/v1`;
}

// Úlohy z doby před volbou regionu běžely v USA.
export const sonioxApi = (job: Job) => job.sonioxBase ?? "https://api.soniox.com/v1";

/**
 * Smaže u Sonioxu přepis i nahraný soubor. Chyby ignoruje: Soniox data
 * jinak smaže sám po 30 dnech a úklid se nesmí zaseknout na jedné úloze.
 */
export async function cleanupSoniox(job: Job): Promise<void> {
  const key = Netlify.env.get("SONIOX_API_KEY");
  if (!key || (!job.providerId && !job.sonioxFileId)) return;
  const auth = { Authorization: `Bearer ${key}` };
  const base = sonioxApi(job);
  await Promise.allSettled([
    job.providerId ? fetch(`${base}/transcriptions/${job.providerId}`, { method: "DELETE", headers: auth }) : null,
    job.sonioxFileId ? fetch(`${base}/files/${job.sonioxFileId}`, { method: "DELETE", headers: auth }) : null,
  ]);
}

export function env(name: string): string {
  const v = Netlify.env.get(name);
  if (!v) throw new Error(`Na serveru chybí proměnná ${name}.`);
  return v;
}

/** Poskládá text s označením mluvčích ze seznamu kousků (slov/tokenů). */
export function withSpeakers(
  pieces: { text: string; speaker?: string | null }[],
): string {
  const out: string[] = [];
  let current: string | null | undefined;
  let buf = "";
  for (const p of pieces) {
    const sp = p.speaker ?? current;
    if (sp !== current && buf.trim()) {
      out.push(label(current) + buf.trim());
      buf = "";
    }
    current = sp;
    buf += p.text;
  }
  if (buf.trim()) out.push(label(current) + buf.trim());
  return out.join("\n\n");
}

function label(sp: string | null | undefined): string {
  const name = speakerName(sp);
  return name ? `${name}: ` : "";
}
