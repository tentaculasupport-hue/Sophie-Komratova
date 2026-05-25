import { createClient } from '@supabase/supabase-js';

// Используем Service Role Key для доступа к БД с правами администратора
// Никогда не свети этот ключ на фронтенде!
export function getAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Отсутствуют переменные окружения SUPABASE_URL или SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}