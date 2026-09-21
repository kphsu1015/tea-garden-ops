-- 進貨單AI辨識：把運費／處理費／稅額／折扣／其他費用等「非庫存費用」跟庫存品項分開處理。
-- 選擇新增receipt_charges資料表，而不是在receipt_lines加line_type欄位：
-- receipt_lines從schema.sql以來的欄位（quantity、unit、category）對庫存品項才有意義，
-- 既有資料全部都是庫存品項，不需要為它們補值或搬動，歷史資料完全不受影響、相容性最好。
-- 請在Supabase SQL Editor執行，需先執行過schema.sql及0001~0007所有migration。
-- 不會修改receipts或receipt_lines既有欄位、不會刪除任何資料。

-- ===== 1. 新資料表：receipt_charges =====
create table public.receipt_charges (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  charge_type text not null check (charge_type in ('shipping','handling','tax','discount','other_fee')),
  description text,
  amount numeric(12,2) not null check (amount >= 0),
  created_at timestamptz not null default now()
);

alter table public.receipt_charges enable row level security;

create policy "active staff read receipt charges" on public.receipt_charges
  for select using (public.is_active_staff());
create policy "inventory managers manage receipt charges" on public.receipt_charges
  for all
  using (public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]))
  with check (public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]));
create policy "admin delete receipt charges" on public.receipt_charges
  for delete using (public.has_role(array['admin']::public.staff_role[]));

create index if not exists receipt_charges_receipt_id_idx on public.receipt_charges (receipt_id);

-- 已入庫後修改費用金額，比照receipt_lines的金額欄位，只限admin可以修改。
create or replace function public.enforce_receipt_charge_amount_edit_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.amount is distinct from old.amount) and not public.has_role(array['admin']::public.staff_role[]) then
    raise exception 'only admin can modify receipt charge amount';
  end if;
  return new;
end;
$$;

drop trigger if exists receipt_charges_amount_edit_guard on public.receipt_charges;
create trigger receipt_charges_amount_edit_guard
  before update on public.receipt_charges
  for each row
  execute function public.enforce_receipt_charge_amount_edit_role();

-- ===== 2. confirm_receipt_with_lines：新增p_charges參數 =====
-- 庫存品項（p_lines）與非庫存費用（p_charges）分開寫入，只有p_lines會建立inventory_items／stock_movements，
-- p_charges只會寫入receipt_charges，絕對不會影響庫存數量。整張進貨單仍在同一個交易內完成，任何一步失敗就整筆回滾。
-- 0006版本的函式簽章只有9個參數，這裡先移除舊簽章再建立新版，避免同名不同參數造成呼叫時的多載歧義。
drop function if exists public.confirm_receipt_with_lines(text, date, text, numeric, text, text, jsonb, integer, jsonb);

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
  new_item_location text;
  has_create_new boolean := false;
  charge_type_value text;
  charge_amount numeric;
begin
  if not public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]) then
    raise exception 'not authorized' using errcode = 'P0001';
  end if;
  if (p_lines is null or jsonb_array_length(p_lines) = 0) and (p_charges is null or jsonb_array_length(p_charges) = 0) then
    raise exception 'at least one line is required' using errcode = 'P0001';
  end if;
  if p_storage_path is null or length(trim(p_storage_path)) = 0 then
    raise exception 'storage path is required' using errcode = 'P0001';
  end if;

  -- 只要有任何一筆要「建立新庫存品項」，整筆呼叫都必須是admin或purchaser（跟庫存管理頁的新增品項權限一致）。
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
    p_original_file_name, p_storage_path, 'stocked', coalesce(p_warnings, '[]'::jsonb), auth.uid(),
    now() + make_interval(days => coalesce(p_retention_days, 90))
  )
  returning * into new_receipt;

  for line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    line_action := line->>'action';
    target_item_id := null;

    if line_action = 'existing' then
      target_item_id := nullif(line->>'inventoryItemId', '')::uuid;
      if target_item_id is null then
        raise exception 'inventoryItemId is required when action is existing' using errcode = 'P0001';
      end if;

    elsif line_action = 'create_new' then
      new_item_name := nullif(trim(line->'newItem'->>'name'), '');
      new_item_category := nullif(trim(line->'newItem'->>'category'), '');
      new_item_unit := nullif(trim(line->'newItem'->>'unit'), '');
      new_item_location := nullif(trim(line->'newItem'->>'location'), '');
      if new_item_name is null then raise exception 'new item name is required' using errcode = 'P0001'; end if;
      if new_item_category is null then raise exception 'new item category is required' using errcode = 'P0001'; end if;
      if new_item_unit is null then raise exception 'new item unit is required' using errcode = 'P0001'; end if;
      if new_item_location is null then raise exception 'new item location is required' using errcode = 'P0001'; end if;

      insert into public.inventory_items (
        name, category, storage_location, base_unit, safety_stock,
        usage_forecast_enabled, estimated_usage, usage_period
      ) values (
        new_item_name, new_item_category, new_item_location, new_item_unit,
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
      receipt_id, inventory_item_id, item_name, quantity, unit, unit_price, total_price, category
    ) values (
      new_receipt.id, target_item_id, line->>'itemName', (line->>'quantity')::numeric, line->>'unit',
      nullif(line->>'unitPrice', '')::numeric, nullif(line->>'totalPrice', '')::numeric, nullif(line->>'category', '')
    );

    if target_item_id is not null then
      perform public.record_stock_movement(
        target_item_id, 'purchase_in', (line->>'quantity')::numeric,
        '進貨單：' || p_original_file_name || coalesce('／' || nullif(trim(p_invoice_number), ''), '')
      );
    end if;
  end loop;

  -- 非庫存費用：只寫入receipt_charges，這個迴圈完全不會碰inventory_items或stock_movements。
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

