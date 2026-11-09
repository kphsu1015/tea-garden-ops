-- 進貨單：可復原的刪除（軟刪除）
-- 做法：刪除＝把 status 改成 'deleted'（並記錄 deleted_at），復原＝改回 'stocked'。
-- 進貨報表的所有統計函式本來就只算 status = 'stocked' 的進貨單，所以刪除後自動不計入，不用改那些函式。
-- 注意：刪除進貨單「不會」退回庫存數量（入庫當時已寫進庫存與異動紀錄），畫面上會明確提醒。
-- 在 Supabase SQL Editor 執行；可重複執行。

alter table public.receipts add column if not exists deleted_at timestamptz;

-- status 原本只允許 pending／stocked／failed，加上 deleted。
-- 舊的 status 檢查約束名稱是自動產生的，用內容找出來再刪，不靠名稱。
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.receipts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''pending''%'
  loop
    execute format('alter table public.receipts drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.receipts add constraint receipts_status_check check (status in ('pending','stocked','failed','deleted'));

-- 只有管理員能把進貨單改成已刪除，或從已刪除改回來。
-- 原本的 update 政策讓管理員／訂貨管家／管家都能更新進貨單，這裡用觸發器鎖住「刪除／復原」這個動作，
-- 避免有人繞過 API 直接改 status。
create or replace function public.guard_receipt_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.status = 'deleted' or old.status = 'deleted') and new.status is distinct from old.status
     and not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'only admins can delete or restore receipts' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists receipts_guard_soft_delete on public.receipts;
create trigger receipts_guard_soft_delete
  before update on public.receipts
  for each row execute function public.guard_receipt_soft_delete();
