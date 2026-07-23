-- Adds task-type tagging to sessions and per-user label overrides to profiles.
-- Run this once in the Supabase SQL Editor.

alter table public.sessions add column if not exists type text;
comment on column public.sessions.type is
  'Task-type key (one of ''deep'',''shallow'',''chores'',''exercise'',''planning''); NULL means a legacy/untagged session.';

create index if not exists sessions_user_type_idx on public.sessions (user_id, type);

alter table public.profiles add column if not exists task_type_labels jsonb;
comment on column public.profiles.task_type_labels is
  'Per-user overrides for the 5 task-type labels, shape { "deep": {"title":"...","desc":"..."}, ... }; NULL means use app defaults. Emoji are fixed in the client and never stored here.';
