import { NextResponse } from "next/server";
import { isPurchaseStatus, mapPurchaseRow, PURCHASE_SELECT_COLUMNS, purchaseStatusToDb } from "@/lib/shared-records";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

// 推進／變更採購需求狀態，或修改急迫程度（一般／急件）。RLS只允許管理員與訂貨管家更新；被擋下時PostgREST不會報錯而是回傳0筆，這裡轉成403。
export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法更新採購需求。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const body = await request.json() as { status?: string; priority?: string };
    if (body.status === undefined && body.priority === undefined) return NextResponse.json({ error: "沒有要更新的欄位。" }, { status: 400 });
    if (body.status !== undefined && !isPurchaseStatus(body.status)) return NextResponse.json({ error: "採購狀態不正確。" }, { status: 400 });
    if (body.priority !== undefined && body.priority !== "一般" && body.priority !== "急件") return NextResponse.json({ error: "急迫程度不正確。" }, { status: 400 });

    const { data, error } = await supabase
      .from("purchase_requests")
      .update({
        updated_at: new Date().toISOString(),
        ...(isPurchaseStatus(body.status) ? { status: purchaseStatusToDb(body.status) } : {}),
        ...(body.status === "已訂購" ? { approved_by: session.userId } : {}),
        ...(body.priority !== undefined ? { priority: body.priority === "急件" ? "urgent" : "normal" } : {}),
      })
      .eq("id", id)
      .select(PURCHASE_SELECT_COLUMNS);
    if (error) throw error;
    if (!data || data.length === 0) return NextResponse.json({ error: "找不到這筆採購需求，或只有管理員與訂貨管家可以更新。" }, { status: 403 });
    return NextResponse.json({ purchase: mapPurchaseRow(data[0]) });
  } catch (error) {
    console.error("Update purchase request failed", error);
    return NextResponse.json({ error: "更新採購需求失敗，請稍後再試。" }, { status: 500 });
  }
}
