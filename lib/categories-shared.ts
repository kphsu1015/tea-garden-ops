// 純常數，前端與後端皆可安全匯入（不得引用任何server-only模組）。

// AI無法判斷分類時使用的標記，不寫入inventory_categories資料表。
export const PENDING_CATEGORY = "待分類";

// 與Supabase尚未設定時的示範資料一致，僅供demo模式顯示。
export const defaultCategorySeed = ["客房備品", "清潔用品", "早餐食材", "晚餐食材", "廚房用品", "維修耗材"];
