# Sanctify-side setup for the Chef Penguino connector

Sanctify project ref: `yndmbdegursbrkwctyco`
URL: `https://yndmbdegursbrkwctyco.supabase.co`

Only Penguino streams Sanctify audio; it signs into YOUR Sanctify Supabase via
Google, then reads approved songs + mints 1-hour signed audio URLs client-side.
Existing RLS already permits both for authenticated users — so the required
changes are **dashboard settings, not code**:

## 1. Allow Penguino to sign in (REQUIRED — Supabase dashboard, no SQL)
Sanctify Supabase → Authentication → URL Configuration → **Redirect URLs**, add:
- `https://chefpenguino.vercel.app/**`
- `http://localhost:5173/**`   (Vite dev, for building/testing)

Nothing else changes; Google is already an enabled provider.

## 2. Audio CORS (VERIFY — usually already fine)
Supabase Storage signed URLs send `access-control-allow-origin: *` by default,
which is what lets Penguino's Web Audio graph play the file cross-origin. I'll
confirm during build; if a custom CORS policy ever narrows it, add
`https://chefpenguino.vercel.app`.

## 3. Anon (publishable) key — REQUIRED for Penguino to embed
Public-safe key (same one shipped in Sanctify's own browser bundle).
Get it: Sanctify Supabase → Project Settings → API → `anon` `public` key.
--> paste it to me, OR say "pull it from prod" and I'll read it from the
deployed Sanctify bundle.

## 4. (OPTIONAL) Better song search — supabase/sanctify_search_songs.sql
Default v1 uses a plain title substring match via a direct table read (no SQL
needed). If you want fuzzy/trigram song search quality, run the RPC in
`sanctify_search_songs.sql` (paste into Sanctify's SQL editor). Not required to ship.
