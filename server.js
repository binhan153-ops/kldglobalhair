import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { startDailyTask, buildDailyTask } from './daily-task.js';

// Đọc file .env nếu có (Node >= 20.12). Trên Render/Railway thì đặt biến môi trường trong dashboard.
try { process.loadEnvFile(); } catch {}

const {
  IG_ACCESS_TOKEN,
  IG_APP_SECRET,
  VERIFY_TOKEN,
  GRAPH_VERSION = 'v23.0',
  PORT = 3000,
} = process.env;
const DRY_RUN = process.env.DRY_RUN === 'true';
const GRAPH = `https://graph.instagram.com/${GRAPH_VERSION}`;
// Token đang dùng; được tự gia hạn mỗi ngày (xem refreshIgToken)
let igToken = IG_ACCESS_TOKEN?.trim();
let igTokenExpiresAt = null;

// Đọc lại rules.json mỗi lần dùng để sửa câu trả lời không cần restart
const loadRules = () => JSON.parse(fs.readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));

// ---------- So khớp từ khóa (bỏ dấu tiếng Việt: "gia" khớp "giá") ----------
const normalize = (s) =>
  ` ${s}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ') + ' ';

const findRule = (rules, text) => {
  const t = normalize(text);
  return rules.find((r) => r.keywords.some((k) => t.includes(normalize(k))));
};

// ---------- Chống xử lý trùng và chống spam câu trả lời mặc định ----------
const seen = new Set();
const isDuplicate = (id) => {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return false;
};

const FALLBACK_COOLDOWN_MS = 12 * 60 * 60 * 1000; // mỗi người chỉ nhận tin mặc định 1 lần / 12h
const lastFallback = new Map();

// ---------- Tạm dừng bot khi nhân viên tự trả lời ----------
// Khi shop tự nhắn cho khách (từ app Instagram), bot im lặng với khách đó trong HUMAN_PAUSE_HOURS giờ.
const HUMAN_PAUSE_MS = Number(process.env.HUMAN_PAUSE_HOURS || 3) * 60 * 60 * 1000;
const pausedUntil = new Map(); // userId -> thời điểm bot được trả lời lại
const botSent = new Map(); // userId -> các câu bot vừa gửi, để phân biệt tin bot với tin của người

const rememberBotText = (userId, text) => {
  const list = (botSent.get(userId) || []).filter((x) => Date.now() - x.at < 5 * 60 * 1000);
  list.push({ text, at: Date.now() });
  botSent.set(userId, list);
};
const isBotText = (userId, text) => (botSent.get(userId) || []).some((x) => x.text === text);
const isPaused = (userId) => (pausedUntil.get(userId) || 0) > Date.now();

// ---------- Chống vòng lặp bot-với-bot (ManyChat, Chatfuel, tin tự động...) ----------
// Tin do một bot khác gửi tới: không trả lời, để hai bot không nhắn qua lại với nhau.
const AUTOMATED_TEXT = /manychat|chatfuel|automation powered|powered by|this is an automated|auto-?reply|tin nh[aắ]n t[uự] đ[oộ]ng|make sure the link worked/i;
// Mỗi khách nhận tối đa LOOP_MAX câu trả lời tự động trong LOOP_WINDOW_MS; vượt quá thì bot im lặng với khách đó.
const LOOP_MAX = 8;
const LOOP_WINDOW_MS = 10 * 60 * 1000;
const repliesTo = new Map(); // userId -> các thời điểm bot đã trả lời
const lastReplyText = new Map(); // userId -> { text, at }

const tooManyReplies = (userId) => {
  const recent = (repliesTo.get(userId) || []).filter((t) => Date.now() - t < LOOP_WINDOW_MS);
  repliesTo.set(userId, recent);
  return recent.length >= LOOP_MAX;
};
// Không gửi lại đúng câu vừa gửi cho cùng khách trong 30 phút
const isRepeat = (userId, text) => {
  const last = lastReplyText.get(userId);
  return last && last.text === text && Date.now() - last.at < 30 * 60 * 1000;
};

// ---------- Gọi Graph API ----------
async function graphPost(path, body) {
  if (DRY_RUN) {
    console.log('[DRY_RUN] POST', path, JSON.stringify(body));
    return;
  }
  const res = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${igToken}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const sendDM = (userId, text) => {
  rememberBotText(userId, text);
  repliesTo.set(userId, [...(repliesTo.get(userId) || []), Date.now()]);
  lastReplyText.set(userId, { text, at: Date.now() });
  return graphPost('/me/messages', { recipient: { id: userId }, message: { text } });
};

// Hiện "đang soạn tin…" cho khách thấy, như người thật đang gõ
const sendTyping = (userId) =>
  graphPost('/me/messages', { recipient: { id: userId }, sender_action: 'typing_on' }).catch(() => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Tự gia hạn token Instagram (token sống ~60 ngày, gia hạn được khi đã > 24h tuổi) ----------
async function refreshIgToken() {
  if (!igToken || DRY_RUN) return;
  try {
    const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(igToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token) {
      igToken = data.access_token;
      igTokenExpiresAt = Date.now() + Number(data.expires_in || 0) * 1000;
      console.log(`Đã gia hạn token Instagram, hết hạn ${new Date(igTokenExpiresAt).toISOString().slice(0, 10)}`);
    } else {
      console.warn('Chưa gia hạn được token Instagram:', data?.error?.message || res.status);
    }
  } catch (e) {
    console.warn('Lỗi gia hạn token Instagram:', e.message);
  }
}

// ---------- Trả lời bằng AI (Claude, dự phòng OpenAI -> Gemini) ----------
// Thứ tự: Claude -> OpenAI -> Gemini, AI nào có key thì được dùng. Tất cả lỗi / không có key -> rules.json như cũ.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const AI_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 500); // tổng câu AI mỗi ngày (giới hạn chi phí)
const AI_PER_USER_DAILY = Number(process.env.AI_PER_USER_DAILY || 40); // mỗi khách mỗi ngày
const HISTORY_MAX = 16; // số tin gần nhất bot nhớ cho mỗi khách
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

const loadKnowledge = () => fs.readFileSync(new URL('./knowledge.md', import.meta.url), 'utf8');

// Phần riêng cho từng kênh: Instagram mời khách sang WhatsApp; trên WhatsApp thì team trả lời ngay trong chat
const CHANNEL_RULES = {
  instagram: `Channel: Instagram direct messages (@kld_global_hair).
