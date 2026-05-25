export default function handler(req, res) {
  // Отдаем только публичные ключи. SERVICE_ROLE_KEY светить нельзя!
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
}