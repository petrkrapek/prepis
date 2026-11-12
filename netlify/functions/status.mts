import type { Config } from "@netlify/functions";
import {
  checkAuth, env, fail, jobKey, json, loadJob, resultKey, saveJob, store, validId, withSpeakers, type Job,
} from "../lib/shared.mts";

const GIVE_UP_MS = 3 * 60 * 60 * 1000; // po 3 hodinách bez výsledku úlohu vzdáme

// Vrací stav úlohy. Hotový přepis vydá jednou a pak úlohu smaže,
// aby na serveru nezůstávaly texty přepisů.
export default async (req: Request) => {
  const denied = checkAuth(req);
  if (denied) return denied;

  const id = new URL(req.url).searchParams.get("job");
  if (!validId(id)) return fail("Neplatné ID úlohy.");
  const job = await loadJob(id);
  if (!job) return fail("Úloha neexistuje nebo už byla vyzvednuta.", 404);

  if (job.status === "error") return json({ status: "error", error: job.error });
  if (job.status === "uploading") return json({ status: "uploading" });

  try {
    const text = job.provider === "soniox" ? await pollSoniox(job) : await pollElevenLabs(job);
    if (text === null) {
      if (Date.now() - job.createdAt > GIVE_UP_MS) {
        job.status = "error";
        job.error = "Služba nevrátila výsledek ani po 3 hodinách.";
        await saveJob(job);
        return json({ status: "error", error: job.error });
      }
      return json({ status: "processing" });
    }
    await store().delete(jobKey(job.id));
    return json({ status: "completed", text });
  } catch (e) {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
    await saveJob(job);
    return json({ status: "error", error: job.error });
  }
};

async function pollSoniox(job: Job): Promise<string | null> {
  const auth = { Authorization: `Bearer ${env("SONIOX_API_KEY")}` };
  const base = "https://api.soniox.com/v1";

  const st = await fetch(`${base}/transcriptions/${job.providerId}`, { headers: auth });
  if (!st.ok) throw new Error(`Soniox: nelze zjistit stav (${st.status}).`);
  const info = (await st.json()) as { status: string; error_message?: string };

  if (info.status === "error") {
    await cleanupSoniox(job);
    throw new Error(`Soniox: ${info.error_message || "přepis selhal."}`);
  }
  if (info.status !== "completed") return null;

  const tr = await fetch(`${base}/transcriptions/${job.providerId}/transcript`, { headers: auth });
  if (!tr.ok) throw new Error(`Soniox: nelze stáhnout přepis (${tr.status}).`);
  const data = (await tr.json()) as {
    text: string;
    tokens?: { text: string; speaker?: string }[];
  };
  await cleanupSoniox(job);

  if (job.diarize && data.tokens?.length) return withSpeakers(data.tokens);
  return data.text.trim();
}

// Soniox soubory ani přepisy sám nemaže, uklidíme je hned po stažení.
async function cleanupSoniox(job: Job) {
  const auth = { Authorization: `Bearer ${env("SONIOX_API_KEY")}` };
  const base = "https://api.soniox.com/v1";
  await Promise.allSettled([
    fetch(`${base}/transcriptions/${job.providerId}`, { method: "DELETE", headers: auth }),
    job.sonioxFileId
      ? fetch(`${base}/files/${job.sonioxFileId}`, { method: "DELETE", headers: auth })
      : Promise.resolve(),
  ]);
}

async function pollElevenLabs(job: Job): Promise<string | null> {
  const s = store();
  const result = (await s.get(resultKey(job.id), { type: "json" })) as
    | { error?: string; transcription?: any }
    | null;
  if (!result) return null;
  await s.delete(resultKey(job.id));

  if (result.error) throw new Error(`ElevenLabs: ${result.error}`);
  const t = result.transcription;
  const words: { text: string; type?: string; speaker_id?: string }[] = t.words ?? [];
  if (job.diarize && words.length) {
    return withSpeakers(
      words
        .filter((w) => w.type !== "audio_event")
        .map((w) => ({ text: w.text, speaker: w.speaker_id ?? null })),
    );
  }
  return String(t.text ?? "").trim();
}

export const config: Config = { path: "/api/status", method: "GET" };
