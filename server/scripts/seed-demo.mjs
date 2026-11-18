/**
 * 演示数据生成脚本（可选）
 * ---------------------------------------------------------------
 * 生成一批带历史连胜的演示用户，方便本地预览 Web 后台与排行榜。
 * 注意：会清空这些演示用户的历史打卡记录，请勿在生产库运行。
 *
 * 用法（先启动服务）：
 *   node scripts/seed-demo.mjs
 *   API_BASE=http://127.0.0.1:3200 DB_PATH=./data/demo.db node scripts/seed-demo.mjs
 *
 * 统一密码：demo1234
 */

import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(process.cwd(), 'data', 'checkin.db');

const PASSWORD = 'demo1234';

const DEMO_USERS = [
  { username: '早起的鸟', streak: 21, best: 30, today: 'done', deadline: null },
  { username: '小满', streak: 12, best: 12, today: 'done', deadline: '23:00' },
  { username: '夜航', streak: 8, best: 15, today: 'late', deadline: '22:00' },
  { username: '温言', streak: 5, best: 9, today: 'excused', deadline: null },
  { username: '阿懒', streak: 4, best: 11, today: 'missed', deadline: '09:00' },
  { username: '咸鱼翻身', streak: 1, best: 6, today: 'pending', deadline: null },
];

const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const addDays = (key, delta) => {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

async function call(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const db = new Database(DB_PATH);
const today = todayKey();
const idByName = new Map();

console.log(`\n生成演示数据 -> ${BASE}\n数据库：${DB_PATH}\n`);

for (const demo of DEMO_USERS) {
  let res = await call('POST', '/api/register', {
    body: { username: demo.username, password: PASSWORD },
  });
  if (res.status === 409) {
    res = await call('POST', '/api/login', {
      body: { username: demo.username, password: PASSWORD },
    });
    if (res.status !== 200) {
      console.warn(`  ! 跳过 ${demo.username}：${res.data.message || res.status}`);
      continue;
    }
  }
  if (!res.data || !res.data.user) {
    console.warn(`  ! 跳过 ${demo.username}：${res.data.message || res.status}`);
    continue;
  }

  const id = res.data.user.id;
  idByName.set(demo.username, id);
  const now = new Date().toISOString();

  db.prepare('DELETE FROM checkins WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM excuses WHERE user_id = ?').run(id);

  // 补齐历史打卡（截止日之前的 streak 天）
  const insert = db.prepare(
    'INSERT INTO checkins (user_id, date, late, note, created_at) VALUES (?, ?, 0, NULL, ?)'
  );
  for (let i = 1; i < demo.streak; i += 1) {
    insert.run(id, addDays(today, -i), now);
  }

  if (demo.today === 'done' || demo.today === 'late') {
    db.prepare(
      'INSERT INTO checkins (user_id, date, late, note, created_at) VALUES (?, ?, ?, NULL, ?)'
    ).run(id, today, demo.today === 'late' ? 1 : 0, now);
  }
  if (demo.today === 'excused') {
    db.prepare(
      'INSERT INTO excuses (user_id, date, reason, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, today, '临时被拉去开会，申请一次请假。', now);
  }

  const lastCounted =
    demo.today === 'pending' || demo.today === 'missed'
      ? addDays(today, -1)
      : today;

  db.prepare(
    'UPDATE users SET current_streak = ?, best_streak = ?, last_counted_date = ?, deadline = ? WHERE id = ?'
  ).run(demo.streak, demo.best, lastCounted, demo.deadline, id);

  console.log(
    `  ✓ ${demo.username.padEnd(6, ' ')} 连胜 ${String(demo.streak).padStart(2, ' ')} · 今日 ${demo.today}`
  );
}

/* ---------------- 演示好友关系 ---------------- */
const bird = idByName.get('早起的鸟');
const xiaoman = idByName.get('小满');
const wenyan = idByName.get('温言');
const nowIso = new Date().toISOString();
const upsertFriend = db.prepare(`
  INSERT INTO friends (user_id, friend_id, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, friend_id)
  DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
`);

if (bird && xiaoman) {
  upsertFriend.run(bird, xiaoman, 'accepted', nowIso, nowIso);
  upsertFriend.run(xiaoman, bird, 'accepted', nowIso, nowIso);
  console.log('  ✓ 好友：早起的鸟 ↔ 小满');
}
if (wenyan && bird) {
  upsertFriend.run(wenyan, bird, 'pending', nowIso, nowIso);
  console.log('  ✓ 待处理申请：温言 → 早起的鸟');
}

db.close();
console.log('\n完成。演示账号密码：demo1234（仅演示数据，不是管理员）\n');