- For prices, quotes, catalogs, samples or orders: briefly collect what they need and invite them to WhatsApp https://wa.me/84888399896 where the team sends the price list and an exact quote.
- Complaints, order problems or payments: apologize briefly, ask for the order details, and hand over to the team on WhatsApp.
- If asked whether you are a bot or a real person, be honest: you are KLD's virtual assistant, and a team member can continue on WhatsApp anytime.
- When the customer has asked for a quote, price list, catalog, sample or wants to order, add one final line on its own: [[LEAD: <one-line summary in English of what they want, with any product/length/color/quantity/country they gave>]]. Add it again later only if the customer gives new details. This line is removed before sending.`,
  whatsapp: `Channel: WhatsApp – this IS the sales team's own WhatsApp chat, so never send the customer to another WhatsApp number or link.
- For prices, quotes, catalogs, samples or orders: collect the details the team needs (product, length, color/texture, quantity, destination country), then tell the customer a sales team member will send the price list / exact quote right here in this chat shortly.
- Complaints, order problems or payments: apologize briefly, ask for the order number and details, and say a team member will reply here personally.
- If asked whether you are a bot or a real person, be honest: you are KLD's virtual assistant, and a team member will join this chat.
- When the customer has asked for a quote, price list, catalog, sample or wants to order, and you have passed it to the team, add one final line on its own: [[LEAD: <one-line summary in English of what they want, with any product/length/color/quantity/country they gave>]]. Add it again later only if the customer gives new details. This line is removed before sending.`,
};

const SYSTEM_PROMPT = `You answer messages for KLD Global Hair Factory, a Vietnamese 100% human hair manufacturer that sells wholesale worldwide. Your customers are salon owners, hair vendors, wig makers and distributors, so trust matters more than speed of selling.

How to write:
- Sound like a real person: an experienced, polite sales rep who treats the customer as a business partner, texting on a phone. Warm, relaxed and tactful – never stiff, overly formal or scripted.
- Keep it short and to the point (usually 1–3 sentences). Mix short and longer sentences; light natural interjections and connectors are fine ("Oh", "Sure!", "Got it", "By the way" – in Vietnamese: ô, à, nha, nhé, nè). No markdown, no headings, no bullet lists unless the customer asks for a list of products. At most one emoji.
- Always reply in the customer's language.
- Get straight to the answer. Never open with canned lines like "As an AI...", "I'm a language model...", "Thank you for reaching out", "Happy to help you" or "Great question", and never repeat the customer's question back to them.
- Answer what they actually asked. Now and then (not in every message) end with one short, natural question to keep the chat going and move it forward (e.g. which product, length, color, quantity, or country).
- Use the conversation history; don't repeat information or links you already gave in the last few messages, and vary your wording instead of reusing the same phrases.

What you may say:
- Only state facts from the knowledge section below. If something isn't there, say the sales team will confirm it on WhatsApp – never guess.
- Never invent or estimate prices, discounts, minimum order quantities, stock, delivery times, certifications, payment terms or customer reviews, and never promise anything.
- If a photo is shared, describe only what you can actually see and relate it to KLD's products.
- If the customer only sends an emoji, a short compliment (e.g. "Beautiful") or a story reaction, reply with a brief, warm thank-you in their language and at most one light question – no sales pitch and no links.

If the message is spam, unrelated advertising, abusive, or clearly an automated message from another bot, reply with exactly: SKIP

