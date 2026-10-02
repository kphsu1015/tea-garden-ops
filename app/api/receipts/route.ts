import { NextResponse } from "next/server";
import { isDateKey } from "@/lib/inventory";
import { getReceiptRetentionDays, mapReceiptRow, RECEIPT_SELECT_COLUMNS } from "@/lib/shared-records";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// 最近的進貨單（含品項明細與非庫存費用）。所有在職員工讀到同一份（RLS：is_active_staff）。
export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ receipts: [], demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const { data, error } = await supabase
      .from("receipts")
      .select(RECEIPT_SELECT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return NextResponse.json({ receipts: (data ?? []).map((row) => mapReceiptRow(row as unknown as Parameters<typeof mapReceiptRow>[0])), demo: false });
  } catch (error) {
    console.error("List receipts failed", error);
    return NextResponse.json({ error: "讀取進貨單失敗，請稍後再試。" }, { status: 500 });
  }
}

type NewItemDraft = {
  name?: string;
  category?: string;
  unit?: string;
  safetyStock?: number;
  usageForecastEnabled?: boolean;
  estimatedUsage?: number;
  usagePeriod?: string;
};

type ReceiptLineInput = {
  action: "existing" | "create_new" | "ignore";
  itemName: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  totalPrice?: number;
  category?: string;
  inventoryItemId?: string;
  // 這批貨的到期日（選填），確認入庫時依此建立／併入庫存批次。
  expiryDate?: string;
  newItem?: NewItemDraft;
};

const CHARGE_TYPES = ["shipping", "handling", "tax", "discount", "other_fee"] as const;
type ChargeType = typeof CHARGE_TYPES[number];

type ReceiptChargeInput = {
  chargeType: ChargeType;
  description?: string;
  amount: number;
};

