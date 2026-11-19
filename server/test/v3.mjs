/**
 * v3 功能测试：习惯 / 休息日 / 积分 / 请假 / 补签卡 / 三榜 / 设备号
 * 用法（先启动服务）：
 *   API_BASE=http://127.0.0.1:4000 DB_PATH=data/v3.db node test/v3.mjs
 */

import path from 'node:path';
import Database from 'better-sqlite3';

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'checkin.db');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra)); }
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
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

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

const db = new Database(DB_PATH);
const suffix = Date.now().toString(36).slice(-5);

async function register(name, deviceId) {
  const res = await call('POST', '/api/register', {
    body: { username: name, password: 'secret123', ...(deviceId ? { deviceId } : {}) },
  });
  return { token: res.data.token, id: res.data.user.id, name, res };
}

/** 只保留一个指定星期生效的习惯，方便精确测试结算 */
async function setupHabit(user, activeDays, deadlineTime = '22:00') {
  const list = await call('GET', '/api/habits', { token: user.token });
  for (const h of list.data.habits) {
    await call('DELETE', `/api/habits/${h.id}`, { token: user.token });
  }
  const created = await call('POST', '/api/habits', {
    token: user.token,
    body: { name: '测试习惯', activeDays, deadlineTime, startDate: addDays(today, -30) },
  });
  return { habitId: created.data.habit.id, habit: created.data.habit };
}

