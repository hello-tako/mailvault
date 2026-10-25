# MailVault — Kế hoạch nâng cấp tính năng toàn diện (2026-10-24)

Mục tiêu theo yêu cầu owner: **tự động cấu hình nhận mail sau khi đồng bộ domain, hoàn thiện gửi mail, nâng tầm đọc/hiển thị và thông báo** — bám sát hạ tầng Cloudflare hiện có (1 Worker, D1, R2, Queues + DLQ, Durable Object hub, Analytics Engine, Vectorize + Workers AI, Email Routing, Email Sending, Access), không thêm dịch vụ bên ngoài.

Phạm vi: khảo sát tính năng đọc code trực tiếp (4 nhóm: provisioning nhận mail, gửi mail, đọc/hiển thị, thông báo) + đối chiếu DEPLOYMENT.md / SECURITY.md / docs/AUDIT-2026-10-24.md + tài liệu Cloudflare Email Service hiện hành. Tài liệu này là kế hoạch **tính năng**; các mục hiệu suất/ops đã có trong audit 2026-10-24 và không lặp lại ở đây.

---

## 1. Tóm tắt điều hành

**Phát hiện quan trọng nhất (điều chỉnh nhận định ban đầu):** pipeline nhận mail **đã tự động hoá ở mức từng domain** — `POST /api/domains/provision` thực hiện đủ: enable Email Routing → đặt catch-all trỏ vào Worker → verify lại (`provisioner.ts:68-233`), và DEPLOYMENT.md:641-647 xác nhận "Adding a domain now needs no dashboard step at all" với zone sạch. Khoảng trống thật khiến owner cảm giác "không tự động được" là:

1. **Mỗi domain vẫn cần owner bấm** — sync xong dừng ở `DISCOVERED`, không có auto-provision zone sạch, không auto-retry domain `FAILED` (chỉ có `/api/domains/:id/retry` thủ công).
2. **Thứ tự provisioning gây outage thật**: MX cũ bị xoá **trước khi** enable (`provisioner.ts:56` trước `:154`); lần 2026-09-20 enable 403 vì Zone Resources khiến 1 domain **mất MX hoàn toàn** (DEPLOYMENT.md:631-639).
3. **Sau provision vẫn phải tạo alias tay** — Worker reject mọi địa chỉ không có alias ACTIVE (`ingest.ts:148-154`), nên "domain READY mà chưa có alias = chưa nhận được mail nào được giữ".
4. **Watchdog chỉ phát hiện drift, không có đường sửa** (watchdog.ts:69, DEPLOYMENT.md:694-696).
5. **Mù registrar/NXDOMAIN** (blind spot D9): domain `loiyeuthuong.org` từng "healthy" trong khi cả thế giới không resolve được MX (DEPLOYMENT.md:118-124).

**Gửi mail**: plumbing đã hoàn chỉnh và có test (kiểm tra chính sách → ghi R2+D1 trước khi gửi → `send_email` → delivery events per-recipient → UI). Cái thiếu là **bề mặt**: không BCC trong UI, chỉ soạn plain-text, không ảnh inline, không forward, không đính kèm lại file từ thư nhận, draft chỉ localStorage, không resend, không hẹn giờ, không cảnh báo bounce — trong khi API/hạ tầng đã hỗ trợ phần lớn (Email Sending cho 25 MiB, `disposition:"inline"` + `cid:`, Queues `delaySeconds` tới 24h).

**Đọc/hiển thị**: nền tốt hơn "sơ khai" (threading, OTP copy 1 chạm, sandbox iframe, search operators, semantic opt-in), nhưng thiếu những gì làm mailbox "thật": tìm nội dung thư (FTS body — T1 còn nợ), ảnh inline `cid:`, dark mode cho HTML, gấp quote, nhóm theo ngày, preview đính kèm, thao tác mobile.

**Thông báo**: đúng nguyên tắc payload-free nhưng cực kỳ tối giản: push cho mọi thư (rules không chặn push), không mute alias/domain, không quiet hours/digest (T4 còn nợ), notification không có nút hành động, không quản lý thiết bị, bounce gửi không báo gì.

**Kế hoạch** chia 5 chương (A nhận mail, B gửi mail, C đọc/hiển thị, D thông báo, E nền tảng) xếp vào 5 release R1–R5. Mọi thay đổi giữ nguyên các nguyên tắc làm nên MailVault: ingest 2 pha, mail là input thù địch, không gì tự hết hạn, push payload-free + chỉ quote sender TRUSTED, mutation Cloudflare chỉ khi owner hành động (mở khoá có kiểm soát cho auto-provision zone sạch — xem A3).

---

## 2. Hiện trạng chi tiết (tóm tắt khảo sát, kèm dẫn chứng)

### 2.1. Nhận mail — provisioning

State machine domain (`shared/enums.ts:7-16`): `DISCOVERED → PREFLIGHT/CONFLICT → PROVISIONING → VERIFYING → READY | FAILED` (+`DISABLED` định nghĩa nhưng không bao giờ dùng).

CF API đã wrap (`cf/api-client.ts`): list zones, list/delete DNS records, GET email routing settings (403 với API token — suy trạng thái từ MX `route*.mx.cloudflare.net`, `preflight.ts:57-67`), **POST /email/routing/enable** (`:204`), GET/PUT **catch-all rule → worker** (`:208-226`), sending subdomains preview/list/enable (`:228-245`). Chưa wrap: tạo/sửa DNS record, rule thường (chỉ có catch-all), destination addresses, disable.

Bước provision hiện tại (`provisioner.ts:68-233`): denylist → preflight → (nếu confirm) **xoá MX foreign** → enable routing → đặt catch-all → verify → READY. Gate an toàn tốt: zone phải active+full, token không thấy zone thì không được đổi zone, conflict MX/catch-all phải owner tick confirm.

