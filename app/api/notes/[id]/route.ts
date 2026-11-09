import { NextResponse } from "next/server";
import { mapNoteRow, NOTE_CATEGORIES, NOTE_SELECT_COLUMNS } from "@/lib/shared-records";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const NOT_FOUND = "找不到這則留言，可能已被刪除。";

// 刪除交接留言：僅管理員。改成軟刪除（寫入deleted_at），管理員可以用PATCH restore復原。
export async function DELETE(_request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法刪除交接留言。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;
  if (session.role !== "admin") return NextResponse.json({ error: "只有管理員可以刪除交接留言。" }, { status: 403 });

  const { id } = await params;
  try {
    const { data, error } = await supabase
      .from("handover_notes")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete handover note failed", error);
    return NextResponse.json({ error: "刪除交接留言失敗，請稍後再試。" }, { status: 500 });
  }
}

type PatchBody =
  | { action: "resolve" | "reopen" | "restore" }
  | { action?: "edit"; category?: string; content?: string; important?: boolean };

// 修改交接留言：
//  - resolve／reopen：任何在職員工都可以（資料庫函式 set_note_resolved）。
//  - edit：只有作者本人或管理員（RLS）。
//  - restore：只有管理員，復原被刪除的留言。
export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法修改交接留言。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const body = await request.json() as PatchBody;

    if (body.action === "resolve" || body.action === "reopen") {
      const { error } = await supabase.rpc("set_note_resolved", { p_id: id, p_resolved: body.action === "resolve" });
      if (error) {
        if (error.code === "P0002") return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
        if (error.code === "42501") return NextResponse.json({ error: "沒有權限修改這則留言。" }, { status: 403 });
        throw error;
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === "restore") {
      if (session.role !== "admin") return NextResponse.json({ error: "只有管理員可以復原已刪除的留言。" }, { status: 403 });
      const { data, error } = await supabase.from("handover_notes").update({ deleted_at: null }).eq("id", id).not("deleted_at", "is", null).select("id");
      if (error) throw error;
      if (!data || data.length === 0) return NextResponse.json({ error: "這則留言不需要復原。" }, { status: 404 });
      return NextResponse.json({ ok: true });
    }

    const edit = body as Extract<PatchBody, { action?: "edit" }>;
    const content = edit.content?.trim();
    if (!content) return NextResponse.json({ error: "請輸入留言內容。" }, { status: 400 });
    if (content.length > 2000) return NextResponse.json({ error: "留言內容不可超過2000字。" }, { status: 400 });
    if (!edit.category || !NOTE_CATEGORIES.includes(edit.category as typeof NOTE_CATEGORIES[number])) {
      return NextResponse.json({ error: "留言分類不正確。" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("handover_notes")
      .update({ category: edit.category, content, important: Boolean(edit.important), edited_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null)
      .select(NOTE_SELECT_COLUMNS);
    if (error) throw error;
    if (!data || data.length === 0) return NextResponse.json({ error: "找不到這則留言，或只有作者本人與管理員可以修改。" }, { status: 403 });
    return NextResponse.json({ note: mapNoteRow(data[0] as never) });
  } catch (error) {
    console.error("Update handover note failed", error);
    return NextResponse.json({ error: "修改交接留言失敗，請稍後再試。" }, { status: 500 });
  }
}
