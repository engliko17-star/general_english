// Настройки сайта.
// Это публичный ключ (anon): его можно держать в коде сайта, данные защищают правила доступа в базе.
// Если стереть SUPABASE_URL, сайт работает в демо-режиме: показывает демо-учебник,
// а ответы хранит только в этом браузере.
// Где взять значения: Supabase → Project Settings → API → Project URL и anon public key.
window.APP_CONFIG = {
  SITE_NAME: 'English Platform',
  SUPABASE_URL: 'https://qkiydyurwvgsdoysihsv.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFraXlkeXVyd3Znc2RveXNpaHN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwODU5NTIsImV4cCI6MjEwODY2MTk1Mn0.R5X3xR-729dj2KOQzA9dhdEg2RhaLhAcvrS-EQ35tZk'
};
