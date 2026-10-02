-- 一個品項可以有多個有效日期：庫存改成「批次」管理，每批有自己的到期日與剩餘數量。
--   入庫：依到期日建立批次（同品項同到期日會併入同一批）。
--   出庫（領用／客房補充／食材使用／損壞）：預設先到期先出（FEFO），自動從最早到期的批次扣；
--     也可以指定批次（例如「過期報廢」要報廢特定那一批）。
--   盤點：每一批分別輸入實際數量。
-- inventory_items.quantity保留為所有批次的總數、nearest_expiry_date改由函式自動計算（還有數量的批次中最早的到期日），
-- 既有的低庫存判斷、報表與畫面都不用改。
-- 請在Supabase SQL Editor執行，需先執行過schema.sql及0001~0013所有migration。

-- ===== 1. 批次表 =====
create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  expiry_date date,
  quantity numeric(12,2) not null default 0 check (quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_batches_item_expiry_idx on public.inventory_batches (inventory_item_id, expiry_date);

-- 只開放讀取；寫入一律透過下面的security definer函式，避免數量與異動紀錄不同步。
alter table public.inventory_batches enable row level security;
drop policy if exists "active staff read inventory batches" on public.inventory_batches;
create policy "active staff read inventory batches" on public.inventory_batches
  for select using (public.is_active_staff());

-- ===== 2. 異動紀錄記下動到哪一批 =====
-- expiry_date是當下的快照：批次扣到0會被刪除（batch_id變null），異動紀錄仍看得到當時是哪個到期日。
alter table public.stock_movements add column if not exists batch_id uuid references public.inventory_batches(id) on delete set null;
alter table public.stock_movements add column if not exists expiry_date date;

-- 進貨單明細也記下到期日，方便日後查詢。
alter table public.receipt_lines add column if not exists expiry_date date;

-- ===== 3. 既有庫存轉成批次 =====
-- 每個目前有庫存、但還沒有任何批次的品項，用現有數量和日期建立一批，資料不會不見。
insert into public.inventory_batches (inventory_item_id, expiry_date, quantity)
select i.id, i.nearest_expiry_date, i.quantity
from public.inventory_items i
where i.quantity > 0
  and not exists (select 1 from public.inventory_batches b where b.inventory_item_id = i.id);

-- ===== 4. 庫存異動交易函式（取代schema.sql版本） =====
-- 參數多了target_batch與batch_expiry，回傳型別不變；舊的4參數版本要先drop，避免呼叫時多載衝突。
drop function if exists public.record_stock_movement(uuid, public.movement_type, numeric, text);

create or replace function public.record_stock_movement(
  target_item uuid,
  movement public.movement_type,
  change_amount numeric,
  movement_note text default null,
  target_batch uuid default null,   -- 指定批次；增加時加到這批、減少時只扣這批。null：增加依batch_expiry找批次、減少先到期先出
  batch_expiry date default null    -- 增加且沒有指定批次時，新庫存的到期日（null代表未標日期）
) returns public.stock_movements
language plpgsql security definer set search_path = public as $$
declare
  item_unit text;
  batch_row public.inventory_batches;
  remaining numeric;
  take numeric;
  new_movement public.stock_movements;
begin
  if not public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]) then raise exception 'not authorized'; end if;
  if change_amount = 0 then raise exception 'quantity change cannot be zero'; end if;

  -- 鎖住品項列：同一品項的異動依序執行，先到期先出與批次合併不會因同時操作而算錯。
  select base_unit into item_unit from public.inventory_items where id = target_item for update;
  if not found then raise exception 'item missing or insufficient stock'; end if;

  if change_amount > 0 then
    if target_batch is not null then
      select * into batch_row from public.inventory_batches
      where id = target_batch and inventory_item_id = target_item for update;
      if not found then raise exception 'batch not found'; end if;
    else
      select * into batch_row from public.inventory_batches
      where inventory_item_id = target_item and expiry_date is not distinct from batch_expiry
      order by created_at limit 1 for update;
      if not found then
        insert into public.inventory_batches (inventory_item_id, expiry_date, quantity)
        values (target_item, batch_expiry, 0) returning * into batch_row;
      end if;
    end if;

    update public.inventory_batches set quantity = quantity + change_amount, updated_at = now() where id = batch_row.id;
    insert into public.stock_movements (inventory_item_id, movement_type, quantity_change, unit, note, operator_id, batch_id, expiry_date)
    values (target_item, movement, change_amount, item_unit, movement_note, auth.uid(), batch_row.id, batch_row.expiry_date)
    returning * into new_movement;

  elsif target_batch is not null then
    select * into batch_row from public.inventory_batches
    where id = target_batch and inventory_item_id = target_item for update;
    if not found then raise exception 'batch not found'; end if;
    if batch_row.quantity + change_amount < 0 then raise exception 'item missing or insufficient stock'; end if;

    update public.inventory_batches set quantity = quantity + change_amount, updated_at = now() where id = batch_row.id;
    insert into public.stock_movements (inventory_item_id, movement_type, quantity_change, unit, note, operator_id, batch_id, expiry_date)
    values (target_item, movement, change_amount, item_unit, movement_note, auth.uid(), batch_row.id, batch_row.expiry_date)
    returning * into new_movement;

  else
    -- 先到期先出：有日期的依到期日由早到晚，未標日期的最後扣；一次跨多批時每批各留一筆異動紀錄。
    remaining := -change_amount;
    for batch_row in
      select * from public.inventory_batches
      where inventory_item_id = target_item and quantity > 0
      order by expiry_date asc nulls last, created_at asc
      for update
    loop
      exit when remaining <= 0;
      take := least(batch_row.quantity, remaining);
      update public.inventory_batches set quantity = quantity - take, updated_at = now() where id = batch_row.id;
      insert into public.stock_movements (inventory_item_id, movement_type, quantity_change, unit, note, operator_id, batch_id, expiry_date)
      values (target_item, movement, -take, item_unit, movement_note, auth.uid(), batch_row.id, batch_row.expiry_date)
      returning * into new_movement;
      remaining := remaining - take;
    end loop;
    -- 庫存不夠扣：raise會讓整筆交易回滾，前面已扣的批次也會還原。
    if remaining > 0 then raise exception 'item missing or insufficient stock'; end if;
  end if;

  delete from public.inventory_batches where inventory_item_id = target_item and quantity = 0;

  update public.inventory_items set
    quantity = coalesce((select sum(quantity) from public.inventory_batches where inventory_item_id = target_item), 0),
    nearest_expiry_date = (select min(expiry_date) from public.inventory_batches where inventory_item_id = target_item and quantity > 0),
    updated_at = now()
  where id = target_item;

  return new_movement;
