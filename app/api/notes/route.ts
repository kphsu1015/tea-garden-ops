import { NextResponse } from "next/server";
import { mapNoteRow, NOTE_CATEGORIES, NOTE_SELECT_COLUMNS } from "@/lib/shared-records";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ notes: [], demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const { data, error } = await supabase
      .from("handover_notes")
      .select(NOTE_SELECT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    return NextResponse.json({ notes: (data ?? []).map(mapNoteRow), demo: false });
  } catch (error) {
    console.error("List handover notes failed", error);
    return NextResponse.json({ error: "讀取交接留言失敗，請稍後再試。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法新增交接留言。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const body = await request.json() as { category?: string; content?: string; important?: boolean };
    const content = body.content?.trim();
    if (!content) return NextResponse.json({ error: "請輸入留言內容。" }, { status: 400 });
    if (content.length > 2000) return NextResponse.json({ error: "留言內容不可超過2000字。" }, { status: 400 });
    if (!body.category || !NOTE_CATEGORIES.includes(body.category as typeof NOTE_CATEGORIES[number])) {
      return NextResponse.json({ error: "留言分類不正確。" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("handover_notes")
      .insert({ category: body.category, content, important: Boolean(body.important), author_id: session.userId })
      .select(NOTE_SELECT_COLUMNS)
      .single();
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: "沒有權限新增交接留言。" }, { status: 403 });
      throw error;
    }
    return NextResponse.json({ note: mapNoteRow(data) }, { status: 201 });
  } catch (error) {
    console.error("Create handover note failed", error);
    return NextResponse.json({ error: "新增交接留言失敗，請稍後再試。" }, { status: 500 });
  }
}
