-- 進貨單確認入庫：AI辨識到的品項如果沒有精確對應現有庫存，不可直接自動建立。
-- 這支migration新增一個交易型RPC，讓「建立進貨單＋（可能的）新建庫存品項＋庫存異動」在同一個交易內完成，
-- 任何一步失敗（例如品項名稱重複、金額為負數、權限不足）都會整筆回滾，不會留下只完成一半的資料。
-- 請在Supabase SQL Editor執行，需先執行過 schema.sql 及 0001~0005 五支migration。
-- 不會建立新資料表、不會修改既有欄位、不會刪除任何資料。

create or replace function public.confirm_receipt_with_lines(
  p_supplier text,
  p_purchase_date date,
  p_invoice_number text,
  p_total_amount numeric,
  p_original_file_name text,
  p_storage_path text,
  p_warnings jsonb,
  p_retention_days integer,
  p_lines jsonb
)
returns public.receipts
language plpgsql security definer set search_path = public as $$
declare
  new_receipt public.receipts;
  line jsonb;
  line_action text;
  target_item_id uuid;
  new_item_name text;
  new_item_category text;
  new_item_unit text;
  new_item_location text;
  has_create_new boolean := false;
begin
  if not public.has_role(array['admin','purchaser','housekeeper']::public.staff_role[]) then
    raise exception 'not authorized' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'at least one line is required' using errcode = 'P0001';
  end if;
  if p_storage_path is null or length(trim(p_storage_path)) = 0 then
    raise exception 'storage path is required' using errcode = 'P0001';
  end if;

  -- 只要有任何一筆要「建立新庫存品項」，整筆呼叫都必須是admin或purchaser（跟庫存管理頁的新增品項權限一致）。
  for line in select * from jsonb_array_elements(p_lines) loop
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

  for line in select * from jsonb_array_elements(p_lines) loop
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

  return new_receipt;
end;
$$;

revoke all on function public.confirm_receipt_with_lines(text, date, text, numeric, text, text, jsonb, integer, jsonb) from public;
grant execute on function public.confirm_receipt_with_lines(text, date, text, numeric, text, text, jsonb, integer, jsonb) to authenticated;
