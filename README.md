# Bot trả lời tự động Instagram

Bot dùng **API chính thức của Meta** (Instagram API with Instagram Login), nên không có nguy cơ bị khóa tài khoản như các tool đăng nhập bằng mật khẩu.

**Chức năng**
- **Trả lời bằng AI (Claude)** như một nhân viên tư vấn: hiểu câu hỏi, trả lời đúng ngôn ngữ của khách, nhớ ngữ cảnh 24 giờ, xem được ảnh khách gửi, hiện "đang soạn tin" trước khi trả lời. Bot chỉ nói những gì có trong `knowledge.md`, không tự bịa giá, và chuyển khách sang WhatsApp để báo giá. Bật bằng biến môi trường `ANTHROPIC_API_KEY`; có giới hạn chi phí `AI_DAILY_LIMIT` (mặc định 500 câu/ngày) và `AI_PER_USER_DAILY` (40 câu/khách/ngày).
- **AI dự phòng (OpenAI, Gemini)**: nếu Claude lỗi, bị giới hạn tốc độ hoặc không có key, bot thử lần lượt OpenAI (`OPENAI_API_KEY`, `OPENAI_MODEL`) rồi Gemini (`GEMINI_API_KEY`, `GEMINI_MODEL`) với cùng prompt và `knowledge.md`. AI nào để trống key thì bỏ qua. Xem AI đang bật ở `/status`.
- Khi không có khóa AI nào, tất cả AI đều lỗi hoặc hết hạn mức: tự chuyển sang trả lời theo từ khóa trong `rules.json`.
- **Tự gia hạn token Instagram** mỗi ngày; xem ngày hết hạn ở `/status`.
- Trả lời **DM** theo từ khóa, gõ không dấu cũng được (`gia` khớp với `giá`).
- Gửi **tin nhắn mặc định** khi không khớp từ khóa nào, tối đa 1 lần mỗi 12 giờ cho mỗi người.
- **Comment rồi gửi DM**: khi có người comment chứa từ khóa, bot tự gửi DM riêng và trả lời công khai dưới comment.
- Kiểm tra chữ ký webhook, chống xử lý trùng, không tự trả lời chính mình.
- **Chống vòng lặp bot-với-bot**: bỏ qua tin tự động của bot khác (ManyChat, Chatfuel…), không gửi lại câu vừa gửi, và tự im lặng với khách nhận quá 8 câu trả lời trong 10 phút.
- **Không chạy song song với ManyChat** trên cùng tài khoản: hai bot sẽ trả lời chồng chéo, lạc đề. Nếu dùng bot này thì tắt automation trong ManyChat.
- Sửa câu trả lời trong `rules.json` là có hiệu lực ngay, không cần khởi động lại.

---

## Bước 1. Chuẩn bị tài khoản
1. Trên app Instagram, vào **Cài đặt → Loại tài khoản** và chuyển sang **Business** hoặc **Creator**.
2. Vào **Cài đặt → Tin nhắn và phản hồi story → Công cụ kết nối**, rồi bật **Cho phép truy cập tin nhắn**. Nếu không bật, webhook DM sẽ không chạy.

## Bước 2. Tạo app trên Meta
1. Vào https://developers.facebook.com/apps, chọn **Create app** rồi chọn use case **Manage messaging & content on Instagram**.
2. Mở **Instagram → API setup with Instagram login**:
   - **Generate access tokens**: thêm tài khoản Instagram của bạn và copy token (đây là `IG_ACCESS_TOKEN`).
   - Copy **Instagram app secret** (đây là `IG_APP_SECRET`).
3. Các quyền cần có: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`.

> Ở chế độ **Development**, Meta chỉ gửi webhook khi người nhắn hoặc comment là tài khoản có vai trò trong app (ví dụ tài khoản được thêm làm Instagram Tester). Như vậy đủ để test. Muốn bot trả lời **khách thật** thì phải chuyển app sang **Live**, và Meta yêu cầu xin **Advanced Access** qua App Review (thường kèm xác minh doanh nghiệp).

## Bước 3. Deploy lên Render (miễn phí)
1. Đưa thư mục này lên một repo GitHub.
2. Trên https://render.com, chọn **New → Web Service** và chọn repo vừa tạo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment: điền `IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `VERIFY_TOKEN` (tự đặt một chuỗi bí mật).
3. Sau khi deploy, bạn có URL dạng `https://ten-app.onrender.com`. Mở URL đó, nếu thấy dòng "đang chạy ✅" là thành công.