end; $$;

revoke all on function public.record_stock_movement(uuid, public.movement_type, numeric, text, uuid, date) from public;
grant execute on function public.record_stock_movement(uuid, public.movement_type, numeric, text, uuid, date) to authenticated;

-- ===== 5. 依批次盤點 =====
-- counts：[{ "batchId": "...", "actual": 3 }, { "expiryDate": "2026-10-20", "actual": 2 }]
--   有batchId：把該批修正成actual；沒有batchId：盤點時多找到的庫存，依expiryDate新增（同日期會併入既有批次）。
-- 全部在同一個交易內，任一筆失敗整次盤點回滾。回傳建立的異動筆數。
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
    actual := round((entry->>'actual')::numeric);
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
    actual := round((entry->>'actual')::numeric);
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

-- ===== 6. 進貨單確認入庫：每一行可帶到期日 =====
-- 簽章（10個參數、回傳public.receipts）跟0012版本完全相同，用create or replace直接覆蓋即可。
-- 跟0012唯一的差別：receipt_lines寫入expiry_date，record_stock_movement帶入該行的到期日建立／併入批次。
create or replace function public.confirm_receipt_with_lines(
  p_supplier text,
  p_purchase_date date,
  p_invoice_number text,
  p_total_amount numeric,
  p_original_file_name text,
  p_storage_path text,
  p_warnings jsonb,
  p_retention_days integer,
  p_lines jsonb,
  p_charges jsonb default '[]'::jsonb
)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare
  new_receipt public.receipts;
  line jsonb;
  charge jsonb;
  line_action text;
  target_item_id uuid;
  new_item_name text;
  new_item_category text;
  new_item_unit text;
  has_create_new boolean := false;
  charge_type_value text;
  charge_amount numeric;
  line_expiry date;
