import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

// 伺服器端（Route Handler）使用，帶著登入者自己的session，讀寫皆受RLS約束，不繞過權限。
export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // 在無法寫入cookie的情境（例如Server Component）呼叫，session刷新改由middleware處理。
        }
      },
    },
  });
}