-- ===== 3. 報表RPC：金額估算改成同時考慮receipt_charges，並新增本月運費／本月其他費用 =====
-- 三支函式都遵守同一條規則：receipts.total_amount有值時，一律只用它當作這張單據的有效金額，
-- 絕不會再額外把receipt_lines或receipt_charges加上去，避免重複計算；只有total_amount是null時，
-- 才會退回用「品項金額加總＋非折扣費用加總－折扣費用加總」估算這張單據的金額。

-- 回傳欄位比0004版本多了shipping_amount／other_fee_amount，Postgres不允許用create or replace
-- 直接改變既有函式的回傳型別，所以這裡先明確drop掉舊版（9個回傳欄位）再建立新版。
drop function if exists public.get_purchase_monthly_summary(date);

create or replace function public.get_purchase_monthly_summary(p_month date)
returns table (
  total_amount numeric,
  receipt_count integer,
  item_count integer,
  top_category_name text,
  top_category_amount numeric,
  top_supplier_name text,
  top_supplier_amount numeric,
  prev_month_total_amount numeric,
  shipping_amount numeric,
  other_fee_amount numeric
)
language plpgsql security invoker set search_path = public as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  prev_month_start date := (date_trunc('month', p_month) - interval '1 month')::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  with month_receipts as (
    select r.id, r.supplier, r.total_amount
    from public.receipts r
    where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end
  ),
  line_totals as (
    select rl.receipt_id, sum(coalesce(rl.total_price, rl.quantity * rl.unit_price)) as amount
    from public.receipt_lines rl
    where rl.receipt_id in (select id from month_receipts)
    group by rl.receipt_id
  ),
  charge_totals as (
    select rc.receipt_id,
      sum(case when rc.charge_type = 'discount' then -rc.amount else rc.amount end) as amount
    from public.receipt_charges rc
    where rc.receipt_id in (select id from month_receipts)
    group by rc.receipt_id
  ),
  receipt_effective as (
    select mr.id, mr.supplier,
      coalesce(mr.total_amount, coalesce(lt.amount, 0) + coalesce(ct.amount, 0)) as effective_amount
    from month_receipts mr
    left join line_totals lt on lt.receipt_id = mr.id
    left join charge_totals ct on ct.receipt_id = mr.id
  ),
  category_totals as (
    select coalesce(rl.category, ii.category, '未分類') as category,
      sum(coalesce(rl.total_price, rl.quantity * rl.unit_price)) as amount
    from public.receipt_lines rl
    join public.receipts r on r.id = rl.receipt_id
    left join public.inventory_items ii on ii.id = rl.inventory_item_id
    where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end
    group by 1
  ),
  supplier_totals as (
    select coalesce(re.supplier, '未標示供應商') as supplier, sum(re.effective_amount) as amount
    from receipt_effective re
    group by 1
  ),
  prev_month_total as (
    select sum(coalesce(r.total_amount, (select sum(rl.total_price) from public.receipt_lines rl where rl.receipt_id = r.id))) as total
    from public.receipts r
    where r.status = 'stocked' and r.purchase_date >= prev_month_start and r.purchase_date < month_start
  ),
  charge_type_totals as (
    select rc.charge_type, sum(rc.amount) as amount
    from public.receipt_charges rc
    where rc.receipt_id in (select id from month_receipts)
    group by rc.charge_type
  )
  select
    coalesce((select sum(effective_amount) from receipt_effective), 0),
    (select count(*) from receipt_effective)::int,
    (select count(*) from public.receipt_lines rl join public.receipts r on r.id = rl.receipt_id
      where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end)::int,
    (select category from category_totals order by amount desc nulls last limit 1),
    (select amount from category_totals order by amount desc nulls last limit 1),
    (select supplier from supplier_totals order by amount desc nulls last limit 1),
    (select amount from supplier_totals order by amount desc nulls last limit 1),
    coalesce((select total from prev_month_total), 0),
    coalesce((select amount from charge_type_totals where charge_type = 'shipping'), 0),
    coalesce((select sum(amount) from charge_type_totals where charge_type in ('handling','tax','other_fee')), 0)
      - coalesce((select amount from charge_type_totals where charge_type = 'discount'), 0);
