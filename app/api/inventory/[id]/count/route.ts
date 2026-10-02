import { NextResponse } from "next/server";
import { isDateKey } from "@/lib/inventory";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

// 盤點／修正庫存、新增庫存異動：都透過schema.sql既有的record_stock_movement()交易函式寫入，
// 這樣quantity與stock_movements紀錄一定同步，不會出現「改了數量卻沒留紀錄」的情況。
// 該函式本身已限定admin／purchaser／housekeeper才能呼叫，這裡不需要另外開RLS政策。
// 批次：增加時可帶expiryDate（新庫存的到期日）；減少時可帶batchId指定扣哪一批，不帶就先到期先出。
const ALLOWED_MOVEMENT_TYPES = new Set(["purchase_in", "daily_use", "room_supply", "food_use", "damaged", "expired", "adjustment"]);

export async function POST(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法盤點庫存。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const body = await request.json() as { changeAmount?: number; note?: string; movementType?: string; batchId?: string; expiryDate?: string };
    if (typeof body.changeAmount !== "number" || !Number.isFinite(body.changeAmount)) {
      return NextResponse.json({ error: "差異數量必須是不為0的數字。" }, { status: 400 });
    }
    // 庫存數量一律整數，即使呼叫端傳了小數也在這裡四捨五入；四捨五入後若變成0視同沒有差異，直接拒絕。
    const changeAmount = Math.round(body.changeAmount);
    if (changeAmount === 0) {
      return NextResponse.json({ error: "差異數量必須是不為0的數字。" }, { status: 400 });
    }
    const movementType = body.movementType && ALLOWED_MOVEMENT_TYPES.has(body.movementType) ? body.movementType : "adjustment";
    if (body.expiryDate && !isDateKey(body.expiryDate)) {
      return NextResponse.json({ error: "到期日格式不正確。" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("record_stock_movement", {
      target_item: id,
      movement: movementType,
      change_amount: changeAmount,
      movement_note: body.note?.trim() || null,
      target_batch: body.batchId || null,
      batch_expiry: changeAmount > 0 ? (body.expiryDate || null) : null,
    });

    if (error) {
      if (error.code === "P0001") {
        if (error.message.includes("not authorized")) {
          return NextResponse.json({ error: "只有管理員、訂貨管家或管家可以盤點／修正庫存。" }, { status: 403 });
        }
        if (error.message.includes("insufficient stock") || error.message.includes("item missing")) {
          return NextResponse.json({ error: "找不到這個品項，或修正後庫存會小於0，請確認數量。" }, { status: 409 });
        }
        if (error.message.includes("batch not found")) {
          return NextResponse.json({ error: "找不到這個批次，可能已被其他人用完，請重新整理後再試。" }, { status: 409 });
        }
        if (error.message.includes("cannot be zero")) {
          return NextResponse.json({ error: "差異數量不可為0。" }, { status: 400 });
        }
      }
      throw error;
    }

    return NextResponse.json({ movement: data });
  } catch (error) {
    console.error("Record stock count failed", error);
    return NextResponse.json({ error: "盤點修正失敗，請稍後再試。" }, { status: 500 });
  }
}
