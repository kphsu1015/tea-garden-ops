import { MOVEMENT_TYPE_LABELS } from "@/lib/inventory";

export interface StockMovementRecord {
  id: string;
  itemName: string;
  movementType: string;
  quantityChange: number;
  unit: string;
  // 這筆異動動到的批次到期日（快照）；null代表未標日期，或是批次功能上線前的舊紀錄。
  expiryDate: string | null;
  note: string | null;
  operatorName: string;
  createdAt: string;
}

type RawMovementRow = {
  id: string;
  movement_type: string;
  quantity_change: number;
  unit: string;
  expiry_date: string | null;
  note: string | null;
  created_at: string;
  inventory_items: { name: string } | { name: string }[] | null;
  staff_profiles: { display_name: string } | { display_name: string }[] | null;
};

// PostgREST的embedded resource在某些查詢情境會回傳物件、某些情境回傳陣列，這裡統一攤平成單一物件。
function firstOf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

export function mapMovementRow(row: RawMovementRow): StockMovementRecord {
  const item = firstOf(row.inventory_items);
  const operator = firstOf(row.staff_profiles);
  return {
    id: row.id,
    itemName: item?.name ?? "（品項已刪除）",
    movementType: MOVEMENT_TYPE_LABELS[row.movement_type] ?? row.movement_type,
    quantityChange: Number(row.quantity_change),
    unit: row.unit,
    expiryDate: row.expiry_date ?? null,
    note: row.note,
    operatorName: operator?.display_name ?? "—",
    createdAt: row.created_at,
  };
}
