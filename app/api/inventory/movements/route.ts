import { NextResponse } from "next/server";
import { mapMovementRow } from "@/lib/movements";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MOVEMENT_SELECT_COLUMNS = "id,movement_type,quantity_change,unit,note,created_at,inventory_items(name),staff_profiles(display_name)";

// 異動歷史查詢：純讀取stock_movements，RLS本身就允許所有在職員工查看（is_active_staff()），
// 這裡不額外限制角色。可用品項id、異動類型篩選，預設回傳最近200筆。
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ movements: [], demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get("itemId");
  const movementType = searchParams.get("movementType");

  try {
    let query = supabase
      .from("stock_movements")
      .select(MOVEMENT_SELECT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(200);
    if (itemId) query = query.eq("inventory_item_id", itemId);
    if (movementType) query = query.eq("movement_type", movementType);

    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ movements: (data ?? []).map(mapMovementRow), demo: false });
  } catch (error) {
    console.error("List stock movements failed", error);
    return NextResponse.json({ error: "讀取異動紀錄失敗，請稍後再試。" }, { status: 500 });
  }
}
