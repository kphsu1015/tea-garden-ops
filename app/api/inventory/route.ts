import { NextResponse } from "next/server";
import { buildUsageForecastColumns, INVENTORY_SELECT_COLUMNS, listInventoryItems, mapInventoryRow } from "@/lib/inventory";
import { initialInventory } from "@/lib/demo-data";
import { createClient } from "@/lib/supabase/server";
import type { InventoryItemInput } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ items: initialInventory, demo: true });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再查看庫存。" }, { status: 401 });

  try {
    const items = await listInventoryItems(supabase);
    return NextResponse.json({ items, demo: false });
  } catch (error) {
    console.error("List inventory items failed", error);
    return NextResponse.json({ error: "讀取庫存失敗，請稍後再試。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法新增品項。" }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再操作。" }, { status: 401 });

  try {
    const body = await request.json() as Partial<InventoryItemInput>;
    const name = body.name?.trim();
    const category = body.category?.trim();
    if (!name) return NextResponse.json({ error: "請輸入品項名稱。" }, { status: 400 });
    if (!category) return NextResponse.json({ error: "請選擇大分類。" }, { status: 400 });

    const forecast = buildUsageForecastColumns(body);
    if ("error" in forecast) return NextResponse.json({ error: forecast.error }, { status: 400 });

    const { data, error } = await supabase
      .from("inventory_items")
      .insert({
        name,
        category,
        base_unit: body.unit?.trim() || "個",
        storage_location: body.location?.trim() || "待設定",
        safety_stock: Number.isFinite(body.safetyStock) ? body.safetyStock : 0,
        suggested_purchase: Number.isFinite(body.suggestedPurchase) ? body.suggestedPurchase : 1,
        supplier: body.supplier?.trim() || null,
        nearest_expiry_date: body.expiryDate || null,
        ...forecast.columns,
      })
      .select(INVENTORY_SELECT_COLUMNS)
      .single();
    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "已有相同名稱的品項。" }, { status: 409 });
      if (error.code === "42501") return NextResponse.json({ error: "只有管理員或訂貨管家可以新增品項。" }, { status: 403 });
      if (error.code === "23514") return NextResponse.json({ error: "預估使用量設定不正確，請確認啟用時數量與週期都已填寫。" }, { status: 400 });
      throw error;
    }

    return NextResponse.json({ item: mapInventoryRow(data) }, { status: 201 });
  } catch (error) {
    console.error("Create inventory item failed", error);
    return NextResponse.json({ error: "新增品項失敗，請稍後再試。" }, { status: 500 });
  }
}
