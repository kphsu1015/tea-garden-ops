import { NextResponse } from "next/server";
import { MOVEMENT_TYPE_ENUM } from "@/lib/inventory";
import { isCursorTimestamp, isDateKey, taipeiDayStartIso, taipeiNextDayStartIso } from "@/lib/movement-log";
import { mapMovementRow } from "@/lib/movements";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MOVEMENT_SELECT_COLUMNS = "id,movement_type,quantity_change,unit,expiry_date,note,created_at,inventory_items(name),staff_profiles(display_name)";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const EXPORT_LIMIT = 5000;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

// 異動歷史查詢：純讀取stock_movements，RLS本身就允許所有在職員工查看（is_active_staff()），
// 這裡不額外限制角色。
// 篩選：itemId、movementType、from／to（台北日期YYYY-MM-DD）、operatorId、q（備註關鍵字）。
// 分頁：用游標（beforeAt＋beforeId＝上一頁最後一筆的時間與id）往更早的方向翻，limit預設50、最多200，
// 回傳hasMore。不用offset，因為翻頁期間若有新異動寫入，offset會整體位移造成重複或漏掉。
// 第一頁另外回傳total（符合條件的總筆數）讓畫面顯示「共N筆」。
// export=1：一次最多回傳5000筆給匯出CSV用。
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ movements: [], total: 0, operators: [], demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get("itemId");
  const movementType = searchParams.get("movementType");
  const operatorId = searchParams.get("operatorId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const q = (searchParams.get("q") ?? "").trim().slice(0, 50);
  const isExport = searchParams.get("export") === "1";
  const beforeAt = searchParams.get("beforeAt");
  const beforeId = searchParams.get("beforeId");

  if (itemId && !UUID_RE.test(itemId)) return badRequest("品項不正確。");
  if (operatorId && !UUID_RE.test(operatorId)) return badRequest("操作人不正確。");
  if (movementType && !Object.values(MOVEMENT_TYPE_ENUM).includes(movementType)) return badRequest("異動類型不正確。");
  if (from && !isDateKey(from)) return badRequest("開始日期格式不正確。");
  if (to && !isDateKey(to)) return badRequest("結束日期格式不正確。");
  if (from && to && from > to) return badRequest("開始日期不能比結束日期晚。");
  // 游標會放進篩選語法，只接受嚴格的時間與uuid格式。
  if ((beforeAt || beforeId) && (!beforeAt || !beforeId || !isCursorTimestamp(beforeAt) || !UUID_RE.test(beforeId))) return badRequest("翻頁位置不正確。");

  const limitRaw = Number(searchParams.get("limit") ?? PAGE_SIZE);
  const limit = isExport ? EXPORT_LIMIT : Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_PAGE_SIZE) : PAGE_SIZE;

  try {
    const firstPage = !beforeAt && !isExport;
    // 多讀一筆只是為了知道後面還有沒有。
    let query = supabase
      .from("stock_movements")
      .select(MOVEMENT_SELECT_COLUMNS, firstPage || isExport ? { count: "exact" } : undefined)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (beforeAt && beforeId) query = query.or(`created_at.lt.${beforeAt},and(created_at.eq.${beforeAt},id.lt.${beforeId})`);
    if (itemId) query = query.eq("inventory_item_id", itemId);
    if (movementType) query = query.eq("movement_type", movementType);
    if (operatorId) query = query.eq("operator_id", operatorId);
    if (from) query = query.gte("created_at", taipeiDayStartIso(from));
    if (to) query = query.lt("created_at", taipeiNextDayStartIso(to));
    // 備註關鍵字：% 與 _ 是萬用字元，當成一般文字處理。
    if (q) query = query.ilike("note", `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);

    // 第一頁才順便帶操作人清單與（選了品項時的）目前庫存，後面「載入更多」不用重複查。
    const readQuantity = () => supabase.from("inventory_items").select("quantity").eq("id", itemId as string).maybeSingle();
    const quantityBefore = firstPage && itemId ? await readQuantity() : null;
    const [result, operators] = await Promise.all([
      query,
      firstPage ? supabase.from("staff_profiles").select("id,display_name,active").order("display_name") : Promise.resolve(null),
    ]);
    if (result.error) throw result.error;
    if (operators?.error) throw operators.error;
    if (quantityBefore?.error) throw quantityBefore.error;
    // 庫存與異動清單是分開讀的：清單前後各讀一次庫存，兩次一樣才表示讀的過程中沒人動過，推算才可信。
    let itemQuantity: number | null = null;
    if (quantityBefore?.data) {
      const quantityAfter = await readQuantity();
      if (quantityAfter.error) throw quantityAfter.error;
      if (quantityAfter.data && Number(quantityAfter.data.quantity) === Number(quantityBefore.data.quantity)) itemQuantity = Number(quantityBefore.data.quantity);
    }

    const all = result.data ?? [];
    const hasMore = all.length > limit;
    return NextResponse.json({
      movements: all.slice(0, limit).map(mapMovementRow),
      hasMore,
      ...(firstPage || isExport ? { total: result.count ?? all.length } : {}),
      ...(firstPage ? {
        operators: (operators?.data ?? []).map((s) => ({ id: s.id as string, name: s.display_name as string, active: Boolean(s.active) })),
        itemQuantity,
      } : {}),
      demo: false,
    });
  } catch (error) {
    console.error("List stock movements failed", error);
    return NextResponse.json({ error: "讀取異動紀錄失敗，請稍後再試。" }, { status: 500 });
  }
}
