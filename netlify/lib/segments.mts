// Poskládá tokeny ze Sonioxu do replik pro arch: kdo mluví, od kolikáté
// sekundy a která slova si služba nebyla jistá. Bez závislostí, ať jde testovat.

/**
 * Slovo s nižší jistotou (0–1) na archu označíme ke kontrole.
 * Soniox žádný práh nedoporučuje, 0,6 je náš odhad.
 */
export const LOW_CONFIDENCE = 0.6;

export interface SonioxToken {
  text: string;
  start_ms?: number;
  confidence?: number;
  speaker?: string | number | null;
}

/** Úsek textu v replice; low = služba si nebyla jistá. */
export interface Part {
  t: string;
  low?: true;
}

export interface Segment {
  speaker: string | null; // "Mluvčí 1", bez rozlišení mluvčích null
  start: number;          // sekunda od začátku nahrávky
  parts: Part[];
}

/** "1" → "Mluvčí 1". ElevenLabs čísluje od 0 (speaker_0), Soniox od 1. */
export function speakerName(sp: string | number | null | undefined): string | null {
  if (sp == null) return null;
  const s = String(sp);
  const n = Number(s.replace(/\D/g, ""));
  return `Mluvčí ${s.startsWith("speaker_") ? n + 1 : n}`;
}

export function buildSegments(tokens: SonioxToken[], diarize: boolean): Segment[] {
  // 1) Tokeny jsou i části slov. Slovo začíná tokenem s mezerou na začátku;
  //    jeho jistota je nejnižší jistota z jeho tokenů.
  type Word = { text: string; start: number; conf: number; speaker: string | null };
  const words: Word[] = [];
  let speaker: string | null = null;
  for (const tk of tokens) {
    if (diarize && tk.speaker != null) speaker = String(tk.speaker);
    const sp = diarize ? speaker : null;
    const last = words[words.length - 1];
    const conf = typeof tk.confidence === "number" ? tk.confidence : 1;
    if (!last || /^\s/.test(tk.text) || last.speaker !== sp) {
      words.push({ text: tk.text, start: tk.start_ms ?? last?.start ?? 0, conf, speaker: sp });
    } else {
      last.text += tk.text;
      last.conf = Math.min(last.conf, conf);
    }
  }

  // 2) Slova skládáme do replik podle mluvčího a uvnitř je slučujeme do úseků.
  const segments: Segment[] = [];
  let raw: string | null | undefined;
  let cur: Segment | null = null;
  for (const w of words) {
    if (!cur || raw !== w.speaker) {
      raw = w.speaker;
      cur = { speaker: speakerName(w.speaker), start: Math.floor(w.start / 1000), parts: [] };
      segments.push(cur);
    }
    const prev = cur.parts[cur.parts.length - 1];
    if (w.conf < LOW_CONFIDENCE && prev?.low) {
      // Nejistá slova za sebou podtrhneme jako jednu frázi.
      prev.t += w.text;
    } else if (w.conf < LOW_CONFIDENCE) {
      // Mezeru před prvním nejistým slovem nechceme podtrženou.
      const [, space, word] = /^(\s*)([\s\S]*)$/.exec(w.text)!;
      append(cur.parts, space, false);
      append(cur.parts, word, true);
    } else {
      append(cur.parts, w.text, false);
    }
  }

  for (const s of segments) {
    const first = s.parts[0], last = s.parts[s.parts.length - 1];
    if (first) first.t = first.t.trimStart();
    if (last) last.t = last.t.trimEnd();
    s.parts = s.parts.filter((p) => p.t);
  }
  return segments.filter((s) => s.parts.length);
}

function append(parts: Part[], t: string, low: boolean) {
  if (!t) return;
  const last = parts[parts.length - 1];
  if (last && !!last.low === low) last.t += t;
  else parts.push(low ? { t, low: true } : { t });
}

/** Prostý text pro kopírování a stažení: repliky oddělené prázdným řádkem. */
export function segmentsText(segments: Segment[]): string {
  return segments
    .map((s) => (s.speaker ? `${s.speaker}: ` : "") + s.parts.map((p) => p.t).join(""))
    .join("\n\n");
}
