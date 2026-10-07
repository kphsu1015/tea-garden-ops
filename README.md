# 茶香花園民宿｜內部採購與庫存系統

以 Next.js App Router、TypeScript、Tailwind CSS 與 Supabase 規劃的民宿內部管理網站。

## 已完成的示範功能

- 管理總覽：低庫存、待採購、即將過期、交接留言
- 庫存清單、分類搜尋與安全庫存警示
- 同一品項多個有效期限（批次管理）：入庫時填到期日，領用時先到期先扣，可依批次報廢與盤點
- 採購需求看板及狀態推進
- 採購入庫、領用、使用、報廢與盤點異動
- 交接留言與重要標記
- 員工權限示意
- 手機與桌面響應式版面
- 瀏覽器 localStorage 示範資料保存
- 自行新增庫存品項
- 系統設定內的品項分類管理（新增／改名／排序／停用／刪除），資料存於Supabase，供所有登入人員共用
- 手機拍照／上傳進貨單，AI辨識成可編輯資料
- 辨識結果確認後，自動建立入庫異動與更新庫存
- 進貨單Private Bucket、90天保存期限與清理清單
- Supabase 正式資料表、RLS與庫存交易函式
- Netlify部署設定

## 本機啟動

```bash
npm install
npm run dev
```

開啟 `http://localhost:3000`。若`.env.local`已設定Supabase，畫面會要求輸入員工Email並寄送登入連結（見下方「正式Supabase設定」）；若尚未設定Supabase，會顯示離線示範模式的登入按鈕。

## 正式Supabase設定

1. 建立Supabase專案。
2. 在SQL Editor依序執行 `supabase/schema.sql`，再執行 `supabase/migrations/0001_inventory_category_management.sql`（新增分類排序／啟用欄位並寫入預設分類）。之後依編號順序執行 `supabase/migrations/` 內其餘檔案（目前到 `0015_stocktake_half_quantity.sql`：盤點數量可輸入0.5；`0014` 把庫存改成依有效期限分批，既有庫存會自動轉成一批）。
3. 複製 `.env.example` 為 `.env.local`。
4. 填入：

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
NEXT_PUBLIC_DEMO_MODE=false
OPENAI_API_KEY=
OPENAI_VISION_MODEL=gpt-4o-mini
RECEIPT_RETENTION_DAYS=90
```

5. 在Supabase Auth → Providers 確認Email登入（Magic Link）已啟用；在 Auth → URL Configuration 把 `你的網域/auth/callback`（本機開發是`http://localhost:3000/auth/callback`）加入 Redirect URLs。
6. 由管理員在SQL Editor手動將員工加入`staff_profiles`（見下方SQL），未列入且非active的帳號登入後看不到任何資料。
7. **本專案不使用 `SUPABASE_SERVICE_ROLE_KEY`。** 「系統設定」的品項分類管理、進貨單AI辨識等所有需要權限的操作，都是用登入者自己的Supabase Auth session執行，全部受RLS約束；未登入或不是active員工時，讀寫會被RLS擋下或回傳401／403。

> 登入方式為Email一次性登入連結（Magic Link）：輸入Email後系統會寄送連結，點擊後導回 `/auth/callback` 完成登入。未設定Supabase時（`NEXT_PUBLIC_SUPABASE_URL`留空），畫面會退回離線示範模式，方便本機開發時不必連線也能操作localStorage示範資料。

## 進貨單照片處理

- 前端先將照片壓縮至最長邊1600px，再送至伺服器辨識。
- OpenAI金鑰只存在伺服器環境變數，不會傳到瀏覽器。
- 正式模式將照片存於名為`receipts`的Private Bucket，只有active員工可讀取。
- `receipts.delete_after`預設為90天；`expired_receipt_paths()`提供到期清理清單。
- 正式上線後應由每日排程的Supabase Edge Function使用Storage API刪除到期檔案，再刪除對應資料列。

## 驗證

```bash
npm run typecheck
npm run lint
npm run build
```

## Netlify

GitHub連接Netlify後：

- Base directory：留空（若此資料夾本身是儲存庫根目錄）
- Build command：`npm run build`
- Publish directory：`.next`

將Supabase環境變數加到Netlify後重新部署。
