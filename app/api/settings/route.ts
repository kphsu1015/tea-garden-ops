import { NextResponse } from "next/server";
import { DEFAULT_RETENTION_DAYS, getReceiptRetentionDays, isValidRetentionDays } from "@/lib/shared-records";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ receiptRetentionDays: DEFAULT_RETENTION_DAYS, demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    return NextResponse.json({ receiptRetentionDays: await getReceiptRetentionDays(supabase), demo: false });
  } catch (error) {
    console.error("Read settings failed", error);
    return NextResponse.json({ error: "讀取系統設定失敗，請稍後再試。" }, { status: 500 });
  }
}

// 修改進貨單照片保存天數：管理員與訂貨管家（RLS "admins purchasers write app settings"）。只影響「之後」新保存的進貨單。
export async function PATCH(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法儲存設定。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const body = await request.json() as { receiptRetentionDays?: number };
    if (!isValidRetentionDays(body.receiptRetentionDays)) {
      return NextResponse.json({ error: "保存天數只能是30、60、90、180或365天。" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("app_settings")
      .upsert({ key: "receipt_retention_days", value: body.receiptRetentionDays, updated_by: session.userId, updated_at: new Date().toISOString() })
      .select("key");
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: "只有管理員與訂貨管家可以修改保存天數。" }, { status: 403 });
      throw error;
    }
    if (!data || data.length === 0) return NextResponse.json({ error: "只有管理員與訂貨管家可以修改保存天數。" }, { status: 403 });
    return NextResponse.json({ receiptRetentionDays: body.receiptRetentionDays });
  } catch (error) {
    console.error("Update settings failed", error);
    return NextResponse.json({ error: "儲存設定失敗，請稍後再試。" }, { status: 500 });
  }
}