Knowledge:
`;

const history = new Map(); // userId -> { msgs, at }
const getHistory = (userId) => {
  const h = history.get(userId);
  return h && Date.now() - h.at < HISTORY_TTL_MS ? h.msgs : [];
};
const pushHistory = (userId, role, content) => {
  const msgs = [...getHistory(userId), { role, content }].slice(-HISTORY_MAX);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift(); // lịch sử phải bắt đầu bằng tin của khách
  history.set(userId, { msgs, at: Date.now() });
  if (history.size > 5000) history.delete(history.keys().next().value);
};

const aiUsage = { day: '', total: 0, perUser: new Map() };
const aiQuotaOk = (userId) => {
  const today = new Date().toISOString().slice(0, 10);
  if (aiUsage.day !== today) Object.assign(aiUsage, { day: today, total: 0, perUser: new Map() });
  return aiUsage.total < AI_DAILY_LIMIT && (aiUsage.perUser.get(userId) || 0) < AI_PER_USER_DAILY;
};
const countAi = (userId) => {
  aiUsage.total++;
  aiUsage.perUser.set(userId, (aiUsage.perUser.get(userId) || 0) + 1);
};

// Mỗi AI nhận (system, history, text, imageUrl) và trả về chuỗi trả lời; ném lỗi nếu không dùng được.
async function askClaude(system, msgs, text, imageUrl, channel) {
  const userContent = imageUrl
    ? [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: text || '(The customer sent this photo.)' },
      ]
    : text;
  try {
    const res = await anthropic.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: CHANNEL_RULES[channel] },
      ],
      messages: [...msgs, { role: 'user', content: userContent }],
    });
    if (res.stop_reason === 'refusal') throw new Error('Claude từ chối trả lời');
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) error.message = 'ANTHROPIC_API_KEY không hợp lệ';
    else if (error instanceof Anthropic.RateLimitError) error.message = 'bị giới hạn tốc độ';
    throw error;
  }
}

// Tải ảnh về dạng data URL (link ảnh Instagram có thể không mở được từ máy chủ OpenAI/Google)
async function imageDataUrl(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`không tải được ảnh (${r.status})`);
  const type = r.headers.get('content-type') || 'image/jpeg';
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
}

// OpenAI và Gemini dùng chung định dạng Chat Completions (Gemini có endpoint tương thích OpenAI)
const openAiCompatible = (name, baseUrl, apiKey, model) => async (system, msgs, text, imageUrl, channel) => {
  const userContent = imageUrl
    ? [
        { type: 'text', text: text || '(The customer sent this photo.)' },
        { type: 'image_url', image_url: { url: await imageDataUrl(imageUrl) } },
      ]
    : text;
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `${system}\n\n${CHANNEL_RULES[channel]}` },
        ...msgs,
        { role: 'user', content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${data.error?.message || data[0]?.error?.message || ''}`.trim());
  const reply = data.choices?.[0]?.message?.content;
  if (typeof reply !== 'string') throw new Error(`${name} không trả về nội dung`);
  return reply;
};

const AI_PROVIDERS = [
  anthropic && { name: `Claude (${AI_MODEL})`, ask: askClaude },
  process.env.OPENAI_API_KEY && {
    name: `OpenAI (${OPENAI_MODEL})`,
    ask: openAiCompatible('OpenAI', 'https://api.openai.com/v1', process.env.OPENAI_API_KEY, OPENAI_MODEL),
  },
  process.env.GEMINI_API_KEY && {
    name: `Gemini (${GEMINI_MODEL})`,
    ask: openAiCompatible('Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', process.env.GEMINI_API_KEY, GEMINI_MODEL),
  },
].filter(Boolean);
const AI_ENABLED = AI_PROVIDERS.length > 0;
const AI_NAMES = AI_PROVIDERS.map((p) => p.name).join(' -> ');

// Trả về câu trả lời, '' nếu nên im lặng (SKIP), hoặc null nếu không AI nào dùng được.
// channel: 'instagram' | 'whatsapp'. Với WhatsApp, dòng [[LEAD: ...]] được tách ra và gửi cho onLead.
async function aiReply(userId, text, imageUrl, channel = 'instagram', onLead = null) {
  if (!AI_ENABLED || !aiQuotaOk(userId)) return null;
  const system = SYSTEM_PROMPT + loadKnowledge();
  const msgs = getHistory(userId);
  let reply = null;
  for (const [i, provider] of AI_PROVIDERS.entries()) {
    try {
      reply = (await provider.ask(system, msgs, text, imageUrl, channel)).trim();
      if (i > 0) console.log(`AI: đã trả lời bằng dự phòng ${provider.name}`);
      break;
    } catch (error) {
      console.error(`AI ${provider.name} lỗi:`, error.message);
    }
  }
  if (reply === null) return null;
  countAi(userId);
  const lead = reply.match(/\[\[LEAD:\s*([\s\S]*?)\]\]/);
  if (lead) {
    reply = reply.replace(lead[0], '').trim();
    if (onLead) onLead(lead[1].trim());
  }
  // Ảnh lưu vào lịch sử dưới dạng chữ (link ảnh Instagram hết hạn nhanh)
  pushHistory(userId, 'user', imageUrl ? `[photo] ${text || ''}`.trim() : text);
  if (!reply || reply === 'SKIP') return '';
  pushHistory(userId, 'assistant', reply);
  return reply.slice(0, 1000); // Instagram giới hạn 1000 ký tự / tin
}

// Private reply: gửi DM cho người vừa comment (mỗi comment chỉ được 1 lần, trong 7 ngày)
const sendPrivateReply = (commentId, text) =>
  graphPost('/me/messages', { recipient: { comment_id: commentId }, message: { text } });

const replyComment = (commentId, message) => graphPost(`/${commentId}/replies`, { message });

// Tên và username Instagram của khách (để sale biết ai đang hỏi giá)
const igProfiles = new Map();
async function igProfile(userId) {
  if (igProfiles.has(userId)) return igProfiles.get(userId);
  let p = {};
  if (!DRY_RUN) {
    try {
      const r = await fetch(`${GRAPH}/${userId}?fields=name,username`, { headers: { Authorization: `Bearer ${igToken}` } });
      if (r.ok) p = await r.json();
    } catch {}
  }
  igProfiles.set(userId, p);
  return p;
}

async function igLead(userId, summary, lastMessage) {
  const p = await igProfile(userId);
  await notifyLead({
    channel: 'Instagram',
    name: p.name || p.username || 'Khách Instagram',
    contact: p.username ? `@${p.username}` : `ID ${userId}`,
    link: p.username ? `https://instagram.com/${p.username}` : 'https://www.instagram.com/direct/inbox/',
    userKey: userId,
    summary,
    lastMessage,
    at: new Date().toISOString(),
  });
}

