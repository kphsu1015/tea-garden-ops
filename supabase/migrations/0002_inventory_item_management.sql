-- 庫存細項品項管理：將inventory_items的寫入權限拆細為admin/purchaser/housekeeper/viewer。
-- 請在Supabase SQL Editor執行，需先執行過 schema.sql 與 0001_inventory_category_management.sql。
-- 不會建立新資料表，也不會刪除既有資料；只調整RLS政策並新增一個防呆trigger。

-- 舊政策讓admin/purchaser/housekeeper都能寫入，現改為：
--   新增／編輯（含停用）：admin、purchaser
--   永久刪除：僅admin
--   housekeeper、viewer：僅能讀取（沿用既有「active staff read inventory」政策）
drop policy if exists "inventory managers write inventory" on public.inventory_items;

create policy "admin and purchaser insert inventory items" on public.inventory_items
  for insert
  with check (public.has_role(array['admin','purchaser']::public.staff_role[]));

create policy "admin and purchaser update inventory items" on public.inventory_items
  for update
  using (public.has_role(array['admin','purchaser']::public.staff_role[]))
  with check (public.has_role(array['admin','purchaser']::public.staff_role[]));

create policy "admin delete inventory items" on public.inventory_items
  for delete
  using (public.has_role(array['admin']::public.staff_role[]));

-- purchaser可以把品項停用（active: true -> false），但重新啟用（false -> true）僅限admin。
-- RLS政策無法依「哪個欄位被改成什麼值」做判斷，所以用trigger在資料庫層擋下非admin的重新啟用操作。
create or replace function public.enforce_inventory_reactivation_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.active = false and new.active = true and not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'only admin can reactivate an inventory item';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_items_reactivation_guard on public.inventory_items;
create trigger inventory_items_reactivation_guard
  before update on public.inventory_items
  for each row
  execute function public.enforce_inventory_reactivation_role();
