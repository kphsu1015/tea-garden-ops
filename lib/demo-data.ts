import type { HandoverNote, InventoryItem, PurchaseRequest } from "./types";

export const initialInventory: InventoryItem[] = [
  { id: "i1", name: "冬粉", category: "晚餐食材", quantity: 8, safetyStock: 10, suggestedPurchase: 20, unit: "包", expiryDate: "2027-03-01", supplier: "山城食品行", active: true, usageForecastEnabled: false },
  { id: "i2", name: "瓶裝水", category: "客房備品", quantity: 2, safetyStock: 4, suggestedPurchase: 6, unit: "箱", supplier: "嘉義飲料行", active: true, usageForecastEnabled: false },
  { id: "i3", name: "客房衛生紙", category: "客房備品", quantity: 5, safetyStock: 10, suggestedPurchase: 12, unit: "串", supplier: "生活百貨", active: true, usageForecastEnabled: true, estimatedUsage: 6, usagePeriod: "weekly" },
  { id: "i4", name: "牛奶", category: "早餐食材", quantity: 9, safetyStock: 12, suggestedPurchase: 12, unit: "瓶", expiryDate: "2026-09-20", supplier: "在地鮮乳", active: true, usageForecastEnabled: false },
  { id: "i5", name: "雞蛋", category: "早餐食材", quantity: 32, safetyStock: 24, suggestedPurchase: 30, unit: "顆", expiryDate: "2026-09-22", active: true, usageForecastEnabled: false },
  { id: "i6", name: "火鍋泡麵", category: "晚餐食材", quantity: 36, safetyStock: 20, suggestedPurchase: 24, unit: "包", expiryDate: "2027-01-15", active: true, usageForecastEnabled: false },
  { id: "i7", name: "浴巾", category: "客房備品", quantity: 48, safetyStock: 36, suggestedPurchase: 12, unit: "條", active: true, usageForecastEnabled: false },
  { id: "i8", name: "垃圾袋", category: "清潔用品", quantity: 5, safetyStock: 5, suggestedPurchase: 10, unit: "捲", active: true, usageForecastEnabled: false },
];

export const initialPurchases: PurchaseRequest[] = [
  { id: "p1", itemName: "咖啡豆", quantity: 2, unit: "包", priority: "一般", status: "待確認", requester: "王管家", requestedAt: "2026-09-16 09:20", note: "早餐區剩最後一包" },
  { id: "p2", itemName: "清潔劑", quantity: 3, unit: "瓶", priority: "一般", status: "已訂購", requester: "林管家", requestedAt: "2026-09-15 16:40" },
  { id: "p3", itemName: "早餐吐司", quantity: 5, unit: "條", priority: "急件", status: "已訂購", requester: "陳管家", requestedAt: "2026-09-15 10:15" },
  { id: "p4", itemName: "洗髮精", quantity: 6, unit: "瓶", priority: "一般", status: "待確認", requester: "王管家", requestedAt: "2026-09-14 14:10" },
  { id: "p5", itemName: "茶葉包", quantity: 10, unit: "包", priority: "一般", status: "已訂購", requester: "Alan", requestedAt: "2026-09-14 09:05" },
];

export const initialNotes: HandoverNote[] = [
  { id: "n1", category: "設備維修", content: "203房吹風機已更換備用品，故障品放在辦公室。", author: "王管家", createdAt: "2026-09-17 10:24", important: true },
  { id: "n2", category: "餐飲", content: "晚餐冬粉庫存偏低，明天有8位晚餐，請優先補貨。", author: "林管家", createdAt: "2026-09-16 18:40", important: true },
  { id: "n3", category: "房務問題", content: "玫瑰房備用枕套剩2組，已放入採購清單。", author: "陳管家", createdAt: "2026-09-16 15:05", important: false },
];
