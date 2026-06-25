const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ══════════════════════════════════════════════
//  КОНФИГ — заполни перед деплоем
// ══════════════════════════════════════════════
const CONFIG = {
    EMAIL:    process.env.BIZON_EMAIL    || '',
    PASSWORD: process.env.BIZON_PASSWORD || '',

    TELEGRAM_BOT_TOKEN: '7042614949:AAES145MXfqlepexPK5koDy10TWPZYi6k5k',
    TELEGRAM_CHAT_ID:   '-5279036150',

    GROUP: '18626',

    // Расписание в UTC. Сейчас лето: NY 12:00 = UTC 16:00, NY 19:00 = UTC 23:00
    // Зимой поменять на 17:00 и 00:00
    WEBINARS: [
        { room: 'ai_avatar_challenge',  scheduleUTC: ['16:00'] },
        { room: 'ai_avatar_challenge2', scheduleUTC: ['16:00'] },
        { room: 'ai_avatar_challenge3', scheduleUTC: ['16:00'] },
        { room: 'ai_extra_income',      scheduleUTC: ['16:00', '23:00'] },
    ],

    // Сколько минут слушать вебинар после подключения
    LISTEN_DURATION_MINUTES: 120,

    // За сколько минут до старта подключаться
    CONNECT_BEFORE_MINUTES: 2,
};
// ══════════════════════════════════════════════

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function httpsGet(hostname, path, headers) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname, path, method: 'GET', headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                resolve({ status: res.statusCode, headers: res.headers, body });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function httpsPost(hostname, path, headers, postData) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(postData) } }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, body }); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function sendTelegram(text) {
    const body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    try {
        await httpsPost('api.telegram.org', `/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
            { 'Content-Type': 'application/json' }, body);
    } catch(e) {
        log(`Telegram error: ${e.message}`);
    }
}

const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Логин на bizon365, возвращает декодированный sid
async function login() {
    log('Логин на bizon365...');

    // Шаг 1: GET /my/login — получаем sid сессии и captcha значения
    const loginPage = await httpsGet('start.bizon365.ru', '/my/login', {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    });
    const setCookies1 = loginPage.headers['set-cookie'] || [];
    const sidCookieRaw = setCookies1.map(c => c.split(';')[0]).find(c => c.startsWith('sid='));
    const sidEncoded = sidCookieRaw ? sidCookieRaw.slice(4) : '';
    const sidDecoded = decodeURIComponent(sidEncoded);
    log(`Login page status: ${loginPage.status}`);

    // Извлекаем captcha параметры из HTML
    const cap1Match = loginPage.body.match(/captcha_1\s*=\s*'([^']+)'/);
    const cap2Match = loginPage.body.match(/captcha_2\s*=\s*'([^']+)'/);
    const captcha_1 = cap1Match ? Number(cap1Match[1]) : 0;
    const captcha_2 = cap2Match ? cap2Match[1] : '';
    log(`captcha_1: ${captcha_1}, captcha_2: ${captcha_2.slice(0, 15)}...`);

    // Шаг 2: POST /my/login/api/loginUser — JSON с декодированным SID
    const body = JSON.stringify({
        userlogin: CONFIG.EMAIL,
        password: CONFIG.PASSWORD,
        captcha_1,
        captcha_2,
    });
    const res = await httpsPost('start.bizon365.ru', '/my/login/api/loginUser', {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
        'Cookie': `sid=${sidDecoded}`,
        'Origin': 'https://start.bizon365.ru',
        'Referer': 'https://start.bizon365.ru/my/login',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': ua,
    }, body);

    log(`Login POST status: ${res.status}`);

    if (res.status !== 200) throw new Error(`Логин не удался: ${JSON.stringify(res.body).slice(0, 200)}`);

    // После успешного логина сервер обновляет sid в Set-Cookie
    const allCookies = (res.headers || {})['set-cookie'] || [];
    const newSidRaw = allCookies.map(c => c.split(';')[0]).find(c => c.startsWith('sid='));
    const sid = newSidRaw ? decodeURIComponent(newSidRaw.slice(4)) : sidDecoded;
    if (!sid) throw new Error('Логин не удался — sid не получен');

    log(`SID получен: ${sid.slice(0, 15)}...`);
    return sid;
}

// Получаем ssid/ssign через loadInitData
async function getTokens(roomSlug, sid) {
    const roomPath = `/room/${CONFIG.GROUP}/${roomSlug}`;
    const cookie = `sid=${sid}`;

    // Загружаем страницу комнаты чтобы получить _csrf и все cookies
    const pageRes = await httpsGet('start.bizon365.ru', roomPath, { 'Cookie': cookie, 'User-Agent': ua });
    log(`[${roomSlug}] Page status: ${pageRes.status}`);

    // Ищем признаки авторизации в теле страницы
    const isAuth = pageRes.body.includes('logout') || pageRes.body.includes('выйти') || pageRes.body.includes('ssid') || pageRes.body.includes('loadInitData');
    log(`[${roomSlug}] Authorized: ${isAuth}`);
    // Ищем CSRF в разных форматах
    const csrfPatterns = [
        /__bizon\._csrf\s*=\s*"([^"]+)"/,      // bizon365 room page
        /"_csrf"\s*:\s*"([^"]+)"/,
        /name="_csrf"\s+value="([^"]+)"/,
        /csrf[_-]?token["']?\s*[:=]\s*["']([^"']+)/i,
        /<meta[^>]+name="_csrf"[^>]+content="([^"]+)"/,
    ];
    let csrfFromBody = '';
    for (const p of csrfPatterns) {
        const m = pageRes.body.match(p);
        if (m) { csrfFromBody = m[1]; break; }
    }
    log(`[${roomSlug}] CSRF from body: ${!!csrfFromBody}`);
    log(`[${roomSlug}] Body snippet: ${pageRes.body.slice(0, 500).replace(/\s+/g, ' ')}`);

    // Собираем все Set-Cookie из ответа
    const setCookies = pageRes.headers['set-cookie'] || [];
    const extraCookies = setCookies.map(c => c.split(';')[0]).join('; ');
    const fullCookie = extraCookies ? `${cookie}; ${extraCookies}` : cookie;

    // CSRF: сначала из тела, иначе из cookie
    const csrfCookieMatch = setCookies.map(c => c.split(';')[0]).find(c => c.startsWith('_csrf='));
    const csrf = csrfFromBody || (csrfCookieMatch ? csrfCookieMatch.slice(6) : '');
    log(`[${roomSlug}] CSRF used: ${csrf.slice(0, 10)}`);

    // Запрашиваем токены, передаём все cookies
    const pd = `_csrf=${encodeURIComponent(csrf)}&ssid=&lang=1`;
    const res = await httpsPost('start.bizon365.ru', `${roomPath}/loadInitData`, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': fullCookie,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://start.bizon365.ru${roomPath}`,
        'User-Agent': ua,
    }, pd);

    if (!res.body || !res.body.ssid) {
        throw new Error(`Токены не получены: ${JSON.stringify(res.body).slice(0, 300)}`);
    }

    log(`[${roomSlug}] Токены OK. ssid=${res.body.ssid.slice(0,10)}...`);
    return { ssid: res.body.ssid, ssign: res.body.ssign, roomId: `${CONFIG.GROUP}:${roomSlug}` };
}

