import { NextResponse } from "next/server";
import { isPurchaseStatus, mapPurchaseRow, PURCHASE_SELECT_COLUMNS, purchaseStatusToDb } from "@/lib/shared-records";
import { requireStaffSession } from "@/lib/staff-auth";
import { roundQuantity } from "@/lib/inventory";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

// 推進／變更採購需求狀態、修改急迫程度（一般／急件），或修改數量／備註（只有「待確認」階段可以改）。RLS只允許管理員與訂貨管家更新；被擋下時PostgREST不會報錯而是回傳0筆，這裡轉成403。
export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法更新採購需求。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const body = await request.json() as { status?: string; priority?: string; quantity?: number; note?: string | null };
    if (body.status === undefined && body.priority === undefined && body.quantity === undefined && body.note === undefined) return NextResponse.json({ error: "沒有要更新的欄位。" }, { status: 400 });
    const editing = body.quantity !== undefined || body.note !== undefined;
    const quantity = body.quantity !== undefined ? roundQuantity(Number(body.quantity)) : undefined;
    if (quantity !== undefined && (!Number.isFinite(quantity) || quantity <= 0)) return NextResponse.json({ error: "採購數量必須大於0。" }, { status: 400 });
    if (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.length > 500)) return NextResponse.json({ error: "備註最多500個字。" }, { status: 400 });
    if (body.status !== undefined && !isPurchaseStatus(body.status)) return NextResponse.json({ error: "採購狀態不正確。" }, { status: 400 });
    if (body.priority !== undefined && body.priority !== "一般" && body.priority !== "急件") return NextResponse.json({ error: "急迫程度不正確。" }, { status: 400 });

    let query = supabase
      .from("purchase_requests")
      .update({
        updated_at: new Date().toISOString(),
        ...(isPurchaseStatus(body.status) ? { status: purchaseStatusToDb(body.status) } : {}),
        ...(body.status === "已訂購" ? { approved_by: session.userId } : {}),
        ...(body.priority !== undefined ? { priority: body.priority === "急件" ? "urgent" : "normal" } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
        ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
      })
      .eq("id", id);
    // 修改數量／備註只限「待確認」：已經訂購的需求改數量沒有意義，也避免跟實際訂單對不上。
    if (editing) query = query.eq("status", purchaseStatusToDb("待確認"));
    const { data, error } = await query.select(PURCHASE_SELECT_COLUMNS);
    if (error) throw error;
    if (!data || data.length === 0) return NextResponse.json({ error: editing ? "只有「待確認」的需求可以修改數量和備註，或你沒有權限（僅管理員與訂貨管家）。" : "找不到這筆採購需求，或只有管理員與訂貨管家可以更新。" }, { status: 403 });
    return NextResponse.json({ purchase: mapPurchaseRow(data[0]) });
  } catch (error) {
    console.error("Update purchase request failed", error);
    return NextResponse.json({ error: "更新採購需求失敗，請稍後再試。" }, { status: 500 });
  }
}
