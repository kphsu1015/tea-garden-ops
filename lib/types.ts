export type Category = string;
export type PurchaseStatus = "待確認" | "已訂購" | "已到貨" | "已入庫" | "暫緩";

export interface InventoryCategory {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  itemCount: number;
  receiptLineCount: number;
  createdAt: string;
}
export type MovementType = "採購入庫" | "日常領用" | "客房補充" | "食材使用" | "損壞" | "過期報廢" | "盤點調整";

export type UsagePeriod = "daily" | "weekly" | "monthly";

// 目前可以指派的角色。「viewer」已停用，舊資料仍可能出現在StaffProfile.role中，但不再是可指派的選項。
export type AssignableStaffRole = "admin" | "purchaser" | "housekeeper";
export type StaffRole = AssignableStaffRole | "viewer";

export interface StaffProfile {
  id: string;
  displayName: string;
  email: string;
  role: StaffRole;
  active: boolean;
  createdAt: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  category: Category;
  quantity: number;
  safetyStock: number;
  suggestedPurchase: number;
  unit: string;
  expiryDate?: string;
  supplier?: string;
  active: boolean;
  usageForecastEnabled: boolean;
  estimatedUsage?: number;
  usagePeriod?: UsagePeriod;
}

export interface InventoryItemInput {
  name: string;
  category: string;
  unit: string;
  safetyStock: number;
  suggestedPurchase: number;
  supplier?: string;
  expiryDate?: string;
  usageForecastEnabled: boolean;
  estimatedUsage?: number;
  usagePeriod?: UsagePeriod;
}

export interface PurchaseRequest {
  id: string;
  itemName: string;
  // 提出採購需求時選的庫存品項id；「確認入庫」時用這個id直接寫入stock_movements，避免品項改名後用名稱比對失準。
  // 舊資料（這個欄位還沒存在前建立的採購需求）可能沒有這個值，確認入庫時會退回用品項名稱比對。
  inventoryItemId?: string;
  quantity: number;
  unit: string;
  priority: "一般" | "急件";
  status: PurchaseStatus;
  requester: string;
  requestedAt: string;
  note?: string;
}

// 送出新採購需求時前端填的欄位；id、狀態、提出人、時間由伺服器（登入者身分）決定。
export type PurchaseDraft = Pick<PurchaseRequest, "itemName" | "inventoryItemId" | "quantity" | "unit" | "priority" | "note">;

export interface HandoverNote {
  id: string;
  category: "客人需求" | "房務問題" | "設備維修" | "餐飲" | "重要公告";
  content: string;
  author: string;
  createdAt: string;
  important: boolean;
}

export type NoteDraft = Pick<HandoverNote, "category" | "content" | "important">;

export type ReceiptLineResolution = "existing" | "create_new" | "ignore";

export interface ReceiptLine {
  id: string;
  itemName: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  totalPrice?: number;
  inventoryItemId?: string;
  category?: string;
  // 這筆品項在確認入庫時是怎麼處理的：對應現有庫存／建立新庫存品項／忽略（不建立或更新庫存）。
  resolution?: ReceiptLineResolution;
}

// 運費／處理費／稅額／折扣／其他費用：這些不是庫存品項，不會建立inventory_items，也不會增加庫存數量。
export type ReceiptChargeType = "shipping" | "handling" | "tax" | "discount" | "other_fee";

export interface ReceiptCharge {
  id: string;
  chargeType: ReceiptChargeType;
  description?: string;
  amount: number;
}

export interface ReceiptAnalysis {
  supplier: string;
  purchaseDate: string;
  invoiceNumber?: string;
  totalAmount?: number;
  lines: ReceiptLine[];
  charges: ReceiptCharge[];
  warnings: string[];
}

export interface ReceiptRecord extends ReceiptAnalysis {
  id: string;
  fileName: string;
  storagePath?: string;
  status: "待確認" | "已入庫" | "辨識失敗";
  createdAt: string;
  deleteAfter?: string;
  demo?: boolean;
}
