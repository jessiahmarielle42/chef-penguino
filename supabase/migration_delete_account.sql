-- Chef Penguino: self-service account deletion
-- Run once in the Supabase SQL Editor.
--
-- App Store / Play Store guidelines require any app with account creation to
-- offer in-app account deletion. The client can't delete from auth.users with
-- the anon key, so this security-definer function (owned by postgres, which
-- has rights on the auth schema) deletes the caller's auth user. The
-- profiles.id -> auth.users(id) ON DELETE CASCADE relationship then cascades
-- and removes the profile, which in turn cascades to sessions, friends,
-- noots, coin_gifts, blocked_users and reports (all FK'd to profiles with
-- ON DELETE CASCADE). One call wipes everything.

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

-- Only authenticated users may call it, and it can only ever delete the
-- caller's own row (auth.uid()), so there's no way to delete someone else.
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
