import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTaipeiMonthStart, isValidMonthStart, mapLineRow } from "@/lib/purchase-report";
import { requireStaffSession } from "@/lib/staff-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ demo: true, lines: [] });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { searchParams } = new URL(request.url);
  const rawMonth = searchParams.get("month");
  const month = rawMonth && isValidMonthStart(rawMonth) ? rawMonth : getTaipeiMonthStart();
  const category = searchParams.get("category") || null;
  const supplier = searchParams.get("supplier") || null;
  const keyword = searchParams.get("keyword") || null;

  try {
    const { data, error } = await supabase.rpc("get_purchase_report_lines", {
      p_month: month,
      p_category: category,
      p_supplier: supplier,
      p_keyword: keyword,
    });
    if (error) {
      if (error.code === "P0001") return NextResponse.json({ error: "只有管理員或訂貨管家可以查看進貨報表。" }, { status: 403 });
      throw error;
    }
    return NextResponse.json({ demo: false, lines: (data ?? []).map(mapLineRow) });
  } catch (error) {
    console.error("Load purchase report lines failed", error);
    return NextResponse.json({ error: "讀取明細失敗，請稍後再試。" }, { status: 500 });
  }
}
