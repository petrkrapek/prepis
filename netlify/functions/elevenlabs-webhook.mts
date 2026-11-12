import type { Config } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";
import { resultKey, store, validId } from "../lib/shared.mts";

const MAX_AGE_S = 30 * 60;

// ElevenLabs sem pošle hotový přepis. Podpis ověříme sdíleným tajemstvím
// z nastavení webhooku v ElevenLabs a výsledek uložíme k dané úloze.
export default async (req: Request) => {
  const secret = Netlify.env.get("ELEVENLABS_WEBHOOK_SECRET");
  if (!secret) return new Response("Missing secret", { status: 500 });

  const raw = await req.text();
  if (!verify(req.headers.get("elevenlabs-signature"), raw, secret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  const data = event?.data ?? {};
  let meta = data.webhook_metadata;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  const jobId = meta?.job_id;
  if (!validId(jobId)) return new Response("Unknown job", { status: 200 }); // nic k uložení

  const transcription = data.transcription ?? (typeof data.text === "string" ? data : null);
  await store().setJSON(
    resultKey(jobId),
    transcription ? { transcription } : { error: data.error || data.message || "přepis selhal." },
  );
  return new Response("ok");
};

// Hlavička má tvar "t=<unix čas>,v0=<hex HMAC-SHA256 z "t.tělo">".
function verify(header: string | null, body: string, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!parts.v0 || !Number.isFinite(t)) return false;
  if (Math.abs(Date.now() / 1000 - t) > MAX_AGE_S) return false;

  const expected = createHmac("sha256", secret).update(`${parts.t}.${body}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parts.v0, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const config: Config = { path: "/api/elevenlabs-webhook", method: "POST" };
