import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

// Velikost jednoho kousku audia. Netlify má limit 6 MB na požadavek
// (binární data se přenášejí v base64, tj. +33 %), proto 4 MB s rezervou.
export const CHUNK_BYTES = 4_000_000;
export const MAX_BYTES = 150 * 1024 * 1024;
export const MAX_CONTEXT_CHARS = 8000;
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
  error?: string;
  createdAt: number;
}

export function store() {
  return getStore({ name: "prepisy", consistency: "strong" });
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

function sha(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Vrátí chybovou odpověď, pokud heslo nesedí; jinak null. */
export function checkAuth(req: Request): Response | null {
  const expected = Netlify.env.get("APP_PASSWORD");
  if (!expected) return fail("Na serveru chybí proměnná APP_PASSWORD.", 500);
  const given = req.headers.get("x-app-password") ?? "";
  if (!timingSafeEqual(sha(given), sha(expected))) {
    return fail("Heslo nesouhlasí.", 401);
  }
  return null;
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
  if (sp == null) return "";
  const n = Number(String(sp).replace(/\D/g, ""));
  // ElevenLabs čísluje od 0 (speaker_0), Soniox od 1.
  return `Mluvčí ${String(sp).startsWith("speaker_") ? n + 1 : n}: `;
}
