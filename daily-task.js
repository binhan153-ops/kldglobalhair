// ---------- Giao việc Sale hằng ngày qua Telegram ----------
// Mỗi sáng Thứ 2–Thứ 7 (giờ Việt Nam) bot tự gửi tin giao việc vào nhóm Telegram.
// Biến môi trường (không bắt buộc):
//   DAILY_TASK=off          tắt chức năng này
//   DAILY_TASK_TIME=07:15   giờ gửi (giờ Việt Nam)
//   DAILY_TASK_CHAT_ID=...  nhóm nhận (mặc định = TELEGRAM_CHAT_ID)
import fs from 'node:fs';

const TZ = 'Asia/Ho_Chi_Minh';
const SENT_FILE = new URL('./.daily-task-sent', import.meta.url);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Ngày giờ hiện tại theo giờ Việt Nam
function vnNow(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday); // 0 = Chủ nhật
  return { y: p.year, m: p.month, d: p.day, hh: Number(p.hour), mm: Number(p.minute), wd, key: `${p.year}-${p.month}-${p.day}` };
}

const THU = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

// Trọng tâm theo thứ trong tuần (giống file PDF giao việc)
const FOCUS = {
  1: ['Đẩy <b>tape-in</b>', 'Ưu tiên khách <b>Anh (UK)</b> – Ms. Hà Anh'],
  2: ['Đẩy <b>keratin</b>', 'Ưu tiên khách <b>Đức</b> – Ms. Trang'],
  3: ['Đẩy <b>clip-in</b>', 'Ưu tiên khách <b>Pháp</b> – Ms. Trang'],
  4: ['Đẩy <b>weft</b>', 'Ưu tiên khách <b>Slovenia / Serbia</b> – Ms. Tươi'],
  5: ['Đẩy <b>bulk wholesale</b> (Burmese curly #1B)', 'Ưu tiên khách <b>Mỹ</b> – Ms. Hiền'],
  6: ['Đẩy <b>bundles</b>', 'Ưu tiên <b>Nga</b> (Ms. Tươi) và <b>Châu Phi</b> (Mr. Thành)',
    '<b>Rà soát cả tuần</b>: đếm khách mới, tin đã gửi, đơn mẫu so với KPI tuần',
    'Follow-up <b>tất cả</b> khách quá 7 ngày chưa trả lời'],
};

// Mẹo bán hàng, đổi mỗi ngày
const TIPS = [
  'Gọi khách bằng tên salon trong câu đầu tiên – tin nhắn "chung chung" rất dễ bị bỏ qua.',
  'Hỏi câu dễ trả lời: "Salon mình đang dùng tape-in hay keratin nhiều hơn?" thay vì "Bạn cần gì?".',
  'Gửi ảnh tóc thật chụp ở xưởng (ánh sáng tự nhiên) – khách tin ảnh thật hơn ảnh đẹp.',
  'Khách hỏi giá → hỏi lại độ dài, màu, số lượng rồi báo giá ngay trong ngày. Báo chậm là mất khách.',
  'Khách chê đắt → đừng giảm giá ngay. Gợi ý đơn mẫu nhỏ để khách tự kiểm tra chất lượng.',
  'Trả lời trong 30 phút: khách hỏi nhiều xưởng cùng lúc, ai trả lời nhanh và rõ thì thắng.',
  'Mỗi tối ghi ngay vào Excel – để hôm sau không nhắn trùng và biết ai cần follow-up.',
  'Kết thúc tin nhắn bằng 1 câu hỏi có/không – khách dễ trả lời hơn.',
  'Xem Instagram của salon trước khi nhắn: họ làm loại tóc nào thì gửi đúng ảnh loại đó.',
  'Không hứa quá: tóc bền khoảng 6–9 tháng tùy chăm sóc. Nói thật giúp giữ khách lâu dài.',
  'Khách đã mua đơn mẫu → 5 ngày sau hỏi thăm khách của salon có thích tóc không. Đó là lúc chốt đơn lớn.',
  'Nhắn rải rác, mỗi tin khác nhau một chút – WhatsApp khoá số nếu gửi y hệt cho nhiều người.',
];

