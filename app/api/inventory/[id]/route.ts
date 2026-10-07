import { NextResponse } from "next/server";
import { buildUsageForecastColumns, INVENTORY_SELECT_COLUMNS, mapInventoryRow, roundQuantity } from "@/lib/inventory";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";
import type { InventoryItemInput } from "@/lib/types";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const WRITE_FORBIDDEN_MESSAGE = "找不到這個品項，或您沒有權限操作（僅管理員或訂貨管家可以新增／編輯品項）。";
const REACTIVATE_FORBIDDEN_MESSAGE = "只有管理員可以重新啟用品項。";
const DELETE_FORBIDDEN_MESSAGE = "找不到這個品項，或您沒有權限刪除（僅管理員可以永久刪除品項）。";
const HAS_HISTORY_MESSAGE = "此品項已有歷史紀錄，無法永久刪除，請改為停用。";

export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法修改品項。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const body = await request.json() as Partial<InventoryItemInput> & { active?: boolean };
    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "請輸入品項名稱。" }, { status: 400 });
      updates.name = name;
    }
    if (typeof body.category === "string") {
      const category = body.category.trim();
      if (!category) return NextResponse.json({ error: "請選擇大分類。" }, { status: 400 });
      updates.category = category;
    }
    if (typeof body.unit === "string") updates.base_unit = body.unit.trim() || "個";
    // 安全庫存最小單位0.5（四捨五入到0.5），且不可為負數。
    if (typeof body.safetyStock === "number" && Number.isFinite(body.safetyStock)) updates.safety_stock = Math.max(0, roundQuantity(body.safetyStock));
    if (typeof body.suggestedPurchase === "number" && Number.isFinite(body.suggestedPurchase)) updates.suggested_purchase = Math.round(body.suggestedPurchase);
    if (typeof body.supplier === "string") updates.supplier = body.supplier.trim() || null;
    // 有效期限改由批次決定（入庫時填、資料庫自動算出最早到期日），這裡不接受直接修改。
    if (typeof body.active === "boolean") updates.active = body.active;

    const forecast = buildUsageForecastColumns(body);
    if ("error" in forecast) return NextResponse.json({ error: forecast.error }, { status: 400 });
    Object.assign(updates, forecast.columns);

    if (Object.keys(updates).length === 0) return NextResponse.json({ error: "沒有可更新的欄位。" }, { status: 400 });

    const { data, error } = await supabase
      .from("inventory_items")
      .update(updates)
      .eq("id", id)
      .select(INVENTORY_SELECT_COLUMNS);
    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "已有相同名稱的品項。" }, { status: 409 });
      if (error.code === "42501") return NextResponse.json({ error: WRITE_FORBIDDEN_MESSAGE }, { status: 403 });
      if (error.code === "P0001") return NextResponse.json({ error: REACTIVATE_FORBIDDEN_MESSAGE }, { status: 403 });
      if (error.code === "23514") return NextResponse.json({ error: "預估使用量設定不正確，請確認啟用時數量與週期都已填寫。" }, { status: 400 });
      throw error;
    }
    if (!data || data.length === 0) return NextResponse.json({ error: WRITE_FORBIDDEN_MESSAGE }, { status: 403 });

    return NextResponse.json({ item: mapInventoryRow(data[0]) });
  } catch (error) {
    console.error("Update inventory item failed", error);
    return NextResponse.json({ error: "更新品項失敗，請稍後再試。" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法刪除品項。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const { data: item, error: fetchError } = await supabase
      .from("inventory_items")
      .select("id,name")
      .eq("id", id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!item) return NextResponse.json({ error: "找不到這個品項。" }, { status: 404 });

    const { data: deleted, error } = await supabase.from("inventory_items").delete().eq("id", id).select("id");
    if (error) {
      if (error.code === "23503") return NextResponse.json({ error: HAS_HISTORY_MESSAGE }, { status: 409 });
      if (error.code === "42501") return NextResponse.json({ error: DELETE_FORBIDDEN_MESSAGE }, { status: 403 });
      throw error;
    }
    if (!deleted || deleted.length === 0) return NextResponse.json({ error: DELETE_FORBIDDEN_MESSAGE }, { status: 403 });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete inventory item failed", error);
    return NextResponse.json({ error: "刪除品項失敗，請稍後再試。" }, { status: 500 });
  }
}
