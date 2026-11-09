import { NextResponse } from "next/server";
import { isCursorTimestamp } from "@/lib/movement-log";
import { mapPurchaseRow, PURCHASE_SELECT_COLUMNS } from "@/lib/shared-records";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

// 已處理（已入庫）的採購需求歷史：伺服器端分頁與搜尋，不受主看板「最近 500 筆」的限制。
// 翻頁用游標（beforeAt＋beforeId＝上一頁最後一筆的最後更新時間與id），新資料寫進來也不會重複或漏掉。
// q：品項名稱或備註關鍵字；urgent=1：只看急件；mine=1：只看我提出的。第一頁另外回傳 total（符合條件的總筆數）。
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ items: [], hasMore: false, total: 0, demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { searchParams } = new URL(request.url);
  const beforeAt = searchParams.get("beforeAt");
  const beforeId = searchParams.get("beforeId");
  if ((beforeAt || beforeId) && (!beforeAt || !beforeId || !isCursorTimestamp(beforeAt) || !UUID_RE.test(beforeId))) {
    return NextResponse.json({ error: "翻頁位置不正確。" }, { status: 400 });
  }
  const limitRaw = Number(searchParams.get("limit") ?? PAGE_SIZE);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE_SIZE) : PAGE_SIZE;
  // 搜尋字會放進篩選語法：把逗號、括號、萬用字元等會破壞語法的字元拿掉，其餘當一般文字。
  const q = (searchParams.get("q") ?? "").replace(/[,()%_\\*"']/g, " ").trim().slice(0, 50);

  try {
    const firstPage = !beforeAt;
    let query = supabase
      .from("purchase_requests")
      .select(PURCHASE_SELECT_COLUMNS, firstPage ? { count: "exact" } : undefined)
      .eq("status", "stocked")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (beforeAt && beforeId) query = query.or(`updated_at.lt.${beforeAt},and(updated_at.eq.${beforeAt},id.lt.${beforeId})`);
    if (searchParams.get("urgent") === "1") query = query.eq("priority", "urgent");
    if (searchParams.get("mine") === "1") query = query.eq("requester_id", session.userId);
    if (q) query = query.or(`item_name.ilike.%${q}%,note.ilike.%${q}%`);

    const { data, error, count } = await query;
    if (error) throw error;
    const all = data ?? [];
    return NextResponse.json({
      items: all.slice(0, limit).map(mapPurchaseRow),
      hasMore: all.length > limit,
      ...(firstPage ? { total: count ?? all.length } : {}),
      demo: false,
    });
  } catch (error) {
    console.error("List purchase history failed", error);
    return NextResponse.json({ error: "讀取已處理的採購需求失敗，請稍後再試。" }, { status: 500 });
  }
}