async function main() {
  console.log(`\nv3 功能测试 -> ${BASE}\n今日（北京）：${today} 星期${weekday(today)}\n`);

  /* ---------------- 模块五：设备 / 注册 ---------------- */
  console.log('[1] 设备号唯一性');
  const deviceId = `dev-${suffix}-aaaaaaaa`;
  const u1 = await register(`v3a_${suffix}`, deviceId);
  check('带 deviceId 注册成功', u1.res.status === 201, u1.res.data);

  const dup = await call('POST', '/api/register', {
    body: { username: `v3dup_${suffix}`, password: 'secret123', deviceId },
  });
  check('同一设备重复注册 409', dup.status === 409 && dup.data.error === 'DEVICE_TAKEN', dup.data);

  const badDevice = await call('POST', '/api/login', {
    body: { username: u1.name, password: 'secret123', deviceId: 'other-device-9999' },
  });
  check('换设备登录被拒绝 403', badDevice.status === 403 && badDevice.data.error === 'DEVICE_MISMATCH', badDevice.data);

  /* ---------------- 模块一：习惯 CRUD ---------------- */
  console.log('\n[2] 习惯创建 / 编辑 / 星期配置');
  const list0 = await call('GET', '/api/habits', { token: u1.token });
  check('新用户自动有默认习惯', list0.data.habits.length === 1, list0.data.habits.length);
  check('默认习惯 7 天生效', list0.data.habits[0].activeDays.length === 7, list0.data.habits[0].activeDays);

  const created = await call('POST', '/api/habits', {
    token: u1.token,
    body: { name: '晨跑', emoji: '🏃', activeDays: [1, 2, 3, 4, 5], deadlineTime: '07:30', startDate: addDays(today, -10) },
  });
  check('创建工作习惯 201', created.status === 201, created.data);
  check('activeDays 规整为 1,2,3,4,5', created.data.habit.activeDays.join(',') === '1,2,3,4,5', created.data.habit.activeDays);
  check('deadlineTime 保存正确', created.data.habit.deadlineTime === '07:30', created.data.habit.deadlineTime);

  const badDays = await call('POST', '/api/habits', {
    token: u1.token,
    body: { name: '坏习惯', activeDays: [] },
  });
  check('空星期被拒绝 400', badDays.status === 400, badDays.data);

  const badTime = await call('POST', '/api/habits', {
    token: u1.token,
    body: { name: '坏时间', activeDays: [1], deadlineTime: '25:00' },
  });
  check('非法时间被拒绝 400', badTime.status === 400, badTime.data);

  const updated = await call('PUT', `/api/habits/${created.data.habit.id}`, {
    token: u1.token,
    body: { activeDays: [1, 3, 5], deadlineTime: '08:00' },
  });
  check('编辑习惯生效', updated.status === 200 && updated.data.habit.activeDays.join(',') === '1,3,5', updated.data.habit);
  await call('PUT', `/api/habits/${created.data.habit.id}`, {
    token: u1.token,
    body: { activeDays: [1, 2, 3, 4, 5], deadlineTime: '07:30' },
  });

  /* ---------------- 休息日 ---------------- */
  console.log('\n[3] 休息日展示与拦截');
  const weekend = await call('POST', '/api/habits', {
    token: u1.token,
    body: { name: '周末读书', activeDays: [6, 7], deadlineTime: '20:00', startDate: addDays(today, -5) },
  });
  const restToday = weekend.data.habit.restToday;
  check('周末习惯在周中为 restToday', [4, 5, 1, 2, 3].includes(weekday(today)) ? restToday === true : restToday === false, { weekday: weekday(today), restToday });

  const restCheckin = await call('POST', `/api/habits/${weekend.data.habit.id}/checkin`, { token: u1.token });
  if (restToday) check('休息日打卡被拒绝 400', restCheckin.status === 400 && restCheckin.data.error === 'REST_DAY', restCheckin.data);
  else check('非休息日可打卡', restCheckin.status === 201, restCheckin.data);

  const status1 = await call('GET', '/api/status', { token: u1.token });
  const restItem = status1.data.habits.find((h) => h.id === weekend.data.habit.id);
  check('status 中休息项 restToday=true', restItem.restToday === true, restItem);
  check('休息项不计入今日待办', status1.data.todayActiveCount === status1.data.habits.filter((h) => h.isActiveToday).length, status1.data.todayActiveCount);

  /* ---------------- 打卡与积分 ---------------- */
  console.log('\n[4] 打卡 + 积分');
  const before = (await call('GET', '/api/status', { token: u1.token })).data;
  const habit1 = status1.data.habits.find((h) => h.name === '晨跑');
  const ck = await call('POST', `/api/habits/${habit1.id}/checkin`, { token: u1.token });
  check('习惯打卡 201', ck.status === 201, ck.data);
  check('打卡加 10 分', ck.data.status.points === before.points + 10, { before: before.points, after: ck.data.status.points });
  check('连胜 +1', ck.data.status.streak >= 1, ck.data.status.streak);

  const again = await call('POST', `/api/habits/${habit1.id}/checkin`, { token: u1.token });
  check('重复打卡幂等 200', again.status === 200 && again.data.alreadyCheckedIn === true, again.data);

  /* ---------------- 模块三：三榜 ---------------- */
  console.log('\n[5] 三榜接口（含匿名只读）');
  for (const type of ['streak', 'total', 'points']) {
    const anon = await call('GET', `/api/leaderboard/${type}`);
    check(`匿名可读 ${type} 榜`, anon.status === 200 && Array.isArray(anon.data.rows), anon.status);
    check(`${type} 榜带排行榜元信息`, typeof anon.data.typeLabel === 'string' && anon.data.unit.length > 0, anon.data.typeLabel);
  }

  const authed = await call('GET', '/api/leaderboard/streak', { token: u1.token });
  const meRow = authed.data.rows.find((r) => r.userId === u1.id);
  check('登录后有 isMe 标记', meRow.isMe === true, meRow);
  check('榜行包含勋章/积分/总次数', Array.isArray(meRow.badges) && typeof meRow.points === 'number' && typeof meRow.totalCheckins === 'number', meRow);

  const sorted = authed.data.rows.every((r, i, arr) => i === 0 || arr[i - 1].value >= r.value);
  check('连胜榜按 value 降序', sorted, authed.data.rows.map((r) => r.value));

  /* ---------------- 勋章 ---------------- */
  console.log('\n[6] 勋章');
  db.prepare('UPDATE habits SET best_streak = 30 WHERE user_id = ?').run(u1.id);
  const boardBadge = await call('GET', '/api/leaderboard/points', { token: u1.token });
  const badgeRow = boardBadge.data.rows.find((r) => r.userId === u1.id);
  check('30 天最佳有 👑', badgeRow.badges.includes('👑'), badgeRow.badges);
  check('同时保留 🛡️', badgeRow.badges.includes('🛡️'), badgeRow.badges);

  /* ---------------- 模块五：请假额度 ---------------- */
  console.log('\n[7] 请假额度与月初重置');
  const u5 = await register(`v3leave_${suffix}`);
  db.prepare('UPDATE users SET leave_balance = 1, leave_month = ? WHERE id = ?').run(today.slice(0, 7), u5.id);

  const ex1 = await call('POST', '/api/excuse', {
    token: u5.token,
    body: { reason: '临时出差，申请一次请假。', date: addDays(today, -1) },
  });
  check('有额度时请假成功', ex1.status === 201 && ex1.data.usedLeave === true, ex1.data);
  check('额度扣减为 0', ex1.data.leaveBalance === 0, ex1.data.leaveBalance);

  const ex2 = await call('POST', '/api/excuse', {
    token: u5.token,
    body: { reason: '再请一次，但已经没额度了。', date: addDays(today, -2) },
  });
  check('无额度仍可填借口保底', ex2.status === 201 && ex2.data.usedLeave === false, ex2.data);

  db.prepare('UPDATE users SET leave_month = ? WHERE id = ?').run('2000-01', u5.id);
  const st5 = await call('GET', '/api/status', { token: u5.token });
  check('跨月自动恢复 3 次额度', st5.data.leaveBalance === 3, st5.data.leaveBalance);

  /* ---------------- 模块二：按 active_days 结算 ---------------- */
  console.log('\n[8] 结算：休息日不断签 / 工作日断签');

  const u2 = await register(`v3miss_${suffix}`);
  const h2 = await setupHabit(u2, [3]); // 只在周三生效
  db.prepare('UPDATE habits SET current_streak = 5, best_streak = 5, last_counted_date = ? WHERE id = ?')
    .run(addDays(today, -2), h2.habitId);
  const before2 = (await call('GET', '/api/status', { token: u2.token })).data;

  const yStatus = weekday(addDays(today, -1));
  if (yStatus === 3) {
    check('工作日漏签 → 连胜清零', before2.streak === 0, before2.streak);
    check('断签扣 20 分', before2.points === 0, before2.points);
  } else {
    check('昨天是休息日 → 连胜保留', before2.streak === 5, before2.streak);
  }

  const u4 = await register(`v3rest_${suffix}`);
  const h4 = await setupHabit(u4, [1]); // 只在周一生效
  db.prepare('UPDATE habits SET current_streak = 4, best_streak = 4, last_counted_date = ? WHERE id = ?')
    .run(addDays(today, -2), h4.habitId);
  const st4 = (await call('GET', '/api/status', { token: u4.token })).data;
  const lastTwo = [addDays(today, -1), addDays(today, -2)].map(weekday);
  if (!lastTwo.includes(1)) check('连续休息日 → 连胜不变', st4.streak === 4, st4.streak);
  else check('窗口内有生效日 → 正常结算', typeof st4.streak === 'number', st4.streak);

  /* ---------------- 补签卡 ---------------- */
  console.log('\n[9] 补签卡自动保命');
  const u3 = await register(`v3card_${suffix}`);
  const h3 = await setupHabit(u3, [3]);
  db.prepare('UPDATE habits SET current_streak = 3, best_streak = 3, last_counted_date = ? WHERE id = ?')
    .run(addDays(today, -2), h3.habitId);
  db.prepare('UPDATE users SET makeup_cards = 1, points = 50 WHERE id = ?').run(u3.id);

  const st3 = (await call('GET', '/api/status', { token: u3.token })).data;
  const cards = db.prepare('SELECT makeup_cards FROM users WHERE id = ?').get(u3.id).makeup_cards;
  if (weekday(addDays(today, -1)) === 3) {
    check('断签自动消耗补签卡', cards === 0, cards);
    check('补签后连胜保留', st3.streak === 3, st3.streak);
    check('补签不扣分', st3.points === 50, st3.points);
    const makeup = db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND makeup = 1').get(u3.id).n;
    check('生成补签记录', makeup >= 1, makeup);
  } else {
    check('昨天非生效日不消耗补签卡', cards === 1, cards);
  }

  /* ---------------- 商店 ---------------- */
  console.log('\n[10] 积分兑换补签卡');
  db.prepare('UPDATE users SET points = 150 WHERE id = ?').run(u1.id);
  const buy = await call('POST', '/api/shop/makeup-card', { token: u1.token, body: { quantity: 1 } });
  check('150 分兑换成功', buy.status === 201, buy.data);
  check('扣 100 分', buy.data.points === 50, buy.data.points);
  check('补签卡 +1', buy.data.makeupCards >= 1, buy.data.makeupCards);

  const poor = await call('POST', '/api/shop/makeup-card', { token: u1.token, body: { quantity: 1 } });
  check('积分不足 400', poor.status === 400, poor.data);

  /* ---------------- 日历 / 兼容接口 ---------------- */
  console.log('\n[11] 日历与旧接口兼容');
  const cal = await call('GET', '/api/user/calendar?days=30', { token: u1.token });
  check('日历 30 天', cal.data.items.length === 30, cal.data.items.length);
  check('日历包含 rest 状态', cal.data.items.some((i) => i.status === 'rest'), cal.data.summary);

  const legacy = await call('POST', '/api/checkin', { token: u1.token, body: {} });
  check('旧 /api/checkin 仍可用', [200, 201].includes(legacy.status), legacy.data);

  console.log(`\n=== v3 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  db.close();
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
