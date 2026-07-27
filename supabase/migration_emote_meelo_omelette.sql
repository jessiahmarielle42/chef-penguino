-- ============================================================
--  Tag the new "Meelo Omelette" emote as type Meelo
-- ------------------------------------------------------------
--  The clip, title and description ship in the app itself (the EMOTES
--  array in main.js), so the emote already works without this. Only the
--  Type tag lives in the database, in emote_meta - which is why this is
--  the one piece that needs a row.
--
--  The "Meelo" tag already exists (it's on whack-a-meelo and
--  my-favourite), so this looks it up by name rather than hardcoding its
--  id, and does nothing if it has been renamed or removed.
--
--  You can skip this entirely and set it in the app instead:
--  Admin Dashboard -> Emotes -> Meelo Omelette -> Type -> Meelo.
--  Both do exactly the same thing.
--
--  Idempotent - safe to run more than once.
-- ============================================================

insert into public.emote_meta (emote_id, tag_id)
select 'meelo-omelette', t.id
from public.emote_tags t
where t.name = 'Meelo'
on conflict (emote_id) do update set tag_id = excluded.tag_id;

-- Verify: should return one row, tag_name = Meelo.
select m.emote_id, t.name as tag_name
from public.emote_meta m
join public.emote_tags t on t.id = m.tag_id
where m.emote_id = 'meelo-omelette';
