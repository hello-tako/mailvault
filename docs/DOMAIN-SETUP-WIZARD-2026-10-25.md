# MailVault — Kế hoạch "Mail Setup Wizard": tự động cấu hình DNS + nhận + gửi mail ngay trong dashboard (2026-10-25)

Mục tiêu theo yêu cầu owner: **với một domain mới bất kỳ, một màn hình duy nhất trong dashboard dẫn từ "vừa add zone" tới "thư nhận được, thư gửi đi"** — tự động DNS, tự động Email Routing + catch-all (nhận), tự động Email Sending + DMARC + sending-via (gửi), và **khi bị chặn thì nói đúng thứ gì thiếu và sửa thế nào** (hiện tại im lặng fail — đây là pain thật của owner).

Phạm vi khảo sát: đọc `routes/domains.ts`, `provisioning/*`, `routes/sending.ts`, `cf/api-client.ts`, `Domains.tsx` (984 dòng, đã có Sync/Preflight/Provision với takeover-confirm + SendingDialog riêng lẻ), DEPLOYMENT.md (token scopes + queue subscription). Kế hoạch này là chương mở rộng của docs/FEATURE-UPGRADE-PLAN-2026-10-24.md (chương A đã ship R1; đây là A-mở-rộng).

---

## 1. Chẩn đoán vì sao domain mới cấu hình không được (hiện trạng)

Kết luận khảo sát — app đã tự động hoá được ~90% nhưng **gãy ở 4 điểm** với domain mới:

| # | Điểm gãy | Biểu hiện owner thấy | Nguyên nhân gốc |
|---|----------|----------------------|-----------------|
| G1 | **Token không phủ zone mới** — token runtime trong Worker secret có Zone Resources giới hạn (không phải "All zones from an account") hoặc thiếu `Zone → Email Routing Rules: Edit` / `Email Sending: Edit` | Provision trả lỗi chung chung hoặc preflight `ApiPermissionError`; sending refresh toàn `UNKNOWN` | Đã từng xảy ra thật 2026-09-20 (outage mất MX); app có message hướng dẫn nhưng **chỉ hiện SAU khi fail**, không kiểm tra TRƯỚC |
| G2 | **Luồng bị chia 3 nơi**: nhận (Sync→Preflight→Provision), gửi (SendingDialog riêng), delivery events (queue subscription phải chạy tay `scripts/ops/queues-subscription.sh` mỗi zone gửi) | Owner không biết phải làm gì tiếp theo sau khi "Enable" xong nhận; gửi lại thiếu bước subscription → không thấy trạng thái delivered/bounced | Thiếu một khung nhìn per-domain |
| G3 | **Không có kiểm tra "thư thật tới được"** sau setup (A8 trong plan cũ còn nợ) | Domain READY nhưng thực tế MX chưa lan truyền / registrar hết hạn → chủ quan tưởng chạy được | Chỉ verify config trong CF, không probe từ ngoài (đã có DoH probe cho domain READY — nhưng không chạy theo yêu cầu) |
| G4 | **DNS write chưa wrap** (A5 còn nợ): không dọn SPF trùng sau khi enable routing, không tự tạo DNS khi CF API từ chối | Sau takeover MX, zone có 2 SPF → gửi từ domain có thể fail SPF | `cf/api-client.ts` chưa có POST/PUT dns_records |

---

## 2. Thiết kế: Mail Setup Wizard (một màn hình, bốn bước)

### 2.1. API mới: `GET /api/domains/:id/setup` — "readiness" (chẩn đoán tổng thể)

Một endpoint read-only trả về **toàn bộ trạng thái + thiếu gì + sửa thế nào** cho 1 zone, chạy song song các check (giữ pattern `verifyDeliveryPath`):

```jsonc
{
  "zone": { "id": "…", "name": "example.com", "status": "active", "type": "full" },
  "receiving": {
    "classification": "READY_TO_PROVISION",       // preflight hiện có
    "mx": { "cloudflare": 1, "foreign": 0, "providers": [] },
    "routing": true, "catchAllOurs": false,
    "publicMxResolvable": true,                   // DoH probe (A6) chạy theo yêu cầu
    "blockers": [],                                // [] = có thể bật ngay
  },
  "sending": {
    "status": "UNKNOWN|ENABLED|…", "via": null,
    "records": [ /* preview DNS Email Sending sẽ ghi */ ],
    "dmarcConflict": false,
    "eventsSubscription": "unknown|likely-missing", // cảnh báo G2
  },
  "token": {
    "canReadZone": true,
    "canEnableRouting": false,                     // probe bằng cách gọi preview/enable? KHÔNG — đo gián tiếp: thử PUT catch-all dry-run? → dùng kết quả preflight 403 + kinds
    "hint": "Thêm zone vào Zone Resources của token mailvault-runtime, hoặc đặt All zones…"
  },
  "next": ["enable-receiving", "enable-sending", "queue-subscription", "probe"]
}
```