// ---------- Xử lý sự kiện ----------
async function handleMessage(event) {
  const msg = event.message;
  if (!msg) return;

  // Tin do chính shop gửi (echo): nếu không phải bot gửi thì là nhân viên -> tạm dừng bot với khách này
  if (msg.is_echo) {
    const customerId = event.recipient?.id;
    if (customerId && !isBotText(customerId, msg.text)) {
      pausedUntil.set(customerId, Date.now() + HUMAN_PAUSE_MS);
      console.log(`Nhân viên đã trả lời ${customerId} -> bot tạm dừng ${HUMAN_PAUSE_MS / 3600000}h`);
    }
    return;
  }

  const imageUrl = (msg.attachments || []).find((a) => a.type === 'image')?.payload?.url;
  if (!msg.text && !imageUrl) return; // bỏ qua sticker, voice, reaction...
  if (isDuplicate(msg.mid)) return;
  const text = msg.text || '';

  const userId = event.sender.id;
  if (isPaused(userId)) {
    console.log(`DM ${userId}: "${text}" -> bỏ qua (nhân viên đang chat)`);
    return;
  }
  if (AUTOMATED_TEXT.test(text)) {
    console.log(`DM ${userId}: "${text}" -> bỏ qua (tin tự động của bot khác)`);
    return;
  }
  if (tooManyReplies(userId)) {
    pausedUntil.set(userId, Date.now() + HUMAN_PAUSE_MS);
    console.log(`DM ${userId}: quá ${LOOP_MAX} câu trả lời trong ${LOOP_WINDOW_MS / 60000} phút -> nghi vòng lặp bot, tạm dừng ${HUMAN_PAUSE_MS / 3600000}h`);
    return;
  }

  // 1) AI trả lời như nhân viên tư vấn
  if (AI_ENABLED) {
    const started = Date.now();
    sendTyping(userId);
    const reply = await aiReply(userId, text, imageUrl, 'instagram', (summary) =>
      igLead(userId, summary, text).catch((e) => console.error('Lỗi báo khách IG:', e.message)));
    if (reply === '') {
      console.log(`DM ${userId}: "${text}" -> AI bỏ qua (spam/tin tự động)`);
      return;
    }
    if (reply) {
      if (isRepeat(userId, reply)) return;
      // Nhịp gõ tự nhiên: tin dài thì "gõ" lâu hơn một chút (2–8 giây tính cả thời gian AI nghĩ)
      const typingMs = Math.min(8000, 2000 + reply.length * 25);
      await sleep(Math.max(0, typingMs - (Date.now() - started)));
      if (isPaused(userId)) return; // nhân viên đã nhảy vào trong lúc bot đang soạn
      await sendDM(userId, reply);
      console.log(`DM ${userId}: "${text}${imageUrl ? ' [ảnh]' : ''}" -> AI`);
      return;
    }
    // reply === null: AI lỗi hoặc hết hạn mức -> dùng rules bên dưới
  }
  if (!text) return;

  // 2) Dự phòng: trả lời theo từ khóa trong rules.json
  const rules = loadRules();
  const rule = findRule(rules.dm, msg.text);

  if (rule) {
    if (isRepeat(userId, rule.reply)) {
      console.log(`DM ${userId}: "${msg.text}" -> bỏ qua (vừa gửi đúng câu này)`);
      return;
    }
    await sendDM(userId, rule.reply);
    console.log(`DM ${userId}: "${msg.text}" -> rule [${rule.keywords[0]}]`);
    return;
  }

  // Chỉ có emoji / lời khen ngắn (thả tim story, "Beautiful"...): cảm ơn ngắn thay vì gửi tin quảng cáo mặc định
  const isReaction = !/[\p{L}\p{N}]/u.test(text) || /^\s*(beautiful|gorgeous|nice|wow|love( it)?|amazing|so pretty|pretty|đẹp( quá)?|xinh( quá)?)\W*$/iu.test(text);
  if (isReaction) {
    const thanks = 'Thank you so much 💖';
    if (!isRepeat(userId, thanks)) await sendDM(userId, thanks);
    console.log(`DM ${userId}: "${text}" -> cảm ơn`);
    return;
  }

  const last = lastFallback.get(userId) || 0;
  if (rules.dmFallback && Date.now() - last > FALLBACK_COOLDOWN_MS) {
    lastFallback.set(userId, Date.now());
    await sendDM(userId, rules.dmFallback);
    console.log(`DM ${userId}: "${msg.text}" -> fallback`);
  }
}

async function handleComment(igAccountId, value) {
  if (!value?.id || !value.text) return;
  if (value.from?.id === igAccountId) return; // không tự trả lời comment của chính mình
  if (isDuplicate(`c_${value.id}`)) return;

  const rule = findRule(loadRules().comment, value.text);
  if (!rule) return;

  if (rule.privateReply) {
    if (value.from?.id) rememberBotText(value.from.id, rule.privateReply); // để tin echo không bị tưởng là nhân viên
    await sendPrivateReply(value.id, rule.privateReply);
  }
  if (rule.publicReply) await replyComment(value.id, rule.publicReply);
  console.log(`Comment @${value.from?.username}: "${value.text}" -> rule [${rule.keywords[0]}]`);
}