Hàng rào cứng: `DOMAIN_DENYLIST` (4 domain), reject alias không biết (`ingest.ts:148-154`, "never auto-created §11"), auth policy REJECT cho spoofed sender.

### 2.2. Gửi mail

Flow (`mail/send.ts`): From phải là alias ACTIVE + domain `sendingStatus=ENABLED` → validate recipients (≤50) → budget 50/ngày (UTC) → build MIME (`mime.ts`, multipart/alternative, base64 UTF-8, RFC2047 headers) → **ghi R2 + D1 row `sendStatus=Queued` TRƯỚC khi gửi** → `EMAIL.send()` → queue `mail-delivery-events` cập nhật 8 trạng thái per-recipient (`delivery.ts`, upsert không bao giờ lùi cấp `db/recipients.ts:20-85`). Reply suy From/To từ row lưu, không tin client; từ chối trả lời thư spoofed.

Onboarding gửi per-domain đã trong app: preview DNS → DMARC confirm (+passkey step-up khi takeover `_dmarc`) → enable (CF tự ghi `cf-bounce.<name>` MX/SPF/DKIM + `_dmarc p=reject`) → chọn sending-via subdomain (`routes/sending.ts`).

Khoảng trống (dẫn chứng mục 3, chương B).

### 2.3. Đọc/hiển thị

Có: two-pane ≥900px + mobile tab; tabs all/unread/starred/filed/sent; threading window-function + thread pane; chọn nhiều + shift-range + bulk; cursor pagination PAGE=50; OTP chip copy từ list row; HTML sanitize server → iframe `sandbox=""`; remote images chặn mặc định; unsubscribe 1-click chỉ cho TRUSTED; delivery report per-recipient; search operators + FTS(subject/preview/sender) + semantic opt-in; ⌘K palette; j/k/e/c/r/x/s/u; vi/en; PWA + badge.

Thiếu (chi tiết mục 3, chương C): FTS body, ảnh `cid:`, dark-mode HTML, gấp quote, nhóm ngày, preview/icon attachment, swipe mobile, panes resize, full headers, print, lightbox, .ics/vCard/winmail.dat, block sender 1 chạm, snippet highlight, search trong thread.

### 2.4. Thông báo

4 kênh, tất cả từ 1 trigger (`index.ts:172-180`, sau khi mail durable): (1) Web Push payload-free tới **mọi** subscription (`push.ts:151-219`); (2) SW fetch `/api/messages?filter=unread` rồi hiện sender+subject — chỉ TRUSTED, chỉ trong 5 phút gần nhất, OTP bị che, URL thành `[link]` (`sw.js:119-149`); (3) DO nudge `{type:"new-mail"}` không nội dung (`hub.ts:34-37`); (4) toast đếm + refetch + badge (chỉ set khi Inbox mounted, `Inbox.tsx:77-86`).

Bất biến phải giữ (SECURITY.md §8.1): push không payload; chỉ quote TRUSTED; endpoint là bearer credential (không bao giờ trả về); push không bao giờ làm hỏng delivery; không nội dung thư qua websocket; SW không cache `/api/*`.

Khoảng trống: không mute (rule archive vẫn push), không quiet hours/digest, không notification actions, không grouping (N thư = N notification), quản lý thiết bị chỉ là con số, bounce không báo, ops-alert hẹp (2 pipeline), badge không clear khi rời Inbox.

---

## 3. Kế hoạch chi tiết

Quy ước độ khó: **S** ≤ 1–2 ngày, **M** 3–5 ngày, **L** 1–2 tuần. Mỗi mục ghi: việc làm — cách bám hạ tầng —(rủi ro).

### Chương A — Nhận mail tự động trọn vẹn (đóng pain #1 của owner)

