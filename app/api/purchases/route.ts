import { NextResponse } from "next/server";
import { mapPurchaseRow, PURCHASE_SELECT_COLUMNS } from "@/lib/shared-records";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// 所有在職員工讀到的是同一份採購需求（RLS：is_active_staff）。
export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ purchases: [], demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const { data, error } = await supabase
      .from("purchase_requests")
      .select(PURCHASE_SELECT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return NextResponse.json({ purchases: (data ?? []).map(mapPurchaseRow), demo: false });
  } catch (error) {
    console.error("List purchase requests failed", error);
    return NextResponse.json({ error: "讀取採購需求失敗，請稍後再試。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法新增採購需求。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const body = await request.json() as {
      itemName?: string; inventoryItemId?: string; quantity?: number; unit?: string; priority?: string; note?: string;
    };
    const itemName = body.itemName?.trim();
    const unit = body.unit?.trim();
    const quantity = Math.round(Number(body.quantity));
    if (!itemName) return NextResponse.json({ error: "請選擇或輸入品項。" }, { status: 400 });
    if (!unit) return NextResponse.json({ error: "缺少計算單位。" }, { status: 400 });
    if (!Number.isFinite(quantity) || quantity <= 0) return NextResponse.json({ error: "採購數量必須大於0。" }, { status: 400 });

    const { data, error } = await supabase
      .from("purchase_requests")
      .insert({
        inventory_item_id: body.inventoryItemId || null,
        item_name: itemName,
        quantity,
        unit,
        priority: body.priority === "急件" ? "urgent" : "normal",
        note: body.note?.trim() || null,
        requester_id: session.userId,
      })
      .select(PURCHASE_SELECT_COLUMNS)
      .single();
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: "沒有權限新增採購需求。" }, { status: 403 });
      if (error.code === "23503") return NextResponse.json({ error: "找不到對應的庫存品項，請重新整理後再試。" }, { status: 400 });
      throw error;
    }
    return NextResponse.json({ purchase: mapPurchaseRow(data) }, { status: 201 });
  } catch (error) {
    console.error("Create purchase request failed", error);
    return NextResponse.json({ error: "新增採購需求失敗，請稍後再試。" }, { status: 500 });
  }
}
