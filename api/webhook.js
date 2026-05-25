import { getAdminClient } from '../supabase-client.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const body = req.body;
  if (!body || typeof body !== 'object') {
    const supabase = getAdminClient();
    await supabase.from('system_logs').insert([{ 
      level: 'warn', 
      source: 'api/webhook', 
      message: "Отримано некоректний JSON від Telegram",
      details: { error: "Empty or invalid JSON body" }
    }]);
    return res.status(400).send('Invalid JSON');
  }

  const { message } = body;
  if (!message || !message.text) return res.status(200).send('OK');

  const supabase = getAdminClient();

  let actualOwnerId = req.query.owner_id;

  const chatId = message.chat.id;
  const stringChatId = String(chatId);
  const cleanTgUsername = message.from?.username ? message.from.username.replace('@', '').trim() : null;
  const userText = message.text;

  if (userText === '/clear' || userText === '/reset') {
    if (cleanTgUsername) {
      await supabase.from('leads').delete().in('contact_info', [cleanTgUsername, `@${cleanTgUsername}`]);
    }
    await supabase.from('chat_histories').delete().eq('chat_id', stringChatId);
    // Видаляємо ліда за всіма можливими варіантами ID чату (стандартний та фолбек)
    await supabase.from('leads').delete().eq('contact_info', `ID: ${chatId}`);
    await supabase.from('leads').delete().eq('contact_info', `TG-Chat: ${chatId}`);

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chatId, 
        text: "🧹 **ПРОТОКОЛ ОЧИЩЕННЯ**: Історію діалогу та дані ліда видалено." 
      })
    });
    return res.status(200).send('OK');
  }

  await processLead(supabase, chatId, userText, actualOwnerId, cleanTgUsername);
  return res.status(200).send('OK');
}