// Подключение к WebSocket
function connectWebSocket(roomSlug, ssid, ssign, roomId, durationMs) {
    return new Promise((resolve) => {
        const processed = new Set();
        let socket = null;
        let pingInterval = null;
        let finished = false;

        function finish(reason) {
            if (finished) return;
            finished = true;
            if (pingInterval) clearInterval(pingInterval);
            if (socket) { try { socket.destroy(); } catch(e){} }
            log(`[${roomSlug}] Отключён (${reason})`);
            resolve();
        }

        // Отправка WebSocket фрейма (клиент → сервер, с маскировкой)
        function sendFrame(text) {
            if (!socket || finished) return;
            const payload = Buffer.from(text);
            const mask = crypto.randomBytes(4);
            const len = payload.length;
            let header;
            if (len < 126) {
                header = Buffer.from([0x81, 0x80 | len]);
            } else if (len < 65536) {
                header = Buffer.from([0x81, 0xFE, (len >> 8) & 0xFF, len & 0xFF]);
            } else {
                header = Buffer.from([0x81, 0x7F, 0,0,0,0, (len>>24)&0xFF, (len>>16)&0xFF, (len>>8)&0xFF, len&0xFF]);
            }
            const masked = Buffer.alloc(len);
            for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
            socket.write(Buffer.concat([header, mask, masked]));
        }

        // Парсинг входящих WebSocket фреймов
        let recvBuf = Buffer.alloc(0);
        function parseFrames(data) {
            recvBuf = Buffer.concat([recvBuf, data]);
            while (recvBuf.length >= 2) {
                const opcode = recvBuf[0] & 0x0F;
                const masked = (recvBuf[1] & 0x80) !== 0;
                let payloadLen = recvBuf[1] & 0x7F;
                let offset = 2;
                if (payloadLen === 126) {
                    if (recvBuf.length < 4) break;
                    payloadLen = recvBuf.readUInt16BE(2);
                    offset = 4;
                } else if (payloadLen === 127) {
                    if (recvBuf.length < 10) break;
                    payloadLen = Number(recvBuf.readBigUInt64BE(2));
                    offset = 10;
                }
                if (masked) offset += 4;
                if (recvBuf.length < offset + payloadLen) break;
                const payload = recvBuf.slice(offset, offset + payloadLen).toString();
                recvBuf = recvBuf.slice(offset + payloadLen);
                if (opcode === 0x8) { finish('close frame'); return; }
                if (opcode === 0x1) handleMessage(payload);
            }
        }

        function handleMessage(raw) {
            if (raw === '2') { sendFrame('3'); return; } // ping → pong
            if (raw === '3') return; // pong
            if (!raw.startsWith('42')) return;
            let arr;
            try { arr = JSON.parse(raw.slice(2)); } catch(e) { return; }
            if (!Array.isArray(arr) || arr[0] !== 'message') return;

            const user  = arr[1] || '?';
            const text  = arr[2] || '';
            const role  = arr[3] || '';
            const msgid = arr[6] || '';

            if (role !== 'guest') return;
            if (!text.trim()) return;
            if (processed.has(msgid)) return;
            processed.add(msgid);

            log(`[${roomSlug}] 💬 ${user}: ${text.slice(0, 80)}`);
            sendTelegram(`🏠 <b>${roomSlug}</b>\n👤 <b>${user}</b>\n💬 ${text}`);
        }

        // Шаг 1: polling handshake → получаем socket.io sid
        const baseQuery = `ssid=${ssid}&ssign=${ssign}&roomid=${encodeURIComponent(roomId)}&group=${CONFIG.GROUP}&ticketid=&campid=&EIO=3`;
        httpsGet('ws4.bizon365.ru', `/socket.io/?${baseQuery}&transport=polling`, {
            'User-Agent': 'Mozilla/5.0 (compatible; BizonMonitor/1.0)'
        }).then(pollRes => {
            const jsonMatch = pollRes.body.match(/\{.*\}/s);
            if (!jsonMatch) throw new Error(`Handshake fail: ${pollRes.body.slice(0,100)}`);
            const handshake = JSON.parse(jsonMatch[0]);
            const socketSid = handshake.sid;
            log(`[${roomSlug}] Handshake OK, socketSid=${socketSid.slice(0,8)}...`);

            // Шаг 2: WebSocket upgrade
            const wsPath = `/socket.io/?${baseQuery}&transport=websocket&sid=${socketSid}`;
            const wsKey  = crypto.randomBytes(16).toString('base64');

            const req = https.request({
                hostname: 'ws4.bizon365.ru',
                port: 443,
                path: wsPath,
                method: 'GET',
                headers: {
                    'Connection': 'Upgrade',
                    'Upgrade': 'websocket',
                    'Sec-WebSocket-Key': wsKey,
                    'Sec-WebSocket-Version': '13',
                    'User-Agent': 'Mozilla/5.0 (compatible; BizonMonitor/1.0)',
                }
            });

            req.on('upgrade', (_res, sock) => {
                socket = sock;
                log(`[${roomSlug}] WebSocket подключён`);
                sock.on('data', parseFrames);
                sock.on('close', () => finish('socket closed'));
                sock.on('error', e => { log(`[${roomSlug}] socket error: ${e.message}`); finish('error'); });

                // socket.io probe
                sendFrame('2probe');
                setTimeout(() => sendFrame('5'), 200); // upgrade confirm

                // Пинг каждые 25 сек
                pingInterval = setInterval(() => sendFrame('2'), 25000);

                // Стоп через durationMs
                setTimeout(() => finish('time limit'), durationMs);
            });

            req.on('error', e => { log(`[${roomSlug}] WS req error: ${e.message}`); resolve(); });
            req.end();

        }).catch(e => { log(`[${roomSlug}] Polling error: ${e.message}`); resolve(); });
    });
}