// ================= WhatsApp (WhatsApp Business Platform – Cloud API, trực tiếp Meta hoặc qua BSP) =================
// WA_PROVIDER=meta     : gửi qua graph.facebook.com/{WA_PHONE_NUMBER_ID}/messages, WA_TOKEN là access token của Meta
// WA_PROVIDER=360dialog: gửi qua waba-v2.360dialog.io/messages, WA_TOKEN là D360-API-KEY (BSP hỗ trợ dùng chung số với app)
const WA_PROVIDER = (process.env.WA_PROVIDER || 'meta').toLowerCase();
const WA_TOKEN = process.env.WA_TOKEN?.trim();
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_APP_SECRET = process.env.WA_APP_SECRET || IG_APP_SECRET; // ký webhook khi đi thẳng Meta
const WA_WEBHOOK_KEY = process.env.WA_WEBHOOK_KEY; // khóa bí mật trên URL webhook khi dùng BSP (BSP không ký webhook)
const WA_ENABLED = Boolean(WA_TOKEN && (WA_PROVIDER !== 'meta' || WA_PHONE_NUMBER_ID));
const WA_FALLBACK = 'Thank you for your message! 🙏 A member of our sales team will reply to you here shortly.';

async function waPost(body) {
  if (DRY_RUN) {
    console.log('[DRY_RUN] WA', JSON.stringify(body));
    return;
  }
  const url = WA_PROVIDER === '360dialog'
    ? 'https://waba-v2.360dialog.io/messages'
    : `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  const headers = WA_PROVIDER === '360dialog'
    ? { 'Content-Type': 'application/json', 'D360-API-KEY': WA_TOKEN }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${WA_TOKEN}` };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ messaging_product: 'whatsapp', ...body }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const waSendText = (to, text) => {
  const key = `wa:${to}`;
  repliesTo.set(key, [...(repliesTo.get(key) || []), Date.now()]);
  lastReplyText.set(key, { text, at: Date.now() });
  return waPost({ to, type: 'text', text: { body: text, preview_url: false } });
};
// Đánh dấu đã xem + hiện "đang soạn tin…" (tự tắt khi gửi tin hoặc sau 25 giây)
const waReadAndTyping = (messageId) =>
  waPost({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }).catch(() => {});

// ---------- Khách cần báo giá: lưu lại và báo cho sale ----------
const leads = []; // mới nhất ở đầu, tối đa 300
let mailer = null;
if (process.env.SMTP_HOST && process.env.LEAD_EMAIL_TO) {
  const nodemailer = (await import('nodemailer')).default;
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
// Telegram: tạo bot qua @BotFather lấy TELEGRAM_BOT_TOKEN; TELEGRAM_CHAT_ID là chat nhận báo (nhiều chat cách nhau dấu phẩy)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const TELEGRAM_ENABLED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS.length);
// Giao việc Sale hằng ngày vào nhóm Telegram (xem daily-task.js)
const DAILY_TASK_CHAT_IDS = (process.env.DAILY_TASK_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const dailyTask = startDailyTask({ token: TELEGRAM_BOT_TOKEN, chatIds: DAILY_TASK_CHAT_IDS, dryRun: DRY_RUN });

async function sendTelegram(text) {
  if (!TELEGRAM_ENABLED) return;
  if (DRY_RUN) {
    console.log('[DRY_RUN] Telegram:', text);
    return;
  }
  for (const chatId of TELEGRAM_CHAT_IDS) {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!r.ok) throw new Error(`Telegram ${r.status}: ${(await r.json().catch(() => ({}))).description || ''}`);
  }
}

// lead: { channel, name, contact, link, userKey, summary, lastMessage, at }
async function notifyLead(lead) {
  // Không báo lại đúng nhu cầu vừa báo của cùng khách
  if (leads.some((l) => l.userKey === lead.userKey && l.summary === lead.summary)) return;
  leads.unshift(lead);
  if (leads.length > 300) leads.pop();
  console.log(`KHÁCH CẦN BÁO GIÁ (${lead.channel}): ${lead.name} (${lead.contact}) – ${lead.summary}`);
  const time = new Date(lead.at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const body = `Kênh: ${lead.channel}\nKhách: ${lead.name} (${lead.contact})\nNhu cầu: ${lead.summary}\nTin nhắn gần nhất: ${lead.lastMessage}\nThời gian: ${time}\n\nMở chat: ${lead.link}`;
  const jobs = [sendTelegram(`🔔 KHÁCH HỎI GIÁ\n${body}`).catch((e) => console.error('Lỗi gửi Telegram báo khách:', e.message))];
  if (mailer) {
    jobs.push(mailer.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.LEAD_EMAIL_TO,
      subject: `[KLD ${lead.channel}] Khách cần báo giá: ${lead.name} (${lead.contact})`,
      text: body,
    }).catch((e) => console.error('Lỗi gửi email báo khách:', e.message)));
  }
  await Promise.all(jobs);
}