| # | Việc | Chi tiết & bám hạ tầng | Độ khó |
|---|------|------------------------|--------|
| **A1** | **Wizard "Add domain → nhận mail" một chạm** | Gộp sync → preflight → provision → verify thành 1 flow trong UI Domains: nhập/chọn zone → hiện đúng những gì sẽ xảy ra (bao gồm cảnh báo conflict) → 1 nút "Enable mail". Thêm nút **"Enable all clean zones"** (chỉ những zone `READY_TO_PROVISION`, gọi `provisionMany` sẵn có — `routes/domains.ts:68-89` đã nhận `zoneIds[]`). Sau READY, wizard gợi ý tạo alias đầu tiên (A9) và chạy probe (A8). | M |
| **A2** | **Đảo thứ tự an toàn: enable TRƯỚC, xoá MX foreign SAU** | Sửa `provisioner.ts` cho MX-takeover: (1) `enableEmailRouting` khi MX cũ còn nguyên (CF thêm MX `route*.mx.cloudflare.net` cạnh MX cũ — mail vẫn chảy về provider cũ, không có cửa sổ đen); (2) verify catch-all + MX CF xuất hiện; (3) chỉ khi cả hai chắc chắn mới xoá MX foreign bằng danh sách preflight đã chốt. Enable fail → **không xoá gì**, domain giữ nguyên đường mail cũ + event `provision:enable_refused`. Đây là fix trực tiếp cho outage 2026-09-20 (DEPLOYMENT.md:631-639). Cần đo thử trên 1 zone test xem `/email/routing/enable` có chấp nhận MX foreign hiện hữu không; nếu CF từ chối → fallback: wrap `POST /zones/:id/dns_records` (A5) tự tạo MX CF đúng priority, verify, rồi mới xoá MX cũ. Kèm integration test dựng lại cả 2 kịch bản. | M |
| **A3** | **Auto-provision có guardrail (opt-in)** | Setting mới trong Settings: "Tự động bật mail cho zone sạch mới sync". Khi bật: sau `POST /api/domains/sync` (hoặc trong cron watchdog), mọi zone mới có classification `READY_TO_PROVISION` (không conflict, active, full, không denylist) được provision tự động — **tái dùng nguyên `provisionDomain`, không thêm quyền nào**. Mọi zone conflicting vẫn chờ owner. Ghi `provisioning_events` bình thường để audit. Kèm **auto-retry** cho `FAILED` do lỗi tạm thời (mạng/5xx): tối đa 2 lần, backoff 1h/6h, không retry với permission/auth (đó là việc của owner). | M |
| **A4** | **Watchdog v2: phát hiện + nút Repair (auto-repair sau đó)** | Giữ nguyên "không tự chữa" mặc định. Khi DRIFT: ngoài event hiện có, tạo "repair suggestion" hiển thị ở Domains — nút **Repair** chạy lại đúng `enableEmailRouting` + `setCatchAllWorker` (không đụng DNS ngoài 2 việc này, không takeover MX). Phase sau (opt-in riêng): auto-repair **chỉ với zone mà `provisioning_events` chứng minh MailVault từng tự cấu hình** (`provision:ready` trong lịch sử) và catch-all hiện tại là worker khác — vẫn ghi event `watchdog:repaired`. Zone bị người khác chiếm catch-all → luôn chờ owner. | M |
| **A5** | **Wrap DNS write (`POST/PUT /zones/:id/dns_records`)** | Cần cho fallback A2 và cho dọn dẹp sau-enable: phát hiện ≥2 TXT SPF trên apex (enable routing không xoá SPF cũ — DEPLOYMENT.md:111-112) → cảnh báo trong preflight + đề nghị gộp/xoá (owner confirm, có snapshot record trước khi xoá như MX). Token runtime đã có scope DNS:Edit (dùng cho sending enable — DEPLOYMENT.md:252-255). | M |
| **A6** | **MX probe từ ngoài qua DoH — vá blind spot registrar** | Watchdog hàng giờ thêm 1 bước cho domain READY: `fetch https://cloudflare-dns.com/dns-query?name=<domain>&type=MX` (JSON DoH, subrequest thường, không quyền mới). MX không resolve ngoài cộng đồng → status `CONFLICT/DNS_UNRESOLVABLE` + alert (D7) — đúng kịch bản `loiyeuthuong.org` (DEPLOYMENT.md:118-124). Rate: chỉ probe domain READY, 1 lần/giờ, cache theo TTL. | S |
| **A7** | **Chế độ nhận per-domain: `STRICT` (mặc định) \| `CATCH_REVIEW` (opt-in)** | STRICT = hiện tại (reject địa chỉ không có alias). CATCH_REVIEW = mail tới địa chỉ chưa có alias được ingest bình thường nhưng đánh dấu `unclaimed=1` (cột mới + index), hiện trong tab riêng "Unclaimed" ở Aliases; owner bấm **Claim** (tạo alias, giữ nguyên thư vào kho) hoặc **Discard** (xoá R2+D1, có confirm). Không auto-create alias — giữ §11 SECURITY.md; "nothing auto-expires" giữ nguyên (Unclaimed không tự xoá). Chống spam bucket: rate-limit unclaimed per domain (mặc định 200/ngày — vượt thì tự tạm về STRICT + alert; spoofed vẫn dán verdict như thường). **Cần owner chốt chính sách trước khi làm (mục 5).** | L |
| **A8** | **Probe end-to-end sau provision** | Khi có ≥1 domain sending-enabled: sau READY, tự gửi probe từ alias sending tới `mailvault-probe-<rand>@<domain-mới>` (alias hệ thống tạo kèm, hiển thị rõ ràng là probe); consumer ingest nhận ra prefix → validate đường mail sống thật, hiện kết quả "✅ thư test đã tới sau Ns" trong wizard + event `provision:probe_ok`. Không có sending domain → wizard hiện hướng dẫn gửi thử thủ công. Probe message là mail thật trong kho (đúng triết lý), owner có thể xoá. | M |
| **A9** | **Gợi ý alias khởi tạo trong wizard** | Bước cuối wizard: checkbox tạo nhanh vài alias (`hello@`, `admin@`, random) — chỉ là UI wrap `POST /api/aliases` sẵn có, default không tick alias nào. | S |

### Chương B — Gửi mail hoàn thiện (Compose v2)

