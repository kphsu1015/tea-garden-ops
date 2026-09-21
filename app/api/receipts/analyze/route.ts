import { NextResponse } from "next/server";
import { listActiveCategoryNames, PENDING_CATEGORY } from "@/lib/categories";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// 簡易記憶體流量限制：同一登入使用者每個時間窗最多幾次AI辨識。
// 注意：僅限單一伺服器行程有效，多執行個體（例如Serverless多實例）不會共用計數，之後如需嚴謹限流建議改用Supabase或Redis等共享儲存。
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 8;
const requestTimestampsByUser = new Map<string, number[]>();

function checkRateLimit(userId: string): number | null {
  const now = Date.now();
  const recent = (requestTimestampsByUser.get(userId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    return Math.ceil((RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000);
  }
  recent.push(now);
  requestTimestampsByUser.set(userId, recent);
  return null;
}

const CHARGE_LINE_TYPES = ["shipping", "handling", "tax", "discount", "other_fee"] as const;
const LINE_TYPES = ["inventory", ...CHARGE_LINE_TYPES] as const;

function buildReceiptSchema(categoryOptionsInput: string[]) {
  // 非庫存費用（運費等）沒有大分類可選，這裡額外加一個空字串選項給這類列使用；
  // 庫存品項仍然只能從categoryOptionsInput（含待分類）裡面選，不會實際用到空字串。
  const categoryOptions = [...categoryOptionsInput, ""];
  return {
    type: "object",
    additionalProperties: false,
    required: ["supplier", "purchaseDate", "invoiceNumber", "totalAmount", "lines", "warnings"],
    properties: {
      supplier: { type: "string" },
      purchaseDate: { type: "string", description: "YYYY-MM-DD，無法辨識則空字串" },
      invoiceNumber: { type: "string" },
      totalAmount: { type: ["number", "null"] },
      lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["lineType", "itemName", "quantity", "unit", "unitPrice", "totalPrice", "category"],
          properties: {
            // inventory：庫存品項；其餘5種是非庫存費用，不可建立庫存品項或增加庫存。
            lineType: { type: "string", enum: [...LINE_TYPES] },
            itemName: { type: "string", description: "品項名稱，若lineType不是inventory則填費用名稱（例如：運費）" },
            quantity: { type: "number" },
            unit: { type: "string" },
            unitPrice: { type: ["number", "null"] },
            totalPrice: { type: ["number", "null"] },
            category: { type: "string", enum: categoryOptions },
          },
        },
      },
      warnings: { type: "array", items: { type: "string" } },
    },
  };
}