async function handleWhatsAppMessage(msg, contact) {
  if (!msg?.id || isDuplicate(`wa_${msg.id}`)) return;
  const from = msg.from;
  const key = `wa:${from}`;
  const name = contact?.profile?.name || from;
  let text = '';
  if (msg.type === 'text') text = msg.text?.body || '';
  else if (msg.type === 'button') text = msg.button?.text || '';
  else if (msg.type === 'interactive') text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
  else if (['image', 'video', 'document'].includes(msg.type)) text = `[The customer sent a ${msg.type}${msg[msg.type]?.caption ? ` with caption: ${msg[msg.type].caption}` : ''}]`;
  else if (msg.type === 'audio') text = '[The customer sent a voice message]';
  else return; // reaction, sticker, location... -> không trả lời

  if (isPaused(key)) {
    console.log(`WA ${from}: "${text}" -> bỏ qua (nhân viên đang chat)`);
    return;
  }
  if (AUTOMATED_TEXT.test(text)) return;
  if (tooManyReplies(key)) {
    pausedUntil.set(key, Date.now() + HUMAN_PAUSE_MS);
    console.log(`WA ${from}: nghi vòng lặp -> tạm dừng ${HUMAN_PAUSE_MS / 3600000}h`);
    return;
  }

  const started = Date.now();
  waReadAndTyping(msg.id);
  const reply = await aiReply(key, text, null, 'whatsapp', (summary) =>
    notifyLead({
      channel: 'WhatsApp',
      name,
      contact: `+${from}`,
      link: `https://wa.me/${from}`,
      userKey: key,
      summary,
      lastMessage: text,
      at: new Date().toISOString(),
    }));

  if (reply === '') return;
  if (reply) {
    if (isRepeat(key, reply)) return;
    const typingMs = Math.min(8000, 2000 + reply.length * 25);
    await sleep(Math.max(0, typingMs - (Date.now() - started)));
    if (isPaused(key)) return; // nhân viên vừa nhảy vào
    await waSendText(from, reply);
    console.log(`WA ${from}: "${text}" -> AI`);
    return;
  }
  // AI không dùng được: báo khách là sale sẽ trả lời, tối đa 1 lần / 12h
  const last = lastFallback.get(key) || 0;
  if (Date.now() - last > FALLBACK_COOLDOWN_MS) {
    lastFallback.set(key, Date.now());
    await waSendText(from, WA_FALLBACK);
    console.log(`WA ${from}: "${text}" -> tin mặc định`);
  }
}

function handleWhatsAppPayload(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (change.field === 'messages') {
        for (const m of v.messages || []) {
          const contact = (v.contacts || []).find((c) => c.wa_id === m.from) || v.contacts?.[0];
          handleWhatsAppMessage(m, contact).catch((e) => console.error('Lỗi WhatsApp:', e.message));
        }
      } else if (change.field === 'smb_message_echoes') {
        // Sale nhắn từ app WhatsApp Business (chế độ dùng chung số) -> bot im lặng với khách đó
        for (const e of v.message_echoes || []) {
          if (e.to) {
            pausedUntil.set(`wa:${e.to}`, Date.now() + HUMAN_PAUSE_MS);
            console.log(`Sale đã trả lời WA ${e.to} từ app -> bot tạm dừng ${HUMAN_PAUSE_MS / 3600000}h`);
          }
        }
      }
    }
  }
}

// ---------- Server ----------
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Kiểm tra chữ ký để chắc chắn request đến từ Meta
function verifySignature(req) {
  if (!IG_APP_SECRET) return DRY_RUN; // chỉ cho phép bỏ qua khi đang test
  const sig = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', IG_APP_SECRET).update(req.rawBody || '').digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Bước xác minh khi đăng ký webhook trên Meta
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // trả lời Meta ngay, xử lý sau để tránh bị gửi lại

  const body = req.body;
  if (body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      handleMessage(event).catch((e) => console.error('Lỗi DM:', e.message));
    }
    for (const change of entry.changes || []) {
      if (change.field === 'comments') {
        handleComment(entry.id, change.value).catch((e) => console.error('Lỗi comment:', e.message));
      }
    }
  }
});