| # | Việc | Chi tiết & bám hạ tầng | Độ khó |
|---|------|------------------------|--------|
| **B1** | **Composer đầy đủ trường** | Thêm **BCC** (API + pipeline đã hỗ trợ đầy đủ: `shared/send.ts:71`, `send.ts:186-195` — chỉ thiếu input `Composer.tsx:389-394`); CC + sửa subject khi reply; **fromName** (API có `send.ts` shared:76); signature per alias (lưu ở alias notes/settings, chèn vào body). | S–M |
| **B2** | **Soạn HTML (markdown → HTML)** | Body soạn plain-text + markdown tối giản (bold/italic/code/link/list/quote). Worker sinh HTML từ markdown với **allowlist chính là `sanitize-html.ts` hiện có** (xuất qua sanitizer để đảm bảo cái gì ra điện cũng sạch như cái gì vào), ghép `multipart/alternative` sẵn có (`mime.ts:150-158`). Preview phía client render qua cùng规则 sandbox iframe. Không kéo editor nặng (contenteditable + Sanitizer DOMPurify-style tự viết hoặc textarea+preview là đủ cho personal mail). | M |
| **B3** | **Ảnh inline (`cid:`)** | Email Sending hỗ trợ sẵn `disposition:"inline"` + `contentId` + `<img src="cid:...">` (tài liệu CF hiện hành); app đang truyền `disposition:"attachment"`, `contentId:null` (`send.ts:280,339`). Composer nhận paste/drag ảnh → upload như attachment inline + chèn `cid:` vào markdown/HTML. Cần C2 (hiển thị cid: khi đọc) để khép vòng. | M |
| **B4** | **Forward + đính kèm lại từ thư nhận** | `POST /api/messages/:id/forward` (mới): từ alias owner chọn, body intro + tuỳ chọn (a) đính `.eml` gốc dưới dạng `message/rfc822` attachment (đọc `raw_r2_key` sẵn có), hoặc (b) inline nội dung (quote text). Trong reply/forward: **"Attach from this message"** — chọn attachment có sẵn, worker copy object R2 sang message mới (không qua client — tiết kiệm bandwidth, tránh giới hạn body request). | M |
| **B5** | **Server-side drafts** | Migration `drafts`: id, owner, alias_id, thread_root_id?, reply_to_message_id?, to/cc/bcc/subject/text, attachments (giữ file ở prefix R2 `drafts/`), created/updated_at, deleted_at. Routes CRUD `/api/drafts(/:id)`; Composer autosave debounce 2s lên server (hạ localStorage xuống cache/migrate 1 lần); reply cũng autosave (hiện chỉ compose mới, `Composer.tsx:256`); list "Drafts" trong UI + đếm badge; multi-device sync tự nhiên. | M |
| **B6** | **Resend / Retry gửi fail** | Nút **Resend** trên message OUT ở trạng thái FAILED/BOUNCED/REJECTED/SUPPRESSED (`DeliveryReport.tsx` + MessageDetail): tạo message mới kế thừa nội dung + attachments (copy R2), giữ thread root, respect daily budget + confirm. Không "re-send same id" — mail gửi là mail (row mới, đúng mô hình hiện tại). | S |
| **B7** | **Hẹn giờ gửi + Undo send** | `scheduled_sends` (D1) + producer queue mới `mail-send-scheduler` với `delaySeconds` 0–86400 (Queues hỗ trợ tới 24h — docs CF): compose "Send now / Send in N phút / Send at HH:mm (≤24h)". Message row `sendStatus=SCHEDULED`, consumer gọi đúng `sendOutbound` path hiện tại. **Undo** = default delay 10s cho "Send now" — nút Undo hiện trong 10s, cancel = xoá job + row. Scheduled list + edit trong Outbox UI. | M |
| **B8** | **Sửa lệch & nâng limit** | (a) Nâng `SEND_LIMITS.maxTotalBytes` 5 MiB → **15 MiB** assembled (CF cho 25 MiB — docs Email Sending; inbound đang 20 MiB — giảm bất đối xứng); theo dõi CPU/JSON parse, nếu tốn thì chuyển upload attachment qua endpoint riêng (R2 presign-style qua worker). (b) Fix `maxlength` subject UI 200 → 998 (`Composer.tsx:397`). (c) **Validate + encode `replyTo`** (CRLF injection vào .eml lưu — `send.ts:182`, `mime.ts:135`; cho qua `splitAddress` như mọi recipient). (d) **Sanitize HTML outbound lúc write** cho đúng comment schema (`shared/send.ts:74-75` hứa nhưng chưa làm). (e) **Ops-alert đi qua pipeline**: tạo message OUT hệ thống (tag `OPS`) để có D1 row + R2 copy, vẫn gửi qua binding; không tính budget thường (đếm riêng). | S–M |
| **B9** | **Bounce/failure notification** | Trong `consumeDeliveryEvents`: khi message OUT chuyển sang terminal-failure (BOUNCED/REJECTED/FAILED/SUPPRESSED toàn bộ hoặc từng recipient) → push payload-free (reuse `pushToAll` với reason `send-failed` — SW hiển thị "A message failed to deliver") + DO nudge `{type:"send-failed"}` → toast trong app mở thẳng message. Giữ payload-free: SW fetch `/api/messages?is:send-failed` mới. | S |
| **B10** | **Contact book (tuỳ chọn, cuối roadmap)** | Bảng `contacts` (address, name, note, last_seen_at); UI quản lý + "Save contact" từ reader; autocomplete ưu tiên contacts trước correspondents. Import/export JSON giống alias (T6 sẵn có). | M |

### Chương C — Đọc & hiển thị (Reader v2)

