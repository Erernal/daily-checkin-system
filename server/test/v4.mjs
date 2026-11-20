/**
 * v4 功能测试：隐私榜单 / 好友撤回删除 / 休假审批 / 改密码 / 勋章 / 删号
 * 用法（先启动服务）：
 *   API_BASE=http://127.0.0.1:4200 DB_PATH=data/v4.db node test/v4.mjs
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
const addDays = (k, delta) => {
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

const db = new Database(DB_PATH);
const suffix = Date.now().toString(36).slice(-5);

async function register(name) {
  const res = await call('POST', '/api/register', { body: { username: name, password: 'secret123' } });
  return { token: res.data.token, id: res.data.user.id, name };
}

async function main() {
  console.log(`\nv4 功能测试 -> ${BASE}\n今日（北京）：${today}\n`);

  const admin = await call('POST', '/api/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  const adminToken = admin.data.token;

  /* ---------------- 模块三：隐私与管理员隔离 ---------------- */
  console.log('[1] 排行榜隐私与管理员隔离');
  const u1 = await register(`v4a_${suffix}`);
  const anonBoard = await call('GET', '/api/leaderboard/streak?limit=50');
  check('匿名可读榜单', anonBoard.status === 200, anonBoard.status);
  check('匿名不返回真实用户名', anonBoard.data.rows.every((r) => /^匿名用户\d+$/.test(r.username)), anonBoard.data.rows.map((r) => r.username));
  check('匿名隐藏 userId', anonBoard.data.rows.every((r) => r.userId === null));
  check('匿名隐藏积分', anonBoard.data.rows.every((r) => r.points === null));
  check('匿名隐藏勋章', anonBoard.data.rows.every((r) => Array.isArray(r.badges) && r.badges.length === 0));
  check('匿名保留连胜/总次数', anonBoard.data.rows.every((r) => typeof r.streak === 'number' && typeof r.totalCheckins === 'number'));
  check('管理员不在榜上', !anonBoard.data.rows.some((r) => r.username === ADMIN_USERNAME));
  check('响应标记 anonymous', anonBoard.data.anonymous === true);

  const authedBoard = await call('GET', '/api/leaderboard/streak?limit=50', { token: u1.token });
  check('登录后显示真实用户名', authedBoard.data.rows.every((r) => !r.username.startsWith('匿名用户')));
  check('登录后含积分与 isMe', authedBoard.data.rows.some((r) => r.isMe === true) && authedBoard.data.rows.every((r) => typeof r.points === 'number'));

  /* ---------------- 模块二：好友撤回 / 删除 ---------------- */
  console.log('\n[2] 好友申请撤回与删除好友');
  const u2 = await register(`v4b_${suffix}`);
  await call('POST', '/api/friends/request', { token: u1.token, body: { userId: u2.id } });

  const list1 = await call('GET', '/api/friends/list', { token: u1.token });
  check('发出的申请可见', list1.data.outgoing.some((o) => o.id === u2.id), list1.data.outgoing);

  const cancel = await call('POST', '/api/friends/cancel', { token: u1.token, body: { userId: u2.id } });
  check('撤回申请成功', cancel.status === 200, cancel.data);

  const list2 = await call('GET', '/api/friends/list', { token: u1.token });
  check('撤回后申请消失', list2.data.outgoing.length === 0, list2.data.outgoing);

  const cancelAgain = await call('POST', '/api/friends/cancel', { token: u1.token, body: { userId: u2.id } });
  check('重复撤回 404', cancelAgain.status === 404, cancelAgain.data);

  await call('POST', '/api/friends/request', { token: u1.token, body: { userId: u2.id } });
  await call('POST', '/api/friends/accept', { token: u2.token, body: { userId: u1.id } });

  const del = await call('POST', '/api/friends/delete', { token: u1.token, body: { userId: u2.id } });
  check('删除好友成功', del.status === 200 && del.data.removed === 2, del.data);

  const list3 = await call('GET', '/api/friends/list', { token: u1.token });
  const list4 = await call('GET', '/api/friends/list', { token: u2.token });
  check('双向删除（自己侧）', list3.data.friends.length === 0, list3.data.friends);
  check('双向删除（对方侧）', list4.data.friends.length === 0, list4.data.friends);

  const delAgain = await call('POST', '/api/friends/delete', { token: u1.token, body: { userId: u2.id } });
  check('重复删除 404', delAgain.status === 404, delAgain.data);

  /* ---------------- 模块四：休假审批 ---------------- */
  console.log('\n[3] 休假自动通过（开关=1）');
  await call('PUT', '/api/admin/settings', { token: adminToken, body: { autoApproveVacation: true } });

  const auto = await call('POST', '/api/vacation', {
    token: u1.token,
    body: { startDate: today, endDate: addDays(today, 1), reason: '家里有事' },
  });
  check('自动通过', auto.status === 201 && auto.data.autoApproved === true && auto.data.request.status === 'approved', auto.data);
  check('提示语正确', auto.data.message === '休假已自动通过', auto.data.message);

  const statusV = await call('GET', '/api/status', { token: u1.token });
  check('今日状态为 vacation', statusV.data.status === 'vacation' && statusV.data.isVacation === true, statusV.data.status);
  check('休假不触发阻断', statusV.data.blocked === false, statusV.data.blocked);
  check('vacation_until 已更新', statusV.data.user.vacationUntil === addDays(today, 1), statusV.data.user.vacationUntil);

  const tooLong = await call('POST', '/api/vacation', {
    token: u2.token,
    body: { startDate: addDays(today, 5), endDate: addDays(today, 8) },
  });
  check('超过 3 天被拒绝 400', tooLong.status === 400, tooLong.data);

  console.log('\n[4] 休假手动审批（开关=0）');
  await call('PUT', '/api/admin/settings', { token: adminToken, body: { autoApproveVacation: false } });
  const settings = await call('GET', '/api/settings', { token: u2.token });
  check('开关已关闭', settings.data.autoApproveVacation === false, settings.data.autoApproveVacation);

  const manual = await call('POST', '/api/vacation', {
    token: u2.token,
    body: { startDate: addDays(today, 3), endDate: addDays(today, 4), reason: '考试' },
  });
  check('手动模式状态 pending', manual.status === 201 && manual.data.request.status === 'pending', manual.data);

  const adminList = await call('GET', '/api/admin/vacations', { token: adminToken });
  check('管理员看到待审批', adminList.data.pending.some((v) => v.id === manual.data.request.id), adminList.data.pending);

  const approve = await call('POST', `/api/admin/vacations/${manual.data.request.id}/approve`, { token: adminToken });
  check('管理员同意', approve.status === 200 && approve.data.status === 'approved', approve.data);

  const myList = await call('GET', '/api/vacation/my', { token: u2.token });
  check('用户侧状态已更新', myList.data.requests.some((v) => v.id === manual.data.request.id && v.status === 'approved'), myList.data.requests);

  const approveAgain = await call('POST', `/api/admin/vacations/${manual.data.request.id}/approve`, { token: adminToken });
  check('重复审批 409', approveAgain.status === 409, approveAgain.data);

  const u3 = await register(`v4c_${suffix}`);
  const r3 = await call('POST', '/api/vacation', { token: u3.token, body: { startDate: addDays(today, 2), endDate: addDays(today, 2) } });
  const u4 = await register(`v4d_${suffix}`);
  const r4 = await call('POST', '/api/vacation', { token: u4.token, body: { startDate: addDays(today, 2), endDate: addDays(today, 3) } });
  const all = await call('POST', '/api/admin/vacations/approve-all', { token: adminToken });
  check('一键同意全部', all.status === 200 && all.data.approved >= 2, all.data);

  const rejected = await call('POST', `/api/admin/vacations/${r3.data.request.id}/reject`, { token: adminToken });
  check('已通过的申请不能再拒绝 409', rejected.status === 409, rejected.data);

  /* ---------------- 模块五：改密码 ---------------- */
  console.log('\n[5] 修改密码');
  const badOld = await call('POST', '/api/user/change-password', {
    token: u3.token,
    body: { oldPassword: 'wrong-pass', newPassword: 'newpass123' },
  });
  check('旧密码错误 403', badOld.status === 403 && badOld.data.error === 'BAD_OLD_PASSWORD', badOld.data);

  const same = await call('POST', '/api/user/change-password', {
    token: u3.token,
    body: { oldPassword: 'secret123', newPassword: 'secret123' },
  });
  check('新旧相同被拒绝 400', same.status === 400, same.data);

  const changed = await call('POST', '/api/user/change-password', {
    token: u3.token,
    body: { oldPassword: 'secret123', newPassword: 'newpass123' },
  });
  check('修改成功', changed.status === 200 && Boolean(changed.data.token), changed.data);

  const loginNew = await call('POST', '/api/login', { body: { username: u3.name, password: 'newpass123' } });
  check('新密码可登录', loginNew.status === 200, loginNew.status);
  const loginOld = await call('POST', '/api/login', { body: { username: u3.name, password: 'secret123' } });
  check('旧密码失效', loginOld.status === 401, loginOld.status);

  /* ---------------- 模块五：特殊勋章 ---------------- */
  console.log('\n[6] 特殊勋章（早起 / 极限微操）');
  const ub = await register(`v4badge_${suffix}`);
  const habit = db.prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY id LIMIT 1').get(ub.id);
  const nowIso = new Date().toISOString();
  for (let i = 0; i < 7; i += 1) {
    db.prepare(`
      INSERT OR REPLACE INTO checkins (habit_id, user_id, date, late, note, makeup, early, edge, created_at)
      VALUES (?, ?, ?, 0, NULL, 0, 1, 1, ?)
    `).run(habit.id, ub.id, addDays(today, -i), nowIso);
  }
  const badgeStatus = await call('GET', '/api/status', { token: ub.token });
  check('连续 7 天早起 → 🐦', badgeStatus.data.badges.includes('🐦'), badgeStatus.data.badges);
  check('连续 7 天极限 → 🦉', badgeStatus.data.badges.includes('🦉'), badgeStatus.data.badges);

  const badgeBoard = await call('GET', '/api/leaderboard/streak', { token: ub.token });
  const badgeRow = badgeBoard.data.rows.find((r) => r.userId === ub.id);
  check('排行榜也显示特殊勋章', badgeRow.badges.includes('🐦') && badgeRow.badges.includes('🦉'), badgeRow.badges);

  /* ---------------- 模块三：管理员删号 ---------------- */
  console.log('\n[7] 管理员删号（级联）');
  const victim = await register(`v4del_${suffix}`);
  await call('POST', '/api/checkin', { token: victim.token, body: {} });

  const delUser = await call('DELETE', `/api/admin/user/${victim.id}`, { token: adminToken });
  check('删除成功', delUser.status === 200 && delUser.data.deleted === victim.name, delUser.data);

  const victimLogin = await call('POST', '/api/login', { body: { username: victim.name, password: 'secret123' } });
  check('被删账号无法登录', victimLogin.status === 401, victimLogin.status);

  const leftover = db.prepare('SELECT COUNT(*) AS n FROM habits WHERE user_id = ?').get(victim.id).n;
  check('习惯级联清理', leftover === 0, leftover);
  const vac = db.prepare('SELECT COUNT(*) AS n FROM vacation_requests WHERE user_id = ?').get(victim.id).n;
  check('休假记录级联清理', vac === 0, vac);

  const delAdmin = await call('DELETE', `/api/admin/user/${admin.data.user.id}`, { token: adminToken });
  check('不能删除管理员 400', delAdmin.status === 400, delAdmin.data);

  const noAuth = await call('DELETE', `/api/admin/user/${u1.id}`);
  check('未登录删号 401', noAuth.status === 401, noAuth.status);

  console.log(`\n=== v4 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  db.close();
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
