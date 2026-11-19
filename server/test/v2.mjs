/**
 * v2 功能测试：好友 / 催打卡 / 免打卡日 / 周期榜 / 日历
 * 用法（先启动服务）：
 *   API_BASE=http://127.0.0.1:3500 DB_PATH=data/v2.db node test/v2.mjs
 */

import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
// 管理员凭据从环境变量读取；本地开发默认值仅供测试使用
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'checkin.db');

let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, extra === undefined ? '' : JSON.stringify(extra));
  }
}

async function call(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

const suffix = Date.now().toString(36).slice(-5);
const pad = (n) => String(n).padStart(2, '0');
const today = (() => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
})();
const addDays = (key, delta) => {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const weekday = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
};

async function register(name) {
  const res = await call('POST', '/api/register', {
    body: { username: name, password: 'secret123' },
  });
  return { token: res.data.token, id: res.data.user.id, name };
}

async function main() {
  console.log(`\nv2 功能测试 -> ${BASE}\n今日（北京）：${today}\n`);

  const admin = await call('POST', '/api/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  const adminToken = admin.data.token;

  // 清掉上次残留的免打卡日，保证测试可重复执行
  await call('POST', '/api/admin/set-skip-dates', {
    token: adminToken,
    body: { dates: [] },
  });
  await call('PUT', '/api/admin/settings', {
    token: adminToken,
    body: { defaultDeadline: '22:00' },
  });

  const u1 = await register(`f1_${suffix}`);
  const u2 = await register(`f2_${suffix}`);
  const u3 = await register(`f3_${suffix}`);

  /* ---------------------------- 好友系统 ---------------------------- */
  console.log('[1] 好友申请 / 同意 / 列表');
  const req1 = await call('POST', '/api/friends/request', {
    token: u1.token,
    body: { username: u2.name },
  });
  check('发送好友申请 201', req1.status === 201 && req1.data.status === 'pending_out', req1);

  const reqAgain = await call('POST', '/api/friends/request', {
    token: u1.token,
    body: { username: u2.name },
  });
  check('重复申请被拒绝 409', reqAgain.status === 409, reqAgain);

  const reqSelf = await call('POST', '/api/friends/request', {
    token: u1.token,
    body: { username: u1.name },
  });
  check('不能加自己为好友 400', reqSelf.status === 400, reqSelf);

  const reqGhost = await call('POST', '/api/friends/request', {
    token: u1.token,
    body: { username: 'nobody_here_' + suffix },
  });
  check('申请不存在的用户 404', reqGhost.status === 404, reqGhost);

  const listU2 = await call('GET', '/api/friends/list', { token: u2.token });
  check('接收方看到待处理申请', listU2.data.incoming.some((x) => x.username === u1.name), listU2.data);
  check('接收方此时没有好友', listU2.data.friends.length === 0, listU2.data.counts);

  const accept = await call('POST', '/api/friends/accept', {
    token: u2.token,
    body: { username: u1.name },
  });
  check('同意好友申请 200', accept.status === 200 && accept.data.state === 'accepted', accept);

  const listU1 = await call('GET', '/api/friends/list', { token: u1.token });
  check('双方好友列表都有对方', listU1.data.friends.some((x) => x.username === u2.name), listU1.data.friends);

  const reqAfter = await call('POST', '/api/friends/request', {
    token: u1.token,
    body: { username: u2.name },
  });
  check('已是好友再申请 409', reqAfter.status === 409 && reqAfter.data.error === 'ALREADY_FRIENDS', reqAfter);

  const acceptNothing = await call('POST', '/api/friends/accept', {
    token: u3.token,
    body: { username: u1.name },
  });
  check('没有待处理申请时同意 404', acceptNothing.status === 404, acceptNothing);

  /* ---------------------------- 催打卡 ---------------------------- */
  console.log('\n[2] 催打卡权限与频率');
  const nudgeStranger = await call('POST', `/api/nudge/${encodeURIComponent(u2.name)}`, {
    token: u3.token,
  });
  check('非好友催打卡 403', nudgeStranger.status === 403 && nudgeStranger.data.error === 'NOT_FRIENDS', nudgeStranger);

  const nudgeSelf = await call('POST', `/api/nudge/${encodeURIComponent(u1.name)}`, {
    token: u1.token,
  });
  check('不能催自己 400', nudgeSelf.status === 400, nudgeSelf);

  const nudgeOk = await call('POST', `/api/nudge/${encodeURIComponent(u2.name)}`, {
    token: u1.token,
  });
  check('好友催打卡成功 201', nudgeOk.status === 201, nudgeOk);
  check('返回文案包含被催人', String(nudgeOk.data.message || '').includes(u2.name), nudgeOk.data);

  const nudgeAgain = await call('POST', `/api/nudge/${encodeURIComponent(u2.name)}`, {
    token: u1.token,
  });
  check('10 分钟内重复催 429', nudgeAgain.status === 429, nudgeAgain);
  check('429 带 retryAfter', nudgeAgain.data.retryAfter > 0, nudgeAgain.data);

  const statusU2 = await call('GET', '/api/status', { token: u2.token });
  check('被催方 status 里能看到催打卡', statusU2.data.nudges.some((n) => n.from === u1.name), statusU2.data.nudges);

  const checkinU2 = await call('POST', '/api/checkin', { token: u2.token });
  check('u2 打卡成功', checkinU2.status === 201, checkinU2);

  const nudgeDone = await call('POST', `/api/nudge/${encodeURIComponent(u2.name)}`, {
    token: u1.token,
  });
  check('对方已打卡时催打卡 400', nudgeDone.status === 400 && nudgeDone.data.error === 'ALREADY_CHECKED_IN', nudgeDone);

  const nudgeGhost = await call('POST', '/api/nudge/nobody_' + suffix, { token: u1.token });
  check('催不存在的人 404', nudgeGhost.status === 404, nudgeGhost);

  /* ---------------------------- 周期榜 ---------------------------- */
  console.log('\n[3] 排行榜周期切换');
  const boardAll = await call('GET', '/api/leaderboard?period=all', { token: u1.token });
  check('总榜 type=streak', boardAll.data.type === 'streak' && boardAll.data.typeLabel === '连胜榜', boardAll.data.typeLabel);
  check('总榜 score=连胜', boardAll.data.rows.every((r) => r.score === r.streak), boardAll.data.rows.map((r) => [r.score, r.streak]));
  check('行内包含好友关系字段', boardAll.data.rows.every((r) => typeof r.friendship === 'string'), boardAll.data.rows[0]);
  check('好友行 friendship=accepted', boardAll.data.rows.find((r) => r.username === u2.name).friendship === 'accepted', boardAll.data.rows);

  const boardWeek = await call('GET', '/api/leaderboard?period=week', { token: u1.token });
  check('周榜 period=week', boardWeek.data.period === 'week', boardWeek.data.period);
  check('周榜起点为周一', weekday(boardWeek.data.range.start) === 1, boardWeek.data.range);
  check('周榜按本周打卡数计分', boardWeek.data.rows.find((r) => r.username === u2.name).score >= 1, boardWeek.data.rows);

  const boardMonth = await call('GET', '/api/leaderboard?period=month', { token: u1.token });
  check('月榜起点为当月 1 号', boardMonth.data.range.start.endsWith('-01'), boardMonth.data.range);

  const boardBad = await call('GET', '/api/leaderboard?period=decade', { token: u1.token });
  check('非法 period 回落连胜榜', boardBad.data.type === 'streak', boardBad.data.type);

  check('排行榜按分数降序', boardWeek.data.rows.every((r, i, arr) => i === 0 || arr[i - 1].score >= r.score), boardWeek.data.rows.map((r) => r.score));

  /* ---------------------------- 日历 ---------------------------- */
  console.log('\n[4] 30 天打卡日历');
  const cal = await call('GET', '/api/user/calendar?days=30', { token: u2.token });
  check('日历返回 30 天', cal.data.items.length === 30, cal.data.items && cal.data.items.length);
  check('日历最后一天是今天', cal.data.items[29].date === today && cal.data.items[29].isToday === true, cal.data.items[29]);
  check('今天状态为 done', cal.data.items[29].status === 'done', cal.data.items[29]);
  check('summary 统计累计打卡', cal.data.summary.done >= 1, cal.data.summary);
  check('日历按时间升序', cal.data.items.every((it, i, arr) => i === 0 || arr[i - 1].date < it.date), cal.data.items.map((i) => i.date).slice(0, 3));
  check('每项带 weekday', cal.data.items.every((it) => it.weekday >= 1 && it.weekday <= 7));

  const calBig = await call('GET', '/api/user/calendar?days=999', { token: u2.token });
  check('days 上限 90', calBig.data.days === 90, calBig.data.days);

  /* ---------------------------- 免打卡日 ---------------------------- */
  console.log('\n[5] 免打卡日');
  const setSkip = await call('POST', '/api/admin/set-skip-dates', {
    token: adminToken,
    body: { dates: `${today}, 2027-01-01` },
  });
  check('管理员设置免打卡日', setSkip.status === 200 && setSkip.data.count === 2, setSkip.data);
  check('返回 isSkipToday', setSkip.data.isSkipToday === true, setSkip.data);

  const badSkip = await call('POST', '/api/admin/set-skip-dates', {
    token: adminToken,
    body: { dates: '2026-13-40' },
  });
  check('非法日期被拒绝 400', badSkip.status === 400, badSkip);

  const skipByUser = await call('POST', '/api/admin/set-skip-dates', {
    token: u1.token,
    body: { dates: today },
  });
  check('普通用户无权设置免打卡日 403', skipByUser.status === 403, skipByUser);

  const u3Status = await call('GET', '/api/status', { token: u3.token });
  check('今天所有人状态为 holiday', u3Status.data.status === 'holiday', u3Status.data);
  check('免打卡日不再强制阻断', u3Status.data.blocked === false, u3Status.data);
  check('免打卡日 isSkipDay=true', u3Status.data.isSkipDay === true, u3Status.data);

  const boardSkip = await call('GET', '/api/leaderboard', { token: u3.token });
  check('排行榜今日状态为 holiday', boardSkip.data.rows.find((r) => r.username === u3.name).todayStatus === 'holiday', boardSkip.data.isSkipDay);
  check('免打卡日 canNudge=false', boardSkip.data.rows.every((r) => r.canNudge === false), boardSkip.data.rows.map((r) => r.canNudge));

  const nudgeSkip = await call('POST', `/api/nudge/${encodeURIComponent(u2.name)}`, { token: u1.token });
  check('免打卡日催打卡 400', nudgeSkip.status === 400 && nudgeSkip.data.error === 'SKIP_DAY', nudgeSkip);

  const calSkip = await call('GET', '/api/user/calendar?days=7', { token: u3.token });
  check('日历今天标记为 holiday', calSkip.data.items[6].status === 'holiday', calSkip.data.items[6]);

  /* ------------------ 免打卡日不断签（直接改库验证） ------------------ */
  console.log('\n[6] 免打卡日冻结连胜（跨天结算）');
  const db = new Database(DB_PATH);
  const freezeName = `freeze_${suffix}`;
  const freeze = await register(freezeName);

  // 伪造：用户两天前打过卡，昨天是免打卡日，今天打开 App（v3：状态在 habits 表上）
  db.prepare(
    'UPDATE habits SET current_streak = 5, best_streak = 5, last_counted_date = ?, start_date = ? WHERE user_id = ?'
  ).run(addDays(today, -2), addDays(today, -30), freeze.id);
  db.prepare('DELETE FROM checkins WHERE user_id = ?').run(freeze.id);

  await call('POST', '/api/admin/set-skip-dates', {
    token: adminToken,
    body: { dates: addDays(today, -1) }, // 只有昨天是免打卡日
  });

  const frozenStatus = await call('GET', '/api/status', { token: freeze.token });
  check('昨天是免打卡日 → 连胜不被清零', frozenStatus.data.streak === 5, frozenStatus.data.streak);
  check('今天不是免打卡日 → 状态正常', frozenStatus.data.isSkipDay === false, frozenStatus.data.status);

  const marker = db.prepare('SELECT MAX(last_counted_date) AS d FROM habits WHERE user_id = ?').get(freeze.id);
  check('结算标记推进到昨天', marker.d === addDays(today, -1), marker);

  // 对照组：没有免打卡日时同样的数据会断签
  await call('POST', '/api/admin/set-skip-dates', { token: adminToken, body: { dates: [] } });
  db.prepare(
    'UPDATE habits SET current_streak = 5, last_counted_date = ?, start_date = ? WHERE user_id = ?'
  ).run(addDays(today, -2), addDays(today, -30), freeze.id);
  const brokenStatus = await call('GET', '/api/status', { token: freeze.token });
  check('无免打卡日 → 断签清零', brokenStatus.data.streak === 0, brokenStatus.data.streak);

  // 恢复全局默认截止时间，避免影响后续使用
  await call('PUT', '/api/admin/settings', { token: adminToken, body: { defaultDeadline: '22:00' } });
  db.close();

  console.log(`\n=== v2 结果：${passed} 通过 / ${failed} 失败 ===\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