Cách đo token **không mutate gì**: tái dùng `preflightZone` (đã phân loại `ApiPermissionError`) + `listDnsRecords` (403 ⇒ thiếu Zone:Read/DNS:Read) + `getCatchAll` (403 ⇒ thiếu Email Routing Rules). Mỗi check kèm `kind` lỗi → map sang câu hướng dẫn sửa (đã có sẵn message trong provisioner — đưa lên UI **trước khi** owner bấm).

### 2.2. Worker: wrap DNS writes (A5) + dọn SPF trùng

- `cf/api-client.ts`: thêm `createDnsRecord(zoneId, record)` (POST) — **chỉ** dùng cho hai việc có kiểm soát: (a) fallback A2 khi `/email/routing/enable` từ chối vì MX foreign còn (ghi MX CF đúng priority → verify → mới xoá MX cũ); (b) hành động "dọn SPF trùng" (xem dưới). **Không** thêm PUT/DELETE (đã có DELETE cho MX takeover) — giữ bề mặt mutation tối thiểu.
- **SPF cleanup**: sau khi routing READY, nếu zone có ≥2 bản TXT `v=spf1`: hiển thị cảnh báo + nút "Gộp SPF" (owner confirm + passkey `provision.spf-merge`): tạo bản gộp `v=spf1 include:_spf.mx.cloudflare.net <các include cũ> ~all` rồi xoá các bản cũ (mỗi bản ghi event đầy đủ như MX takeover). Từ chối tự động — chỉ gợi ý.

### 2.3. Wizard UI (trong `Domains.tsx`, tái dùng toàn bộ logic sẵn có)

Mỗi row domain có nút **"Thiết lập mail"** mở dialog 4 bước (một cột trạng thái bên trái, hành động bên phải):

1. **Kiểm tra** — gọi `GET /setup`, hiện 3 thẻ: Token / Nhận / Gửi, mỗi thẻ xanh–vàng–đỏ + câu sửa cụ thể (G1 trả lời được "tôi không thể cấu hình" ngay từ đầu).
2. **Nhận mail** — nút `Bật nhận mail` = gọi provision hiện có (đã có enable-before-delete, takeover-confirm + passkey); xong tự chạy lại preflight + DoH probe (G3) và hiện "✅ MX đã nhìn thấy từ internet".
3. **Gửi mail** — nhúng `SendingDialog` hiện có vào bước (preview records → DMARC confirm + passkey → enable → chọn sending-via); kèm checklist item **"Đăng ký sự kiện giao thư cho zone này"** với lệnh copy `./scripts/ops/queues-subscription.sh <zone-id> <domain>` + mô tả vì sao cần (G2).
4. **Xong** — tổng kết trạng thái cuối + đường dẫn probe (A8 nâng cấp: nút "Gửi thư test" nếu có sẵn ≥1 sending domain — tạo alias `setup-probe-<rand>` tự xoá sau verify; nếu chưa có domain gửi thì hiện hướng dẫn gửi thử từ Gmail).

Auto-provision (A3, đã ship) tích hợp: nếu setting bật, bước 2 hiện "đã tự bật khi Sync".

### 2.4. Những gì KHÔNG làm (giữ nguyên triết lý)

- Vẫn **không** mutate zone nào khi tải trang / cron — mọi bước là owner-action rõ ràng (bấm nút trong wizard).
- Vẫn không ghi DMARC/DKIM bằng tay cho sending — Cloudflare API tự ghi đúng (đã đo trên omnipos.tech); wizard chỉ hiện preview.
- Token là secret của owner — wizard chỉ **chỉ ra** thiếu scope, không thể tự sửa (liên kết tới hướng dẫn tạo lại token trong DEPLOYMENT.md).

---

## 3. Triển khai theo lát (mỗi lát 1 PR, CI xanh mới merge — quy trình cũ)