// ---------- Webhook WhatsApp ----------
const waKeyOk = (req) => !WA_WEBHOOK_KEY || req.query.key === WA_WEBHOOK_KEY;
const waSignatureOk = (req) => {
  const sig = req.get('x-hub-signature-256');
  if (!sig) return WA_PROVIDER !== 'meta' || DRY_RUN; // BSP không ký -> dựa vào WA_WEBHOOK_KEY
  if (!WA_APP_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', WA_APP_SECRET).update(req.rawBody || '').digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
};

app.get('/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/whatsapp', (req, res) => {
  if (!waKeyOk(req) || !waSignatureOk(req)) return res.sendStatus(401);
  res.sendStatus(200);
  if (!WA_ENABLED && !DRY_RUN) return;
  if (req.body?.object === 'whatsapp_business_account') handleWhatsAppPayload(req.body);
});

// Danh sách khách cần báo giá (mở bằng https://.../leads?key=WA_WEBHOOK_KEY)
app.get('/leads', (req, res) => {
  if (!WA_WEBHOOK_KEY || req.query.key !== WA_WEBHOOK_KEY) return res.sendStatus(403);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = leads.map((l) => `<tr><td>${esc(new Date(l.at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }))}</td><td>${esc(l.channel)}</td><td>${esc(l.name)}</td><td><a href="${esc(l.link)}">${esc(l.contact)}</a></td><td>${esc(l.summary)}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Khách cần báo giá</title>
<body style="font-family:system-ui;margin:16px"><h2>Khách cần báo giá (${leads.length})</h2><p style="color:#666">Danh sách mất khi bot khởi động lại – email và Telegram là bản lưu lâu dài.</p>
<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Thời gian</th><th>Kênh</th><th>Khách</th><th>Liên hệ</th><th>Nhu cầu</th></tr>${rows}</table></body>`);
});

// ---------- Trợ lý soạn trả lời cho sale (không biết tiếng Anh) ----------
// Mở https://.../assistant, nhập mật khẩu ASSISTANT_KEY một lần. Sale dán tin của khách,
// AI trả về: khách hỏi gì (tiếng Việt), câu trả lời bằng ngôn ngữ của khách, bản dịch tiếng Việt và việc cần kiểm tra.
const ASSISTANT_KEY = process.env.ASSISTANT_KEY?.trim();
const ASSISTANT_DAILY_LIMIT = Number(process.env.ASSISTANT_DAILY_LIMIT || 300);
const assistantUsage = { day: '', count: 0 };

const ASSISTANT_PROMPT = `You help a sales person at KLD Global Hair Factory reply to customers on WhatsApp, Instagram and Facebook. The sales person is Vietnamese and does not read English, so you explain everything to them in Vietnamese and write the customer-facing reply for them to copy and send.

Customers are salon owners, hair vendors, wig makers and distributors abroad. The goal is to answer quickly and helpfully, build trust, and move the chat toward an order – without being pushy or annoying.

How to write the reply to the customer:
- Write it in the customer's language (usually English).
- Sound like an experienced, warm, polite sales rep texting on a phone. Short and to the point (usually 1–4 sentences). Plain text, no markdown. At most one emoji.
- Answer exactly what the customer asked first. Then, only if useful, ask one short question that moves toward the order (product, length, color, quantity, country).
- Don't open with canned lines ("Thank you for reaching out", "Great question") and don't repeat the customer's question back.

What you may state:
- Only facts from the knowledge section below and from the seller's notes (the notes are written in Vietnamese by the sales person and are true facts – use them, translated).
- Never invent prices, discounts, stock, shipping costs, certifications or promises. If the customer needs one of these and the notes don't give it, write a reply that stays honest (e.g. you'll check and send the exact price/quote shortly) and tell the sales person in Vietnamese what to find out.
- If the customer is complaining or upset, apologize sincerely, don't argue, and ask for the order details.

Fields to return (all Vietnamese fields in simple, natural Vietnamese):
- customer_language: the customer's language, in Vietnamese (e.g. "Tiếng Anh").
- meaning_vi: what the customer wrote and what they want, in Vietnamese.
- reply: the message to send, in the customer's language.
- reply_vi: a faithful Vietnamese translation of reply, so the sales person knows exactly what they are sending.
- check_vi: what the sales person must check, add or decide before sending (missing price, a photo to attach, a promise to confirm...). Empty string if nothing.

Knowledge:
`;

const ASSISTANT_SCHEMA = {
  type: 'object',
  properties: {
    customer_language: { type: 'string' },
    meaning_vi: { type: 'string' },
    reply: { type: 'string' },
    reply_vi: { type: 'string' },
    check_vi: { type: 'string' },
  },
  required: ['customer_language', 'meaning_vi', 'reply', 'reply_vi', 'check_vi'],
  additionalProperties: false,
};

const keyMatches = (given, expected) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

app.get('/assistant', (_req, res) =>
  res.type('html').send(fs.readFileSync(new URL('./assistant.html', import.meta.url), 'utf8')));

app.post('/assistant/draft', async (req, res) => {
  if (!ASSISTANT_KEY) return res.status(503).json({ error: 'Chưa đặt ASSISTANT_KEY trên máy chủ.' });
  if (!keyMatches(req.get('x-assistant-key'), ASSISTANT_KEY)) return res.status(401).json({ error: 'Sai mật khẩu.' });
  if (!anthropic) return res.status(503).json({ error: 'Chưa có ANTHROPIC_API_KEY trên máy chủ.' });

  const message = String(req.body?.message || '').trim().slice(0, 6000);
  const notes = String(req.body?.notes || '').trim().slice(0, 2000);
  const variant = req.body?.variant === 'shorter' ? 'shorter' : '';
  if (!message) return res.status(400).json({ error: 'Anh chưa dán tin nhắn của khách.' });

  const today = new Date().toISOString().slice(0, 10);
  if (assistantUsage.day !== today) Object.assign(assistantUsage, { day: today, count: 0 });
  if (assistantUsage.count >= ASSISTANT_DAILY_LIMIT) {
    return res.status(429).json({ error: `Hôm nay đã dùng hết ${ASSISTANT_DAILY_LIMIT} lượt, mai dùng tiếp nhé.` });
  }

  let content = `Customer's message(s), pasted by the sales person (may include earlier chat lines):\n<customer>\n${message}\n</customer>`;
  if (notes) content += `\n\nSeller's notes (Vietnamese, true facts to use):\n<notes>\n${notes}\n</notes>`;
  if (variant === 'shorter') content += '\n\nMake the reply as short as possible: one or two sentences.';

  try {
    const r = await anthropic.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ASSISTANT_SCHEMA } },
      system: [{ type: 'text', text: ASSISTANT_PROMPT + loadKnowledge(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });
    if (r.stop_reason === 'refusal') return res.status(422).json({ error: 'AI từ chối soạn câu này, Anh tự trả lời giúp nhé.' });
    const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    assistantUsage.count++;
    res.json(JSON.parse(text));
  } catch (e) {
    console.error('Lỗi trợ lý soạn trả lời:', e.message);
    res.status(502).json({ error: 'AI đang lỗi, Anh thử lại sau ít phút.' });
  }
});

