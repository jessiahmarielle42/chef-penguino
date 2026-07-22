-- Chef Penguino: let the admin review all blocks in the Admin Dashboard.
-- Run once in the Supabase SQL Editor (after migration_block_report.sql).
--
-- The reports table already has an "admin can view all reports" policy from
-- migration_block_report.sql. blocked_users only had a per-user "see who
-- you've blocked" policy, so the admin couldn't see other users' blocks. This
-- adds an admin-only read policy, mirroring the reports one. RLS policies are
-- OR-combined, so regular users keep seeing only their own blocks.

create policy "admin can view all blocks"
  on public.blocked_users for select
  using (auth.email() = 'keefefons@gmail.com');