| Lát | Nội dung | Đối chiếu | Độ khó |
|-----|----------|-----------|---------|
| **W1 — Chẩn đoán** | `GET /api/domains/:id/setup` readiness (token probes + nhận + gửi + DoH on-demand + `next[]`) + test unit/integration (stub client đủ các case 403/200) | G1, G3 | M |
| **W2 — Wizard UI** | Dialog 4 bước trong Domains.tsx (tái dùng provision + SendingDialog + withStepUp), i18n vi/en đủ, nút copy lệnh subscription | G2 | M |
| **W3 — DNS writes + SPF** | `createDnsRecord` + fallback A2 hoàn chỉnh + SPF merge (confirm + passkey + events) + test | G4 | M |
| **W4 — Probe e2e (A8)** | Nút "Gửi thư test tới domain này" (dùng sending domain sẵn có, alias tạm tự dọn) + kết quả hiển thị trong wizard; fallback hướng dẫn tay | G3 | S–M |

**Definition of done cả kế hoạch**: một domain mới (đã là zone trong account, token hợp lệ): bấm Sync → bấm "Thiết lập mail" → bước 2 và 3 đều bật được trong ≤2 phút, không rời dashboard, không lệnh tay nào trừ đúng 1 lần copy lệnh queue-subscription (việc account-level Cloudflare chưa có API deploy-side); nếu token thiếu gì, bước 1 nói đúng câu lệnh/dashboard nào cần sửa.

---

## 4. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|---|---|
| Readiness endpoint tốn subrequest (mỗi domain ~6 call CF) | Chỉ gọi on-demand khi mở wizard; cache kết quả 60s trong isolate như rules-cache |
| Token probe gây nhầm lẫn (403 tạm thời) | Phân loại giống watchdog: "unknown is not evidence" — hiện "không đo được" chứ không đỏ |
| SPF gộp sai làm hỏng gửi của provider cũ | Mặc định giữ `~all`, chỉ gộp include (không đổi mechanism/all), hiện diff đầy đủ trước confirm, passkey bắt buộc, event log mỗi bản bị xoá |
| Wizard làm Domains.tsx (984 dòng) phình to | Tách `components/domains/SetupWizard.tsx` — Domains.tsx chỉ giữ nút mở dialog |
| Fallback A2 (tự ghi MX) xung đột priority với MX cũ | Ghi priority thấp hơn (số lớn hơn) MX cũ → sender ưu tiên MX cũ tới khi owner xoá; chỉ xoá sau verify — đúng thứ tự enable-before-delete |

> **Trạng thái 2026-10-25 — W1 + W2 ĐÃ SHIP (PR #33, production 10:29Z).** `GET /api/domains/:id/setup` (chẩn đoán song song: token → nhận → DNS công cộng → gửi → SPF, suy ra `next[]` bằng `buildSetupNext` có 5 unit test) + Wizard "Thiết lập mail" trong menu từng domain (thẻ chẩn đoán có màu; Enable receiving leo thang takeover-tick chỉ khi conflict trả lời; mở SendingDialog sẵn có; copy lệnh queue-subscription; đo lại DNS). **W3 + W4 ĐÃ SHIP (PR #34, production 10:50Z 2026-10-25)** — kế hoạch Wizard hoàn tất trọn vẹn: `mergeSpfRecords` (gộp mechanism thứ nhất-xuất-hiện, giữ all mạnh nhất — 4 unit test) + `POST /api/domains/:id/spf-merge` (confirm + passkey `provision.spf-merge`; tạo → verify → xoá, mỗi bản ghi cũ vào event log) + `createDnsRecord` trong API client (chỉ tạo — xoá vẫn đi đường đã có log). W4/A8: `POST /api/domains/:id/probe` gửi thư thật từ alias domain-gửi đầu tiên tới alias `setup-probe-*` mới trên domain đích; wizard poll `GET …/probe?aliasId=` — thư tới thì worker **tự xoá alias + thư probe** (nghệ thuật chứng minh, không phải kho lưu). Fallback A2-dạng-tự-ghi-MX khi enable từ chối **không cần làm nữa**: enable-before-delete (R1/A2) đã loại kịch bản đó — CF enable thành công cả khi MX foreign còn (đã đo thật trên takeover 2026-09-20).

*Tài liệu này là kế hoạch thực thi cho yêu cầu 2026-10-25; các lát W1–W4 cập nhật trạng thái ngay dưới bảng ở mục 3 khi ship.*
