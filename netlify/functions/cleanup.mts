import type { Config } from "@netlify/functions";
import { cleanupSoniox, deleteJob, legacyStore, store, type Job } from "../lib/shared.mts";

// Úloha starší než 6 hodin už nikoho nezajímá: prohlížeč je zavřený,
// nebo přepis uvázl (status.mts úlohu vzdává po 3 hodinách).
const STALE_MS = 6 * 60 * 60 * 1000;

// Každou hodinu uklidí úložiště, aby v něm nezůstaly nahrávky ani zadání:
// 1) opuštěné úlohy v EU i s jejich daty u Sonioxu,
// 2) kousky zvuku a výsledky, ke kterým už úloha neexistuje,
// 3) cokoli v původním úložišti v USA (do 12. 11. 2026 se ukládalo tam).
export default async () => {
  const s = store();
  const { blobs } = await s.list();
  const live = new Set<string>();
  let stale = 0;
  for (const { key } of blobs) {
    if (!key.startsWith("job/")) continue;
    const job = (await s.get(key, { type: "json" })) as Job | null;
    if (!job) continue;
    if (Date.now() - job.createdAt < STALE_MS) { live.add(job.id); continue; }
    if (job.provider === "soniox") await cleanupSoniox(job);
    await deleteJob(job);
    stale++;
  }

  let orphans = 0;
  for (const { key } of blobs) {
    const id = /^(?:audio|result)\/([^/]+)/.exec(key)?.[1];
    if (id && !live.has(id)) { await s.delete(key); orphans++; }
  }

  const legacy = legacyStore();
  const old = await legacy.list();
  for (const { key } of old.blobs) {
    if (key.startsWith("job/")) {
      const job = (await legacy.get(key, { type: "json" })) as Job | null;
      if (job?.provider === "soniox") await cleanupSoniox(job);
    }
    await legacy.delete(key);
  }

  console.log(`Úklid: ${stale} opuštěných úloh, ${orphans} osiřelých dat, ${old.blobs.length} položek ze starého úložiště v USA.`);
};

// Každou hodinu v 17. minutě (UTC).
export const config: Config = { schedule: "17 * * * *" };
