const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const mysql = require('mysql2/promise');

const {
  PORT = 3000,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN,
  MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE,
  ADMIN_API_KEY
} = process.env;

const app = express();
app.use(express.json());

let pool;
(async () => {
  pool = await mysql.createPool({
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT || 3306),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10
  });
})();

app.get('/', (_, res) => res.send('Dropbot running'));

// 1) 승인 페이지 열기
app.get('/auth/discord', (req, res) => {
  const params = {
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: ['identify', 'email', 'guilds.join'].join(' '),
    prompt: 'consent'
  };
  res.redirect(`https://discord.com/api/oauth2/authorize?${qs.stringify(params)}`);
});

// 2) 콜백: 토큰 저장
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenRes = await axios.post('https://discord.com/api/v10/oauth2/token',
      qs.stringify({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const token = tokenRes.data;

    // 유저 정보
    const meRes = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `${token.token_type} ${token.access_token}` }
    });
    const me = meRes.data;

    const now = new Date();
    const expiresAt = new Date(Date.now() + (token.expires_in - 60) * 1000);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(`
        INSERT INTO discord_users (user_id, username, global_name, avatar, email, locale, consented_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          username=VALUES(username),
          global_name=VALUES(global_name),
          avatar=VALUES(avatar),
          email=VALUES(email),
          last_login_at=VALUES(last_login_at)
      `, [me.id, me.username, me.global_name || null, me.avatar || null, me.email || null, me.locale || null, now, now]);

      await conn.query(`
        INSERT INTO discord_tokens (user_id, access_token, refresh_token, token_type, scope, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          access_token=VALUES(access_token),
          refresh_token=VALUES(refresh_token),
          token_type=VALUES(token_type),
          scope=VALUES(scope),
          expires_at=VALUES(expires_at),
          updated_at=VALUES(updated_at)
      `, [me.id, token.access_token, token.refresh_token, token.token_type, token.scope, expiresAt, now]);

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    res.send('✅ 승인 완료! 서버 장애 시 자동 재입장 처리됩니다. 창을 닫아도 됩니다.');
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).send('OAuth 오류');
  }
});

// 토큰 갱신
async function refreshAccessToken(userId) {
  const [rows] = await pool.query('SELECT refresh_token FROM discord_tokens WHERE user_id=?', [userId]);
  if (!rows.length) throw new Error('No refresh token');

  const refresh_token = rows[0].refresh_token;

  const res = await axios.post('https://discord.com/api/v10/oauth2/token',
    qs.stringify({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const t = res.data;
  const expiresAt = new Date(Date.now() + (t.expires_in - 60) * 1000);
  await pool.query(
    'UPDATE discord_tokens SET access_token=?, refresh_token=?, token_type=?, scope=?, expires_at=?, updated_at=? WHERE user_id=?',
    [t.access_token, t.refresh_token ?? refresh_token, t.token_type, t.scope, expiresAt, new Date(), userId]
  );
  return t.access_token;
}

// 길드에 유저 추가
async function addUserToGuild(guildId, userId) {
  const [rows] = await pool.query('SELECT access_token, expires_at FROM discord_tokens WHERE user_id=?', [userId]);
  if (!rows.length) throw new Error('User not found in tokens');
  let accessToken = rows[0].access_token;
  const expiresAt = new Date(rows[0].expires_at);
  if (expiresAt < new Date()) accessToken = await refreshAccessToken(userId);

  try {
    const r = await axios.put(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      { access_token: accessToken },
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
    );
    return r.status; // 201 or 204
  } catch (e) {
    const code = e?.response?.status;
    throw new Error(`join failed ${code}: ${JSON.stringify(e?.response?.data)}`);
  }
}

// DM 보내기(옵션)
async function sendDM(userId, content) {
  const ch = await axios.post('https://discord.com/api/v10/users/@me/channels',
    { recipient_id: userId },
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
  await axios.post(`https://discord.com/api/v10/channels/${ch.data.id}/messages`,
    { content },
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
}

// 관리자용: 대량 재입장
app.post('/admin/rejoin', async (req, res) => {
  if (req.headers['x-api-key'] !== ADMIN_API_KEY) return res.status(401).send('unauthorized');
  const { guild_id, notify } = req.query;
  if (!guild_id) return res.status(400).send('guild_id required');

  const [users] = await pool.query('SELECT user_id FROM discord_users');
  let ok = 0, fail = 0, already = 0;

  for (const u of users) {
    try {
      const status = await addUserToGuild(guild_id, u.user_id);
      if (status === 201 || status === 204) ok++;
      if (notify === '1') await sendDM(u.user_id, '✅ 새 서버로 복구되었습니다! 환영합니다.');
      await pool.query(
        'INSERT INTO guild_join_logs (user_id, guild_id, status, created_at, updated_at) VALUES (?,?,?,?,?)',
        [u.user_id, guild_id, 'joined', new Date(), new Date()]
      );
      await new Promise(r => setTimeout(r, 250)); // 레이트리밋 보호
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes('409')) {
        already++;
        await pool.query(
          'INSERT INTO guild_join_logs (user_id, guild_id, status, created_at, updated_at) VALUES (?,?,?,?,?)',
          [u.user_id, guild_id, 'already', new Date(), new Date()]
        );
      } else {
        fail++;
        await pool.query(
          'INSERT INTO guild_join_logs (user_id, guild_id, status, error_text, created_at, updated_at) VALUES (?,?,?,?,?,?)',
          [u.user_id, guild_id, 'failed', msg, new Date(), new Date()]
        );
      }
    }
  }
  res.json({ ok, already, fail, total: users.length });
});

// 쉬운 버튼 페이지(관리자)
app.get('/admin', (req, res) => {
  res.send(`
    <form method="POST" action="/admin/rejoin?guild_id=" onsubmit="event.preventDefault(); const id = document.getElementById('g').value; fetch('/admin/rejoin?guild_id='+id+'&notify=1',{method:'POST', headers:{'x-api-key':'${ADMIN_API_KEY}'}}).then(r=>r.json()).then(j=>alert(JSON.stringify(j))).catch(e=>alert(e));">
      <h3>새 서버 ID 입력 → 자동 재입장</h3>
      <input id="g" placeholder="Guild ID" />
      <button type="submit">실행</button>
    </form>
  `);
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));