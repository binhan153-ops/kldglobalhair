// Giả lập webhook từ Meta để test local. Chạy server với DRY_RUN=true trước.
// Dùng: node test/simulate.js dm "cho mình hỏi giá"
//       node test/simulate.js comment "ib giá ạ"
//       node test/simulate.js wa "hi, price for 20 inch bulk?"   (tin WhatsApp của khách)
//       node test/simulate.js wa-echo "ok em gửi báo giá"        (sale trả lời từ app WhatsApp Business)
const [type = 'dm', text = 'gia bao nhieu vay shop'] = process.argv.slice(2);
const isWa = type.startsWith('wa');
const url = `http://localhost:${process.env.PORT || 3000}/${isWa ? 'whatsapp' : 'webhook'}`;

const waValue = type === 'wa-echo'
  ? { messaging_product: 'whatsapp', message_echoes: [{ from: '84888399896', to: '447700900123', id: `wamid.e${Date.now()}`, type: 'text', text: { body: text } }] }
  : {
      messaging_product: 'whatsapp',
      contacts: [{ wa_id: '447700900123', profile: { name: 'Test Salon' } }],
      messages: [{ from: '447700900123', id: `wamid.${Date.now()}`, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: text } }],
    };

const payload = isWa
  ? { object: 'whatsapp_business_account', entry: [{ id: 'WABA_ID', changes: [{ field: type === 'wa-echo' ? 'smb_message_echoes' : 'messages', value: waValue }] }] }
  : type === 'comment'
    ? {
        object: 'instagram',
        entry: [{
          id: 'MY_IG_ID',
          time: Date.now(),
          changes: [{
            field: 'comments',
            value: { id: `c${Date.now()}`, text, from: { id: '999', username: 'khach_test' }, media: { id: 'm1' } },
          }],
        }],
      }
    : {
        object: 'instagram',
        entry: [{
          id: 'MY_IG_ID',
          time: Date.now(),
          messaging: [{
            sender: { id: '12345' },
            recipient: { id: 'MY_IG_ID' },
            timestamp: Date.now(),
            message: { mid: `m${Date.now()}`, text },
          }],
        }],
      };

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
console.log(`Gửi ${type}: "${text}" -> HTTP ${res.status}. Xem log của server để thấy câu trả lời.`);