// Запуск мониторинга одной комнаты
async function startWebinar(roomSlug, sid) {
    log(`[${roomSlug}] ▶ Старт мониторинга`);
    try {
        const { ssid, ssign, roomId } = await getTokens(roomSlug, sid);
        const durationMs = CONFIG.LISTEN_DURATION_MINUTES * 60 * 1000;
        await sendTelegram(`🟢 <b>Мониторинг запущен:</b> ${roomSlug}`);
        await connectWebSocket(roomSlug, ssid, ssign, roomId, durationMs);
        await sendTelegram(`🔴 <b>Мониторинг завершён:</b> ${roomSlug}`);
    } catch(e) {
        log(`[${roomSlug}] Ошибка: ${e.message}`);
        await sendTelegram(`❌ <b>Ошибка ${roomSlug}:</b> ${e.message}`);
    }
}

// Планировщик
function msUntilUTC(h, m) {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
}

function schedule(roomSlug, timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const cm = m >= CONFIG.CONNECT_BEFORE_MINUTES ? m - CONFIG.CONNECT_BEFORE_MINUTES : 60 - (CONFIG.CONNECT_BEFORE_MINUTES - m);
    const ch = m >= CONFIG.CONNECT_BEFORE_MINUTES ? h : h - 1;

    function next() {
        const ms = msUntilUTC(ch, cm);
        log(`[${roomSlug}] Следующий запуск через ${Math.round(ms/60000)} мин (UTC ${String(ch).padStart(2,'0')}:${String(cm).padStart(2,'0')})`);
        setTimeout(async () => { await startWebinar(roomSlug); next(); }, ms);
    }
    next();
}