| # | Việc | Chi tiết & bám hạ tầng | Độ khó |
|---|------|------------------------|--------|
| **C1** | **FTS nội dung thư (T1 audit)** | Migration: thêm cột body (text thuần truncate ~10 KB) vào `messages_fts` (mô hình migration 0003); ingest ghi thêm khi commit (text đã có trong parsed R2); **backfill** chạy trong cron watchdog (500 message/lần theo `app_settings` progress — không blocker, xong khi xong); Settings switch (khuyến nghị default ON — D1 là kho riêng đã authenticated, có tiền lệ opt-in semantic). Kèm **snippet highlight**: FTS trả matchinfo → highlight trong preview row khi search. | M–L |
| **C2** | **Hiển thị ảnh inline `cid:`** | Data đã sẵn: `attachments.content_id` (0001:80) + sanitizer giữ `<img>` nhưng đang drop `cid:` (`sanitize-html.ts:57-61`). Worker khi build HTML cho detail: thay `src="cid:X"` bằng URL attachment xác thực cùng origin; iframe render qua blob (app fetch authenticated → objectURL → postMessage vào iframe / render trực tiếp trong MessageHtml flow). Ảnh remote vẫn chặn mặc định — chỉ cid (nội dung local, không tracking pixel). Kèm **lightbox** trong app cho cid/attachment ảnh. | M |
| **C3** | **Dark mode cho HTML mail** | Iframe đang ép `color-scheme:light` + nền trắng (`MessageHtml.tsx:31-32`). Thêm setting "Email appearance: Light / Smart dark / Invert": inject CSS vào doc iframe (filter invert + hue-rotate cho phần tử có nền sáng — kỹ thuật gmail-style; giữ ảnh không invert). Default Light để trung thành rendering. | S–M |
| **C4** | **Gấp quote trả lời** | TextBody: nhận block `>` liên tục + dòng "On … wrote:" → render thành `<details>`-style fold "⋯ Quoted reply (N dòng)" mở được (làm trong `TextBody.tsx` — dữ liệu đã tách block). HTML: sanitizer đánh dấu đoạn Gmail-quote (`div.gmail_quote` / blockquote) → tách HTML tại điểm quote, phần sau render trong component `Fold` (ngoài iframe, đã sanitize) — không cần script trong iframe. | M |
| **C5** | **Vệ sinh list & điều hướng** | (a) Header nhóm ngày Today/Yesterday/This week/older (client-side từ list items); (b) jump-to-first-unread khi vào inbox; (c) **Mark all read per mailbox** (route mới `POST /api/messages/mark-all-read` với filter, có confirm); (d) overlay **`?` = shortcuts help**; (e) **per-sender remote-image allowlist**: bảng nhỏ `sender_consents` (owner, sender_domain, allow_images) — khi đọc thư từ sender đã allow thì `remoteImages` mặc định on (server check khi build detail); nút "Always load images from this sender" khi bật tay. | S–M |
| **C6** | **Mobile: swipe + pull-to-refresh; density + zoom** | Swipe trái = archive, phải = mark read (+star tuỳ cài đặt) trên MessageRow mobile (pointer events, ngưỡng 64px, không ăn theo scroll dọc); pull-to-refresh khi scroll-top. Density list compact/cozy (Settings); text zoom body 3 mức (font-size root iframe). | M |
| **C7** | **Full headers + print** | Panel "Original headers" trong ⋯ menu: worker trả headers thô (đã parse từ postal-mime/R2 raw — cần lưu/đọc lại header section), fold mặc định, highlight `Authentication-Results`, `Received` chain rút gọn. Print stylesheet cho MessageDetail (in body sạch + metadata). | S |
| **C8** | **Thread xếp chồng + reply-all** | Thread pane (`MessageDetail.tsx:450-469`) nâng cấp: mỗi entry load-in-place nội dung khi mở (lazy `GET /api/messages/:id`), hiện đủ body/attachments từng message; nút Reply / **Reply-All** (điền To = all participants trừ mình, CC giữ) / Forward (B4) ngay trên entry. | M |
| **C9** | **Định dạng đặc biệt** | `.ics`: parse VEVENT cơ bản (summary/time/location) hiển thị thẻ lịch trong reader + nút tải lại file; `.vcf`: hiện tên/tổ chức + "Save contact" (tải .vcf); `winmail.dat`: decode TNEF (thư viện nhỏ hoặc parser tự viết extract attachments). Mức ưu tiên thấp nhất trong chương. | M |
| **C10** | **Block sender 1 chạm** | Nút trong reader "Block this sender" → tạo rule (sender match → tag `Blocked` + archive) qua API rules sẵn có — đúng triết lý "rules organise, never delete"; Settings/doi diện list rules có nhãn Blocked + nút Unblock. | S |
| **C11** | **Dịch thư (opt-in)** | Nút "Translate" trong reader (vi↔en + auto-detect) dùng binding **AI sẵn có** (cùng mô hình opt-in như semantic); read-time only, không lưu, hiển thị song song dưới body; Settings off mặc định + giải thích tradeoff (nội dung thư gửi tới Workers AI trong cùng account). | S–M |
| **C12** | **Search nâng cao** | Phrase `"..."` (FTS5 phrase syntax tự nhiên có sẵn khi không re-split — sửa `ftsMatch` `db/messages.ts:308-316`), operator `subject:`, `has:image|pdf` (JOIN attachments), search-in-thread (khi mở thread, filter q trong thread items); snippet từ C1. | M |
| **C13** | **Panels resize** | Kéo divider hai pane (desktop) — lưu width vào localStorage; mobile không đổi. | S |

### Chương D — Thông báo (Notify v2)

