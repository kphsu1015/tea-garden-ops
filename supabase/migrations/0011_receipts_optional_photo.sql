-- 新增進貨單：除了原本的拍照AI辨識，加入「手動輸入」（不需要照片，直接填供應商／品項／金額）。
-- receipts.storage_path原本是not null unique，手動輸入沒有照片就沒有storage_path，
-- 這裡把它改成可以是null（unique constraint在標準SQL下，多筆null彼此不算重複，不影響既有唯一性保護）。
-- 請在Supabase SQL Editor執行，需先執行過schema.sql及0001~0010所有migration。

alter table public.receipts alter column storage_path drop not null;

-- confirm_receipt_with_lines：不再強制要求storage_path，沒有照片時存null。
-- 簽章（10個參數、回傳public.receipts）跟0009版本完全相同，用create or replace直接覆蓋即可，不需要先drop。
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
