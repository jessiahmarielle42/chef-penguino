-- Emote Type tags + admin overrides for each emote's title/description.
-- Restricted to keefefons@gmail.com via auth.email() checks below - this is
-- the actual enforcement; the app only hides the admin entry point client-side.
-- Run this once in the Supabase SQL Editor.

-- ---------- the master list of Type tags ----------
create table if not exists public.emote_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table public.emote_tags enable row level security;

create policy "emote tags are publicly readable"
  on public.emote_tags for select
  using (true);

create policy "admin can manage emote tags"
  on public.emote_tags for all
  using (auth.email() = 'keefefons@gmail.com')
  with check (auth.email() = 'keefefons@gmail.com');

-- ---------- per-emote Type + optional title/description override ----------
-- emote_id matches an id from the hardcoded EMOTES list in main.js (e.g.
-- 'waving', 'inspection'), not a DB foreign key, since emotes themselves
-- aren't stored in the database.
create table if not exists public.emote_meta (
  emote_id text primary key,
  tag_id uuid references public.emote_tags(id) on delete set null,
  title text,
  description text,
  updated_at timestamptz not null default now()
);

alter table public.emote_meta enable row level security;

create policy "emote meta is publicly readable"
  on public.emote_meta for select
  using (true);

create policy "admin can manage emote meta"
  on public.emote_meta for all
  using (auth.email() = 'keefefons@gmail.com')
  with check (auth.email() = 'keefefons@gmail.com');