> Gói Free của Render sẽ "ngủ" khi không có truy cập, nên tin nhắn đầu tiên có thể trả lời chậm khoảng 30–50 giây. Muốn trả lời ngay thì dùng gói trả phí, Railway hoặc VPS.

## Bước 4. Đăng ký webhook
Trong app Meta, vào **Instagram → API setup → Configure webhooks**:
- Callback URL: `https://ten-app.onrender.com/webhook`
- Verify token: giống hệt `VERIFY_TOKEN` bạn đã đặt.
- Bấm **Verify and save**, sau đó **Subscribe** các field `messages` và `comments`.

Thử dùng một tài khoản Instagram khác nhắn "giá" cho tài khoản của bạn, bot sẽ trả lời.

---

## WhatsApp
Bot trả lời WhatsApp bằng cùng bộ não AI và cùng `knowledge.md`, nhưng không chuyển khách sang link WhatsApp nữa. Thay vào đó bot hỏi đủ thông tin (sản phẩm, độ dài, màu, số lượng, quốc gia) rồi báo sale qua email và trang `/leads?key=...`.
- **Dùng chung số với app WhatsApp Business ("coexistence")**: Meta chỉ cho làm qua nhà cung cấp chính thức (BSP), ví dụ 360dialog. Đặt `WA_PROVIDER=360dialog`, `WA_TOKEN` = API key của 360dialog, rồi khai báo webhook `https://<bot>/whatsapp?key=<WA_WEBHOOK_KEY>` trong 360dialog. Khi sale nhắn từ app, bot tự im với khách đó `HUMAN_PAUSE_HOURS` giờ (webhook `smb_message_echoes`).
- **Số riêng chỉ cho bot (API trực tiếp Meta)**: `WA_PROVIDER=meta`, `WA_TOKEN`, `WA_PHONE_NUMBER_ID`; webhook `https://<bot>/whatsapp?key=...`, verify token = `VERIFY_TOKEN`, subscribe field `messages`.
- Test: `node test/simulate.js wa "hi, price for tape in?"` và `node test/simulate.js wa-echo "ok"`.

## Báo khách hỏi giá (email + Telegram)
Khi khách trên **Instagram hoặc WhatsApp** hỏi giá, catalog, mẫu hoặc muốn đặt hàng, AI tóm tắt nhu cầu (sản phẩm, độ dài, màu, số lượng, quốc gia) và gửi ngay cho sale qua email và Telegram, kèm link mở chat. Danh sách cũng xem được ở `/leads?key=<WA_WEBHOOK_KEY>`. Cùng một nhu cầu của cùng khách chỉ báo 1 lần. Chỉ chạy khi bot trả lời bằng AI.
- **Email**: điền `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `LEAD_EMAIL_TO` (Gmail: `smtp.gmail.com`, `SMTP_PASS` là "Mật khẩu ứng dụng").
- **Telegram**:
  1. Trên Telegram, nhắn `@BotFather` → `/newbot` → đặt tên, nhận token. Đây là `TELEGRAM_BOT_TOKEN`.
  2. Mở bot vừa tạo, bấm **Start** và gửi 1 câu bất kỳ.
  3. Mở `https://api.telegram.org/bot<TOKEN>/getUpdates` trên trình duyệt, tìm `"chat":{"id":...}`. Số đó là `TELEGRAM_CHAT_ID` (muốn báo vào nhóm: thêm bot vào nhóm rồi làm lại bước 2–3, id nhóm bắt đầu bằng dấu `-`).
- Xem đã bật chưa ở `/status` (`emailBaoKhach`, `telegramBaoKhach`).