end;
$$;

create or replace function public.get_purchase_monthly_trend(p_end_month date, p_months integer default 12)
returns table (month date, total_amount numeric)
language plpgsql security invoker set search_path = public as $$
declare
  end_month date := date_trunc('month', p_end_month)::date;
  start_month date := (date_trunc('month', p_end_month) - ((greatest(p_months, 1) - 1) || ' months')::interval)::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  with months as (
    select generate_series(start_month, end_month, interval '1 month')::date as month
  ),
  range_receipts as (
    select r.id, date_trunc('month', r.purchase_date)::date as month, r.total_amount
    from public.receipts r
    where r.status = 'stocked' and r.purchase_date >= start_month and r.purchase_date < (end_month + interval '1 month')::date
  ),
  line_totals as (
    select rl.receipt_id, sum(coalesce(rl.total_price, rl.quantity * rl.unit_price)) as amount
    from public.receipt_lines rl
    where rl.receipt_id in (select id from range_receipts)
    group by rl.receipt_id
  ),
  charge_totals as (
    select rc.receipt_id,
      sum(case when rc.charge_type = 'discount' then -rc.amount else rc.amount end) as amount
    from public.receipt_charges rc
    where rc.receipt_id in (select id from range_receipts)
    group by rc.receipt_id
  ),
  receipt_effective as (
    select rr.month,
      coalesce(rr.total_amount, coalesce(lt.amount, 0) + coalesce(ct.amount, 0)) as effective_amount
    from range_receipts rr
    left join line_totals lt on lt.receipt_id = rr.id
    left join charge_totals ct on ct.receipt_id = rr.id
  )
  select m.month, coalesce(sum(re.effective_amount), 0)
  from months m
  left join receipt_effective re on re.month = m.month
  group by m.month
  order by m.month;
end;
$$;

create or replace function public.get_purchase_supplier_breakdown(p_month date)
returns table (supplier text, total_amount numeric, receipt_count integer)
language plpgsql security invoker set search_path = public as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if not public.has_role(array['admin','purchaser']::public.staff_role[]) then
    raise exception 'not authorized';
  end if;

  return query
  with month_receipts as (
    select r.id, r.supplier, r.total_amount
    from public.receipts r
    where r.status = 'stocked' and r.purchase_date >= month_start and r.purchase_date < month_end
  ),
  line_totals as (
    select rl.receipt_id, sum(coalesce(rl.total_price, rl.quantity * rl.unit_price)) as amount
    from public.receipt_lines rl
    where rl.receipt_id in (select id from month_receipts)
    group by rl.receipt_id
  ),
  charge_totals as (
    select rc.receipt_id,
      sum(case when rc.charge_type = 'discount' then -rc.amount else rc.amount end) as amount
    from public.receipt_charges rc
    where rc.receipt_id in (select id from month_receipts)
    group by rc.receipt_id
  )
  select coalesce(mr.supplier, '未標示供應商') as supplier,
    coalesce(sum(coalesce(mr.total_amount, coalesce(lt.amount, 0) + coalesce(ct.amount, 0))), 0),
    count(*)::int
  from month_receipts mr
  left join line_totals lt on lt.receipt_id = mr.id
  left join charge_totals ct on ct.receipt_id = mr.id
  group by 1
  order by 2 desc nulls last;
end;
$$;

revoke all on function public.get_purchase_monthly_summary(date) from public;
grant execute on function public.get_purchase_monthly_summary(date) to authenticated;

revoke all on function public.get_purchase_monthly_trend(date, integer) from public;
grant execute on function public.get_purchase_monthly_trend(date, integer) to authenticated;

revoke all on function public.get_purchase_supplier_breakdown(date) from public;
grant execute on function public.get_purchase_supplier_breakdown(date) to authenticated;
