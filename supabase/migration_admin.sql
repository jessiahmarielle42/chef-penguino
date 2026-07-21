-- Admin Dashboard: preset profile pictures + admin pizza/coin editing.
-- Restricted to keefefons@gmail.com via auth.email() checks below - this is
-- the actual enforcement; the app only hides the entry point client-side.
-- Run this once in the Supabase SQL Editor.

-- ---------- preset profile pictures ----------
create table if not exists public.preset_avatars (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  url text not null,
  created_at timestamptz not null default now()
);

alter table public.preset_avatars enable row level security;

create policy "preset avatars are publicly readable"
  on public.preset_avatars for select
  using (true);

create policy "admin can manage preset avatars"
  on public.preset_avatars for all
  using (auth.email() = 'keefefons@gmail.com')
  with check (auth.email() = 'keefefons@gmail.com');

-- Presets live in the same public 'avatars' storage bucket (see
-- migration_avatar.sql), under a shared presets/ prefix rather than a
-- per-user uid folder, so they need their own storage policy.
create policy "admin can manage preset avatars in storage"
  on storage.objects for all
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = 'presets' and auth.email() = 'keefefons@gmail.com')
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = 'presets' and auth.email() = 'keefefons@gmail.com');

-- ---------- admin can view/edit any user ----------
create policy "admin can view all profiles"
  on public.profiles for select
  using (auth.email() = 'keefefons@gmail.com');

create policy "admin can update any profile"
  on public.profiles for update
  using (auth.email() = 'keefefons@gmail.com');

-- Lets the admin insert an "Admin Edit" session row into another user's own
-- log (adjusting their pizzas via the existing bump_pizzas trigger, and
-- leaving a visible record of the change).
create policy "admin can insert sessions for any user"
  on public.sessions for insert
  with check (auth.email() = 'keefefons@gmail.com');
