# Hướng dẫn giao việc vận hành — MailVault (2026-10-24)

**Người thực hiện:** trợ lý. **Kết quả mong đợi sau khi xong cả 3 việc:** repo tự deploy lên production khi merge, kho thư có lớp chống mất dữ liệu, và có hệ thống phát hiện sập từ bên ngoài.

**Bối cảnh 1 dòng:** code đã xong và commit trên branch `redesign/full-interface` (repo `vn-tak/mailvault`, máylocal tại `~/Documents/mail sever`). Còn 3 thao tác phía Cloudflare/GitHub mà chỉ người có quyền dashboard làm được.

**Quy tắc chung:**
- Làm đúng theo thứ tự 1 → 2 → 3. Việc 3 (push + merge) làm **sau cùng**.
- Ghi lại màn hình (screenshot) mỗi bước đánh dấu ✅ để báo cáo lại.
- Nếu một bước không khớp với mô tả (menu đổi tên, báo lỗi lạ): **dừng việc đó**, chụp màn hình lỗi, hỏi lại. Không tự đoán, không retry nhiều lần, tuyệt đối không chạy lệnh xóa (`wrangler delete`, xóa bucket, xóa database…).

---

## Việc 1 — Tạo CI token Cloudflare và bỏ vào GitHub Secrets

**Mục đích:** CI trên GitHub cần một token riêng để (a) áp D1 migrations + deploy Worker mỗi lần merge vào `main`, (b) chạy backup D1 hàng tuần lên R2, (c) rollback khi cần. Đây là token **thứ hai**, tách biệt với token runtime đã có trong Worker (đừng đụng vào token cũ).

### 1a. Tạo token trên Cloudflare

