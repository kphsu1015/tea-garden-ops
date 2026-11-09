import { NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 一次設定所有分類的順序（僅管理員）。ids必須剛好是目前所有分類的id，由資料庫函式在單一交易內整批更新；
// 期間若有人新增或刪除了分類，會回傳409請使用者重新載入，不會排成錯的順序。
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法排序分類。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;
  if (session.role !== "admin") return NextResponse.json({ error: "只有管理員可以調整分類順序。" }, { status: 403 });

  try {
    const body = await request.json() as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 500 || !body.ids.every((id) => typeof id === "string" && UUID_RE.test(id))) {
      return NextResponse.json({ error: "排序資料不正確。" }, { status: 400 });
    }
    const { error } = await supabase.rpc("reorder_inventory_categories", { p_ids: body.ids });
    if (error) {
      if (error.code === "P0011") return NextResponse.json({ error: "分類清單剛剛有變動，請重新整理後再調整順序。" }, { status: 409 });
      if (error.code === "42501") return NextResponse.json({ error: "只有管理員可以調整分類順序。" }, { status: 403 });
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Reorder categories failed", error);
    return NextResponse.json({ error: "調整順序失敗，請稍後再試。" }, { status: 500 });
  }
}