// Giao việc Sale: xem trước (không gửi) và gửi ngay để thử. Cần ?key=<ASSISTANT_KEY>
app.get('/daily-task/preview', (req, res) => {
  if (!ASSISTANT_KEY || !keyMatches(req.query.key, ASSISTANT_KEY)) return res.status(401).send('Sai mật khẩu.');
  const { messages } = buildDailyTask();
  res.type('text/plain').send(messages.join('\n\n----------\n\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
});
app.get('/daily-task/send-now', async (req, res) => {
  if (!ASSISTANT_KEY || !keyMatches(req.query.key, ASSISTANT_KEY)) return res.status(401).send('Sai mật khẩu.');
  try { await dailyTask.send(); res.send('Đã gửi giao việc vào nhóm Telegram ✅'); }
  catch (e) { res.status(502).send(`Lỗi gửi Telegram: ${e.message}`); }
});

app.get('/', (_req, res) => res.send('IG auto-reply bot đang chạy ✅'));

// Kiểm tra cấu hình mà không lộ giá trị bí mật
app.get('/status', (_req, res) => res.json({
  IG_ACCESS_TOKEN: igToken ? `có (${igToken.length} ký tự)` : 'THIẾU',
  tokenHetHan: igTokenExpiresAt ? new Date(igTokenExpiresAt).toISOString().slice(0, 10) : 'chưa rõ (gia hạn lần đầu sau 24h)',
  IG_APP_SECRET: IG_APP_SECRET ? 'có' : 'THIẾU',
  VERIFY_TOKEN: VERIFY_TOKEN ? 'có' : 'THIẾU',
  traLoiBangAI: AI_ENABLED ? `BẬT (${AI_NAMES})` : 'TẮT – thiếu ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY, đang dùng rules.json',
  cauAIHomNay: `${aiUsage.total}/${AI_DAILY_LIMIT}`,
  whatsapp: WA_ENABLED ? `BẬT (${WA_PROVIDER})` : 'TẮT – thiếu WA_TOKEN' + (WA_PROVIDER === 'meta' ? '/WA_PHONE_NUMBER_ID' : ''),
  emailBaoKhach: mailer ? `BẬT -> ${process.env.LEAD_EMAIL_TO}` : 'TẮT – thiếu SMTP_HOST/LEAD_EMAIL_TO',
  telegramBaoKhach: TELEGRAM_ENABLED ? `BẬT (${TELEGRAM_CHAT_IDS.length} chat)` : 'TẮT – thiếu TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID',
  giaoViecSaleTelegram: dailyTask.status(),
  troLySoanTraLoi: ASSISTANT_KEY && anthropic ? `BẬT (/assistant, hôm nay ${assistantUsage.count}/${ASSISTANT_DAILY_LIMIT})` : 'TẮT – thiếu ASSISTANT_KEY hoặc ANTHROPIC_API_KEY',
  khachCanBaoGia: leads.length,
  DRY_RUN,
  HUMAN_PAUSE_HOURS: HUMAN_PAUSE_MS / 3600000,
  khachDangTamDung: [...pausedUntil.values()].filter((t) => t > Date.now()).length,
}));

// Meta yêu cầu URL chính sách quyền riêng tư để đăng app
app.get('/privacy', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chính sách quyền riêng tư – KLD Global Hair</title>
<body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6">
<h1>Chính sách quyền riêng tư</h1>
<p>Ứng dụng KLD AutoReply do KLD Global Hair vận hành, dùng để tự động trả lời tin nhắn và bình luận gửi đến tài khoản Instagram @kld_global_hair và số WhatsApp +84 88 839 9896.</p>
<h2>Dữ liệu chúng tôi xử lý</h2>
<p>Khi bạn nhắn tin hoặc bình luận cho @kld_global_hair, hoặc nhắn WhatsApp cho chúng tôi, ứng dụng nhận nội dung tin nhắn, tên hiển thị và ID Instagram / số WhatsApp của bạn qua API chính thức của Meta, để trả lời và để đội bán hàng gửi báo giá khi bạn yêu cầu. Nội dung tin nhắn được xử lý bởi dịch vụ AI của Anthropic (dự phòng: OpenAI, Google Gemini) để soạn câu trả lời.</p>
<h2>Lưu trữ</h2>
<p>Chúng tôi không lưu trữ lâu dài, không bán và không chia sẻ dữ liệu của bạn cho bên thứ ba. Dữ liệu tạm thời chỉ nằm trong bộ nhớ máy chủ và bị xóa khi máy chủ khởi động lại.</p>
<h2>Xóa dữ liệu</h2>
<p>Bạn có thể yêu cầu xóa dữ liệu bất cứ lúc nào bằng cách nhắn tin cho @kld_global_hair hoặc gửi email tới binhan153@gmail.com.</p>
</body>`));

app.listen(PORT, () => {
  console.log(`Bot chạy tại cổng ${PORT}${DRY_RUN ? ' (DRY_RUN – không gửi tin thật)' : ''}`);
  if (!IG_ACCESS_TOKEN && !DRY_RUN) console.warn('⚠️  Thiếu IG_ACCESS_TOKEN');
  console.log(AI_ENABLED ? `Trả lời bằng AI: BẬT (${AI_NAMES})` : 'Trả lời bằng AI: TẮT (chưa có khóa AI nào) – dùng rules.json');
  refreshIgToken();
  setInterval(refreshIgToken, 24 * 60 * 60 * 1000);
  // Giữ bot luôn thức trên Render gói Free (ngủ sau 15 phút không có request), để Meta không bị timeout khi gửi tin
  const selfUrl = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (selfUrl && !DRY_RUN) {
    setInterval(() => fetch(`${selfUrl}/`).catch(() => {}), 10 * 60 * 1000);
    console.log(`Giữ thức: tự ping ${selfUrl} mỗi 10 phút`);
  }
});
