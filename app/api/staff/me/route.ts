import { NextResponse } from "next/server";
import { mapStaffRow } from "@/lib/staff";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// 讓已登入員工修改自己的暱稱，不限角色（admin／purchaser／housekeeper都可以）。
// 透過update_own_display_name RPC寫入，RPC內部只用auth.uid()鎖定只能改自己那一列，不會影響role／active／email。
export async function PATCH(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法修改暱稱。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const body = await request.json() as { displayName?: string };
    const displayName = body.displayName?.trim();
    if (!displayName) return NextResponse.json({ error: "請輸入暱稱。" }, { status: 400 });
    if (displayName.length > 50) return NextResponse.json({ error: "暱稱最多50個字。" }, { status: 400 });

    const { data, error } = await supabase.rpc("update_own_display_name", { p_display_name: displayName });
    if (error) {
      if (error.code === "P0001") return NextResponse.json({ error: "請先登入後再操作。" }, { status: 401 });
      throw error;
    }

    return NextResponse.json({ staff: mapStaffRow(data) });
  } catch (error) {
    console.error("Update own display name failed", error);
    return NextResponse.json({ error: "修改暱稱失敗，請稍後再試。" }, { status: 500 });
  }
}
