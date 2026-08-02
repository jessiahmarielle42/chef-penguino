-- Chef Penguino: Background Music picker - lets a signed-in chef pick which
-- soundtrack plays instead of the default. Null = default track, so a
-- pre-migration profile (or one that never opened the picker) needs no
-- backfill.

alter table public.profiles add column if not exists soundtrack text;
