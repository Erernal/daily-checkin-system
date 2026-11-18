/**
 * 后端接口冒烟测试（Node 18+ 自带 fetch）
 * 用法：
 *   1) 先启动服务：npm start（或 PORT=3100 node server.js）
 *   2) 另开终端：API_BASE=http://127.0.0.1:3100 node test/smoke.mjs
 */

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';

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

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
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

async function main() {
  console.log(`\nAPI 冒烟测试 -> ${BASE}\n`);

  console.log('[1] 健康检查');
  const health = await call('GET', '/api/health');
  check('GET /api/health 返回 200', health.status === 200, health);
  check('健康检查 ok=true', health.data && health.data.ok === true, health.data);

  console.log('\n[2] 注册 / 登录');
  const aliceName = `alice_${suffix}`;
  const bobName = `bob_${suffix}`;

  const regAlice = await call('POST', '/api/register', {
    body: { username: aliceName, password: 'secret123' },
  });
  check('注册 Alice 返回 201', regAlice.status === 201, regAlice);
  check('注册返回 token', Boolean(regAlice.data && regAlice.data.token), regAlice.data);

  const regWeak = await call('POST', '/api/register', {
    body: { username: 'x', password: '1' },
  });
  check('弱口令/非法用户名被拒绝 400', regWeak.status === 400, regWeak);

  const regDup = await call('POST', '/api/register', {
    body: { username: aliceName, password: 'secret123' },
  });
  check('重复用户名返回 409', regDup.status === 409, regDup);

  const bob = await call('POST', '/api/register', {
    body: { username: bobName, password: 'secret123' },
  });
  check('注册 Bob 返回 201', bob.status === 201, bob);

  const badLogin = await call('POST', '/api/login', {
    body: { username: aliceName, password: 'wrong-pass' },
  });
  check('错误密码返回 401', badLogin.status === 401, badLogin);

  const adminLogin = await call('POST', '/api/login', {
    body: { username: 'admin', password: 'admin123' },
  });
  check('内置管理员 admin/admin123 可登录', adminLogin.status === 200, adminLogin);
  check('管理员标记 isAdmin', adminLogin.data && adminLogin.data.user.isAdmin === true, adminLogin.data);

  const alice = { token: regAlice.data.token };

  console.log('\n[3] 未登录访问受保护接口');
  const noAuth = await call('GET', '/api/status');
  check('无 token 返回 401', noAuth.status === 401, noAuth);

  console.log('\n[4] 打卡状态 / 设置');
  const status0 = await call('GET', '/api/status', { token: alice.token });
  check('初始状态为 pending 或 missed', ['pending', 'missed'].includes(status0.data.status), status0.data);
  check('新用户连胜为 0', status0.data.streak === 0, status0.data);

  const settings0 = await call('GET', '/api/settings', { token: alice.token });
  check('默认截止时间存在', /^\d{2}:\d{2}$/.test(settings0.data.deadline), settings0.data);

  const setTime = await call('PUT', '/api/settings', {
    token: alice.token,
    body: { deadline: '23:59' },
  });
  check('修改个人截止时间成功', setTime.status === 200 && setTime.data.deadline === '23:59', setTime);

  const badTime = await call('PUT', '/api/settings', {
    token: alice.token,
    body: { deadline: '25:99' },
  });
  check('非法时间被拒绝 400', badTime.status === 400, badTime);

  console.log('\n[5] 打卡');
  const checkin1 = await call('POST', '/api/checkin', { token: alice.token });
  check('首次打卡返回 201', checkin1.status === 201, checkin1);
  check('打卡后连胜 = 1', checkin1.data.status.streak === 1, checkin1.data);
  check('打卡后 status = done 或 late', ['done', 'late'].includes(checkin1.data.status.status), checkin1.data.status);
  check('打卡后不再阻断', checkin1.data.status.blocked === false, checkin1.data.status);

  const checkin2 = await call('POST', '/api/checkin', { token: alice.token });
  check('重复打卡幂等（alreadyCheckedIn）', checkin2.status === 200 && checkin2.data.alreadyCheckedIn === true, checkin2);

  console.log('\n[6] 借口');
  const bobStatus = await call('GET', '/api/status', { token: bob.data.token });
  check('Bob 初始未阻断', bobStatus.data.blocked === false, bobStatus.data);

  const excuseShort = await call('POST', '/api/excuse', {
    token: bob.data.token,
    body: { reason: '忙' },
  });
  check('过短借口被拒绝 400', excuseShort.status === 400, excuseShort);

  const excuse = await call('POST', '/api/excuse', {
    token: bob.data.token,
    body: { reason: '今天加班到凌晨，实在没赶上截止时间。' },
  });
  check('提交借口返回 201', excuse.status === 201, excuse);
  check('借口后状态为 excused', excuse.data.status.status === 'excused', excuse.data.status);
  check('借口后解除阻断', excuse.data.status.blocked === false, excuse.data.status);

  const excuseAgain = await call('POST', '/api/excuse', {
    token: bob.data.token,
    body: { reason: '今天加班到凌晨，实在没赶上截止时间。' },
  });
  check('同一天重复借口幂等', excuseAgain.data.alreadyExcused === true, excuseAgain.data);

  console.log('\n[7] 排行榜');
  const board = await call('GET', '/api/leaderboard', { token: alice.token });
  check('排行榜返回 200', board.status === 200, board);
  check('排行榜含 Alice', board.data.rows.some((r) => r.username === aliceName), board.data.rows);
  check('排行榜标记 isMe', board.data.rows.some((r) => r.isMe === true), board.data.rows);
  check('排名从 1 开始连续', board.data.rows.every((r, i) => r.rank === i + 1), board.data.rows.map((r) => r.rank));
  check('Alice 排第一（连胜最高）', board.data.rows[0].username === aliceName, board.data.rows[0]);

  console.log('\n[8] 管理员重置');
  const target = board.data.rows.find((r) => r.username === aliceName);
  const denyReset = await call('POST', `/api/admin/users/${target.userId}/reset`, {
    token: bob.data.token,
  });
  check('普通用户重置被拒绝 403', denyReset.status === 403, denyReset);

  const reset = await call('POST', `/api/admin/users/${target.userId}/reset`, {
    token: adminLogin.data.token,
    body: { resetStreak: true },
  });
  check('管理员重置成功', reset.status === 200, reset);
  check('重置后连胜归零', reset.data.user.streak === 0, reset.data.user);

  const afterReset = await call('GET', '/api/status', { token: alice.token });
  check('重置后 Alice 今日未打卡', afterReset.data.checkedIn === false, afterReset.data);

  console.log('\n[9] 修改账号');
  const badAccount = await call('PUT', '/api/account', {
    token: alice.token,
    body: { password: 'newpass123', currentPassword: 'wrong' },
  });
  check('当前密码错误时改密被拒绝 403', badAccount.status === 403, badAccount);

  const newName = `alice2_${suffix}`;
  const account = await call('PUT', '/api/account', {
    token: alice.token,
    body: { username: newName, password: 'newpass123', currentPassword: 'secret123' },
  });
  check('修改用户名+密码成功', account.status === 200, account);

  const loginNew = await call('POST', '/api/login', {
    body: { username: newName, password: 'newpass123' },
  });
  check('新密码可登录', loginNew.status === 200, loginNew);

  const board2 = await call('GET', '/api/leaderboard', { token: adminLogin.data.token });
  check('改名后排行榜同步', board2.data.rows.some((r) => r.username === newName), board2.data.rows.map((r) => r.username));

  console.log('\n[10] 管理员修改全局设置');
  const globalSettings = await call('PUT', '/api/admin/settings', {
    token: adminLogin.data.token,
    body: { defaultDeadline: '21:30' },
  });
  check('管理员修改全局截止时间', globalSettings.status === 200 && globalSettings.data.defaultDeadline === '21:30', globalSettings);
  check('时区被强制为北京时间', globalSettings.data.timezone === 'Asia/Shanghai', globalSettings.data);

  const badDeadline = await call('PUT', '/api/admin/settings', {
    token: adminLogin.data.token,
    body: { defaultDeadline: '99:99' },
  });
  check('非法默认截止时间被拒绝 400', badDeadline.status === 400, badDeadline);

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
