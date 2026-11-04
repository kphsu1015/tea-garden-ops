-- 訂貨管家（purchaser）也可以「重新啟用停用的品項」和「永久刪除品項」，跟管理員一樣（2026-11-04 使用者決定）。
-- 請在Supabase SQL Editor執行，需先執行過schema.sql及0001~0015所有migration。
-- 只調整inventory_items的刪除政策和重新啟用的防呆trigger；不會建立或刪除資料表，也不會改動任何資料。
-- 其他權限都不變：管家（housekeeper）仍然只能讀取與盤點，分類、進貨單、留言、員工管理的權限照舊。

-- 1) 永久刪除：原本只有admin，改成admin與purchaser。
drop policy if exists "admin delete inventory items" on public.inventory_items;
drop policy if exists "admin and purchaser delete inventory items" on public.inventory_items;
create policy "admin and purchaser delete inventory items" on public.inventory_items
  for delete
  using (public.has_role(array['admin','purchaser']::public.staff_role[]));

-- 2) 重新啟用（active: false -> true）：原本只有admin，改成admin與purchaser。
--    trigger本身沿用0002建立的inventory_items_reactivation_guard，只替換它呼叫的函式內容。
create or replace function public.enforce_inventory_reactivation_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.active = false and new.active = true and not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'only admin or purchaser can reactivate an inventory item';
  end if;
  return new;
end;
$$;
