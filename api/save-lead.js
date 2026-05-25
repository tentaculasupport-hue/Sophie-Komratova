import { getAdminClient } from '../supabase-client.js';

export default async function handler(req, res) {
  // Разрешаем только POST запросы
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, phone } = req.body;

  // Простая валидация
  if (!name || !phone) {
    return res.status(400).json({ error: 'Имя и телефон обязательны для заполнения' });
  }

  try {
    const supabase = getAdminClient();
    
    const { error } = await supabase
      .from('leads_web')
      .insert([{ name, phone, source: 'landing_page' }]);

    if (error) throw error;

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Lead Save Error:', error);
    return res.status(500).json({ error: 'Ошибка сервера при сохранении данных' });
  }
}