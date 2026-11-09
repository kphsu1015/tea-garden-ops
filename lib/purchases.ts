import type { PurchaseRequest } from "@/lib/types";

// 採購需求頁用的純函式：等待天數、篩選、誰能改。

const DAY_MS = 86_400_000;

// 以台北日期算「過了幾天」（不是 24 小時的倍數）：昨天晚上提出、今天早上看，算 1 天。
export function daysSince(iso: string | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const key = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const toDay = (k: string) => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY_MS; };
  return Math.max(0, Math.round(toDay(key(now)) - toDay(key(then))));
}

export type AgeInfo = { text: string; stale: boolean };

// 卡片上的「等了幾天」：待確認看提出時間，已訂購／已到貨看「最後更新時間」；太新的不顯示，免得每張卡都有一行字。
export function ageInfo(request: Pick<PurchaseRequest, "status" | "createdAtIso" | "updatedAtIso">, now: Date = new Date()): AgeInfo | null {
  if (request.status === "待確認") {
    const days = daysSince(request.createdAtIso, now);
    if (days === null || days < 2) return null;
    return { text: `已等 ${days} 天還沒處理`, stale: days >= 7 };
  }
  if (request.status === "已訂購" || request.status === "已到貨") {
    const days = daysSince(request.updatedAtIso, now);
    if (days === null || days < 3) return null;
    // 用的是「最後更新時間」（改狀態、改急迫程度、改數量都會更新），所以寫成「N 天沒有更新」，不寫成訂了／到貨幾天。
    return { text: `${request.status}，${days} 天沒有更新`, stale: days >= 7 };
  }
  return null;
}

export type RequestFilter = { query: string; onlyUrgent: boolean; onlyMineId: string | null };

export function filterRequests(requests: PurchaseRequest[], filter: RequestFilter): PurchaseRequest[] {
  const q = filter.query.trim().toLowerCase();
  return requests.filter((r) =>
    (!filter.onlyUrgent || r.priority === "急件") &&
    (!filter.onlyMineId || r.requesterId === filter.onlyMineId) &&
    (!q || `${r.itemName} ${r.requester} ${r.note ?? ""}`.toLowerCase().includes(q)),
  );
}

// 提出需求的本人，可以改「自己提出、還在待確認」的需求（管理員與訂貨管家本來就能改任何需求，不算在這裡）。
export function canEditOwnRequest(request: Pick<PurchaseRequest, "status" | "requesterId">, currentUserId: string | null): boolean {
  return currentUserId !== null && request.requesterId === currentUserId && request.status === "待確認";
}

// 已處理的需求依「處理時間」新到舊。
export function sortDone(requests: PurchaseRequest[]): PurchaseRequest[] {
  const stamp = (r: PurchaseRequest) => r.updatedAtIso ?? r.createdAtIso ?? r.requestedAt;
  return [...requests].sort((a, b) => stamp(b).localeCompare(stamp(a)));
}