async function processLead(supabase, chatId, userText, ownerId, cleanTgUsername) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const stringChatId = String(chatId);
  let actualOwnerId = ownerId;

  // 0. ФІЛЬТР ШУМУ ТА ЕМОДЗІ (Anti-Wake Logic)
  // Ігноруємо ТІЛЬКИ якщо в повідомленні немає жодної літери або цифри (чистий шум)
  const hasSemanticContent = /[a-zA-Zа-яА-Я0-9ієїґІЄЇҐ]/.test(userText);
  
  if (!hasSemanticContent) {
    console.log(`[CLEANUP] Повідомлення від ${chatId} класифіковано як шум. Ігнорування Groq-сесії.`);
    // Просто оновлюємо час останньої активності в історії без виклику ШІ
    await supabase.from('chat_histories').update({ updated_at: new Date().toISOString() }).eq('chat_id', stringChatId);
    return;
  }

  // 0.5. ДИНАМІЧНЕ ЗАВАНТАЖЕННЯ НАЛАШТУВАНЬ ТА ПРОМПТУ (Одним запитом)
  // 🟢 СТАЛО: Поиск промта для Алины в новой структуре таблицы prompts
  const { data: botPrompt, error: promptError } = await supabase
    .from('prompts')
    .select('*')
    .eq('agent_name', 'alina')
    .single();

  if (promptError || !botPrompt) {
    console.error("Промт для 'alina' не найден в базе данных. Проверь таблицу prompts.");
    throw new Error("Не вдалося завантажити базові налаштування бота для Алины.");
  }

  const greetingText = botPrompt.greeting_text || "Добрий день! Мене звати Олег. Чим я можу допомогти?";
  const paymentLink = botPrompt.payment_link || "https://tentacula-project.vercel.app/index.html";

  // 1. Перевіряємо команду /start з pythagoras_hash (UUID)
  const startCommandMatch = userText.match(/^\/start\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  let pythagorasHashFromStart = null;

  if (startCommandMatch) {
    pythagorasHashFromStart = startCommandMatch[1];
    console.log(`[WEBHOOK] Отримано команду /start з Pythagoras Hash: ${pythagorasHashFromStart}`);

    // Спробуємо знайти користувача auth за цим хешем
    const { data: authUserByHash, error: authHashErr } = await supabase
      .from('auth')
      .select('id, tg_chat_id, tg_username')
      .eq('pythagoras_hash', pythagorasHashFromStart)
      .maybeSingle();

    if (authUserByHash && authUserByHash.id) {
      actualOwnerId = authUserByHash.id; // Цей користувач є власником
      console.log(`[WEBHOOK] Зв'язано з користувачем auth ID: ${actualOwnerId} через Pythagoras Hash.`);

      // Якщо Telegram chat ID або username ще не прив'язані, оновлюємо їх
      if (authUserByHash.tg_chat_id !== String(chatId) || authUserByHash.tg_username !== cleanTgUsername) {
        await supabase.from('auth').update({
          tg_chat_id: String(chatId),
          tg_username: cleanTgUsername,
          pythagoras_hash: null // Очищаємо хеш після успішного зв'язування
        }).eq('id', actualOwnerId);
        console.log(`[WEBHOOK] Оновлено користувача auth ${actualOwnerId} даними Telegram.`);
      }
    } else if (authHashErr) {
      console.error("[WEBHOOK] Помилка пошуку користувача auth за Pythagoras Hash:", authHashErr.message);
    }
  }

  // 2. Якщо actualOwnerId все ще не встановлено (наприклад, не команда /start з хешем, або хеш не знайдено)
  // спробуємо знайти власника за існуючими даними Telegram
  if (!actualOwnerId) {
    let { data: userAuth } = await supabase
      .from('auth')
      .select('id, tg_chat_id, tg_username')
      .eq('tg_chat_id', String(chatId))
      .maybeSingle();

    if (!userAuth && cleanTgUsername) {
      const { data: userByNick } = await supabase
        .from('auth')
        .select('id, tg_chat_id, tg_username')
        .eq('tg_username', cleanTgUsername)
        .maybeSingle();
      
      if (userByNick) {
        userAuth = userByNick;
        if (!userByNick.tg_chat_id) { // Оновлюємо tg_chat_id, якщо знайдено за нікнеймом і ще не встановлено
          await supabase.from('auth').update({ tg_chat_id: String(chatId) }).eq('id', userByNick.id);
        }
      }
    }

    if (userAuth && userAuth.id) {
      actualOwnerId = userAuth.id;
      console.log(`[WEBHOOK] Зв'язано з користувачем auth ID: ${actualOwnerId} через існуючі дані Telegram.`);
    }
  }

  // 3. Фолбек, якщо власника ще не знайдено (ні з URL, ні за хешем, ні за існуючими даними Telegram)
  if (!actualOwnerId) {
    // Якщо owner_id не було передано в URL і користувача не зв'язано через дані Telegram,
    // спробуємо знайти першого Альфа-користувача як фолбек
    const { data: alphaUser } = await supabase
      .from('auth')
      .select('id')
      .eq('role', 'alpha')
      .limit(1)
      .single();
    if (alphaUser) actualOwnerId = alphaUser.id;
    console.log(`[WEBHOOK] Використовуємо Альфа-користувача ID: ${actualOwnerId} як власника (фолбек).`);
  }

  // ОПТИМІЗАЦІЯ /START (0 токенів + збереження в CRM)
  if (userText === '/start' || pythagorasHashFromStart) { // Обробляємо як /start, так і /start <hash>
    // ПЕРЕВІРКА НА СПАМ /START
    const { data: recentHistory } = await supabase
      .from('chat_histories')
      .select('updated_at')
      .eq('chat_id', stringChatId)
      .maybeSingle();

    if (recentHistory) {
      const lastUpdate = new Date(recentHistory.updated_at).getTime();
      // Якщо /start натиснуто менше ніж 10 секунд тому — ігноруємо важку логіку
      if (Date.now() - lastUpdate < 10000) {
        console.log(`[SECURITY] Блокування спам-запиту /start для ${chatId}`);
        return;
      }
    }

    const botReply = greetingText;
    
    // 1. Створюємо запис історії (статус completed, бо привітання не потребує аналізу)
    await supabase.from('chat_histories').upsert({
      chat_id: stringChatId, 
      messages: [
        { role: "user", content: userText }, // Додаємо повідомлення користувача /start
        { role: "assistant", content: botReply }
      ],
      analysis_status: 'completed',
      owner_id: actualOwnerId,
      updated_at: new Date().toISOString() 
    }, { onConflict: 'chat_id' });

    // 2. Реєструємо ліда, щоб він миттєво з'явився в дашборді
    const leadData = {
      name: 'Unknown', 
      contact_info: cleanTgUsername ? `@${cleanTgUsername}` : 'Не вказано',
      platform: 'Telegram',
      raw_data: userText,
      status: 'new'
    };
    await upsertLead(supabase, leadData, chatId, false, actualOwnerId, botReply, botToken, paymentLink);
    return; // Вихід: повідомлення відправлено, БД оновлена, Groq не викликався
  }

  // 1. ЗЧИТУВАННЯ ІСТОРІЇ
  const { data: dbData } = await supabase
    .from('chat_histories')
    .select('messages')
    .eq('chat_id', stringChatId)
    .maybeSingle();

  let currentHistory = (dbData && Array.isArray(dbData.messages)) ? dbData.messages : [];
  currentHistory.push({ role: "user", content: userText });

  // СИСТЕМА ТОЧЕЧНОГО ТРИГГЕРНОГО ПЕРЕХВАТА СЦЕНАРИЕВ
  let systemInstruction = botPrompt.content;
  let injectionMessage = null; // Флаг для отдельного системного сообщения
  
  try {
    // ИСПРАВЛЕНИЕ 1: Точные названия колонок из базы. Убран owner_id, так как его нет в таблице.
    const { data: triggers, error: selectErr } = await supabase
      .from('objection_knowledge_base')
      .select('objection_keyword, ai_strategy');

    if (selectErr) throw selectErr;

    if (triggers && triggers.length > 0) {
      const cleanUserText = userText.toLowerCase();
      
      // ИСПРАВЛЕНИЕ 2: Режем строку базы по запятым и проверяем ТОЧНОЕ СОВПАДЕНИЕ СЛОВА
      const matchedTrigger = triggers.find(t => {
        if (!t.objection_keyword) return false;
        const keywords = t.objection_keyword.toLowerCase().split(',').map(k => k.trim());
        
        return keywords.some(keyword => {
          // Регулярка: ищет ключевик, окруженный пробелами, пунктуацией или краями строки.
          // Игнорирует вхождения внутри других слов (защита от ложного срабатывания "ок" внутри "пока").
          const regex = new RegExp(`(?:^|[\\s.,!?()\\-"'])${keyword}(?:[\\s.,!?()\\-"']|$)`, 'i');
          return regex.test(cleanUserText);
        });
      });

      if (matchedTrigger) {
        console.log(`[TRIGGER FIRED] Перехват на слова: "${matchedTrigger.objection_keyword}"`);
        // ИСПРАВЛЕНИЕ 3: Выносим инструкцию в отдельное системное сообщение для Groq
        injectionMessage = {
          role: "system",
          content: `КРИТИЧНЕ ПРАВИЛО: Клієнт озвучив триггер, пов'язаний з "${matchedTrigger.objection_keyword}". Твоя єдина стратегія відведеної відповіді: ${matchedTrigger.ai_strategy}. Не пиши зайвого, відповідай суворо за цією стратегією.`
        };
      }
    }
  } catch (triggerErr) {
    console.error("[TRIGGER ERROR] Ошибка селектора сценариев:", triggerErr);
  }

  // Візуальний ефект друку
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: "typing" })
    });
  } catch (e) {}

  // Формування вікна контексту (останні 10 реплік)
  const messagesForGroq = [
    { role: "system", content: systemInstruction },
    // Берем историю, НО без самого последнего сообщения юзера
    ...currentHistory.slice(-10, -1).map(m => ({
      role: m.role,
      content: m.content
    }))
  ];

  // Вставляем ЖЕСТКУЮ инъекцию прямо ПЕРЕД последним сообщением юзера
  if (injectionMessage) {
    messagesForGroq.push(injectionMessage);
  }
  
  // Добавляем само текущее сообщение юзера в конец, чтобы Groq отвечал именно на него
  const lastMsg = currentHistory[currentHistory.length - 1];
  messagesForGroq.push({ role: lastMsg.role, content: lastMsg.content });

  let aiReply = "";

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
        top_p: 0.9,
        max_tokens: 350
      })
    });

    const contentType = response.headers.get("content-type");
    
    if (!response.ok || !contentType || !contentType.includes("application/json")) {
      const isRateLimit = response.status === 429;
      if (isRateLimit) {
        console.warn("[WEBHOOK] Groq Rate Limit Reached. Switching to protocol: MANUAL_QUEUE.");
        await supabase.from('system_logs').insert([{ 
          level: 'warn', 
          source: 'api/webhook', 
          message: "Groq Rate Limit (Webhook)",
          details: { chat_id: stringChatId }
        }]);
      } else {
        const rawText = await response.text();
        console.error("API повернув сміття замість JSON:", rawText.slice(0, 100));
        await supabase.from('system_logs').insert([{ 
          level: 'error', 
          source: 'api/webhook', 
          message: "Groq returned non-JSON response",
          details: { status: response.status, body: rawText.slice(0, 200) }
        }]);
      }
      throw new Error(isRateLimit ? "RATE_LIMIT" : "JSON_ERROR");
    }

    const data = await response.json();
    
    if (data.error) throw new Error(data.error.message);

    let botReply = data.choices[0].message.content.trim();
    let leadSystemStatus = 'new';

    if (botReply.includes('[BLOCK_USER]')) {
      leadSystemStatus = 'blocked';
      botReply = botReply.replace('[BLOCK_USER]', '').trim();
      console.log(`[SECURITY] ИИ инициировал блокировку токсичного пользователя: ${chatId}`);
    }

    currentHistory.push({ role: "assistant", content: botReply });

    await supabase
      .from('chat_histories')
      .upsert({ 
        chat_id: stringChatId, 
        messages: currentHistory,
        analysis_status: 'pending', 
        owner_id: actualOwnerId,
        updated_at: new Date().toISOString() 
      }, { onConflict: 'chat_id' });

    const leadData = {
      name: cleanTgUsername || 'Anonymous', 
      contact_info: cleanTgUsername ? `@${cleanTgUsername}` : `ID: ${chatId}`,
      platform: 'Telegram',
      raw_data: userText,
      status: leadSystemStatus === 'blocked' ? 'blocked' : 'new'
    };

    if (userText === '/start') {
      leadData.name = 'Unknown';
      leadData.contact_info = cleanTgUsername ? `@${cleanTgUsername}` : 'Не вказано';
    }

    await upsertLead(supabase, leadData, chatId, false, actualOwnerId, botReply, botToken, paymentLink);

  } catch (err) {
    console.error("[WEBHOOK CATCH]:", err.message);
    
    await supabase.from('system_logs').insert([{ 
      level: 'error', 
      source: 'api/webhook', 
      message: `Критична помилка обробки повідомлення: ${err.message}`,
      details: { chat_id: stringChatId }
    }]);

    await supabase.from('chat_histories').upsert({ 
      chat_id: stringChatId, 
      messages: currentHistory,
      analysis_status: 'pending',
      owner_id: actualOwnerId,
      updated_at: new Date().toISOString() 
    }, { onConflict: 'chat_id' });

    await fallbackSave(supabase, chatId, userText, actualOwnerId, botToken, cleanTgUsername, paymentLink || "https://tentacula-project.vercel.app/index.html");
  }
}