1. Đăng nhập [dash.cloudflare.com](https://dash.cloudflare.com) bằng tài khoản **tungbipdz@gmail.com**.
2. Bấm avatar góc phải → **My Profile** → mục trái **API Tokens** → **Create Token**.
3. Cuối trang chọn **Create Custom Token** → **Get started**.
4. Đặt tên: `mailvault-ci`.
5. Mục **Permissions**, thêm đúng 5 dòng sau (bấm **+ Add more** để thêm dòng):

   | # | Scope | Permission | Ghi chú |
   |---|-------|------------|---------|
   | 1 | Account | Workers Scripts | Edit | deploy Worker |
   | 2 | Account | D1 | Edit | migrations + export backup + restore |
   | 3 | Account | Queues | Edit | deploy cập nhật consumer queue |
   | 4 | Account | R2 | Edit | backup + deploy kiểm tra bucket |
   | 5 | Zone | Workers Routes | Edit | 2 route custom domain của Worker |

6. Dòng 4 (R2): sau khi chọn Edit sẽ hiện cột **Include** bên phải → chọn **Specific buckets** → chọn cả **`mail-vault-storage`** và **`mail-vault-backups`** (bucket deploy cần đọc, bucket backup cần ghi).
7. Dòng 5 (Workers Routes): cột Include để **All zones**.
8. Mục **Account Resources**: Include → **Tung BIP DZ's Account** (`ef250a88911fd24073cb73d1c07e0218`).
9. (Tuỳ chọn, khuyến nghị) Mục **TTL**: đặt hết hạn sau **1 năm** — để có mốc lịch nhắc quay vòng token.
10. Bấm **Continue to summary** → **Create Token**.
11. ⚠️ **Sao chép chuỗi token hiển thị ra chỗ an toàn ngay** (Cloudflare chỉ hiện đúng 1 lần). Định dạng ~40 ký tự gồm chữ-số-gạch dưới. ✅ *chụp màn hình sau khi tạo xong (che token nếu thấy trong ảnh).*

### 1b. Bỏ token vào GitHub Secrets

1. Mở repo **https://github.com/vn-tak/mailvault** (đăng nhập tài khoản có quyền Admin/Settings).
2. **Settings** → mục trái **Secrets and variables** → **Actions** → nút **New repository secret**.
3. Tạo 2 secret:

   | Name | Secret value |
   |------|--------------|
   | `CLOUDFLARE_API_TOKEN` | chuỗi token vừa copy ở 1a.11 |
   | `CLOUDFLARE_ACCOUNT_ID` | `ef250a88911fd24073cb73d1c07e0218` |

   ✅ *chụp màn hình danh sách 2 secret (GitHub chỉ hiện tên, không hiện giá trị — an toàn để chụp).*

### 1c. Kiểm tra ngay (không cần đợi merge)

1. Trong repo → tab **Actions** → workflow **"Backup D1"** bên trái → **Run workflow** → Branch chọn `redesign/full-interface` → **Run workflow**.
2. Đợi ~2–4 phút, mở run vừa tạo, cả 4 bước phải ✅ xanh (Ensure bucket / Export D1 / Upload to R2 / Prune).
3. Kiểm chứng dữ liệu thật: Cloudflare dashboard → **R2 Object Storage** → bucket **`mail-vault-backups`** → thư mục `d1/` → thấy file `mailvault-<ngày>.sql` dung lượng > 0. ✅
4. Nếu run đỏ: mở log bước đỏ, chụp lại. Lỗi hay gặp: `Authentication error [code 10000]` = thiếu/thiếu đúng permission ở bước 1a.5 — sửa bằng cách tạo lại token với đúng bảng trên (token cũ cứ để, tạo mới rồi update secret).

---

## Việc 2 — Bật R2 Object Versioning + đặt uptime monitor

**Mục đích:** versioning giữ bản cũ của mọi file .eml/attachment trong bucket — xóa nhầm vẫn khôi phục được (hiện tại xóa là mất vĩnh viễn). Uptime monitor phát hiện app sập từ bên ngoài, cả khi dashboard Cloudflare vẫn toàn xanh.

### 2a. Bật Object Versioning cho bucket thư

1. Cloudflare dashboard → **R2 Object Storage** → hàng bucket **`mail-vault-storage`** → bấm tên bucket.
2. Tab **Settings**.
3. Cuộn tới thẻ **Object Versioning** → gạt công tắc/**Enable** → xác nhận.
4. Xác nhận trạng thái hiển thị **Enabled**. ✅ *chụp màn hình Settings.*

Lưu ý: các bản phiên bản cũ cũng chiếm dung lượng R2 (rất nhỏ ở quy mô cá nhân; R2 miễn phí 10 GB). Không cần cấu hình gì thêm — từ giờ mọi lần ghi đè/xóa đều tự giữ bản cũ.

### 2b. Đặt uptime monitor (UptimeRobot, gói free)

1. Vào **https://uptimerobot.com** → Sign up bằng email tuỳ chọn (tạo tài khoản riêng cho ops cũng được) → xác nhận email.
2. Bấm **Add New Monitor**, điền:
   - **Monitor type:** HTTPS
   - **Friendly name:** `MailVault health`
   - **URL**: `https://mail.tungjp.store/api/health`
   - **Monitoring interval:** 5 minutes
   - (nên bật) **Email alerts** tới hộp thư bạn nhận được.
3. **Create** → trạng thái monitor chuyển **Up** trong ~1–2 phút. ✅
4. Kiểm tra giám sát hoạt động: bấm vào monitor → response time có biểu đồ, HTTP status 200.

(Ghi chú để báo cáo: repo đã có workflow "Smoke production" chạy hàng đêm kiểm tra thêm portal `code.tungjp.store` — không cần đặt monitor thứ hai cho portal.)

---

## Việc 3 — Push branch, mở PR và merge để CI deploy

**Mục đích:** đưa 13 commit của đợt nâng cấp lên production. **Chỉ làm sau khi Việc 1 và 2 đã ✅.**

### 3a. Push branch

Trên máy chủ sở hữu (Mac), Terminal:

```bash
cd ~/Documents/mail\ sever
git status          # phải sạch: "nothing to commit, working tree clean"
git log --oneline -3   # thấy: "Type the alert test's captured send through unknown" trên cùng
git push origin redesign/full-interface
```

✅ *chụp output lệnh push (phải không có chữ "rejected").*

### 3b. Mở Pull Request và merge

1. Mở **https://github.com/vn-tak/mailvault/compare/main...redesign/full-interface** → **Create pull request**.
2. Đợi CI check **CI / verify** chạy (~10–15 phút: typecheck, lint, 415 test, 58→63 E2E). Phải ✅ xanh. Nếu đỏ: dừng, báo lại, đừng merge.
3. **Merge pull request** (Squash and merge **KHÔNG dùng** — chọn **Create a merge commit** hoặc **Rebase and merge** để giữ 13 commit lịch sử).
4. Ngay sau merge, tab **Actions** sẽ chạy 2 job nối tiếp trong workflow **CI**:
   - `verify` (lần cuối trên main)
   - `deploy` — lần **đầu tiên** chạy bằng CI token: áp D1 migrations (thêm 2 index của migration 0014, chạy vài giây) rồi deploy Worker + SPA. Theo dõi tới khi ✅ (~5 phút).
5. Nếu `deploy` đỏ: chụp log, **dừng**, báo lại. Đừng thử sửa gì trên Cloudflare.

### 3c. Kiểm tra sau deploy (5 phút, theo checklist)

| # | Kiểm tra | Cách | Kết quả đúng |
|---|----------|------|--------------|
| 1 | App sống | mở `https://mail.tungjp.store/api/health` | JSON có `"ok":true` |
| 2 | Inbox tải bình thường | đăng nhập app → Inbox | danh sách thư hiện, badges đúng |
| 3 | Tính năng mới 1 | mở 1 tin nhắn → More → "Download original (.eml)" | tải được file .eml |
| 4 | Tính năng mới 2 | Aliases → "Export" | tải file JSON danh sách alias |
| 5 | CI deploy dùng token mới | Actions → run CI vừa rồi, job `deploy` | xanh toàn bộ |
| 6 | Uptime | UptimeRobot | trạng thái Up |

✅ *chụp cả 6 ô kết quả.*

### 3d. Nếu deployment có vấn đề (phương án rollback, chỉ khi được yêu cầu)

- Vào **Actions** → workflow **"Roll back production"** → Run workflow → dán `version_id` của bản trước (xem bằng `npx wrangler versions list` trong thư mục `apps/worker`, lấy id gần nhất trước thời điểm merge). Việc này chỉ lùi **code Worker**, không đụng dữ liệu D1/R2 — an toàn.

---

## Báo cáo hoàn tất (mẫu)

> 1. Token `mailvault-ci` đã tạo (TTL 1 năm), 2 secrets đã set, workflow Backup D1 chạy xanh, file backup xuất hiện trong `mail-vault-backups/d1/`.
> 2. Object Versioning trên `mail-vault-storage`: Enabled. UptimeRobot theo dõi `mail.tungjp.store/api/health`: Up.
> 3. Đã push + merge PR #<số>. CI verify + deploy xanh. Checklist 6/6 đạt. Kèm screenshot đính kèm.

**Sau khi báo cáo này được xác nhận, toàn bộ kế hoạch nâng cấp (audit docs/AUDIT-2026-10-24.md) coi như đóng.** Các mục còn hoãn (FTS nội dung thư, digest notification, restore drill…) nằm trong "Còn lại" của tài liệu audit, không thuộc phạm vi lần này.
