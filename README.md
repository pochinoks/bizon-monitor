# BizonMonitor

Мониторит чат вебинаров Bizon365 и пересылает живые сообщения в Telegram.
Работает автономно на сервере — браузер не нужен.

## Деплой на Railway (5 минут)

### 1. Получи SID из браузера
1. Открой любой вебинар Bizon365
2. F12 → Application → Cookies → start.bizon365.ru
3. Найди cookie с именем `sid`, скопируй значение
4. Вставь в `index.js` в поле `SID:`

### 2. Задеплой на Railway
1. Зарегистрируйся на railway.app
2. New Project → Deploy from GitHub repo
   ИЛИ: установи Railway CLI и выполни:
   ```
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
3. Railway сам запустит `node index.js`

### 3. Обновление SID
SID живёт ~1 месяц. Когда перестанет работать:
1. Повтори шаг 1
2. Обнови переменную в Railway → Variables → SID
   (лучше вынести SID в переменную окружения)

## Расписание (UTC)
- Лето (EDT): NY 12:00 = UTC 16:00, NY 19:00 = UTC 23:00
- Зима (EST): NY 12:00 = UTC 17:00, NY 19:00 = UTC 00:00

Поменяй `scheduleUTC` в конфиге при смене сезона.
