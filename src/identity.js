// Do prohlížeče se přibalí jen to, co stránka potřebuje z knihovny Netlify Identity.
// Sestaví se příkazem `npm run build` do public/identity.js.
export { getUser, oauthLogin, logout, handleAuthCallback, refreshSession } from "@netlify/identity";