## Trợ lý soạn trả lời (cho sale không biết tiếng Anh)
Mở `https://<bot>/assistant` trên điện thoại hoặc máy tính. Dán tin của khách (WhatsApp, Instagram, Facebook…), bấm **Soạn trả lời**, AI trả về:
- **Khách hỏi gì** (tiếng Việt)
- **Câu trả lời gửi khách** bằng ngôn ngữ của khách, có nút Copy
- **Nghĩa tiếng Việt** của câu trả lời
- **Kiểm tra trước khi gửi**: thông tin còn thiếu (giá, phí ship, ảnh cần gửi kèm…)

Ô **Ghi chú cho AI** (tiếng Việt, không bắt buộc) để đưa thêm thông tin thật, ví dụ giá: AI dịch và đưa vào câu trả lời. AI chỉ dùng `knowledge.md` và ghi chú, không tự bịa giá. Nút **Ngắn hơn** soạn lại thật ngắn.
- Bật bằng `ASSISTANT_KEY` (mật khẩu tự đặt, nhập một lần trên trang). Cần `ANTHROPIC_API_KEY`.
- Giới hạn `ASSISTANT_DAILY_LIMIT` lượt/ngày (mặc định 300). Xem ở `/status` (`troLySoanTraLoi`).
- Trang không gửi gì cho khách: sale tự copy và bấm gửi.

## Tùy chỉnh câu trả lời (`rules.json`)
```json
{ "keywords": ["giá", "bao nhiêu"], "reply": "Nội dung trả lời" }
```
- `dm`: các luật trả lời tin nhắn. Bot kiểm tra từ trên xuống và dùng luật đầu tiên khớp.
- `dmFallback`: câu trả lời khi không khớp luật nào. Để `""` nếu muốn tắt.
- `comment`: `privateReply` là tin DM gửi riêng, `publicReply` là câu trả lời hiện dưới comment. Bỏ trường nào thì bot không gửi phần đó.

## Test trên máy (không gửi tin thật)
Cần cài Node.js 20 trở lên.
```bash
npm install
copy .env.example .env      # rồi sửa DRY_RUN=true
npm start
```
Mở thêm một cửa sổ terminal khác:
```bash
node test/simulate.js dm "cho mình hỏi gia"
node test/simulate.js comment "ib giá ạ"
```

## Giới hạn của Meta cần biết
- **Cửa sổ 24 giờ**: chỉ được nhắn cho người đã nhắn bạn trong vòng 24 giờ gần nhất. Bot chỉ trả lời nên không bị ảnh hưởng.
- **Private reply**: mỗi comment chỉ được gửi 1 DM, và phải gửi trong vòng 7 ngày.
- **Token**: token Instagram hết hạn sau khoảng 60 ngày. Gia hạn bằng lệnh:
  `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=TOKEN`
- Bot nhớ dữ liệu chống trùng trong RAM, nên khi restart thì danh sách này bị xóa. Với shop nhỏ điều này không thành vấn đề.

## Nâng cấp tiếp
- Gắn AI (Claude) để tự tư vấn khi không khớp từ khóa nào.
- Lưu khách hàng vào Google Sheets hoặc database.
- Thêm nút bấm nhanh (quick replies) và tin nhắn có hình ảnh.

## Giao việc Sale hằng ngày (Telegram)
Bot tự gửi tin giao việc + mẫu báo cáo cuối ngày vào nhóm Telegram lúc **07:15 Thứ 2–Thứ 7** (giờ Việt Nam). Code ở `daily-task.js`.
- Dùng sẵn `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID`. Muốn gửi vào nhóm khác: đặt `DAILY_TASK_CHAT_ID`.
- Đổi giờ: `DAILY_TASK_TIME=07:15`. Tắt: `DAILY_TASK=off`.
- Xem trước (không gửi): `/daily-task/preview?key=<ASSISTANT_KEY>`. Gửi ngay để thử: `/daily-task/send-now?key=<ASSISTANT_KEY>`.
- Trạng thái ở `/status` (`giaoViecSaleTelegram`).
