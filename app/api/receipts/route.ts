import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type NewItemDraft = {
  name?: string;
  category?: string;
  unit?: string;
  location?: string;
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
  newItem?: NewItemDraft;
};

// 確認入庫：建立進貨單、（若有）建立新庫存品項、寫入品項明細與庫存異動，全部在單一Postgres交易（RPC）內完成，
// 任一步驟失敗都會整筆回滾，不會留下只建立一半的資料。只有真的完成照片上傳（有storagePath）才會呼叫這支。
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法保存進貨單。" }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再操作。" }, { status: 401 });

  try {
    const body = await request.json() as {
      supplier?: string;
      purchaseDate?: string;
      invoiceNumber?: string;
      totalAmount?: number;
      originalFileName?: string;
      storagePath?: string;
      warnings?: string[];
      retentionDays?: number;
      lines?: ReceiptLineInput[];
    };

    if (!body.storagePath) return NextResponse.json({ error: "缺少照片儲存路徑。" }, { status: 400 });
    if (!body.originalFileName) return NextResponse.json({ error: "缺少檔案名稱。" }, { status: 400 });
    if (!Array.isArray(body.lines) || body.lines.length === 0) return NextResponse.json({ error: "至少需要一筆品項。" }, { status: 400 });
    if (typeof body.totalAmount === "number" && body.totalAmount < 0) return NextResponse.json({ error: "單據總額不可為負數。" }, { status: 400 });

    for (const line of body.lines) {
      if (!(line.quantity > 0)) return NextResponse.json({ error: "品項數量必須大於0。" }, { status: 400 });
      if (typeof line.unitPrice === "number" && line.unitPrice < 0) return NextResponse.json({ error: "單價不可為負數。" }, { status: 400 });
      if (typeof line.totalPrice === "number" && line.totalPrice < 0) return NextResponse.json({ error: "品項金額不可為負數。" }, { status: 400 });
      if (line.action !== "existing" && line.action !== "create_new" && line.action !== "ignore") {
        return NextResponse.json({ error: "每個品項都必須選擇：對應現有庫存、建立新庫存品項或忽略此品項。" }, { status: 400 });
      }
      if (line.action === "existing" && !line.inventoryItemId) {
        return NextResponse.json({ error: `「${line.itemName}」尚未選擇要對應的庫存品項。` }, { status: 400 });
      }
      if (line.action === "create_new") {
        const draft = line.newItem;
        if (!draft?.name?.trim() || !draft?.category?.trim() || !draft?.unit?.trim() || !draft?.location?.trim()) {
          return NextResponse.json({ error: `「${line.itemName}」的新品項資料尚未填寫完整（名稱／大分類／單位／存放位置）。` }, { status: 400 });
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

    const { data, error } = await supabase.rpc("confirm_receipt_with_lines", {
      p_supplier: body.supplier?.trim() || null,
      p_purchase_date: body.purchaseDate || null,
      p_invoice_number: body.invoiceNumber?.trim() || null,
      p_total_amount: typeof body.totalAmount === "number" ? body.totalAmount : null,
      p_original_file_name: body.originalFileName,
      p_storage_path: body.storagePath,
      p_warnings: body.warnings ?? [],
      p_retention_days: body.retentionDays ?? 90,
      p_lines: body.lines,
    });

    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "已有相同名稱的品項，或這張照片已經保存過，請改選「對應現有庫存」或確認是否已入庫過。" }, { status: 409 });
      if (error.code === "23514") return NextResponse.json({ error: "金額、數量或預估使用量設定不正確（例如負數，或啟用預估使用量卻沒填完整）。" }, { status: 400 });
      if (error.code === "P0001") {
        if (error.message.includes("not authorized")) return NextResponse.json({ error: "沒有權限建立進貨單。" }, { status: 403 });
        if (error.message.includes("only admin or purchaser can create new inventory items")) return NextResponse.json({ error: "只有管理員或訂貨管家可以建立新庫存品項，請改選「對應現有庫存」或「忽略此品項」，或請管理員／訂貨管家協助入庫。" }, { status: 403 });
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
