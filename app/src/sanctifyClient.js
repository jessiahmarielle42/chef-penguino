// ---------- Sanctify connector (admin-only Background Music source) ----------
// A SECOND Supabase client pointed at the Sanctify project, used only by the
// admin to sign into Sanctify, search its catalog, and mint signed audio URLs
// for songs chosen as Chef Penguino background music. Kept in its own module +
// lazily constructed so it never loads for normal users and never touches
// Penguino's own auth session.
//
// Isolation from Penguino's client is deliberate:
//  - a distinct `storageKey` so the two sessions never collide in localStorage,
//  - `detectSessionInUrl: false` so this client NEVER races Penguino's client
//    for the `?code=` on an OAuth return - main.js captures + strips the code
//    itself (only when the `cpsanctify` marker is present) and hands it here
//    via exchangeCodeForSession().
import { createClient } from '@supabase/supabase-js'

// Public, browser-safe values (the same publishable key Sanctify ships in its
// own client bundle). Not a secret - RLS on the Sanctify project is what gates
// access, and only authenticated users can read the catalog / sign audio URLs.
export const SANCTIFY_URL = 'https://yndmbdegursbrkwctyco.supabase.co'
export const SANCTIFY_KEY = 'sb_publishable_yYmAyLLJ5efxbAUkqrSj6Q_U1mu6H1c'
export const SANCTIFY_STORAGE_KEY = 'cp-sanctify-auth'

let _client = null
export function getSanctifyClient() {
  if (!_client) {
    _client = createClient(SANCTIFY_URL, SANCTIFY_KEY, {
      auth: {
        storageKey: SANCTIFY_STORAGE_KEY,
        flowType: 'pkce',
        detectSessionInUrl: false, // main.js drives the code exchange - see above
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  }
  return _client
}