function demoResult() {
  return {
    supplier: "示範供應商",
    purchaseDate: new Date().toISOString().slice(0, 10),
    invoiceNumber: "DEMO-001",
    totalAmount: 1290,
    lines: [
      { lineType: "inventory", itemName: "抽取式衛生紙", quantity: 6, unit: "串", unitPrice: 120, totalPrice: 720, category: "客房備品" },
      { lineType: "inventory", itemName: "牛五花", quantity: 2, unit: "公斤", unitPrice: 260, totalPrice: 520, category: "晚餐食材" },
      { lineType: "shipping", itemName: "運費", quantity: 1, unit: "式", unitPrice: 50, totalPrice: 50, category: "" },
    ],
    warnings: ["這是示範辨識結果，正式使用時請設定OPENAI_API_KEY。"],
    demo: true,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { image?: string; mimeType?: string };
    if (!body.image || !body.mimeType || !ALLOWED_MIME_TYPES.has(body.mimeType)) {
      return NextResponse.json({ error: "請上傳JPG、PNG或WEBP格式的圖片。" }, { status: 400 });
    }
    if (body.image.length > 12_000_000) {
      return NextResponse.json({ error: "圖片過大，請壓縮後再試。" }, { status: 413 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey && process.env.NEXT_PUBLIC_DEMO_MODE !== "false") {
      return NextResponse.json(demoResult());
    }
    if (!apiKey) {
      return NextResponse.json({ error: "尚未設定OPENAI_API_KEY。" }, { status: 503 });
    }

    // 接下來會真正呼叫OpenAI並產生費用，所以從這裡開始必須確認為已登入的Supabase員工，避免外人消耗額度。
    const supabase = await createClient();
    if (!supabase) {
      return NextResponse.json({ error: "尚未設定Supabase，無法驗證登入狀態，暫停AI辨識。" }, { status: 503 });
    }
    const session = await requireStaffSession(supabase);
    if (!session.ok) return session.response;
    const retryAfterSeconds = checkRateLimit(session.userId);
    if (retryAfterSeconds !== null) {
      console.warn("Receipt analyze rate limited", session.userId);
      return NextResponse.json(
        { error: `操作過於頻繁，請於${retryAfterSeconds}秒後再試。` },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    let activeCategories: string[];
    try {
      activeCategories = await listActiveCategoryNames(supabase);
    } catch (error) {
      console.error("Load active categories failed, fallback to empty list", error);
      activeCategories = [];
    }
    const categoryOptions = [...activeCategories, PENDING_CATEGORY];

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: `辨識這張民宿進貨單。這是逐字轉錄任務，不是內容重寫任務：品項名稱必須是單據上實際印出的文字，逐字照抄，禁止用「這類產品常見的名稱」去補全或替換看不清楚的字——例如單據寫「奶油」絕不能因為猜測而寫成「防油」，寫「工房」不能自行加上「廠」字。任何一個字看不清楚時，用「?」取代該字（例如「開元?工房奶油牛角」），並在warnings註明「品項名稱部分字元無法辨識」，絕對不要用聽起來合理的詞取代。特別留意容易誤認的字元（0與O、1與7、6與8、3與5、9與0）。每一列請用「數量×單價=金額」互相驗證，若三者對不起來，以單據上實際印刷或手寫的數字為準並在warnings註明可能有誤。

每一列都要判斷lineType：庫存品項填「inventory」；如果這一列的名稱包含「運費」「物流費」「宅配費」「配送費」「Freight」「Shipping」「Delivery fee」，一律判斷為「shipping」；包含「Handling fee」「包裝費」「手續費」判斷為「handling」；稅額（例如營業稅、稅金）判斷為「tax」；折扣、折讓、優惠減免判斷為「discount」；其他明顯不是實體商品的費用項目判斷為「other_fee」。這些非庫存費用絕對不可以判斷成inventory，也不會被建立成庫存品項。只要看到上述關鍵字就優先判斷為對應的非庫存費用類型，不要因為它也出現在品項清單裡就當成一般商品。

分類欄位(category)只在lineType為inventory時才需要選擇，只能從以下選項中選一個，優先從現有分類中選擇最符合的：${activeCategories.join("、") || "（目前尚無啟用中的分類）"}。如果實在無法判斷應歸屬哪個分類，請填「${PENDING_CATEGORY}」，不要自行發明新分類名稱。lineType不是inventory時，category請填空字串。無法確認的資訊請留空並寫入warnings。` },
            { type: "input_image", image_url: `data:${body.mimeType};base64,${body.image}`, detail: "high" },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "receipt_analysis",
            strict: true,
            schema: buildReceiptSchema(categoryOptions),
          },
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("OpenAI receipt analysis failed", response.status, detail.slice(0, 500));
      return NextResponse.json({ error: "AI辨識暫時失敗，請稍後再試或手動輸入。" }, { status: 502 });
    }

    type ResponsesApiOutput = {
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };
    const data = await response.json() as ResponsesApiOutput;
    const outputText = data.output
      ?.find((item) => item.type === "message")
      ?.content?.find((part) => part.type === "output_text")
      ?.text;
    if (!outputText) {
      return NextResponse.json({ error: "AI沒有回傳可用的辨識結果。" }, { status: 502 });
    }
    return NextResponse.json(JSON.parse(outputText));
  } catch (error) {
    console.error("Receipt analysis error", error);
    return NextResponse.json({ error: "進貨單處理失敗，請確認圖片後重試。" }, { status: 500 });
  }
}
