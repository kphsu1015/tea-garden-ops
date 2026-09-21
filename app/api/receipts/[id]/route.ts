import { NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const AMOUNT_FORBIDDEN_MESSAGE = "只有管理員可以修改進貨單金額。";
const DELETE_FORBIDDEN_MESSAGE = "找不到這張進貨單，或您沒有權限刪除（僅管理員可以刪除）。";

// 修改已入庫進貨單的金額（單據總額／品項單價與金額）。RLS另外用trigger限定僅admin能改這些欄位，
// 這裡的角色錯誤（P0001）會被轉成清楚的中文訊息。
export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法修改進貨單。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const body = await request.json() as {
      totalAmount?: number | null;
      lines?: Array<{ id: string; unitPrice?: number | null; totalPrice?: number | null }>;
    };

    if (typeof body.totalAmount === "number" && body.totalAmount < 0) {
      return NextResponse.json({ error: "單據總額不可為負數。" }, { status: 400 });
    }
    if (Array.isArray(body.lines)) {
      for (const line of body.lines) {
        if (typeof line.unitPrice === "number" && line.unitPrice < 0) return NextResponse.json({ error: "單價不可為負數。" }, { status: 400 });
        if (typeof line.totalPrice === "number" && line.totalPrice < 0) return NextResponse.json({ error: "品項金額不可為負數。" }, { status: 400 });
      }
    }

    if (typeof body.totalAmount !== "undefined") {
      const { data, error } = await supabase.from("receipts").update({ total_amount: body.totalAmount }).eq("id", id).select("id");
      if (error) {
        if (error.code === "P0001") return NextResponse.json({ error: AMOUNT_FORBIDDEN_MESSAGE }, { status: 403 });
        if (error.code === "23514") return NextResponse.json({ error: "單據總額不可為負數。" }, { status: 400 });
        throw error;
      }
      if (!data || data.length === 0) return NextResponse.json({ error: "找不到這張進貨單，或您沒有權限修改。" }, { status: 403 });
    }

    if (Array.isArray(body.lines)) {
      for (const line of body.lines) {
        const updates: Record<string, unknown> = {};
        if (typeof line.unitPrice !== "undefined") updates.unit_price = line.unitPrice;
        if (typeof line.totalPrice !== "undefined") updates.total_price = line.totalPrice;
        if (Object.keys(updates).length === 0) continue;

        const { data, error } = await supabase.from("receipt_lines").update(updates).eq("id", line.id).eq("receipt_id", id).select("id");
        if (error) {
          if (error.code === "P0001") return NextResponse.json({ error: "只有管理員可以修改品項金額。" }, { status: 403 });
          if (error.code === "23514") return NextResponse.json({ error: "品項金額不可為負數。" }, { status: 400 });
          throw error;
        }
        if (!data || data.length === 0) return NextResponse.json({ error: "找不到這個品項，或您沒有權限修改。" }, { status: 403 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Update receipt amount failed", error);
    return NextResponse.json({ error: "更新進貨單失敗，請稍後再試。" }, { status: 500 });
  }
}

// 刪除／取消已入庫進貨單：僅admin。receipt_lines因為on delete cascade會一併移除。
export async function DELETE(_request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法刪除進貨單。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const { data: deleted, error } = await supabase.from("receipts").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!deleted || deleted.length === 0) return NextResponse.json({ error: DELETE_FORBIDDEN_MESSAGE }, { status: 403 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete receipt failed", error);
    return NextResponse.json({ error: "刪除進貨單失敗，請稍後再試。" }, { status: 500 });
  }
}