begin
  if not public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]) then
    raise exception 'not authorized' using errcode = 'P0001';
  end if;
  if (p_lines is null or jsonb_array_length(p_lines) = 0) and (p_charges is null or jsonb_array_length(p_charges) = 0) then
    raise exception 'at least one line is required' using errcode = 'P0001';
  end if;
  if p_original_file_name is null or length(trim(p_original_file_name)) = 0 then
    raise exception 'original file name is required' using errcode = 'P0001';
  end if;
  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'total amount is required' using errcode = 'P0001';
  end if;

  for line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if line->>'action' = 'create_new' then
      has_create_new := true;
    end if;
  end loop;
  if has_create_new and not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'only admin or purchaser can create new inventory items' using errcode = 'P0001';
  end if;

  insert into public.receipts (
    supplier, purchase_date, invoice_number, total_amount,
    original_file_name, storage_path, status, warnings, uploaded_by, delete_after
  ) values (
    nullif(trim(p_supplier), ''), p_purchase_date, nullif(trim(p_invoice_number), ''), p_total_amount,
    p_original_file_name, nullif(trim(p_storage_path), ''), 'stocked', coalesce(p_warnings, '[]'::jsonb), auth.uid(),
    now() + make_interval(days => coalesce(p_retention_days, 90))
  )
  returning * into new_receipt;

  for line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    line_action := line->>'action';
    target_item_id := null;
    line_expiry := nullif(line->>'expiryDate', '')::date;

    if line_action = 'existing' then
      target_item_id := nullif(line->>'inventoryItemId', '')::uuid;
      if target_item_id is null then
        raise exception 'inventoryItemId is required when action is existing' using errcode = 'P0001';
      end if;

    elsif line_action = 'create_new' then
      new_item_name := nullif(trim(line->'newItem'->>'name'), '');
      new_item_category := nullif(trim(line->'newItem'->>'category'), '');
      new_item_unit := nullif(trim(line->'newItem'->>'unit'), '');
      if new_item_name is null then raise exception 'new item name is required' using errcode = 'P0001'; end if;
      if new_item_category is null then raise exception 'new item category is required' using errcode = 'P0001'; end if;
      if new_item_unit is null then raise exception 'new item unit is required' using errcode = 'P0001'; end if;

      insert into public.inventory_items (
        name, category, base_unit, safety_stock,
        usage_forecast_enabled, estimated_usage, usage_period
      ) values (
        new_item_name, new_item_category, new_item_unit,
        coalesce((line->'newItem'->>'safetyStock')::numeric, 0),
        coalesce((line->'newItem'->>'usageForecastEnabled')::boolean, false),
        (line->'newItem'->>'estimatedUsage')::numeric,
        nullif(line->'newItem'->>'usagePeriod', '')
      )
      returning id into target_item_id;

    elsif line_action = 'ignore' then
      target_item_id := null;
    else
      raise exception 'invalid line action: %', coalesce(line_action, 'null') using errcode = 'P0001';
    end if;

    insert into public.receipt_lines (
      receipt_id, inventory_item_id, item_name, quantity, unit, unit_price, total_price, category, expiry_date
    ) values (
      new_receipt.id, target_item_id, line->>'itemName', (line->>'quantity')::numeric, line->>'unit',
      nullif(line->>'unitPrice', '')::numeric, nullif(line->>'totalPrice', '')::numeric, nullif(line->>'category', ''),
      case when target_item_id is not null then line_expiry end
    );

    if target_item_id is not null then
      perform public.record_stock_movement(
        target_item_id, 'purchase_in', (line->>'quantity')::numeric,
        '進貨單：' || p_original_file_name || coalesce('／' || nullif(trim(p_invoice_number), ''), ''),
        null, line_expiry
      );
    end if;
  end loop;

  for charge in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    charge_type_value := charge->>'chargeType';
    if charge_type_value is null or charge_type_value not in ('shipping','handling','tax','discount','other_fee') then
      raise exception 'invalid charge type: %', coalesce(charge_type_value, 'null') using errcode = 'P0001';
    end if;
    charge_amount := (charge->>'amount')::numeric;
    if charge_amount is null or charge_amount < 0 then
      raise exception 'charge amount must be zero or positive' using errcode = 'P0001';
    end if;

    insert into public.receipt_charges (receipt_id, charge_type, description, amount)
    values (new_receipt.id, charge_type_value, nullif(trim(charge->>'description'), ''), charge_amount);
  end loop;

  return new_receipt;
end;
$$;

revoke all on function public.confirm_receipt_with_lines(text, date, text, numeric, text, text, jsonb, integer, jsonb, jsonb) from public;
grant execute on function public.confirm_receipt_with_lines(text, date, text, numeric, text, text, jsonb, integer, jsonb, jsonb) to authenticated;
