import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignableStaffRole } from "@/lib/types";

export type StaffSessionCheck =
  | { ok: true; userId: string; email: string; role: AssignableStaffRole }
  | { ok: false; status: 401 | 403 };

// 每次都要重新確認：Supabase session有效（401）、staff_profiles存在且id=auth.uid()、
// Email與目前登入Email一致、active=true、角色只能是admin／purchaser／housekeeper（403）。
// viewer已移除，不再是有效角色。不能只靠登入頁擋，這支給所有API路由共用。
export async function checkStaffSession(supabase: SupabaseClient): Promise<StaffSessionCheck> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email) return { ok: false, status: 401 };

  const { data } = await supabase
    .from("staff_profiles")
    .select("email,role,active")
    .eq("id", user.id)
    .maybeSingle();

  if (!data) return { ok: false, status: 403 };
  if (data.email.toLowerCase() !== user.email.toLowerCase()) return { ok: false, status: 403 };
  if (!data.active) return { ok: false, status: 403 };
  if (data.role !== "admin" && data.role !== "purchaser" && data.role !== "housekeeper") return { ok: false, status: 403 };

  return { ok: true, userId: user.id, email: user.email, role: data.role };
}

export const LOGIN_REQUIRED_MESSAGE = "請先登入後再操作。";
export const UNAUTHORIZED_MESSAGE = "此帳號尚未獲授權或已停用，請聯絡管理員。";
export const GENERIC_LOGIN_ERROR = "Email或密碼錯誤，或此帳號尚未獲授權。";
export const GENERIC_RESET_MESSAGE = "如果此Email已獲授權，系統將寄送密碼設定或重設信。";

export type StaffSessionOk = { ok: true; userId: string; email: string; role: AssignableStaffRole };

// 給API route handler共用：未登入回401，已登入但不在白名單／被停用／角色不符回403。
// 呼叫端只要「若ok為false就直接回傳response」，不用每支API各自重複401/403判斷邏輯。
export async function requireStaffSession(supabase: SupabaseClient): Promise<StaffSessionOk | { ok: false; response: NextResponse }> {
  const check = await checkStaffSession(supabase);
  if (check.ok) return check;
  const message = check.status === 401 ? LOGIN_REQUIRED_MESSAGE : UNAUTHORIZED_MESSAGE;
  return { ok: false, response: NextResponse.json({ error: message }, { status: check.status }) };
}

export function isPasswordValid(password: string): boolean {
  return typeof password === "string" && password.length >= 12;
}
