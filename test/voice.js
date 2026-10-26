// Thử giọng văn của bot với vài tin nhắn mẫu, gọi Claude thật (cần ANTHROPIC_API_KEY trong .env).
// Không khởi động server, không gửi gì cho khách – chỉ in câu trả lời ra màn hình.
// Dùng: node test/voice.js              (kênh Instagram)
//       node test/voice.js whatsapp
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

try { process.loadEnvFile(); } catch {}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Chưa có ANTHROPIC_API_KEY trong .env');
  process.exit(1);
}

const channel = process.argv[2] || 'instagram';
const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
// Lấy đoạn chữ nằm giữa hai dấu ` ngay sau "start"
const between = (start) => {
  const i = src.indexOf(start) + start.length;
  return src.slice(i, src.indexOf('`', i));
};
const SYSTEM_PROMPT = between('const SYSTEM_PROMPT = `');
const CHANNEL_RULE = between(`  ${channel}: \``);
const knowledge = fs.readFileSync(new URL('../knowledge.md', import.meta.url), 'utf8');

// Mỗi mục là một cuộc trò chuyện riêng; nhiều tin = khách nhắn liên tiếp
const conversations = [
  ['Hi, do you sell raw hair?'],
  ['How much is 20 inch bundles?'],
  ['Beautiful 😍'],
  ['Are you a bot?'],
  ['I ordered 2 weeks ago and still nothing. This is ridiculous'],
  ['Hello, I own a salon in Lagos', 'What lengths do you have for raw bulk?', 'Can you do blonde 613?'],
  ['Shop ơi tóc này có bị rụng không?'],
  ['Cho mình xin bảng giá tóc nối tape-in nha'],
  ['Chào bạn, mình mở salon ở Đức, muốn nhập tóc', 'Bên bạn có làm màu theo yêu cầu không?'],
];

const client = new Anthropic();
const model = process.env.AI_MODEL || 'claude-opus-5-5';

for (const turns of conversations) {
  const messages = [];
  console.log('\n────────────────────────');
  for (const text of turns) {
    messages.push({ role: 'user', content: text });
    const res = await client.messages.create({
      model,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: SYSTEM_PROMPT + knowledge },
        { type: 'text', text: CHANNEL_RULE },
      ],
      messages,
    });
    const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    messages.push({ role: 'assistant', content: reply });
    console.log(`Khách: ${text}\nBot:   ${reply}\n`);
  }
}
