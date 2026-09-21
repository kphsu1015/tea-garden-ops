"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// 沒有Realtime時的同步做法：定時重新讀取，且每次分頁重新可見／視窗取得焦點時立刻讀取一次，
// 讓不同員工的畫面在幾十秒內一致。分頁在背景時不輪詢，省流量與伺服器負擔。
export const SHARED_DATA_POLL_MS = 30_000;

export function usePolling(callback: () => void, enabled: boolean, intervalMs = SHARED_DATA_POLL_MS) {
  const callbackRef = useRef(callback);
  useEffect(() => { callbackRef.current = callback; });

  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState === "visible") callbackRef.current(); };
    const interval = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [enabled, intervalMs]);
}

// 呼叫寫入型API（POST／PATCH／DELETE），成功回傳undefined，失敗回傳給畫面顯示的錯誤訊息。
export async function requestJson(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<string | void> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) return data.error || "操作失敗，請稍後再試。";
  } catch (reason) {
    return reason instanceof Error ? reason.message : "操作失敗，請稍後再試。";
  }
}

// 從共用API（Supabase）讀取一份所有員工共用的資料，並自動保持最新。
// field是回應JSON裡放資料的欄位名（例如"purchases"）。enabled為false時不發出請求（例如未登入）。
export function useSharedData<T>({ url, field, enabled }: { url: string; field: string; enabled: boolean }) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // silent：背景輪詢時不要出現「載入中」，失敗也不蓋掉畫面上已有的資料。
  const refresh = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError(""); }
    try {
      const response = await fetch(url);
      const json = await response.json() as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(json.error || "讀取資料失敗");
      setData((json[field] ?? null) as T | null);
      setError("");
    } catch (reason) {
      if (!silent) setError(reason instanceof Error ? reason.message : "讀取資料失敗，請稍後再試。");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [url, field]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => { refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [enabled, refresh]);

  usePolling(() => { refresh(true); }, enabled);

  return { data, loading, error, refresh };
}
