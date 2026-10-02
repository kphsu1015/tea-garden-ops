import { NextResponse } from "next/server";
import { isDateKey } from "@/lib/inventory";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

type CountInput = { batchId?: string; expiryDate?: string; actual?: number };

// 依批次盤點：每一批輸入實際數量，盤點時多找到的庫存可以依到期日新增。
// 透過stocktake_inventory_batches()在單一交易內寫入，任一批失敗整次盤點回滾，不會只修正到一半。
export async function POST(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法盤點庫存。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const body = await request.json() as { counts?: CountInput[]; note?: string };
    if (!Array.isArray(body.counts) || body.counts.length === 0) {
      return NextResponse.json({ error: "沒有要盤點的數量。" }, { status: 400 });
    }
    const counts = [];
    for (const entry of body.counts) {
      if (typeof entry.actual !== "number" || !Number.isFinite(entry.actual) || entry.actual < 0) {
        return NextResponse.json({ error: "實際數量必須是不小於0的數字。" }, { status: 400 });
      }
      if (entry.expiryDate && !isDateKey(entry.expiryDate)) {
        return NextResponse.json({ error: "到期日格式不正確。" }, { status: 400 });
      }
      // 庫存數量一律整數。
      counts.push(entry.batchId
        ? { batchId: entry.batchId, actual: Math.round(entry.actual) }
        : { expiryDate: entry.expiryDate || null, actual: Math.round(entry.actual) });
    }

    const { data, error } = await supabase.rpc("stocktake_inventory_batches", {
      target_item: id,
      counts,
      movement_note: body.note?.trim() || null,
    });

    if (error) {
      if (error.code === "P0001") {
        if (error.message.includes("not authorized")) {
          return NextResponse.json({ error: "只有管理員、訂貨管家或管家可以盤點／修正庫存。" }, { status: 403 });
        }
        if (error.message.includes("batch not found")) {
          return NextResponse.json({ error: "有批次已被其他人用完或修改，請重新整理後再盤點。" }, { status: 409 });
        }
        if (error.message.includes("item missing") || error.message.includes("insufficient stock")) {
          return NextResponse.json({ error: "找不到這個品項，或修正後庫存會小於0，請確認數量。" }, { status: 409 });
        }
        if (error.message.includes("actual quantity")) {
          return NextResponse.json({ error: "實際數量必須是不小於0的數字。" }, { status: 400 });
        }
      }
      throw error;
    }

    return NextResponse.json({ changed: data });
  } catch (error) {
    console.error("Stocktake failed", error);
    return NextResponse.json({ error: "盤點修正失敗，請稍後再試。" }, { status: 500 });
  }
}
