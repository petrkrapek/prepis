import type { Config } from "@netlify/functions";
import {
  checkAuth, cleanupSoniox, deleteJob, env, fail, json, loadJob, resultKey, sonioxApi, store, validId, withSpeakers,
  type Job,
} from "../lib/shared.mts";
import { buildSegments, segmentsText, type Segment, type SonioxToken } from "../lib/segments.mts";

// Hotový přepis: prostý text na kopírování a u Sonioxu i repliky pro arch.
type Result = { text: string; segments?: Segment[] };

const GIVE_UP_MS = 3 * 60 * 60 * 1000; // po 3 hodinách bez výsledku úlohu vzdáme

// Vrací stav úlohy. Hotový přepis i chybu vydá jednou a pak úlohu smaže,
// aby na serveru nezůstávaly texty přepisů ani zadání.
export default async (req: Request) => {
  const denied = await checkAuth();
  if (denied) return denied;

  const id = new URL(req.url).searchParams.get("job");
  if (!validId(id)) return fail("Neplatné ID úlohy.");
  const job = await loadJob(id);
  if (!job) return fail("Úloha neexistuje nebo už byla vyzvednuta.", 404);

  if (job.status === "error") return giveUp(job, job.error || "Přepis se nepodařil.");
  if (job.status === "uploading") return json({ status: "uploading" });

  try {
    const result = job.provider === "soniox" ? await pollSoniox(job) : await pollElevenLabs(job);
    if (result === null) {
      if (Date.now() - job.createdAt > GIVE_UP_MS) return giveUp(job, "Služba nevrátila výsledek ani po 3 hodinách.");
      return json({ status: "processing" });
    }
    await deleteJob(job);
    return json({ status: "completed", ...result });
  } catch (e) {
    return giveUp(job, e instanceof Error ? e.message : String(e));
  }
};

async function pollSoniox(job: Job): Promise<Result | null> {
  const auth = { Authorization: `Bearer ${env("SONIOX_API_KEY")}` };
  const base = sonioxApi(job);

  const st = await fetch(`${base}/transcriptions/${job.providerId}`, { headers: auth });
  if (!st.ok) throw new Error(`Soniox: nelze zjistit stav (${st.status}).`);
  const info = (await st.json()) as { status: string; error_message?: string };

  if (info.status === "error") throw new Error(`Soniox: ${info.error_message || "přepis selhal."}`); // uklidí giveUp
  if (info.status !== "completed") return null;

  const tr = await fetch(`${base}/transcriptions/${job.providerId}/transcript`, { headers: auth });
  if (!tr.ok) throw new Error(`Soniox: nelze stáhnout přepis (${tr.status}).`);
  const data = (await tr.json()) as { text: string; tokens?: SonioxToken[] };
  await cleanupSoniox(job);

  if (!data.tokens?.length) return { text: data.text.trim() };
  const segments = buildSegments(data.tokens, job.diarize);
  return { text: segmentsText(segments), segments };
}

// Úlohu vzdáme: uklidíme ji u služby i u nás a chybu vydáme prohlížeči.
async function giveUp(job: Job, error: string): Promise<Response> {
  if (job.provider === "soniox") await cleanupSoniox(job);
  await deleteJob(job);
  return json({ status: "error", error });
}

async function pollElevenLabs(job: Job): Promise<Result | null> {
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
    return {
      text: withSpeakers(
        words
          .filter((w) => w.type !== "audio_event")
          .map((w) => ({ text: w.text, speaker: w.speaker_id ?? null })),
      ),
    };
  }
  return { text: String(t.text ?? "").trim() };
}

export const config: Config = { path: "/api/status", method: "GET" };
