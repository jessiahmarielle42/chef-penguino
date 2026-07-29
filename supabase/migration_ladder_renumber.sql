-- Normalise the picture ladder to levels 1..20, preserving the order the admin
-- arranged. Safe to run any number of times - it sets absolute values rather
-- than adjusting whatever is already there.
--
-- Why this shape: the earlier fixes used relative arithmetic
-- (set unlock_level = unlock_level - 1), which lands somewhere different every
-- time it runs. The Supabase SQL Editor executes the whole buffer, so a
-- statement left in the tab re-applies on the next Run - the ladder drifted
-- from 2..21 to 0..19 to 3..22 that way. Absolute values can't drift.
--
-- Matches how the app itself renumbers: renumberPresetLadder() assigns
-- 1, 2, 3... by position rather than incrementing what's there.

update public.preset_avatars set unlock_level = 1 where id = '82803396-56e4-4acc-b947-1c9ca2afa27f';
update public.preset_avatars set unlock_level = 2 where id = '1eb72bd3-11ec-4910-9c51-8437137945d7';
update public.preset_avatars set unlock_level = 3 where id = 'ce5c7f04-8a64-4558-b690-8f668e69d98b';
update public.preset_avatars set unlock_level = 4 where id = 'feae6424-1f52-41cd-bc11-a4fcd24f2dd6';
update public.preset_avatars set unlock_level = 5 where id = '62323744-c9c2-47f9-b608-c78c2dd0a5bc';
update public.preset_avatars set unlock_level = 6 where id = '3ce0b654-2c0b-4b41-9afc-4a451a3d655e';
update public.preset_avatars set unlock_level = 7 where id = '1eee7a0e-5f08-4712-bac9-d7d8480941f5';
update public.preset_avatars set unlock_level = 8 where id = 'c25bc167-a405-4981-8ae8-90ff0822015a';
update public.preset_avatars set unlock_level = 9 where id = '8955633a-bd6b-4caa-a724-abc982224e6e';
update public.preset_avatars set unlock_level = 10 where id = 'db0bd4ba-7ea9-4479-b18b-62486f283f91';
update public.preset_avatars set unlock_level = 11 where id = '0df088ec-df3a-423e-893c-b216d4e76248';
update public.preset_avatars set unlock_level = 12 where id = '8691e203-2dda-4a4f-8299-6bf88b0a985c';
update public.preset_avatars set unlock_level = 13 where id = '0376e6c8-1bf5-4f74-b5b0-439829c46e34';
update public.preset_avatars set unlock_level = 14 where id = 'dfc0a77e-c686-44cc-92a1-bd667daea5c5';
update public.preset_avatars set unlock_level = 15 where id = '3c8ca8c2-839d-4274-b315-dd5c577b2606';
update public.preset_avatars set unlock_level = 16 where id = '21707a4a-6f8f-4906-aab5-e97fcb9189d3';
update public.preset_avatars set unlock_level = 17 where id = '3a9b7f11-9983-4cb6-999b-8334ad149ea7';
update public.preset_avatars set unlock_level = 18 where id = 'fee6e055-80f5-49f7-aa57-805af9984260';
update public.preset_avatars set unlock_level = 19 where id = 'c322ada3-fd2a-4ddb-b891-089079dc0d59';
update public.preset_avatars set unlock_level = 20 where id = '402d117f-cfff-49c3-b389-dbf43ba15b12';

-- Verify - expect 1, 20, 20:
-- select min(unlock_level), max(unlock_level), count(*) from public.preset_avatars;
