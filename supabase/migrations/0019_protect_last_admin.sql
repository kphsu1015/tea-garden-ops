-- 防止系統裡沒有任何「使用中的管理員」
-- 問題：管理員可以把唯一的管理員（包含自己）降成管家或停用，之後沒有人能再管理員工與權限，只能進資料庫手動修。
-- 做法：在 staff_profiles 上加觸發器，更新或刪除「使用中的管理員」時，
--       如果做完之後已經沒有其他使用中的管理員，就直接拒絕（錯誤碼 P0010）。
-- 在 Supabase SQL Editor 執行；可重複執行。不會修改任何現有資料。

create or replace function public.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  other_admins integer;
begin
  if old.role = 'admin' and old.active
     and (tg_op = 'DELETE' or new.role is distinct from 'admin' or new.active is not true) then
    -- 用交易層級的互斥鎖讓「降級／停用管理員」一次只有一個人通過檢查：兩個人同時各降一位時會排隊，
    -- 後面那位會看到前面已經生效的結果。不鎖資料列，所以不會跟各自已持有的列鎖互相卡死。
    perform pg_advisory_xact_lock(hashtext('staff_profiles_last_admin_guard'));
    select count(*) into other_admins from public.staff_profiles where role = 'admin' and active and id <> old.id;
    if other_admins = 0 then
      raise exception 'cannot remove the last active admin' using errcode = 'P0010';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists staff_profiles_guard_last_admin on public.staff_profiles;
create trigger staff_profiles_guard_last_admin
  before update or delete on public.staff_profiles
  for each row execute function public.guard_last_admin();

-- 取消邀請 vs 對方接受邀請：原本的 accept_staff_invitation 讀取邀請時沒有鎖，
-- 取消（刪除）剛好發生在「讀到邀請」和「建立員工」之間，會出現「顯示已取消、對方卻成了員工」。
-- 這裡原樣重新定義該函式，只在讀取邀請時加 for update，讓取消與接受互斥（後到的那一方會看到結果）。
create or replace function public.accept_staff_invitation()
returns public.staff_profiles
language plpgsql security definer set search_path = public, auth as $$
declare
  invitation public.staff_invitations;
  result_row public.staff_profiles;
  current_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'P0001';
  end if;

  select email into current_email from auth.users where id = auth.uid();
  if current_email is null then
    raise exception 'auth user not found' using errcode = 'P0001';
  end if;

  select * into invitation from public.staff_invitations
  where lower(email) = lower(current_email) and accepted_at is null
  limit 1
  for update;

  if invitation.id is null then
    raise exception 'no pending invitation for this email' using errcode = 'P0002';
  end if;

  insert into public.staff_profiles (id, display_name, email, role, active)
  values (auth.uid(), coalesce(nullif(trim(invitation.display_name), ''), current_email), current_email, invitation.role, true)
  on conflict (id) do update set
    role = excluded.role,
    active = true,
    display_name = coalesce(nullif(trim(excluded.display_name), ''), public.staff_profiles.display_name)
  returning * into result_row;

  update public.staff_invitations set accepted_at = now() where id = invitation.id;

  return result_row;
end;
$$;

revoke all on function public.accept_staff_invitation() from public;
grant execute on function public.accept_staff_invitation() to authenticated;
