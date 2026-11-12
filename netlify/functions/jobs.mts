import type { Config } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import {
  CHUNK_BYTES, MAX_BYTES, MAX_CONTEXT_CHARS, MAX_CONTEXT_TOTAL, MAX_TERMS, MAX_TERM_CHARS,
  checkAuth, fail, json, saveJob, type Job,
} from "../lib/shared.mts";

// Založí přepisovou úlohu a vrátí její ID a počet kousků k nahrání.
export default async (req: Request) => {
  const denied = await checkAuth();
  if (denied) return denied;

  let b: any;
  try { b = await req.json(); } catch { return fail("Neplatný požadavek."); }

  const provider = b.provider;
  if (provider !== "soniox" && provider !== "elevenlabs") return fail("Neznámá přepisová služba.");

  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) return fail("Soubor je prázdný.");
  if (size > MAX_BYTES) return fail(`Soubor je větší než ${MAX_BYTES / 1024 / 1024} MB.`);

  const language =
    typeof b.language === "string" && /^(auto|[a-z]{2,3})$/.test(b.language) ? b.language : "auto";
  const context = String(b.context ?? "").trim().slice(0, MAX_CONTEXT_CHARS);
  const rawTerms: string[] = Array.isArray(b.terms) ? b.terms.map((t: unknown) => String(t).trim()) : [];
  const terms = [...new Set(rawTerms.filter(Boolean))]
    .slice(0, MAX_TERMS)
    .map((t) => t.slice(0, MAX_TERM_CHARS));
  const total = context.length + terms.reduce((n, t) => n + t.length, 0);
  if (provider === "soniox" && total > MAX_CONTEXT_TOTAL) {
    return fail(`Kontext a odborné výrazy mají dohromady ${total} znaků, Soniox jich přijme nejvýš ${MAX_CONTEXT_TOTAL}. Zkraťte je.`);
  }

  const job: Job = {
    id: randomUUID(),
    provider,
    language,
    context,
    terms,
    diarize: !!b.diarize,
    mime: String(b.mime || "application/octet-stream").slice(0, 100),
    filename: String(b.filename || "audio").replace(/[^\w.\-]/g, "_").slice(0, 80),
    size,
    chunks: Math.ceil(size / CHUNK_BYTES),
    status: "uploading",
    createdAt: Date.now(),
  };
  await saveJob(job);
  return json({ id: job.id, chunks: job.chunks, chunkBytes: CHUNK_BYTES });
};

export const config: Config = { path: "/api/jobs", method: "POST" };
