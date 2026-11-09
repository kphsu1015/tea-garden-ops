import { NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// 最近被刪除的進貨單（僅管理員）：給進貨報表頁的「最近刪除」清單用，讓管理員隨時可以復原。
export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ receipts: [], demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;
  if (session.role !== "admin") return NextResponse.json({ error: "只有管理員可以查看已刪除的進貨單。" }, { status: 403 });

  try {
    const { data, error } = await supabase
      .from("receipts")
      .select("id,supplier,purchase_date,invoice_number,total_amount,deleted_at,receipt_lines(total_price)")
      .eq("status", "deleted")
      .order("deleted_at", { ascending: false, nullsFirst: false })
      .limit(20);
    if (error) throw error;
    return NextResponse.json({
      demo: false,
      receipts: (data ?? []).map((row) => {
        const lines = (row.receipt_lines ?? []) as Array<{ total_price: number | null }>;
        return {
          id: row.id as string,
          supplier: (row.supplier as string | null) ?? null,
          purchaseDate: (row.purchase_date as string | null) ?? null,
          invoiceNumber: (row.invoice_number as string | null) ?? null,
          amount: row.total_amount !== null ? Number(row.total_amount) : lines.reduce((sum, l) => sum + (Number(l.total_price) || 0), 0),
          lineCount: lines.length,
          deletedAt: (row.deleted_at as string | null) ?? null,
        };
      }),
    });
  } catch (error) {
    console.error("List deleted receipts failed", error);
    return NextResponse.json({ error: "讀取已刪除的進貨單失敗，請稍後再試。" }, { status: 500 });
  }
}
