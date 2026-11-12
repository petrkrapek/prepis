import type { Config } from "@netlify/functions";
import { currentUser, json } from "../lib/shared.mts";

// Stránka se sem zeptá po načtení, jestli je uživatel přihlášený a má přístup.
export default async () => {
  const user = await currentUser();
  return user instanceof Response ? user : json(user);
};

export const config: Config = { path: "/api/me", method: "GET" };