| # | Việc | Chi tiết & bám hạ tầng | Độ khó |
|---|------|------------------------|--------|
| **D1** | **Notification rules: mute theo alias / domain / sender** | Migration `notification_prefs` (owner, scope: `alias|domain|sender_domain`, value, action: `all|mute|digest`); **áp tại commit ingest** (`index.ts:172-180` trước khi `pushToAll` — query prefs theo recipient alias + sender domain, cache isolate TTL 60s như rules): mail bị rule archive hoặc mute → không push, không toast, vẫn nudge refetch im lặng (list tự cập nhật). UI: "Mute notifications" trong AliasDetail; "Mute this sender" trong reader. | M |
| **D2** | **Quiet hours + digest (T4 audit)** | Settings quiet hours (vd 22:00–07:00, timezone browser → lưu UTC offset). Mail tới trong quiet hours: bỏ qua push realtime, đánh dấu `digest_pending=1` (cột hoặc query theo received_at + last_digest_at). Cron mới `"2 * * * *"`: nếu đang/just-kết-thúc quiet hours và có pending → **1 push bodyless tổng hợp** (SW fetch unread và hiển thị "N new messages" — không gì vượt ra ngoài nguyên tắc) + tuỳ chọn email digest qua `send_email` (nội dung: chỉ đếm + danh sách TRUSTED senders/subjects, cùng quy tắc che như push). Tùy chọn "Digest hàng giờ" cho ai nhận mail máy nhiều (chế độ standalone). | M |
| **D3** | **Notification actions + grouping** | `sw.js` `showNotification` thêm `actions: [{action:"read",title:Mark read},{action:"archive",title:Archive}]` — handler `notificationclick` phân biệt `event.action`, fetch `POST /api/messages/:id/read` / bulk archive với header CSRF chuẩn (SW same-origin, giữ được header `x-mailvault`). Grouping: tag chung `mailvault-new-mail` + `renotify:true` + `data.count` (N thư mới gộp 1 notification, click → inbox); TRUSTED có code vẫn hiện riêng tag per-message để không đè. Test cả Chrome + Safari (hỗ trợ actions khác nhau — degrade sạch). | M |
| **D4** | **Quản lý thiết bị push** | Routes: `GET /api/push/devices` (id, UA rút gọn, last_ok_at, fails, label), `PATCH /api/push/devices/:id` (đặt tên), `DELETE /api/push/devices/:id` (thu hồi — dùng khi mất máy). Settings hiện danh sách thay vì con số (`Settings.tsx:354-357`), kèm cảnh báo endpoint ≥5 fails. Endpoint vẫn không bao giờ rời D1. | S |
| **D5** | **"Since you left" panel** | Không cần bảng mới: App ghi `last_visit` (app_settings); khi mở lại và có unread nhận sau last_visit → toast mở rộng "3 new since you left — from A, B (TRUSTED only)" bấm vào filter `is:unread after:last_visit`. Nội dung chỉ hiện TRUSTED, cùng quy tắc sw.js. | S |
| **D6** | **Urgency/TTL theo tuỳ chọn** | `push.ts` thêm `Urgency: high` cho mail TRUSTED có OTP code (giảm trễ hệ thống — ghi chú code hiện có: bỏ `low` vì trễ phút; `high` an toàn), TTL chọn 1h/6h/24h trong Settings; test push đi cùng cấu hình thật. | S |
| **D7** | **Ops-alert mở rộng** | Dùng đường `ops-alert.ts` sẵn: thêm kinds `watchdog-drift` (DRIFT mới + DNS_UNRESOLVABLE từ A6), `dlq-depth` (nếu chưa có — audit 0.5 đã wire DLQ alert, verify lại), `send-quota-80%`. Nhận viên vẫn `allowedEmails[0]`, không lưu nội dung. | S |
| **D8** | **Badge hygiene** | Chuyển set/clear badge lên App level (theo counters global sau mọi reload + nudge), không chỉ khi Inbox mounted (`Inbox.tsx:77-86`); clear khi unread=0; DO hub trả lời ping (`hub.ts:44-46` đang no-op dù comment nói "replies" — ping/pong chuẩn giúp phát hiện socket chết). | S |

### Chương E — Nền tảng (cross-cutting, làm song song mỗi release)

- **E1 Migrations**: `0015_notification_prefs.sql`, `0016_drafts.sql`, `0017_scheduled_sends.sql`, `0018_sender_consents.sql`, `0019_fts_body.sql`, `0020_unclaimed.sql`… (đúng văn hoá 1-mục-tiên-1-migration, CI áp tự động từ Phase 0.4).
- **E2 Test strategy**: mỗi mục giữ chuẩn repo — unit (zod + logic), integration Miniflare (D1/R2/queue thật), E2E Playwright (wizard provision, compose BCC/rich, digest, notification actions qua SW test). **Bất biến có test bắt buộc**: payload-free push (test hiện có mở rộng cho digest/send-failed), không mutation Cloudflare ngoài owner-action (test auto-provision chỉ chạy với clean zone + setting on), reject unknown alias giữ nguyên ở STRICT.
- **E3 Metrics**: AE events mới `digest_sent`, `notify_muted`, `forward_used`, `probe_ok/failed`, `auto_provision` — chỉ count/duration, không message id (đúng schema metrics.ts).
- **E4 Docs**: DEPLOYMENT.md thêm mục "Receiving v2" (thứ tự enable-before-delete, auto-provision setting) + "Compose v2"; SECURITY.md bổ chính sách CATCH_REVIEW + notification prefs (threat model: spam bucket, mute không ảnh hưởng storage).

---

## 4. Roadmap theo release

Nguyên tắc: **safety trước — pain của owner trước — nền có test trước mặt rộng**. Mỗi release ship độc lập, CI verify + deploy hiện hành giữ nguyên vai trò gate.

### R1 — "Nhận mail trọn vẹn" (tuần 1–2) — giải quyết pain #1

