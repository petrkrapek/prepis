import type { Config } from "@netlify/functions";
import { currentUser, json } from "../lib/shared.mts";
import { publicTemplates } from "../lib/correction.mts";

// Stránka se sem zeptá po načtení, jestli je uživatel přihlášený a má přístup.
// Dozví se i šablony AI korektury; bez klíče k Anthropic je korektura vypnutá (null).
export default async () => {
  const user = await currentUser();
  if (user instanceof Response) return user;
  const correction = Netlify.env.get("ANTHROPIC_API_KEY") ? { templates: publicTemplates() } : null;
  return json({ ...user, correction });
};

export const config: Config = { path: "/api/me", method: "GET" };
