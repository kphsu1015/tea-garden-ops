import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

// 盤點／修正庫存：透過schema.sql既有的record_stock_movement()交易函式寫入，
// 這樣quantity與stock_movements紀錄一定同步，不會出現「改了數量卻沒留紀錄」的情況。
// 該函式本身已限定admin／purchaser／housekeeper才能呼叫，這裡不需要另外開RLS政策。
export async function POST(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法盤點庫存。" }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再操作。" }, { status: 401 });

  const { id } = await params;
  try {
    const body = await request.json() as { changeAmount?: number; note?: string };
    const changeAmount = body.changeAmount;
    if (typeof changeAmount !== "number" || !Number.isFinite(changeAmount) || changeAmount === 0) {
      return NextResponse.json({ error: "差異數量必須是不為0的數字。" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("record_stock_movement", {
      target_item: id,
      movement: "adjustment",
      change_amount: changeAmount,
      movement_note: body.note?.trim() || null,
    });

    if (error) {
      if (error.code === "P0001") {
        if (error.message.includes("not authorized")) {
          return NextResponse.json({ error: "只有管理員、訂貨管家或管家可以盤點／修正庫存。" }, { status: 403 });
        }
        if (error.message.includes("insufficient stock") || error.message.includes("item missing")) {
          return NextResponse.json({ error: "找不到這個品項，或修正後庫存會小於0，請確認數量。" }, { status: 409 });
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