async function main() {
    // GitHub Actions mode: node index.js room1 room2 ...
    const rooms = process.argv.slice(2);
    if (rooms.length > 0) {
        log('═══════════════════════════════════');
        log(`GitHub Actions mode: ${rooms.join(', ')}`);
        log('═══════════════════════════════════');
        const sid = await login();
        await Promise.all(rooms.map(r => startWebinar(r, sid)));
        log('Все комнаты завершены');
        process.exit(0);
    }

    // Persistent server mode (Railway / Render)
    log('═══════════════════════════════════');
    log('BizonMonitor v1.0 запущен');
    log(`Комнат: ${CONFIG.WEBINARS.length}`);
    log('═══════════════════════════════════');

    await sendTelegram(`🚀 <b>BizonMonitor запущен</b>\nКомнаты:\n${CONFIG.WEBINARS.map(w => `• ${w.room} (${w.scheduleUTC.join(', ')} UTC)`).join('\n')}`);

    for (const w of CONFIG.WEBINARS) {
        for (const t of w.scheduleUTC) {
            schedule(w.room, t);
        }
    }

    http.createServer((req, res) => { res.writeHead(200); res.end('OK'); })
        .listen(process.env.PORT || 3000, () => log(`HTTP health-check: port ${process.env.PORT || 3000}`));
}

main();
