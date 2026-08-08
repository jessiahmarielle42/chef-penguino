-- OPTIONAL: fuzzy song-title search for the Chef Penguino connector.
-- Run in the SANCTIFY Supabase SQL editor (project yndmbdegursbrkwctyco).
-- Only needed if you want trigram-quality search; the connector ships without
-- it using a plain substring read. Callable by authenticated users only.

create or replace function public.search_songs(q text)
returns table (
  id uuid,
  title text,
  audio_url text,
  cover_url text,
  duration_seconds int,
  artist_name text,
  score real
)
language sql
stable
set search_path = public
as $$
  select s.id, s.title, s.audio_url, s.cover_url, s.duration_seconds,
         a.name as artist_name,
         (similarity(s.title, q)
          + case when s.title ilike q || '%' then 0.3 else 0 end)::real as score
  from public.songs s
  join public.artists a on a.id = s.artist_id
  where s.status = 'approved'
    and s.audio_url is not null
    and (s.title % q or s.title ilike '%' || q || '%')
  order by score desc, s.play_count desc
  limit 20;
$$;

grant execute on function public.search_songs(text) to authenticated;
