// 進貨單草稿：一張單常要填好幾分鐘，換頁、重新整理、手機切 App 都不能讓它歸零。
// 草稿只存在這台裝置的瀏覽器（localStorage），不上傳；照片沒有存（太大），還原後要照片的話得重拍。
// 草稿「依帳號分開存」：共用一台裝置換人登入時，看不到前一個人的供應商與價格。
// 送出入庫成功、或使用者按「丟掉草稿」就清掉；超過 7 天的草稿自動作廢。

export const DRAFT_KEY_PREFIX = "tea-receipt-draft-v1";
export const DRAFT_MAX_AGE_MS = 7 * 86_400_000;

export const draftKey = (owner: string) => `${DRAFT_KEY_PREFIX}:${owner}`;

export interface StoredDraft<T> { version: 1; savedAt: number; mode: "scan" | "manual"; hadPhoto: boolean; analysis: T }

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

export function saveDraft<T>(owner: string, draft: Omit<StoredDraft<T>, "version" | "savedAt">, now = Date.now(), storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage || !owner) return false;
  try {
    storage.setItem(draftKey(owner), JSON.stringify({ version: 1, savedAt: now, ...draft }));
    return true;
  } catch {
    return false; // 空間滿了或被瀏覽器擋掉：草稿功能失效但不影響填單
  }
}

export function loadDraft<T>(owner: string, now = Date.now(), storage: StorageLike | null = defaultStorage()): StoredDraft<T> | null {
  if (!storage || !owner) return null;
  const key = draftKey(owner);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft<T>;
    if (parsed?.version !== 1 || typeof parsed.savedAt !== "number" || !parsed.analysis) { storage.removeItem(key); return null; }
    if (now - parsed.savedAt > DRAFT_MAX_AGE_MS) { storage.removeItem(key); return null; }
    return parsed;
  } catch {
    try { storage.removeItem(key); } catch { /* 忽略 */ }
    return null;
  }
}

export function clearDraft(owner: string, storage: StorageLike | null = defaultStorage()): void {
  if (!owner) return;
  try { storage?.removeItem(draftKey(owner)); } catch { /* 忽略 */ }
}

// 「3 分鐘前」「2 小時前」「2 天前」：給草稿提示用。
export function draftAgeLabel(savedAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - savedAt) / 60_000));
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.round(hours / 24)} 天前`;
}