> **Trạng thái 2026-10-25 — ĐÃ SHIP (PR #23, production e68ee87b).** Đủ: A2 (enable-before-delete + event `provision:enable_refused` + 3 test), A6 (probe DoH + `DNS_UNRESOLVABLE` + 4 test), A3 (setting + API + hook sync + toggle Settings, default OFF), B8 (limit 5→15 MiB, replyTo validate, sanitize HTML lúc write, subject UI 998), D8 (badge App-level, hub ping→pong). A1 không cần làm — UI chọn nhiều zone → Preflight → Enable đã có sẵn. Còn của R1: A8 (probe e2e sau provision) và A9 (gợi ý alias trong wizard) — chuyển sang làm đầu R2.

Thứ tự trong release: **A2 (đảo thứ tự an toàn — fix rủi ro trước)** → A1 (wizard + bulk enable) → A6 (DoH probe) → A3 (auto-provision opt-in) → A9 → B8 (các fix nhỏ replyTo/subject/limit/sanitize/ops-alert pipeline) → D8 (badge hygiene) → A8 (probe e2e — cần domain sending đã onboard).

**Definition of done**: thêm domain mới (zone sạch) từ lúc bấm sync tới thư test đầu tiên tới inbox **≤ 2 phút, 0 thao tác dashboard**; enable fail không bao giờ để domain mất MX (test dựng lại kịch bản 2026-09-20); domain expired registrar bị watchdog đỏ trong ≤ 1 giờ; E2E wizard xanh.

### R2 — "Gửi mail hoàn thiện" (tuần 3–4)

> **Lát 2 ĐÃ SHIP (PR #25, 2026-10-25).** Forward (More menu + phím `f`, `POST /api/messages/:id/forward`: intro của owner + bản gốc đính `message/rfc822` hoặc trích text server-side; checkbox "Attach the original (.eml)") và markdown→HTML server-side (`src/mail/markdown.ts` — bold/em/code/list/quote→blockquote/link https; HTML alternative qua sanitizer chung, plain text nguyên văn). Test: worker 491 (+11), web 116, E2E 66 (+1 forward tự dọn dữ liệu).

> **Trạng thái 2026-10-25 — lát đầu ĐÃ SHIP (PR #24).** B1 (BCC trong compose; reply thêm CC + sửa subject prefilled + fromName cả hai chế độ — API đã hỗ trợ từ trước, chỉ UI chưa lộ), B5 (nút "Send it again" cho send terminal-fail: `POST /api/messages/:id/resend`, worker đọc lại body/file từ R2, row mới cùng thread, lần hỏng giữ làm lịch sử), B9-lite (delivery event khiến send fail terminal → nudge `{type:"send-failed"}` qua hub → toast "không gửi được" + lối tắt Sent; push cho bounce để ở R4 theo nguyên tắc payload-free). Test: worker 480 (+6), web 116, E2E 65. Còn của R2: không còn gì — attach-from-mail (B2refs), B6 scheduled/undo, B10 contacts ĐÃ SHIP (PR #30).

B1 → B5 (resend) → B4 (forward + attach-from-mail) → B9 (bounce notify) → B2 (markdown→HTML) → B3 (inline images — sau khi C2 xong hoặc tạm chỉ gửi) → B6 (scheduled + undo).

**Definition of done**: soạn thư có BCC/HTML/ảnh inline/forward/resend/hẹn giờ; không còn đường mất draft (server drafts ở R2 nếu kịp, không thì đầu R3); bounce tạo notification trong ≤ 5 phút; 47 send test hiện có + test mới xanh.

### R3 — "Đọc như mailbox thật" (tuần 5–6)

> **Trạng thái 2026-10-25 — 2 lát ĐÃ SHIP.** C1 FTS nội dung thư (PR #26: migration 0022 cột body cap 20k ký tự, mọi writer ghi body, cron backfill từ R2 mỗi giờ 800 thư tới khi xong — switch `ftsBodyBackfill` trong app_settings) và D1 mute (PR #26: migration 0023, gate tại consumer sau commit chỉ chặn ping/toast/nudge, menu "Mute this sender" + nút alias). C4 + C5 (PR #27): separator ngày (mobile gọn để giữ contract "mail bắt đầu gần đỉnh"), gấp quote trong TextBody, "Mark all read" theo đúng filter của list (`POST /api/messages/read-all`), overlay `?` liệt kê toàn bộ phím tắt. Và **B4 server drafts + C3 dark-mode HTML + D4 quản lý thiết bị push ĐÃ SHIP (PR #29, 2026-10-25)**: draft lưu vault theo slot (compose / reply-<id>), hydrate trước khi gõ, autosave debounced, gửi/xoá sạch slot; khung email theo theme graphite (invert trang + re-invert ảnh, không script/network); Settings liệt kê thiết bị push theo tên + tình trạng giao + thu hồi theo id (endpoint không bao giờ rời server). Và **C2+B3 ảnh inline ĐÃ SHIP (PR #28, 2026-10-25)**: composer chèn ảnh tại con trỏ dưới dạng `![](cid:…)` (checkbox chuyển lại thành đính kèm thường), wire đi đúng phần MIME inline + Content-ID; đọc resolver phía server đổi cid → data URL từ chính attachment trong R2 (không network — ảnh remote vẫn chặn; thiếu/quá 512KB/4MB thì bỏ thẻ chứ không hiện khung vỡ; ảnh có nút View mở tab mới). Test lần lượt: 495/116/66. Còn của R3: không còn gì (trừ winmail.dat/TNEF chủ động bỏ — ghi rõ ở bảng quyết định). C9 ics/vCard, C10 block, C11 translate, C12 phrase/subject:/has:, C13 panes, C6/C7/C8 — ĐÃ SHIP (PR #31). Còn của D: không còn gì — D2 quiet hours+digest, D3 actions+grouping, D5, D6 urgency/TTL, D7 ĐÃ SHIP (PR #32); D1/D4/D8 ship trước đó.

C1 (FTS body + backfill) → C2 (cid images + lightbox) → C4 (quote folding) → C5 (date groups, mark-all-read, `?`, per-sender images) → C8 (thread stacked + reply-all) → C6 (swipe/density/zoom) → C3 (dark HTML) → C7 (headers + print) → C13.

**Definition of done**: tìm thấy thư theo nội dung body (p95 ≤ 300ms @50k sau backfill); mail newsletter nhiều ảnh renders đầy đủ inline; thread đọc không phải rời màn hình; E2E 412px cho swipe + fold xanh.

### R4 — "Thông báo thông minh" (tuần 7–8)

D1 (mute rules) → D2 (quiet hours + digest) → D3 (actions + grouping) → D4 (device management) → D5 → D6 → D7.

**Definition of done**: mail bị mute không bao giờ push (test); quiet hours chỉ nhận 1 digest push khi kết thúc; notification có nút Mark read/Archive hoạt động Chrome + Safari; thiết bị mất có thể thu hồi từ UI; mọi test payload-free vẫn xanh.

### R5 — "Mở rộng có điều kiện" (tuần 9+)

A7 (CATCH_REVIEW — **sau khi owner chốt mục 5**) → A4-phase2 (auto-repair DRIFT có giới hạn) → C9 (.ics/vCard/winmail) → C11 (translate) → C12 (search phrase/subject:/has:) → B10 (contacts) → T8 audit (bulk-mail heuristic) → C virtualization nếu thêm infinite scroll.

---

## 5. Quyết định owner cần chốt (trước release tương ứng)

| # | Quyết định | Khuyến nghị | Release |
|---|-----------|-------------|---------|
| 1 | Auto-provision zone sạch mặc định ON hay OFF? | OFF mặc định, ON sau 1 tuần chạy thủ công ổn | R1 |
| 2 | Nâng limit gửi 5 → 15 MiB? | Có (CF cap 25 MiB; giữ cảnh báo size trong UI) | R1 |
| 3 | FTS body default ON? | ON (D1 đã authenticated; semantic vẫn opt-in vì sao chép ra ngoài D1) | R3 |
| 4 | CATCH_REVIEW nhận địa chỉ unknown? | Làm ở R5, opt-in per domain, rate-limit 200/ngày | R5 |
| 5 | Auto-repair DRIFT? | Chỉ manual Repair button ở R1–R4; auto sau khi Repair chạy ổn 2 tuần | R5 |
| 6 | Digest thêm kênh email (send_email) hay chỉ push? | Push-only trước; email digest nếu push hay bị hệ điều hành dập | R4 |
| 7 | Translate (Workers AI) opt-in? | Để cuối, giải thích tradeoff rõ trong Settings | R5 |

---

## 6. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|--------|-----------|
| `/email/routing/enable` có thể từ chối khi MX foreign còn (A2) | Đo thử trên 1 zone test trước khi sửa thứ tự; fallback tạo MX CF qua DNS write rồi mới xoá cũ; giữ path cũ sau feature flag 1 release |
| Auto-provision vùng xám (zone "sạch" nhưng chủ định không muốn mail) | Chỉ classification READY_TO_PROVISION + setting opt-in + event audit từng zone + nút undo (forget domain không xoá zone) |
| CATCH_REVIEW thành thùng spam backscatter | Rate-limit per domain, vượt thì tự về STRICT + alert; verdict spoof vẫn dán; không auto-expire nhưng có nút bulk discard |
| FTS backfill tăng D1 rows written (cost) | Batch 500/lần trong cron đêm; theo dõi rows read trong cost review hàng quý (4.9 audit) |
| Notification actions trên Safari khác Chrome | Feature-detect `Notification.maxActions`; degrade thành notification thường |
| Scheduled send dùng queue delay ≤24h | Lâu hơn 24h: cron sweep bảng scheduled_sends (đã có cron hàng giờ) — ghi rõ giới hạn trong UI |
| Markdown→HTML sinh HTML không mong muốn | Sinh xong **đi qua chính `sanitize-html.ts`** trước khi lưu/gửi — single source of truth |
| Ảnh inline cid là vector tracking? | cid là nội dung local trong R2, không fetch ngoài; remote ảnh vẫn chặn mặc định — không mở lỗ hổng |
| Queues mới (scheduler) thêm tài nguyên tạo tay | Khai báo full trong `wrangler.jsonc` (producer + consumer) để deploy tự tạo; không subscription tay như email.sending |

---

## 7. KPI & cách đo

| Chỉ tiêu | Baseline 2026-10-24 | Mục tiêu |
|----------|--------------------|----------| 
| Sync → thư đầu tiên tới inbox (zone sạch) | Nhiều bấm + tạo alias tay, không đo được | ≤ 2 phút, 0 thao tác dashboard, probe tự xác nhận |
| Outage "mất MX" khi provisioning | Đã xảy ra 1 lần (2026-09-20) | 0 — enable-before-delete + test dựng lại kịch bản |
| Domain expired registrar bị phát hiện | Không bao giờ (blind spot) | ≤ 1 giờ (DoH probe) |
| Soạn thư: BCC/HTML/ảnh inline/forward/hẹn giờ | 0/6 | 6/6 (R2) |
| Draft mất khi đóng tab giữa chừng | Chỉ compose thường, localStorage | 0 — server drafts |
| Bounce biết được | Chỉ khi tự mở message | Notification ≤ 5 phút |
| Tìm thư theo nội dung body | Không thể (FTS subject/preview/sender) | Có, p95 ≤ 300ms @50k |
| Mail mute vẫn push | Luôn push | 0 |
| Thông báo trong quiet hours | Mỗi thư 1 push | 1 digest khi kết thúc |

---

## 8. Kết luận

Hạ tầng MailVault hiện tại đủ mạnh để nhận **mọi** tính năng trong kế hoạch này mà không thêm dịch vụ ngoài: Email Routing API đã wrap đúng chỗ thiếu, Email Sending hỗ trợ 25 MiB + inline cid + custom headers whitelisted, Queues có delay 24h cho scheduler + undo, DO hub + payload-free push là nền tốt cho notification rules/digest/actions, Workers AI + Vectorize sẵn cho translate/semantic, và bảng D1 mới chỉ là migration đánh số tiếp. Điều cần nhất không phải viết lại gì — mà là (1) làm cho luồng provision an toàn và tự động đúng nghĩa, (2) kéo tầng UI compose/reader lên ngang mức plumbing đã có sẵn phía dưới, (3) dạy notification biết chọn lúc nào im.

*Tài liệu sinh ra cùng đợt khảo sát tính năng 2026-10-24 (4 subagent đọc toàn bộ worker/web/docs). Đối chiếu kế hoạch ops/hiệu suất: docs/AUDIT-2026-10-24.md.*
