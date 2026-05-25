import { getAdminClient } from '../supabase-client.js';

export default async function handler(req, res) {
  // Жесткий фильтр метода: если это браузер (GET), отдаем 200 и не падаем
  if (req.method !== 'POST') {
    return res.status(200).json({ status: "alive", message: "Send POST request" });
  }

  // Безопасный парсинг тела запроса
  const body = req.body || {};
  const { message } = body;
  
  if (!message || !message.text) return res.status(200).send('OK');

  const supabase = getAdminClient();
  const chatId = message.chat.id;
  const cleanTgUsername = message.from?.username ? message.from.username.replace('@', '').trim() : null;
  const userText = message.text;

  // Протокол очистки диалога
  if (userText === '/clear' || userText === '/reset') {
    await supabase.from('chat_histories').delete().eq('chat_id', String(chatId));
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: "🧹 Память диалога очищена." })
    });
    return res.status(200).send('OK');
  }

  await processLead(supabase, chatId, userText, cleanTgUsername);
  return res.status(200).send('OK');
}

async function processLead(supabase, chatId, userText, cleanTgUsername) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const stringChatId = String(chatId);

  // 0. ФИЛЬТР ШУМА
  const hasSemanticContent = /[a-zA-Zа-яА-Я0-9ієїґІЄЇҐ]/.test(userText);
  if (!hasSemanticContent) return;

  // 1. ЗАГРУЗКА НАСТРОЕК АГЕНТА ИЗ БАЗЫ
  const { data: botPrompt, error: promptError } = await supabase
    .from('prompts')
    .select('system_instruction, temperature')
    .eq('agent_name', 'alina')
    .single();

  if (promptError || !botPrompt) {
    console.error("КРИТИЧЕСКАЯ ОШИБКА: Промт для 'alina' не найден в таблице prompts.");
    return;
  }

  // Инструктируем ИИ завершать диалог ссылкой на раздел "Обо мне"
  const systemInstruction = `${botPrompt.system_instruction}\n\nВАЖНО: Когда диалог будет подходить к завершению (после ответов на все вопросы или при прощании), обязательно предложи пользователю узнать больше о тебе, перейдя по ссылке: https://sophie-komratova.vercel.app/#about`;

  // 2. ЧТЕНИЕ ИСТОРИИ ДИАЛОГА
  const { data: dbData } = await supabase
    .from('chat_histories')
    .select('messages')
    .eq('chat_id', stringChatId)
    .maybeSingle();

  let currentHistory = (dbData && Array.isArray(dbData.messages)) ? dbData.messages : [];
  currentHistory.push({ role: "user", content: userText });

  // 3. ПЕРЕХВАТ ТРИГГЕРОВ (Отработка возражений)
  let injectionMessage = null;
  try {
    const { data: triggers } = await supabase
      .from('objection_knowledge_base')
      .select('objection_trigger, approved_response')
      .eq('is_active', true);

    if (triggers && triggers.length > 0) {
      const cleanUserText = userText.toLowerCase();
      const matchedTrigger = triggers.find(t => {
        if (!t.objection_trigger) return false;
        const keywords = t.objection_trigger.toLowerCase().split(',').map(k => k.trim());
        return keywords.some(keyword => {
          const regex = new RegExp(`(?:^|[\\s.,!?()\\-"'])${keyword}(?:[\\s.,!?()\\-"']|$)`, 'i');
          return regex.test(cleanUserText);
        });
      });

      if (matchedTrigger) {
        injectionMessage = {
          role: "system",
          content: `КРИТИЧЕСКОЕ ПРАВИЛО: Клиент озвучил триггер "${matchedTrigger.objection_trigger}". Отвечай строго по этой стратегии: ${matchedTrigger.approved_response}.`
        };
      }
    }
  } catch (triggerErr) {
    console.error("[TRIGGER ERROR]:", triggerErr);
  }

  // 4. ФОРМИРОВАНИЕ ПАМЯТИ ДЛЯ GROQ
  const messagesForGroq = [
    { role: "system", content: systemInstruction },
    ...currentHistory.slice(-10, -1).map(m => ({ role: m.role, content: m.content }))
  ];

  if (injectionMessage) messagesForGroq.push(injectionMessage);

  const lastMsg = currentHistory[currentHistory.length - 1];
  messagesForGroq.push({ role: lastMsg.role, content: lastMsg.content });

  // 5. ЗАПРОС К ИИ
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: messagesForGroq,
        temperature: botPrompt.temperature ?? 0.7,
        max_tokens: 350
      })
    });

    if (!response.ok) throw new Error(`Groq API Status: ${response.status}`);

    const data = await response.json();
    const botReply = data.choices[0].message.content.trim();

    currentHistory.push({ role: "assistant", content: botReply });

    // Сохраняем историю
    await supabase.from('chat_histories').upsert({
      chat_id: stringChatId,
      messages: currentHistory,
      updated_at: new Date().toISOString()
    }, { onConflict: 'chat_id' });

    // Отправляем ответ в Telegram
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: botReply })
    });

    // Фиксируем лида в базе
    await upsertLead(supabase, chatId, cleanTgUsername, userText);

  } catch (err) {
    console.error("[WEBHOOK CATCH]:", err.message);
  }
}

async function upsertLead(supabase, chatId, cleanTgUsername, text) {
  const contactInfo = cleanTgUsername ? `@${cleanTgUsername}` : `ID: ${chatId}`;

  const { data: existingLeads } = await supabase
    .from('leads')
    .select('id')
    .eq('phone', contactInfo);

  if (existingLeads && existingLeads.length > 0) {
    await supabase.from('leads').update({
      business_info: text
    }).eq('id', existingLeads[0].id);
  } else {
    await supabase.from('leads').insert([{
      name: cleanTgUsername || 'Anonymous',
      phone: contactInfo,
      business_info: text,
      agent_id: 'alina'
    }]);
  }
}