-- ============================================================
--  Tag the new "Meelo Milo" + "Meelo Pizza" emotes as type Meelo
-- ------------------------------------------------------------
--  The clips, titles and descriptions ship in the app itself (the EMOTES
--  array in main.js), so both emotes already work without this. Only the
--  Type tag lives in the database, in emote_meta - which is why this is
--  the one piece that needs a row.
--
--  The "Meelo" tag already exists (it's on whack-a-meelo, my-favourite and
--  meelo-omelette), so this looks it up by name rather than hardcoding its
--  id, and does nothing if it has been renamed or removed.
--
--  You can skip this entirely and set it in the app instead:
--  Admin Dashboard -> Emotes -> Meelo Milo -> Type -> Meelo (and again for
--  Meelo Pizza). Both do exactly the same thing.
--
--  Idempotent - safe to run more than once.
-- ============================================================

insert into public.emote_meta (emote_id, tag_id)
select e.emote_id, t.id
from (values ('meelo-milo'), ('meelo-pizza')) as e(emote_id)
join public.emote_tags t on t.name = 'Meelo'
on conflict (emote_id) do update set tag_id = excluded.tag_id;

-- Verify: should return two rows, tag_name = Meelo.
select m.emote_id, t.name as tag_name
from public.emote_meta m
join public.emote_tags t on t.id = m.tag_id
where m.emote_id in ('meelo-milo', 'meelo-pizza');
