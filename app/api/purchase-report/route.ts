import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getTaipeiMonthStart, isValidMonthStart, mapCategoryRow, mapSummaryRow, mapSupplierRow, mapTopItemRow, mapTrendRow } from "@/lib/purchase-report";

export const runtime = "nodejs";

const FORBIDDEN_MESSAGE = "只有管理員或訂貨管家可以查看進貨報表。";

export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.json({
      demo: true,
      month: getTaipeiMonthStart(),
      summary: null,
      trend: [],
      categories: [],
      items: [],
      suppliers: [],
    });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再查看報表。" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const rawMonth = searchParams.get("month");
  const month = rawMonth && isValidMonthStart(rawMonth) ? rawMonth : getTaipeiMonthStart();

  try {
    const [summaryRes, trendRes, categoriesRes, itemsRes, suppliersRes] = await Promise.all([
      supabase.rpc("get_purchase_monthly_summary", { p_month: month }).single(),
      supabase.rpc("get_purchase_monthly_trend", { p_end_month: month, p_months: 12 }),
      supabase.rpc("get_purchase_category_breakdown", { p_month: month }),
      supabase.rpc("get_purchase_top_items", { p_month: month, p_limit: 10 }),
      supabase.rpc("get_purchase_supplier_breakdown", { p_month: month }),
    ]);

    for (const res of [summaryRes, trendRes, categoriesRes, itemsRes, suppliersRes]) {
      if (res.error) {
        if (res.error.code === "P0001") return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
        throw res.error;
      }
    }

    return NextResponse.json({
      demo: false,
      month,
      summary: summaryRes.data ? mapSummaryRow(summaryRes.data) : null,
      trend: (trendRes.data ?? []).map(mapTrendRow),
      categories: (categoriesRes.data ?? []).map(mapCategoryRow),
      items: (itemsRes.data ?? []).map(mapTopItemRow),
      suppliers: (suppliersRes.data ?? []).map(mapSupplierRow),
    });
  } catch (error) {
    console.error("Load purchase report failed", error);
    return NextResponse.json({ error: "讀取報表失敗，請稍後再試。" }, { status: 500 });
  }
}
