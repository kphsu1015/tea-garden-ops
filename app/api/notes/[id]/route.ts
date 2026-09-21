import { NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

// 刪除交接留言：僅管理員（RLS "admins delete notes"）。被擋下時回傳0筆，轉成403。
export async function DELETE(_request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法刪除交接留言。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const { data, error } = await supabase.from("handover_notes").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data || data.length === 0) return NextResponse.json({ error: "找不到這則留言，或只有管理員可以刪除。" }, { status: 403 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete handover note failed", error);
    return NextResponse.json({ error: "刪除交接留言失敗，請稍後再試。" }, { status: 500 });
  }
}
