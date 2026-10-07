-- 庫存數量最小單位從1改成0.5（例如0.5包、1.5公斤）。
-- 0014的盤點函式會把實際數量round()成整數，盤點輸入0.5會被改成1（或0），這裡改成四捨五入到最接近的0.5。
-- 其他函式（record_stock_movement、confirm_receipt_with_lines）本來就是numeric不取整數，不需要修改。
-- 請在Supabase SQL Editor執行，需先執行過schema.sql及0001~0014所有migration。

create or replace function public.stocktake_inventory_batches(
  target_item uuid,
  counts jsonb,
  movement_note text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  entry jsonb;
  actual numeric;
  current_qty numeric;
  diff numeric;
  changed integer := 0;
begin
  if not public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]) then raise exception 'not authorized'; end if;
  perform 1 from public.inventory_items where id = target_item for update;
  if not found then raise exception 'item missing or insufficient stock'; end if;

  -- 先處理既有批次，再處理新增的日期；避免新日期併入既有批次後，再用併入後的數量算差異。
  for entry in select * from jsonb_array_elements(coalesce(counts, '[]'::jsonb)) where value->>'batchId' is not null loop
    actual := round((entry->>'actual')::numeric * 2) / 2;
    if actual is null or actual < 0 then raise exception 'actual quantity must be zero or positive'; end if;
    select quantity into current_qty from public.inventory_batches
    where id = (entry->>'batchId')::uuid and inventory_item_id = target_item;
    if not found then raise exception 'batch not found'; end if;
    diff := actual - current_qty;
    if diff <> 0 then
      perform public.record_stock_movement(target_item, 'adjustment', diff, movement_note, (entry->>'batchId')::uuid, null);
      changed := changed + 1;
    end if;
  end loop;

  for entry in select * from jsonb_array_elements(coalesce(counts, '[]'::jsonb)) where value->>'batchId' is null loop
    actual := round((entry->>'actual')::numeric * 2) / 2;
    if actual is null or actual < 0 then raise exception 'actual quantity must be zero or positive'; end if;
    if actual > 0 then
      perform public.record_stock_movement(target_item, 'adjustment', actual, movement_note, null, nullif(entry->>'expiryDate', '')::date);
      changed := changed + 1;
    end if;
  end loop;

  return changed;
end; $$;

revoke all on function public.stocktake_inventory_batches(uuid, jsonb, text) from public;
grant execute on function public.stocktake_inventory_batches(uuid, jsonb, text) to authenticated;
