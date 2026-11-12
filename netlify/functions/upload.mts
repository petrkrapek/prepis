import type { Config } from "@netlify/functions";
import { CHUNK_BYTES, checkAuth, chunkKey, fail, json, loadJob, store, validId } from "../lib/shared.mts";

// Přijme jeden kousek audia (max. 4 MB) a uloží ho do Netlify Blobs.
export default async (req: Request) => {
  const denied = await checkAuth();
  if (denied) return denied;

  const url = new URL(req.url);
  const id = url.searchParams.get("job");
  const index = Number(url.searchParams.get("index"));
  if (!validId(id)) return fail("Neplatné ID úlohy.");

  const job = await loadJob(id);
  if (!job) return fail("Úloha neexistuje.", 404);
  if (job.status !== "uploading") return fail("Úloha už neočekává další data.", 409);
  if (!Number.isInteger(index) || index < 0 || index >= job.chunks) return fail("Neplatné pořadí kousku.");

  const data = await req.arrayBuffer();
  if (data.byteLength === 0 || data.byteLength > CHUNK_BYTES) return fail("Neplatná velikost kousku.");

  await store().set(chunkKey(id, index), data);
  return json({ ok: true });
};

export const config: Config = { path: "/api/upload", method: "POST" };
