import type { Config } from "@netlify/functions";
import {
  checkAuth, chunkKey, deleteAudio, deleteJob, env, fail, json, loadJob, saveJob, sonioxBase, store, validId, type Job,
} from "../lib/shared.mts";

// Poskládá nahrané kousky a předá audio zvolené službě. Nečeká na výsledek:
// Soniox zpracuje úlohu asynchronně, ElevenLabs pošle výsledek na webhook.
export default async (req: Request) => {
  const denied = await checkAuth();
  if (denied) return denied;

  const id = new URL(req.url).searchParams.get("job");
  if (!validId(id)) return fail("Neplatné ID úlohy.");
  const job = await loadJob(id);
  if (!job) return fail("Úloha neexistuje.", 404);
  if (job.status !== "uploading") return fail("Přepis už byl spuštěn.", 409);

  // Když se přepis nespustí, smažeme úlohu celou: prohlížeč se na ni už
  // nezeptá a při opakování založí novou. Nic tak v úložišti nezůstane.
  const s = store();
  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < job.chunks; i++) {
    const part = await s.get(chunkKey(id, i), { type: "arrayBuffer" });
    if (!part) {
      await deleteJob(job);
      return fail(`Chybí část ${i + 1} z ${job.chunks}. Nahrajte soubor znovu.`);
    }
    parts.push(part);
  }
  const audio = new Blob(parts, { type: job.mime });
  if (audio.size !== job.size) {
    await deleteJob(job);
    return fail("Nahraný soubor nemá očekávanou velikost. Nahrajte ho znovu.");
  }

  try {
    if (job.provider === "soniox") await startSoniox(job, audio);
    else await startElevenLabs(job, audio);
  } catch (e) {
    await deleteJob(job);
    return fail(e instanceof Error ? e.message : String(e), 502);
  }
  job.status = "processing";
  await saveJob(job);
  await deleteAudio(job);
  return json({ ok: true });
};

async function startSoniox(job: Job, audio: Blob) {
  const base = sonioxBase();
  job.sonioxBase = base;
  const auth = { Authorization: `Bearer ${env("SONIOX_API_KEY")}` };

  const fd = new FormData();
  fd.append("file", audio, job.filename);
  const up = await fetch(`${base}/files`, { method: "POST", headers: auth, body: fd });
  if (!up.ok) throw new Error(`Soniox odmítl soubor (${up.status}): ${await up.text()}`);
  const file = (await up.json()) as { id: string };
  job.sonioxFileId = file.id;

  const body: Record<string, unknown> = {
    model: Netlify.env.get("SONIOX_MODEL") || "stt-async-v6",
    file_id: file.id,
    enable_speaker_diarization: job.diarize,
    client_reference_id: job.id,
  };
  if (job.language !== "auto") body.language_hints = [job.language];
  const context: Record<string, unknown> = {};
  if (job.context) context.text = job.context;
  if (job.terms.length) context.terms = job.terms;
  if (Object.keys(context).length) body.context = context;

  try {
    const tr = await fetch(`${base}/transcriptions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!tr.ok) throw new Error(`Soniox odmítl přepis (${tr.status}): ${await tr.text()}`);
    job.providerId = ((await tr.json()) as { id: string }).id;
  } catch (e) {
    // Přepis nevznikl. Nahraný soubor by jinak u Sonioxu zůstal až 30 dní.
    await fetch(`${base}/files/${file.id}`, { method: "DELETE", headers: auth }).catch(() => {});
    job.sonioxFileId = undefined;
    throw e;
  }
}

async function startElevenLabs(job: Job, audio: Blob) {
  const fd = new FormData();
  fd.append("model_id", Netlify.env.get("ELEVENLABS_MODEL") || "scribe_v2");
  fd.append("file", audio, job.filename);
  if (job.language !== "auto") fd.append("language_code", job.language);
  fd.append("diarize", String(job.diarize));
  fd.append("tag_audio_events", "false");
  for (const t of job.terms) fd.append("keyterms", t);
  fd.append("webhook", "true");
  const webhookId = Netlify.env.get("ELEVENLABS_WEBHOOK_ID");
  if (webhookId) fd.append("webhook_id", webhookId);
  fd.append("webhook_metadata", JSON.stringify({ job_id: job.id }));

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env("ELEVENLABS_API_KEY") },
    body: fd,
  });
  if (!res.ok) throw new Error(`ElevenLabs odmítl přepis (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { request_id?: string };
  job.providerId = data.request_id;
}

export const config: Config = { path: "/api/start", method: "POST" };
