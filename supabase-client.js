import { createClient } from '@supabase/supabase-js';

export function getAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("SUPABASE_URL или SERVICE_ROLE_KEY не заданы в переменных окружения!");
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}