export function buildDailyTask(date = new Date()) {
  const t = vnNow(date);
  const ngay = `${THU[t.wd]} ${t.d}/${t.m}/${t.y}`;
  const focus = FOCUS[t.wd] || ['Ngày nghỉ – chỉ trả lời khách nhắn đến'];
  const dayIndex = Math.floor(Date.UTC(+t.y, +t.m - 1, +t.d) / 86400000);
  const tip = TIPS[dayIndex % TIPS.length];

  const task = [
    `📋 <b>GIAO VIỆC SALE – ${esc(ngay.toUpperCase())}</b>`,
    'Người giao: <b>Ms. Thùy</b> · KLD GLOBAL HAIR',
    '',
    '🎯 <b>TRỌNG TÂM HÔM NAY</b>',
    ...focus.map((f) => `• ${f}`),
    '',
    '✅ <b>KPI MỖI BẠN</b> (Hà Anh, Trang, Tươi, Hiền, Thành)',
    '• Tự tìm <b>20 khách mới</b> → ghi vào file Excel <b>của mình</b>',
    '• Nhắn chào hàng <b>30 khách</b> – <b>CHỈ khách mới do mình tự tìm</b>, mỗi khách 3 ảnh khác nhau',
    '• Follow-up khách <b>của mình</b> quá 7 ngày chưa trả lời',
    '• Trả lời khách trong <b>30 phút</b>, khách hỏi giá → báo giá trong ngày',
    '• 1 bài hoặc 2 story Instagram',
    '• <b>Sale 6</b>: chăm 15 khách cũ, đôn đốc đơn mẫu, gộp Excel cả nhóm buổi tối',
    '',
    '⏰ <b>LỊCH</b> (giờ VN)',
    '8:00 trả lời tin qua đêm · 8:30 tìm khách mới · 13:30 chuẩn bị ảnh, đăng bài',
    '15:00 nhắn đợt 1 (15 khách) · 19:00 nhắn đợt 2 (15 khách) + follow-up',
    '21:00 cập nhật Excel + gửi báo cáo. Ms. Hiền (Mỹ): nhắn 20h–23h',
    '',
    '🚫 <b>QUY ĐỊNH NHẮN KHÁCH (bắt buộc)</b>',
    '• <b>KHÔNG nhắn khách trong file châu Âu</b> (KhachHang_TocNoi_ChauAu_500_v2) – robot công ty đang nhắn các khách này',
    '• Chỉ nhắn khách mới <b>do mình tự tìm</b>',
    '• <b>Trước khi nhắn phải xem cột Trạng thái</b>: chỉ nhắn khách "Chưa nhắn". Đã nhắn / đã trả lời → <b>không nhắn lại</b>',
    '• Nhắn xong ghi ngay Trạng thái + ngày nhắn vào file',
    '',
    '⚠️ <b>NHỚ</b>: WhatsApp tối đa 20 người lạ/ngày/số · không gửi tóc mẫu miễn phí (mời mua đơn mẫu nhỏ) · giao hàng 5–7 ngày · không nhắn trùng khách',
    '',
    `💡 <b>Mẹo hôm nay</b>: ${esc(tip)}`,
    '',
    'Mọi người làm đủ KPI và gửi báo cáo theo mẫu bên dưới <b>trước 22h</b>. Có khó khăn nhắn ngay trong nhóm nhé. Cố lên! 💪',
  ].join('\n');

  const report = [
    '📝 <b>MẪU BÁO CÁO CUỐI NGÀY</b> (copy, điền rồi gửi vào nhóm)',
    '',
    `<code>BÁO CÁO NGÀY ${t.d}/${t.m} – [Tên] – Thị trường: ____
1. Khách mới tự tìm: __ / 20
2. Tin chào hàng (khách tự tìm): __ / 30 (WhatsApp __ · Instagram __ · Email __ · Facebook __)
3. Follow-up lần 2: __ khách
4. Khách trả lời: __ (tên salon)
5. Báo giá đã gửi: __ · Đơn mẫu chốt: __
6. Bài / story Instagram: có / không
7. Khó khăn cần hỗ trợ: ____</code>`,
  ].join('\n');

  return { key: t.key, ngay, isWorkday: Boolean(FOCUS[t.wd]), messages: [task, report] };
}

export function startDailyTask({ token, chatIds, dryRun }) {
  const enabled = process.env.DAILY_TASK !== 'off' && Boolean(token && chatIds.length);
  const [hh, mm] = (process.env.DAILY_TASK_TIME || '07:15').split(':').map(Number);
  let lastSent = '';
  try { lastSent = fs.readFileSync(SENT_FILE, 'utf8').trim(); } catch {}
  let lastResult = 'chưa gửi lần nào';

  async function send(date = new Date()) {
    const { key, messages } = buildDailyTask(date);
    for (const chatId of chatIds) {
      for (const text of messages) {
        if (dryRun) { console.log(`[DRY_RUN] Giao việc -> ${chatId}:\n${text}`); continue; }
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        });
        if (!r.ok) throw new Error(`Telegram ${r.status}: ${(await r.json().catch(() => ({}))).description || ''}`);
      }
    }
    lastSent = key;
    try { fs.writeFileSync(SENT_FILE, key); } catch {}
    lastResult = `đã gửi ${key}`;
    console.log(`Đã gửi giao việc Sale ${key} vào Telegram`);
  }

  if (enabled) {
    setInterval(() => {
      const t = vnNow();
      const mins = t.hh * 60 + t.mm;
      const start = hh * 60 + mm;
      // Chỉ gửi trong 60 phút kể từ giờ hẹn (phòng khi bot khởi động lại), mỗi ngày 1 lần, Thứ 2–Thứ 7
      if (t.wd === 0 || lastSent === t.key || mins < start || mins >= start + 60) return;
      lastSent = t.key; // chặn gửi trùng trong lúc đang gửi
      send().catch((e) => {
        lastSent = '';
        lastResult = `LỖI ${t.key}: ${e.message}`;
        console.error('Lỗi gửi giao việc Telegram:', e.message);
      });
    }, 60 * 1000);
    console.log(`Giao việc Sale: BẬT, gửi ${process.env.DAILY_TASK_TIME || '07:15'} Thứ 2–Thứ 7 vào ${chatIds.length} nhóm Telegram`);
  }

  return {
    send,
    status: () => (enabled
      ? `BẬT (${process.env.DAILY_TASK_TIME || '07:15'} Thứ 2–7, ${lastResult})`
      : 'TẮT – thiếu TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID hoặc DAILY_TASK=off'),
  };
}