async function fallbackSave(supabase, chatId, text, ownerId, botToken, cleanTgUsername, paymentLink) {
  const leadData = {
    name: 'Manual Check Needed', 
    contact_info: (text === '/start') ? (cleanTgUsername ? `@${cleanTgUsername}` : 'Не вказано') : `TG-Chat: ${chatId}`,
    platform: 'Telegram', 
    raw_data: text, 
    status: 'new'
  };

  try {
    await upsertLead(supabase, leadData, chatId, true, ownerId, null, botToken, paymentLink);
  } catch (err) {
    console.error("КРИТИЧНА ПОМИЛКА БД:", err.message);
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `❌ Помилка бази даних: ${err.message}` })
    });
  }
}

    async function upsertLead(supabase, leadData, chatId, isFallback = false, ownerId, aiReply = null, botToken, paymentLink) {
  const contactInfo = leadData.contact_info;

  const { data: existingLeads, error: selectError } = await supabase
    .from('leads')
    .select('id')
    .eq('contact_info', contactInfo);

  if (selectError) {
    console.error('Ошибка при поиске дубликатов:', selectError.message);
    throw selectError;
  }

  let telegramMessage = '';
  let dbOperationError = null;

  if (existingLeads && existingLeads.length > 0) {
    const existingLeadId = existingLeads[0].id;

    const updatePayload = {
      raw_data: leadData.raw_data,
      status: 'updated',
      owner_id: ownerId
    };

    if (leadData.name && leadData.name !== 'Unknown' && leadData.name !== 'Manual Check Needed') {
      updatePayload.name = leadData.name;
    }

    const { error: updateError } = await supabase
      .from('leads')
      .update(updatePayload)
      .eq('id', existingLeadId);

    if (updateError) {
      console.error('ОШИБКА ОБНОВЛЕНИЯ ДУБЛИКАТА:', updateError.message);
      dbOperationError = updateError;
    } else {
      if (aiReply) {
        telegramMessage = aiReply;
      } else if (isFallback) {
        telegramMessage = "⚠️ **ТЕХНІЧНИЙ ПРОТОКОЛ**: Наразі спостерігається тимчасова затримка в обробці нейронного зв'язку. Наші інженери вже працюють над вирішенням ситуації. Ваш запит надійно зафіксовано в системі — менеджер зв'яжеться з Вами найближчим часом.";
      }
    }
  } else {
    const finalLeadData = { ...leadData, owner_id: ownerId };

    const { error: insertError } = await supabase.from('leads').insert([finalLeadData]);

    if (insertError) {
      console.error('ОШИБКА БАЗЫ:', insertError.message);
      dbOperationError = insertError;
    } else {
      if (aiReply) {
        telegramMessage = aiReply;
      } else {
        telegramMessage = isFallback
          ? "⚠️ **ТЕХНІЧНИЙ ПРОТОКОЛ**: Наразі спостерігається тимчасова затримка в обробці нейронного зв'язку. Наші інженери вже працюють над вирішенням ситуації. Ваш запит надійно зафіксовано в системі — менеджер зв'яжеться з Вами найближчим часом."
          : `✅ **ЗАПИТ ЗАФІКСОВАНО**\n👤 Ім'я: ${leadData.name}\n📞 Контакт: ${leadData.contact_info}`;
      }
    }
  }

  if (dbOperationError) {
    throw dbOperationError;
  }

  if (!telegramMessage) return;

  let finalReply = telegramMessage;

  // ГАРАНТІЯ НАЯВНОСТІ ЛІНКА (Захист від зливу клієнта)
  const validPaymentLink = paymentLink || "https://tentacula-project.vercel.app/index.html"; 
  
  // 1. Спочатку чистимо стандартні теги-заглушки
  finalReply = finalReply.replace(/\[вставити лінк на оплату\]/gi, validPaymentLink)
                         .replace(/\[вставити лінк\]/gi, validPaymentLink);

  // 2. Жорсткий перехват: Якщо клієнт погодився...
  const lowerReply = finalReply.toLowerCase();
  const lowerUserText = (leadData.raw_data || '').toLowerCase();
  
  if ((lowerUserText === 'так' || lowerUserText.includes('давай') || lowerUserText.includes('лінк')) && 
      (lowerReply.includes('посилання') || lowerReply.includes('реєстрац')) && 
      !lowerReply.includes('http')) {
    finalReply += `\n\nОсь ваше посилання для початку роботи: ${validPaymentLink}`;
  }

  const tgResponseJson = {
    chat_id: chatId,
    text: finalReply
  };

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tgResponseJson)
    });

    if (!response.ok) {
      throw new Error(`Telegram rejected HTML: ${response.statusText}`);
    }
  } catch (error) {
    console.error("[TELEGRAM ERROR] Сбой разметки, отправляем чистый текст:", error);
    
    const fallbackJson = {
      chat_id: chatId,
      text: telegramMessage
    };

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fallbackJson)
    });
  }
}