// 確認入庫：建立進貨單、（若有）建立新庫存品項、寫入品項明細與庫存異動，全部在單一Postgres交易（RPC）內完成，
// 任一步驟失敗都會整筆回滾，不會留下只建立一半的資料。storagePath是選填的：拍照辨識完成上傳後才會有；
// 手動輸入進貨單沒有照片，storagePath留空即可，receipts.storage_path欄位已改成可以是null。
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法保存進貨單。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const body = await request.json() as {
      supplier?: string;
      purchaseDate?: string;
      invoiceNumber?: string;
      totalAmount?: number;
      originalFileName?: string;
      storagePath?: string;
      warnings?: string[];
      lines?: ReceiptLineInput[];
      charges?: ReceiptChargeInput[];
    };

    if (!body.originalFileName) return NextResponse.json({ error: "缺少檔案名稱。" }, { status: 400 });
    // 庫存數量、安全庫存、預估使用量一律整數，即使呼叫端傳了小數也在這裡四捨五入，不會存進小數。
    const lines = (body.lines ?? []).map((line) => ({
      ...line,
      quantity: Math.round(line.quantity),
      newItem: line.newItem ? {
        ...line.newItem,
        safetyStock: typeof line.newItem.safetyStock === "number" ? Math.round(line.newItem.safetyStock) : line.newItem.safetyStock,
        estimatedUsage: typeof line.newItem.estimatedUsage === "number" ? Math.round(line.newItem.estimatedUsage) : line.newItem.estimatedUsage,
      } : line.newItem,
    }));
    const charges = body.charges ?? [];
    if (lines.length === 0 && charges.length === 0) return NextResponse.json({ error: "至少需要一筆庫存品項或費用。" }, { status: 400 });
    // 進貨單一定要有金額才能送出，不管是AI辨識還是手動輸入。
    if (typeof body.totalAmount !== "number" || !(body.totalAmount > 0)) {
      return NextResponse.json({ error: "請填寫單據總額（必須大於0）。" }, { status: 400 });
    }

    for (const line of lines) {
      if (!(line.quantity > 0)) return NextResponse.json({ error: "品項數量必須大於0。" }, { status: 400 });
      if (typeof line.unitPrice === "number" && line.unitPrice < 0) return NextResponse.json({ error: "單價不可為負數。" }, { status: 400 });
      if (typeof line.totalPrice === "number" && line.totalPrice < 0) return NextResponse.json({ error: "品項金額不可為負數。" }, { status: 400 });
      if (line.expiryDate && !isDateKey(line.expiryDate)) return NextResponse.json({ error: `「${line.itemName}」的到期日格式不正確。` }, { status: 400 });
      if (line.action !== "existing" && line.action !== "create_new" && line.action !== "ignore") {
        return NextResponse.json({ error: "每個品項都必須選擇：對應現有庫存、建立新庫存品項或忽略此品項。" }, { status: 400 });
      }
      if (line.action === "existing" && !line.inventoryItemId) {
        return NextResponse.json({ error: `「${line.itemName}」尚未選擇要對應的庫存品項。` }, { status: 400 });
      }
      if (line.action === "create_new") {
        const draft = line.newItem;
        if (!draft?.name?.trim() || !draft?.category?.trim() || !draft?.unit?.trim()) {
          return NextResponse.json({ error: `「${line.itemName}」的新品項資料尚未填寫完整（名稱／大分類／單位）。` }, { status: 400 });
        }
        if (draft.usageForecastEnabled) {
          if (typeof draft.estimatedUsage !== "number" || draft.estimatedUsage <= 0) {
            return NextResponse.json({ error: `「${line.itemName}」啟用預估使用量時，預估使用量必須大於0。` }, { status: 400 });
          }
          if (!draft.usagePeriod) {
            return NextResponse.json({ error: `「${line.itemName}」啟用預估使用量時，請選擇使用週期。` }, { status: 400 });
          }
        }
      }
    }

    // 非庫存費用（運費／處理費／稅額／折扣／其他費用）：不要求分類、數量、單位或對應庫存，
    // 只需要合法的費用類型與不為負數的金額，確認入庫後只會寫入receipt_charges，不會建立庫存品項或庫存異動。
    for (const charge of charges) {
      if (!CHARGE_TYPES.includes(charge.chargeType)) {
        return NextResponse.json({ error: "費用類型不正確，請選擇運費、處理費、稅額、折扣或其他費用。" }, { status: 400 });
      }
      if (typeof charge.amount !== "number" || !Number.isFinite(charge.amount) || charge.amount < 0) {
        return NextResponse.json({ error: "費用金額必須是不小於0的數字。" }, { status: 400 });
      }
    }

    const { data, error } = await supabase.rpc("confirm_receipt_with_lines", {
      p_supplier: body.supplier?.trim() || null,
      p_purchase_date: body.purchaseDate || null,
      p_invoice_number: body.invoiceNumber?.trim() || null,
      p_total_amount: typeof body.totalAmount === "number" ? body.totalAmount : null,
      p_original_file_name: body.originalFileName,
      p_storage_path: body.storagePath || null,
      p_warnings: body.warnings ?? [],
      // 保存天數以資料庫共用設定為準，不信任前端傳來的值，避免不同員工的瀏覽器設定不一致。
      p_retention_days: await getReceiptRetentionDays(supabase),
      p_lines: lines,
      p_charges: charges,
    });

    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "已有相同名稱的品項，或這張照片已經保存過，請改選「對應現有庫存」或確認是否已入庫過。" }, { status: 409 });
      if (error.code === "23514") return NextResponse.json({ error: "金額、數量或預估使用量設定不正確（例如負數，或啟用預估使用量卻沒填完整）。" }, { status: 400 });
      if (error.code === "P0001") {
        if (error.message.includes("not authorized")) return NextResponse.json({ error: "沒有權限建立進貨單。" }, { status: 403 });
        if (error.message.includes("only admin or purchaser can create new inventory items")) return NextResponse.json({ error: "只有管理員或訂貨管家可以建立新庫存品項，請改選「對應現有庫存」或「忽略此品項」，或請管理員／訂貨管家協助入庫。" }, { status: 403 });
        if (error.message.includes("total amount is required")) return NextResponse.json({ error: "請填寫單據總額（必須大於0）。" }, { status: 400 });
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    return NextResponse.json({ id: data?.id }, { status: 201 });
  } catch (error) {
    console.error("Confirm receipt failed", error);
    return NextResponse.json({ error: "保存進貨單失敗，請稍後再試。" }, { status: 500 });
  }
}
