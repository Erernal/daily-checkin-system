'use strict';

/* ==========================================================================
 *  不拖延 · 强制打卡系统 v3.0
 * --------------------------------------------------------------------------
 *  Node.js 18+ / Express 4 / better-sqlite3 / JWT
 *
 *  v3 新增：
 *   · 打卡项 habits：active_days（生效星期）、deadline_time（每日截止）、
 *     start_date（生效日期），支持多习惯、休息日、按习惯独立连胜；
 *   · 结算按 habits.active_days 判定：休息日不断签、不扣分；
 *   · 积分：打卡 +10、断签 -20、100 分兑换补签卡（断签时自动消耗保命）；
 *   · 请假额度：每人每月 3 次，月初自动重置，无额度时请假不保连胜；
 *   · 三榜：/api/leaderboard/streak | total | points（未登录只读可访问）；
 *   · 勋章：连续 7 天 🛡️、30 天 👑；
 *   · 设备号唯一：注册/登录可带 deviceId，users.device_id 唯一索引。
 * ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

/* --------------------------------------------------------------------------
 * 1. 配置
 * ------------------------------------------------------------------------ */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data', 'checkin.db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-please-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const BUSINESS_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_DEADLINE = process.env.DEFAULT_DEADLINE || '22:00';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PROD ? '' : 'admin123');

const POINTS_PER_CHECKIN = 10;
const POINTS_PER_BREAK = 20;
const MAKEUP_CARD_COST = 100;
const LEAVE_PER_MONTH = 3;
const MAX_HABITS = 20;
const MAX_ACTIVE_DAYS = 7;

const EXCUSE_LOOKBACK_DAYS = 7;
const LEADERBOARD_MAX = 200;
const CALENDAR_MAX_DAYS = 90;
const SKIP_DATES_MAX = 365;
const NUDGE_COOLDOWN_MS = 10 * 60 * 1000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (IS_PROD && JWT_SECRET === 'dev-only-secret-please-change-me') {
  console.warn('[warn] 生产环境请务必设置 JWT_SECRET 环境变量！');
}
if (IS_PROD && !process.env.ADMIN_PASSWORD) {
  console.warn('[warn] 生产环境未设置 ADMIN_PASSWORD，将随机生成管理员初始密码（只在建号时打印一次）');
}
if (!IS_PROD && !process.env.ADMIN_PASSWORD) {
  console.warn('[warn] 正在使用开发环境默认管理员密码，仅限本地调试；部署请设置 ADMIN_PASSWORD 与 NODE_ENV=production');
}

/* --------------------------------------------------------------------------
 * 2. 数据库与迁移
 * ------------------------------------------------------------------------ */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const nowIso = () => new Date().toISOString();

/* 北京时间格式化器要在迁移（ensureDefaultHabit 计算 start_date）之前就绪 */
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const pad2 = (n) => String(n).padStart(2, '0');

function tableColumns(name) {
  try {
    return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

function ensureColumn(table, column, ddl) {
  if (tableColumns(table).includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

/** 基础表（v1/v2 结构；新库直接建造成 v3 形状） */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash     TEXT    NOT NULL,
    is_admin          INTEGER NOT NULL DEFAULT 0,
    deadline          TEXT,
    current_streak    INTEGER NOT NULL DEFAULT 0,
    best_streak       INTEGER NOT NULL DEFAULT 0,
    last_counted_date TEXT,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS habits (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT    NOT NULL,
    emoji             TEXT    NOT NULL DEFAULT '⏰',
    active_days       TEXT    NOT NULL DEFAULT '1,2,3,4,5,6,7',
    deadline_time     TEXT    NOT NULL DEFAULT '22:00',
    start_date        TEXT    NOT NULL,
    current_streak    INTEGER NOT NULL DEFAULT 0,
    best_streak       INTEGER NOT NULL DEFAULT 0,
    last_counted_date TEXT,
    archived          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,
    late       INTEGER NOT NULL DEFAULT 0,
    note       TEXT,
    makeup     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL,
    UNIQUE (habit_id, date)
  );

  CREATE TABLE IF NOT EXISTS excuses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,
    reason     TEXT    NOT NULL,
    uses_leave INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL,
    UNIQUE (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   INTEGER,
    action     TEXT NOT NULL,
    target_id  INTEGER,
    detail     TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS friends (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    UNIQUE (user_id, friend_id),
    CHECK (user_id <> friend_id)
  );

  CREATE TABLE IF NOT EXISTS nudges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date         TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
  );

  /* 设备登录记录：只记录不拦截，用于注册时判断“这台设备是否已经用过” */
  CREATE TABLE IF NOT EXISTS device_logins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id     TEXT    NOT NULL,
    first_seen_at TEXT    NOT NULL,
    last_seen_at  TEXT    NOT NULL,
    UNIQUE (user_id, device_id)
  );

  /* 休假申请（自动/手动审批） */
  CREATE TABLE IF NOT EXISTS vacation_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_date  TEXT    NOT NULL,
    end_date    TEXT    NOT NULL,
    reason      TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at  TEXT    NOT NULL,
    reviewed_at TEXT,
    reviewed_by INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_checkins_user_date  ON checkins (user_id, date);
  CREATE INDEX IF NOT EXISTS idx_excuses_user_date   ON excuses (user_id, date);
  CREATE INDEX IF NOT EXISTS idx_friends_user        ON friends (user_id, status);
  CREATE INDEX IF NOT EXISTS idx_friends_friend      ON friends (friend_id, status);
  CREATE INDEX IF NOT EXISTS idx_nudges_to_date      ON nudges (to_user_id, date);
  CREATE INDEX IF NOT EXISTS idx_device_logins_device ON device_logins (device_id);
  CREATE INDEX IF NOT EXISTS idx_habits_user         ON habits (user_id, archived);
  CREATE INDEX IF NOT EXISTS idx_vacation_user       ON vacation_requests (user_id, status);
  CREATE INDEX IF NOT EXISTS idx_vacation_status     ON vacation_requests (status);
`);

/* 注意：必须在预编译语句之前完成迁移，否则旧库缺少新列会导致 prepare 失败 */
migrate();

/* ---------------------------- 增量迁移 ---------------------------- */

function migrate() {
  // users 新字段
  ensureColumn('users', 'device_id', 'device_id TEXT');
  ensureColumn('users', 'points', 'points INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'leave_balance', `leave_balance INTEGER NOT NULL DEFAULT ${LEAVE_PER_MONTH}`);
  ensureColumn('users', 'leave_month', 'leave_month TEXT');
  ensureColumn('users', 'makeup_cards', 'makeup_cards INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'vacation_until', 'vacation_until TEXT');
  ensureColumn('users', 'badge_early', 'badge_early INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'badge_edge', 'badge_edge INTEGER NOT NULL DEFAULT 0');

  // checkins：记录“是否 08:00 前 / 是否截止前 1 小时内”，用于特殊勋章
  ensureColumn('checkins', 'early', 'early INTEGER NOT NULL DEFAULT 0');
  ensureColumn('checkins', 'edge', 'edge INTEGER NOT NULL DEFAULT 0');

  // 设备号不再做数据库级唯一约束：登录换机要能静默更新；
  // 防小号靠注册时查 device_logins / users.device_id。
  db.exec('DROP INDEX IF EXISTS idx_users_device');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_device ON users (device_id)');

  // excuses 是否消耗请假额度
  ensureColumn('excuses', 'uses_leave', 'uses_leave INTEGER NOT NULL DEFAULT 1');

  // checkins 从 v2（user_id,date）升级到 v3（habit_id,date）
  const cols = tableColumns('checkins');
  if (!cols.includes('habit_id')) {
    console.log('[migrate] 正在把 checkins 升级为多习惯结构…');
    db.exec('ALTER TABLE checkins RENAME TO checkins_v2_backup');
    db.exec(`
      CREATE TABLE checkins (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date       TEXT    NOT NULL,
        late       INTEGER NOT NULL DEFAULT 0,
        note       TEXT,
        makeup     INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL,
        UNIQUE (habit_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_checkins_habit_date ON checkins (habit_id, date);
      CREATE INDEX IF NOT EXISTS idx_checkins_user_date  ON checkins (user_id, date);
    `);

    const users = db.prepare('SELECT * FROM users').all();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO checkins (habit_id, user_id, date, late, note, makeup, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `);

    for (const user of users) {
      const habit = ensureDefaultHabit(user);
      const rows = db.prepare('SELECT * FROM checkins_v2_backup WHERE user_id = ?').all(user.id);
      for (const row of rows) {
        insert.run(habit.id, user.id, row.date, row.late, row.note, row.created_at);
      }
      db.prepare(
        'UPDATE habits SET current_streak = ?, best_streak = ?, last_counted_date = ? WHERE id = ?'
      ).run(user.current_streak || 0, user.best_streak || 0, user.last_counted_date, habit.id);
    }
    console.log(`[migrate] 完成：${users.length} 个用户，checkins 已迁移到默认习惯`);
  }

  // 每个用户至少有一个习惯
  for (const user of db.prepare('SELECT * FROM users').all()) ensureDefaultHabit(user);

  // 习惯维度索引只能在 habit_id 存在后创建
  db.exec('CREATE INDEX IF NOT EXISTS idx_checkins_habit_date ON checkins (habit_id, date)');
}

/** 给用户兜底创建一个「每日打卡」习惯（老数据迁移 / 新用户注册都用它） */
function ensureDefaultHabit(user, deadline) {
  const existing = db
    .prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY id ASC LIMIT 1')
    .get(user.id);
  if (existing) return existing;

  const start = dateKey(new Date(user.created_at || Date.now()));
  const info = db
    .prepare(`
      INSERT INTO habits (user_id, name, emoji, active_days, deadline_time, start_date, created_at, updated_at)
      VALUES (?, '每日打卡', '⏰', '1,2,3,4,5,6,7', ?, ?, ?, ?)
    `)
    .run(user.id, deadline || user.deadline || DEFAULT_DEADLINE, start, nowIso(), nowIso());

  return db.prepare('SELECT * FROM habits WHERE id = ?').get(info.lastInsertRowid);
}

/* --------------------------------------------------------------------------
 * 3. 预编译语句
 * ------------------------------------------------------------------------ */

const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  userByDevice: db.prepare('SELECT * FROM users WHERE device_id = ?'),
  deviceLoginByDevice: db.prepare('SELECT user_id FROM device_logins WHERE device_id = ? LIMIT 1'),
  upsertDeviceLogin: db.prepare(`
    INSERT INTO device_logins (user_id, device_id, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, device_id)
    DO UPDATE SET last_seen_at = excluded.last_seen_at
  `),
  allUsers: db.prepare('SELECT * FROM users ORDER BY id ASC'),
  insertUser: db.prepare(`
    INSERT INTO users (username, password_hash, is_admin, device_id, points, leave_balance, leave_month, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
  `),
  updateUserDeadline: db.prepare('UPDATE users SET deadline = ?, updated_at = ? WHERE id = ?'),
  updateUsername: db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'),
  updateDevice: db.prepare('UPDATE users SET device_id = ?, updated_at = ? WHERE id = ?'),
  addPoints: db.prepare('UPDATE users SET points = MAX(0, points + ?), updated_at = ? WHERE id = ?'),
  updateLeave: db.prepare('UPDATE users SET leave_balance = ?, leave_month = ?, updated_at = ? WHERE id = ?'),
  takeLeave: db.prepare('UPDATE users SET leave_balance = leave_balance - 1, updated_at = ? WHERE id = ?'),
  takeMakeup: db.prepare('UPDATE users SET makeup_cards = makeup_cards - 1, updated_at = ? WHERE id = ?'),
  addMakeup: db.prepare('UPDATE users SET makeup_cards = makeup_cards + ?, updated_at = ? WHERE id = ?'),
  syncUserStreak: db.prepare(
    'UPDATE users SET current_streak = ?, best_streak = ?, last_counted_date = ?, updated_at = ? WHERE id = ?'
  ),

  habitsByUser: db.prepare('SELECT * FROM habits WHERE user_id = ? AND archived = 0 ORDER BY id ASC'),
  habitById: db.prepare('SELECT * FROM habits WHERE id = ?'),
  countHabits: db.prepare('SELECT COUNT(*) AS n FROM habits WHERE user_id = ? AND archived = 0'),
  insertHabit: db.prepare(`
    INSERT INTO habits (user_id, name, emoji, active_days, deadline_time, start_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateHabit: db.prepare(`
    UPDATE habits SET name = ?, emoji = ?, active_days = ?, deadline_time = ?, start_date = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `),
  archiveHabit: db.prepare('UPDATE habits SET archived = 1, updated_at = ? WHERE id = ? AND user_id = ?'),
  updateHabitStreak: db.prepare(
    'UPDATE habits SET current_streak = ?, best_streak = ?, last_counted_date = ?, updated_at = ? WHERE id = ?'
  ),
  maxStreak: db.prepare(
    'SELECT COALESCE(MAX(current_streak), 0) AS n FROM habits WHERE user_id = ? AND archived = 0'
  ),
  maxBestStreak: db.prepare(
    'SELECT COALESCE(MAX(best_streak), 0) AS n FROM habits WHERE user_id = ? AND archived = 0'
  ),

  checkinOn: db.prepare('SELECT * FROM checkins WHERE habit_id = ? AND date = ?'),
  insertCheckin: db.prepare(`
    INSERT INTO checkins (habit_id, user_id, date, late, note, makeup, early, edge, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  deleteCheckinsOn: db.prepare('DELETE FROM checkins WHERE user_id = ? AND date = ?'),
  totalCheckins: db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND makeup = 0'),
  countBetween: db.prepare(
    'SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND makeup = 0 AND date BETWEEN ? AND ?'
  ),

  excuseOn: db.prepare('SELECT * FROM excuses WHERE user_id = ? AND date = ?'),
  insertExcuse: db.prepare(`
    INSERT INTO excuses (user_id, date, reason, uses_leave, created_at) VALUES (?, ?, ?, ?, ?)
  `),
  deleteExcuseOn: db.prepare('DELETE FROM excuses WHERE user_id = ? AND date = ?'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  audit: db.prepare(
    'INSERT INTO audit_log (actor_id, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?)'
  ),

  friendshipOne: db.prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?'),
  upsertFriendship: db.prepare(`
    INSERT INTO friends (user_id, friend_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, friend_id)
    DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
  `),
  friendshipsOf: db.prepare('SELECT * FROM friends WHERE user_id = ? OR friend_id = ?'),
  acceptedFriends: db.prepare(`
    SELECT u.*, f.created_at AS friends_since
    FROM friends f JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ? AND f.status = 'accepted'
  `),
  incomingRequests: db.prepare(`
    SELECT u.id, u.username, f.created_at AS requested_at
    FROM friends f JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `),
  outgoingRequests: db.prepare(`
    SELECT u.id, u.username, f.created_at AS requested_at
    FROM friends f JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `),

  insertNudge: db.prepare(
    'INSERT INTO nudges (from_user_id, to_user_id, date, created_at) VALUES (?, ?, ?, ?)'
  ),
  lastNudgeBetween: db.prepare(
    'SELECT * FROM nudges WHERE from_user_id = ? AND to_user_id = ? ORDER BY id DESC LIMIT 1'
  ),
  nudgesTodayFor: db.prepare(`
    SELECT n.id, n.created_at, u.username AS from_username
    FROM nudges n JOIN users u ON u.id = n.from_user_id
    WHERE n.to_user_id = ? AND n.date = ?
    ORDER BY n.id DESC LIMIT 5
  `),

  /* 休假 */
  approvedVacationOn: db.prepare(`
    SELECT * FROM vacation_requests
    WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?
    LIMIT 1
  `),
  myVacations: db.prepare(
    'SELECT * FROM vacation_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20'
  ),
  overlapVacation: db.prepare(`
    SELECT * FROM vacation_requests
    WHERE user_id = ? AND status IN ('pending', 'approved')
      AND start_date <= ? AND end_date >= ?
    LIMIT 1
  `),
  insertVacation: db.prepare(`
    INSERT INTO vacation_requests (user_id, start_date, end_date, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  vacationById: db.prepare('SELECT * FROM vacation_requests WHERE id = ?'),
  updateVacation: db.prepare(`
    UPDATE vacation_requests SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?
  `),
  pendingVacations: db.prepare(`
    SELECT v.*, u.username
    FROM vacation_requests v JOIN users u ON u.id = v.user_id
    WHERE v.status = 'pending'
    ORDER BY v.id ASC
    LIMIT 200
  `),
  recentVacations: db.prepare(`
    SELECT v.*, u.username
    FROM vacation_requests v JOIN users u ON u.id = v.user_id
    WHERE v.status != 'pending'
    ORDER BY v.id DESC
    LIMIT 30
  `),
  approveAllVacations: db.prepare(`
    UPDATE vacation_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ?
    WHERE status = 'pending'
  `),
  maxApprovedVacation: db.prepare(`
    SELECT MAX(end_date) AS d FROM vacation_requests
    WHERE user_id = ? AND status = 'approved'
  `),
  setVacationUntil: db.prepare('UPDATE users SET vacation_until = ?, updated_at = ? WHERE id = ?'),
};

/* --------------------------------------------------------------------------
 * 4. 种子数据
 * ------------------------------------------------------------------------ */

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function seed() {
  const defaults = {
    default_deadline: DEFAULT_DEADLINE,
    site_name: '拒绝摆烂（NoSlack）',
    skip_dates: '',
    auto_approve_vacation: '1',
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!q.getSetting.get(key)) q.setSetting.run(key, value);
  }

  const existing = q.userByName.get(ADMIN_USERNAME);
  if (!existing) {
    const generated = !ADMIN_PASSWORD;
    const initialPassword = generated ? randomPassword() : ADMIN_PASSWORD;
    const now = nowIso();
    const info = q.insertUser.run(
      ADMIN_USERNAME,
      hashPassword(initialPassword),
      1,
      null,
      LEAVE_PER_MONTH,
      currentMonth(),
      now,
      now
    );
    const admin = q.userById.get(info.lastInsertRowid);
    ensureDefaultHabit(admin, defaultDeadline());

    console.log(`[seed] 已创建管理员账号：${ADMIN_USERNAME}`);
    if (generated) {
      console.log('[seed] 初始密码（仅打印这一次，登录后请立即修改）：');
      console.log(`[seed]   ${initialPassword}`);
    } else {
      console.log('[seed] 初始密码来自 ADMIN_PASSWORD 环境变量（不在日志中显示）');
    }
  } else if (existing.is_admin !== 1) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
  }
}

/* --------------------------------------------------------------------------
 * 5. 密码 / Token
 * ------------------------------------------------------------------------ */

const SCRYPT_KEYLEN = 64;

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const derived = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(hash, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function signToken(user) {
  return jwt.sign({ sub: String(user.id), adm: user.is_admin === 1 }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

/* --------------------------------------------------------------------------
 * 6. 时间工具（强制北京时间；formatter / pad2 已在文件顶部定义）
 * ------------------------------------------------------------------------ */

function zonedParts(date = new Date()) {
  const parts = formatter.formatToParts(date);
  const bag = {};
  for (const p of parts) if (p.type !== 'literal') bag[p.type] = p.value;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) % 24,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function dateKey(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function currentMonth() {
  return dateKey().slice(0, 7);
}

function minutesOfDay(date = new Date()) {
  const p = zonedParts(date);
  return p.hour * 60 + p.minute;
}

function secondsOfDay(date = new Date()) {
  const p = zonedParts(date);
  return p.hour * 3600 + p.minute * 60 + p.second;
}

function addDays(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function startOfWeek(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(key, -((dow + 6) % 7));
}

function weekdayIndex(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function isValidDateKey(value) {
  if (!DATE_RE.test(String(value))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/* --------------------------------------------------------------------------
 * 7. 设置 / 免打卡日
 * ------------------------------------------------------------------------ */

function getSetting(key, fallback = null) {
  const row = q.getSetting.get(key);
  return row ? row.value : fallback;
}

function defaultDeadline() {
  const value = getSetting('default_deadline', DEFAULT_DEADLINE);
  return TIME_RE.test(value) ? value : DEFAULT_DEADLINE;
}

let skipDatesCache = null;

function skipDates() {
  if (skipDatesCache) return skipDatesCache;
  const raw = getSetting('skip_dates', '') || '';
  const set = new Set();
  for (const piece of raw.split(/[\s,，;；]+/)) {
    const value = piece.trim();
    if (value && isValidDateKey(value)) set.add(value);
  }
  skipDatesCache = set;
  return set;
}

function isSkipDate(dateStr) {
  return skipDates().has(dateStr);
}

function nextSkipDate(fromDate) {
  let best = null;
  for (const d of skipDates()) if (d >= fromDate && (!best || d < best)) best = d;
  return best;
}

function setSkipDates(list) {
  const sorted = Array.from(new Set(list)).sort();
  q.setSetting.run('skip_dates', sorted.join(','));
  skipDatesCache = null;
  return sorted;
}

/* --------------------------------------------------------------------------
 * 8. 习惯工具
 * ------------------------------------------------------------------------ */

function parseActiveDays(csv) {
  const set = new Set();
  for (const piece of String(csv || '').split(',')) {
    const n = Number(piece.trim());
    if (Number.isInteger(n) && n >= 1 && n <= MAX_ACTIVE_DAYS) set.add(n);
  }
  return set;
}

function activeDaysToArray(csv) {
  return Array.from(parseActiveDays(csv)).sort((a, b) => a - b);
}

/** 校验并规整 activeDays，返回 '1,2,3' 或 null（非法） */
function normalizeActiveDays(input) {
  if (input === undefined) return undefined;
  let pieces;
  if (Array.isArray(input)) pieces = input;
  else if (typeof input === 'string') pieces = input.split(/[\s,]+/);
  else return null;

  const set = new Set();
  for (const piece of pieces) {
    const n = Number(String(piece).trim());
    if (!Number.isInteger(n) || n < 1 || n > MAX_ACTIVE_DAYS) return null;
    set.add(n);
  }
  if (!set.size) return null;
  return Array.from(set).sort((a, b) => a - b).join(',');
}

/** 该习惯在某天是否生效（生效星期 + 开始日期） */
function isActiveOn(habit, date) {
  if (habit.archived) return false;
  if (habit.start_date && date < habit.start_date) return false;
  return parseActiveDays(habit.active_days).has(weekdayIndex(date));
}

/* --------------------------------------------------------------------------
 * 9. 积分 / 请假 / 补签卡 / 勋章
 * ------------------------------------------------------------------------ */

function refreshUser(user) {
  const fresh = q.userById.get(user.id);
  return Object.assign(user, fresh);
}

/** 月初自动把请假额度重置为 3 */
function ensureLeaveMonth(user) {
  const month = currentMonth();
  if (user.leave_month !== month) {
    q.updateLeave.run(LEAVE_PER_MONTH, month, nowIso(), user.id);
    user.leave_balance = LEAVE_PER_MONTH;
    user.leave_month = month;
  }
  return user;
}

function addPoints(userId, delta) {
  q.addPoints.run(delta, nowIso(), userId);
}

function consumeMakeup(user) {
  if (!user.makeup_cards || user.makeup_cards <= 0) return false;
  q.takeMakeup.run(nowIso(), user.id);
  user.makeup_cards -= 1;
  return true;
}

/** 勋章：连胜 7/30 天 + 早起鸟（连续 7 天 08:00 前）+ 极限微操（连续 7 天截止前 1 小时） */
function badgesFor(user, bestStreak) {
  const badges = [];
  if (bestStreak >= 7) badges.push('🛡️');
  if (bestStreak >= 30) badges.push('👑');
  if (user && user.badge_early === 1) badges.push('🐦');
  if (user && user.badge_edge === 1) badges.push('🦉');
  return badges;
}

/** 休假判定：当天是否落在某条已通过的休假申请区间内 */
function isVacationOn(userId, date) {
  return Boolean(q.approvedVacationOn.get(userId, date, date));
}

/** 打卡后重新评估特殊勋章：最近 7 天每天都有 early/edge 打卡 */
function evaluateBadges(userId, today) {
  const from = addDays(today, -6);
  const early = db
    .prepare(
      'SELECT COUNT(DISTINCT date) AS n FROM checkins WHERE user_id = ? AND early = 1 AND date BETWEEN ? AND ?'
    )
    .get(userId, from, today).n;
  const edge = db
    .prepare(
      'SELECT COUNT(DISTINCT date) AS n FROM checkins WHERE user_id = ? AND edge = 1 AND date BETWEEN ? AND ?'
    )
    .get(userId, from, today).n;

  if (early >= 7) db.prepare('UPDATE users SET badge_early = 1 WHERE id = ? AND badge_early = 0').run(userId);
  if (edge >= 7) db.prepare('UPDATE users SET badge_edge = 1 WHERE id = ? AND badge_edge = 0').run(userId);
}

/* --------------------------------------------------------------------------
 * 10. 结算（按 habits.active_days）
 * ------------------------------------------------------------------------ */

/**
 * 把某个 habit 的 last_counted_date 推进到昨天：
 *  · 只在 active_days 内的日期要求打卡；
 *  · 休息日 / 免打卡日直接跳过；
 *  · 有 uses_leave=1 的请假 → 保连胜；
 *  · 否则优先消耗补签卡（记为补签打卡），没有卡才断签并扣 20 分。
 */
function settleHabit(user, habit, today) {
  const marker = habit.last_counted_date;
  if (!marker) return false;

  const yesterday = addDays(today, -1);
  if (marker >= yesterday) return false;

  let cursor = addDays(marker, 1);
  let missed = false;
  let guard = 0;

  while (cursor <= yesterday && guard < 400) {
    if (isActiveOn(habit, cursor) && !isSkipDate(cursor) && !isVacationOn(user.id, cursor)) {
      const hasCheckin = q.checkinOn.get(habit.id, cursor);
      const excuse = q.excuseOn.get(user.id, cursor);
      const protectedByLeave = Boolean(excuse && excuse.uses_leave === 1);

      if (!hasCheckin && !protectedByLeave) {
        if (consumeMakeup(user)) {
          q.insertCheckin.run(habit.id, user.id, cursor, 0, '补签卡', 1, 0, 0, nowIso());
        } else {
          missed = true;
        }
      }
    }
    cursor = addDays(cursor, 1);
    guard += 1;
  }

  const nextStreak = missed ? 0 : habit.current_streak;
  const nextBest = Math.max(habit.best_streak, nextStreak);

  q.updateHabitStreak.run(nextStreak, nextBest, yesterday, nowIso(), habit.id);
  if (missed) addPoints(user.id, -POINTS_PER_BREAK);

  habit.current_streak = nextStreak;
  habit.best_streak = nextBest;
  habit.last_counted_date = yesterday;
  return true;
}

/** 结算某个用户的全部习惯，并把 user 的聚合连胜同步过去 */
function settleUser(user, today = dateKey()) {
  const habits = q.habitsByUser.all(user.id);
  let changed = false;
  for (const habit of habits) {
    if (settleHabit(user, habit, today)) changed = true;
  }
  if (changed) {
    const streak = q.maxStreak.get(user.id).n;
    const best = q.maxBestStreak.get(user.id).n;
    const last = habits.reduce(
      (acc, h) => (h.last_counted_date && h.last_counted_date > acc ? h.last_counted_date : acc),
      null
    );
    q.syncUserStreak.run(streak, best, last, nowIso(), user.id);
    refreshUser(user);
  }
  return changed;
}

/* --------------------------------------------------------------------------
 * 11. 状态
 * ------------------------------------------------------------------------ */

function habitState(habit, user, today, now, nowMin) {
  const activeToday = isActiveOn(habit, today);
  const checkin = q.checkinOn.get(habit.id, today);
  const deadlinePassed = nowMin >= hhmmToMinutes(habit.deadline_time);
  const excuse = q.excuseOn.get(user.id, today);

  return {
    id: habit.id,
    name: habit.name,
    emoji: habit.emoji,
    activeDays: activeDaysToArray(habit.active_days),
    deadlineTime: habit.deadline_time,
    startDate: habit.start_date,
    streak: habit.current_streak,
    bestStreak: habit.best_streak,
    isActiveToday: activeToday,
    restToday: !activeToday,
    checkedIn: Boolean(checkin),
    late: Boolean(checkin && checkin.late === 1),
    checkinAt: checkin ? checkin.created_at : null,
    deadlinePassed,
    canCheckin: activeToday && !checkin && !isSkipDate(today) && !excuse,
    secondsUntilDeadline: deadlinePassed ? 0 : hhmmToMinutes(habit.deadline_time) * 60 - secondsOfDay(now),
  };
}

function buildStatus(user, now = new Date()) {
  const today = dateKey(now);
  const yesterday = addDays(today, -1);
  const nowMin = minutesOfDay(now);
  const holiday = isSkipDate(today);

  settleUser(user, today);
  refreshUser(user);
  ensureLeaveMonth(user);
  evaluateBadges(user.id, today);
  refreshUser(user);

  const vacation = isVacationOn(user.id, today);
  const habits = q.habitsByUser.all(user.id);
  const items = habits.map((h) => habitState(h, user, today, now, nowMin));
  const active = items.filter((i) => i.isActiveToday);
  const done = active.filter((i) => i.checkedIn);
  const lateAny = done.some((i) => i.late);
  const excuseToday = q.excuseOn.get(user.id, today);

  let status;
  if (vacation) status = 'vacation';
  else if (holiday) status = 'holiday';
  else if (excuseToday && !done.length) status = 'excused';
  else if (!active.length) status = 'rest';
  else if (done.length === active.length) status = lateAny ? 'late' : 'done';
  else if (done.length > 0) status = 'partial';
  else if (active.some((i) => i.deadlinePassed)) status = 'missed';
  else status = 'pending';

  const pendingPassed = active.some((i) => !i.checkedIn && i.deadlinePassed);
  const missedYesterday =
    !isSkipDate(yesterday) &&
    !isVacationOn(user.id, yesterday) &&
    habits.some((h) => {
      if (!isActiveOn(h, yesterday)) return false;
      if (q.checkinOn.get(h.id, yesterday)) return false;
      // 只要填过借口（哪怕没额度）就不再反复拦截，但没额度不会保连胜
      return !q.excuseOn.get(user.id, yesterday);
    });

  let blocked = false;
  let blockDate = null;
  let blockReason = null;

  if (!holiday && !vacation && !excuseToday) {
    if (pendingPassed) {
      blocked = true;
      blockDate = today;
      blockReason = 'TODAY_DEADLINE_PASSED';
    } else if (missedYesterday) {
      blocked = true;
      blockDate = yesterday;
      blockReason = 'YESTERDAY_MISSED';
    }
  }

  const streak = q.maxStreak.get(user.id).n;
  const best = q.maxBestStreak.get(user.id).n;
  const totalCheckins = q.totalCheckins.get(user.id).n;
  const nudges = q.nudgesTodayFor.all(user.id, today).map((row) => ({
    id: row.id,
    from: row.from_username,
    createdAt: row.created_at,
  }));

  return {
    user: {
      id: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1,
      deadline: user.deadline,
      createdAt: user.created_at,
      points: user.points,
      leaveBalance: user.leave_balance,
      makeupCards: user.makeup_cards,
      badges: badgesFor(user, best),
      vacationUntil: user.vacation_until || null,
    },
    today,
    timezone: BUSINESS_TIMEZONE,
    serverTime: now.toISOString(),
    isSkipDay: holiday,
    isVacation: vacation,
    nextSkipDate: nextSkipDate(today),
    status,
    statusLabel: {
      pending: '待打卡',
      done: '已打卡',
      late: '迟到',
      partial: '部分完成',
      excused: '已请假',
      missed: '漏签',
      holiday: '免打卡',
      rest: '今日休息',
      vacation: '休假中',
    }[status] || status,
    streak,
    bestStreak: best,
    totalCheckins,
    points: user.points,
    leaveBalance: user.leave_balance,
    makeupCards: user.makeup_cards,
    badges: badgesFor(user, best),
    habits: items,
    todayActiveCount: active.length,
    todayDoneCount: done.length,
    blocked,
    blockDate,
    blockReason,
    deadlinePassed: active.length ? active.every((i) => i.deadlinePassed) : false,
    secondsUntilDeadline: active.length
      ? Math.min(...active.map((i) => i.secondsUntilDeadline))
      : 0,
    nudges,
  };
}

/** 轻量版：只算今日状态（排行榜用） */
function todayStatusOf(user, today, nowMin) {
  if (isVacationOn(user.id, today)) return 'vacation';
  if (isSkipDate(today)) return 'holiday';
  const habits = q.habitsByUser.all(user.id);
  const active = habits.filter((h) => isActiveOn(h, today));
  if (!active.length) return 'rest';

  const done = active.filter((h) => q.checkinOn.get(h.id, today));
  if (done.length === active.length) {
    return done.some((h) => q.checkinOn.get(h.id, today).late === 1) ? 'late' : 'done';
  }
  if (q.excuseOn.get(user.id, today)) return 'excused';
  if (active.some((h) => nowMin >= hhmmToMinutes(h.deadline_time))) return 'missed';
  return 'pending';
}

function serializeUser(user) {
  const best = q.maxBestStreak.get(user.id).n;
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    deadline: user.deadline,
    streak: q.maxStreak.get(user.id).n,
    bestStreak: best,
    lastCountedDate: user.last_counted_date,
    createdAt: user.created_at,
    points: user.points,
    leaveBalance: user.leave_balance,
    makeupCards: user.makeup_cards,
    badges: badgesFor(user, best),
    deviceBound: Boolean(user.device_id),
    vacationUntil: user.vacation_until || null,
  };
}

function publicError(res, status, code, message, extra) {
  return res.status(status).json(Object.assign({ error: code, message }, extra || {}));
}

/* --------------------------------------------------------------------------
 * 12. 好友关系
 * ------------------------------------------------------------------------ */

function buildFriendMap(meId) {
  const map = new Map();
  const pendingIn = new Set();
  const pendingOut = new Set();

  for (const row of q.friendshipsOf.all(meId, meId)) {
    const other = row.user_id === meId ? row.friend_id : row.user_id;
    if (row.status === 'accepted') map.set(other, 'accepted');
    else if (row.user_id === meId) pendingOut.add(other);
    else pendingIn.add(other);
  }
  for (const id of pendingOut) if (!map.has(id)) map.set(id, 'pending_out');
  for (const id of pendingIn) if (!map.has(id)) map.set(id, 'pending_in');
  return map;
}

function friendshipState(a, b) {
  if (a === b) return 'self';
  const forward = q.friendshipOne.get(a, b);
  const backward = q.friendshipOne.get(b, a);
  if (forward && forward.status === 'accepted') return 'accepted';
  if (backward && backward.status === 'accepted') return 'accepted';
  if (forward && forward.status === 'pending') return 'pending_out';
  if (backward && backward.status === 'pending') return 'pending_in';
  return 'none';
}

/* --------------------------------------------------------------------------
 * 13. 排行榜
 * ------------------------------------------------------------------------ */

const BOARD_TYPES = {
  streak: { label: '连胜榜', unit: '天' },
  total: { label: '总次数榜', unit: '次' },
  points: { label: '积分榜', unit: '分' },
};

function buildBoard(type, me, limit) {
  const now = new Date();
  const today = dateKey(now);
  const nowMin = minutesOfDay(now);
  const friendMap = me ? buildFriendMap(me.id) : null;

  const rows = q.allUsers
    .all()
    .filter((user) => user.is_admin !== 1) // 管理员不上榜
    .map((user) => {
    settleUser(user, today);
    ensureLeaveMonth(user);
    refreshUser(user);

    const streak = q.maxStreak.get(user.id).n;
    const best = q.maxBestStreak.get(user.id).n;
    const total = q.totalCheckins.get(user.id).n;
    const points = user.points;
    const todayStatus = todayStatusOf(user, today, nowMin);
    const checkedInToday = todayStatus === 'done' || todayStatus === 'late';
    const friendship = friendMap
      ? friendMap.get(user.id) || (me && user.id === me.id ? 'self' : 'none')
      : null;

    const value = type === 'total' ? total : type === 'points' ? points : streak;

    return {
      userId: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1,
      value,
      score: value,
      streak,
      bestStreak: best,
      totalCheckins: total,
      points,
      badges: badgesFor(user, best),
      todayStatus,
      friendship,
      canNudge: Boolean(
        me &&
          friendship === 'accepted' &&
          !checkedInToday &&
          !isSkipDate(today) &&
          user.id !== me.id
      ),
      isMe: Boolean(me && user.id === me.id),
      createdAt: user.created_at,
    };
  });

  rows.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    if (b.streak !== a.streak) return b.streak - a.streak;
    if (b.totalCheckins !== a.totalCheckins) return b.totalCheckins - a.totalCheckins;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });

  const ranked = rows.map((row, index) => ({ rank: index + 1, ...row }));
  const meta = BOARD_TYPES[type] || BOARD_TYPES.streak;
  const visible = ranked.slice(0, limit);

  // 未登录：脱敏。只保留打卡次数与连胜天数，隐藏用户名/积分/勋章/好友信息
  const payloadRows = me
    ? visible
    : visible.map((row) => ({
        rank: row.rank,
        userId: null,
        username: `匿名用户${row.rank}`,
        isAdmin: false,
        value: type === 'points' ? null : row.value,
        score: type === 'points' ? null : row.value,
        streak: row.streak,
        bestStreak: row.bestStreak,
        totalCheckins: row.totalCheckins,
        points: null,
        badges: [],
        todayStatus: row.todayStatus,
        friendship: null,
        canNudge: false,
        isMe: false,
      }));

  return {
    type,
    typeLabel: meta.label,
    unit: meta.unit,
    period: type,
    anonymous: !me,
    generatedAt: now.toISOString(),
    timezone: BUSINESS_TIMEZONE,
    today,
    isSkipDay: isSkipDate(today),
    total: ranked.length,
    rows: payloadRows,
    me: me ? ranked.find((r) => r.userId === me.id) || null : null,
  };
}

/* --------------------------------------------------------------------------
 * 14. 限流
 * ------------------------------------------------------------------------ */

const buckets = new Map();

function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (now - b.start > 3600_000) buckets.delete(key);
}, 600_000).unref();

/* --------------------------------------------------------------------------
 * 15. Express 应用
 * ------------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: '128kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

function loadUserFromToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { token: '', error: 'NO_TOKEN' };
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = q.userById.get(Number(payload.sub));
    if (!user) return { token, error: 'USER_NOT_FOUND' };
    return { token, user };
  } catch (err) {
    return { token, error: err && err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' };
  }
}

function authRequired(req, res, next) {
  const { user, error } = loadUserFromToken(req);
  if (!user) {
    if (error === 'NO_TOKEN') return publicError(res, 401, 'UNAUTHORIZED', '请先登录');
    if (error === 'TOKEN_EXPIRED') return publicError(res, 401, 'TOKEN_EXPIRED', '登录已过期，请重新登录');
    return publicError(res, 401, 'TOKEN_INVALID', '登录凭证无效');
  }
  req.user = ensureLeaveMonth(user);
  next();
}

/** 可选登录：排行榜等接口即使未登录也能只读访问 */
function optionalAuth(req, res, next) {
  const { user } = loadUserFromToken(req);
  req.user = user || null;
  next();
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.is_admin !== 1) {
    return publicError(res, 403, 'FORBIDDEN', '需要管理员权限');
  }
  next();
}

function freshUser(user) {
  ensureLeaveMonth(user);
  settleUser(user, dateKey());
  refreshUser(user);
  return user;
}

/* ------------------------------- 健康检查 -------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'qiangzhi-checkin',
    version: '3.0.0',
    timezone: BUSINESS_TIMEZONE,
    now: new Date().toISOString(),
    today: dateKey(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/* ------------------------------- 用户系统 -------------------------------- */

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5-]{2,24}$/;

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    return '用户名需为 2-24 位字母、数字、下划线或中文';
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    return '密码长度需为 6-72 位';
  }
  return null;
}

function normalizeDeviceId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  return trimmed;
}

/**
 * 记录一次设备使用（注册 / 登录都会调用）：
 *  · device_logins 记录「哪台设备用过哪个账号」，注册时用来防小号；
 *  · 登录时静默把 users.device_id 更新为当前设备，不做任何拦截。
 */
function recordDevice(user, deviceId) {
  if (!deviceId) return;
  const now = nowIso();
  q.upsertDeviceLogin.run(user.id, deviceId, now, now);
  if (user.device_id !== deviceId) {
    q.updateDevice.run(deviceId, now, user.id);
    user.device_id = deviceId;
  }
}

/** 这台设备是否已经绑定过账号（注册防小号用） */
function isDeviceTaken(deviceId) {
  if (!deviceId) return false;
  return Boolean(q.userByDevice.get(deviceId) || q.deviceLoginByDevice.get(deviceId));
}

app.post('/api/register', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit({ key: `reg:${ip}`, limit: 20, windowMs: 3600_000 })) {
    return publicError(res, 429, 'TOO_MANY_REQUESTS', '注册过于频繁，请稍后再试');
  }

  const body = req.body || {};
  const { username, password } = body;
  const problem = validateCredentials(username, password);
  if (problem) return publicError(res, 400, 'INVALID_INPUT', problem);

  const name = String(username).trim();
  if (q.userByName.get(name)) return publicError(res, 409, 'USERNAME_TAKEN', '该用户名已被注册');

  const deviceId = normalizeDeviceId(body.deviceId);
  if (body.deviceId && !deviceId) {
    return publicError(res, 400, 'INVALID_DEVICE', '设备标识格式不正确');
  }
  if (isDeviceTaken(deviceId)) {
    return publicError(res, 409, 'DEVICE_TAKEN', '该设备已绑定过账号，请直接登录');
  }

  const now = nowIso();
  const info = q.insertUser.run(
    name,
    hashPassword(password),
    0,
    deviceId,
    LEAVE_PER_MONTH,
    currentMonth(),
    now,
    now
  );
  const user = q.userById.get(info.lastInsertRowid);
  ensureDefaultHabit(user, defaultDeadline());
  recordDevice(user, deviceId);

  console.log(`[auth] 新用户注册：${user.username} (#${user.id})`);
  res.status(201).json({ token: signToken(user), user: serializeUser(user) });
});

app.post('/api/login', (req, res) => {
  const body = req.body || {};
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return publicError(res, 400, 'INVALID_INPUT', '请输入用户名和密码');
  }

  const ip = req.ip || 'unknown';
  if (!rateLimit({ key: `login:${ip}:${username.toLowerCase()}`, limit: 10, windowMs: 900_000 })) {
    return publicError(res, 429, 'TOO_MANY_REQUESTS', '尝试次数过多，请 15 分钟后再试');
  }

  const user = q.userByName.get(username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return publicError(res, 401, 'BAD_CREDENTIALS', '用户名或密码错误');
  }

  // 换设备登录不拦截：只记录新设备并静默更新 users.device_id
  const deviceId = normalizeDeviceId(body.deviceId);
  if (deviceId) recordDevice(user, deviceId);

  ensureLeaveMonth(user);
  settleUser(user, dateKey());
  refreshUser(user);

  res.json({ token: signToken(user), user: serializeUser(user) });
});

/* ------------------------------- 状态 ------------------------------------ */

app.get('/api/me', authRequired, (req, res) => {
  const user = freshUser(req.user);
  res.json({ user: serializeUser(user), status: buildStatus(user) });
});

app.get('/api/status', authRequired, (req, res) => {
  const user = freshUser(req.user);
  res.json(buildStatus(user));
});

/* ------------------------------- 习惯 CRUD -------------------------------- */

app.get('/api/habits', authRequired, (req, res) => {
  const user = freshUser(req.user);
  const now = new Date();
  const status = buildStatus(user, now);
  res.json({ today: status.today, habits: status.habits });
});

function validateHabitPayload(body, { partial = false } = {}) {
  const out = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (name.length < 1 || name.length > 30) return { error: '习惯名称需为 1-30 个字符' };
    out.name = name;
  }

  if (body.emoji !== undefined || !partial) {
    const emoji = String(body.emoji || '⏰').trim().slice(0, 4) || '⏰';
    out.emoji = emoji;
  }

  if (body.activeDays !== undefined || !partial) {
    const normalized = normalizeActiveDays(
      body.activeDays === undefined ? '1,2,3,4,5,6,7' : body.activeDays
    );
    if (!normalized) return { error: '请至少选择一个生效星期（1=周一 … 7=周日）' };
    out.activeDays = normalized;
  }

  if (body.deadlineTime !== undefined || !partial) {
    const time = String(body.deadlineTime || defaultDeadline());
    if (!TIME_RE.test(time)) return { error: '截止时间格式应为 HH:MM' };
    out.deadlineTime = time;
  }

  if (body.startDate !== undefined || !partial) {
    const start = String(body.startDate || dateKey());
    if (!isValidDateKey(start)) return { error: '开始日期格式应为 YYYY-MM-DD' };
    out.startDate = start;
  }

  return out;
}

app.post('/api/habits', authRequired, (req, res) => {
  const user = req.user;
  if (q.countHabits.get(user.id).n >= MAX_HABITS) {
    return publicError(res, 400, 'TOO_MANY_HABITS', `最多创建 ${MAX_HABITS} 个习惯`);
  }

  const payload = validateHabitPayload(req.body || {});
  if (payload.error) return publicError(res, 400, 'INVALID_INPUT', payload.error);

  const now = nowIso();
  const today = dateKey();
  const info = q.insertHabit.run(
    user.id,
    payload.name,
    payload.emoji,
    payload.activeDays,
    payload.deadlineTime,
    payload.startDate,
    now,
    now
  );
  const habit = q.habitById.get(info.lastInsertRowid);
  if (isActiveOn(habit, today)) {
    q.updateHabitStreak.run(0, 0, addDays(today, -1), nowIso(), habit.id);
  }

  console.log(`[habit] ${user.username} 创建习惯「${payload.name}」`);
  res.status(201).json({ ok: true, habit: habitState(habit, user, today, new Date(), minutesOfDay()) });
});

app.put('/api/habits/:id', authRequired, (req, res) => {
  const user = freshUser(req.user);
  const habit = q.habitById.get(Number(req.params.id));
  if (!habit || habit.user_id !== user.id || habit.archived) {
    return publicError(res, 404, 'HABIT_NOT_FOUND', '习惯不存在');
  }

  const body = req.body || {};
  const payload = validateHabitPayload(
    {
      name: body.name === undefined ? habit.name : body.name,
      emoji: body.emoji === undefined ? habit.emoji : body.emoji,
      activeDays: body.activeDays === undefined ? habit.active_days : body.activeDays,
      deadlineTime: body.deadlineTime === undefined ? habit.deadline_time : body.deadlineTime,
      startDate: body.startDate === undefined ? habit.start_date : body.startDate,
    },
    { partial: false }
  );
  if (payload.error) return publicError(res, 400, 'INVALID_INPUT', payload.error);

  q.updateHabit.run(
    payload.name,
    payload.emoji,
    payload.activeDays,
    payload.deadlineTime,
    payload.startDate,
    nowIso(),
    habit.id,
    user.id
  );

  const updated = q.habitById.get(habit.id);
  res.json({
    ok: true,
    habit: habitState(updated, user, dateKey(), new Date(), minutesOfDay()),
  });
});

app.delete('/api/habits/:id', authRequired, (req, res) => {
  const user = req.user;
  const habit = q.habitById.get(Number(req.params.id));
  if (!habit || habit.user_id !== user.id || habit.archived) {
    return publicError(res, 404, 'HABIT_NOT_FOUND', '习惯不存在');
  }
  q.archiveHabit.run(nowIso(), habit.id, user.id);
  res.json({ ok: true });
});

/* ------------------------------- 打卡 ------------------------------------ */

function performCheckin(user, habit, now = new Date()) {
  const today = dateKey(now);
  const existing = q.checkinOn.get(habit.id, today);
  if (existing) {
    return { alreadyCheckedIn: true, habit, status: null };
  }

  const nowMin = minutesOfDay(now);
  const deadlineMin = hhmmToMinutes(habit.deadline_time);
  const late = nowMin >= deadlineMin ? 1 : 0;
  // 特殊勋章判定所需的标记：08:00 前 / 截止前 1 小时内（且未迟到）
  const early = zonedParts(now).hour < 8 ? 1 : 0;
  const edge = !late && nowMin >= deadlineMin - 60 ? 1 : 0;
  const yesterday = addDays(today, -1);
  const continuing = habit.last_counted_date === yesterday;
  const nextStreak = continuing ? habit.current_streak + 1 : 1;
  const nextBest = Math.max(habit.best_streak, nextStreak);
  const note = null;

  const tx = db.transaction(() => {
    q.insertCheckin.run(habit.id, user.id, today, late, note, 0, early, edge, now.toISOString());
    q.updateHabitStreak.run(nextStreak, nextBest, today, now.toISOString(), habit.id);
    q.addPoints.run(POINTS_PER_CHECKIN, now.toISOString(), user.id);
  });
  tx();

  evaluateBadges(user.id, today);

  habit.current_streak = nextStreak;
  habit.best_streak = nextBest;
  habit.last_counted_date = today;
  refreshUser(user);

  return { alreadyCheckedIn: false, habit, late: late === 1, gainedStreak: nextStreak };
}

app.post('/api/habits/:id/checkin', authRequired, (req, res) => {
  const now = new Date();
  const user = freshUser(req.user);
  const habit = q.habitById.get(Number(req.params.id));

  if (!habit || habit.user_id !== user.id || habit.archived) {
    return publicError(res, 404, 'HABIT_NOT_FOUND', '习惯不存在');
  }
  if (!isActiveOn(habit, dateKey(now))) {
    return publicError(res, 400, 'REST_DAY', '今天是这个习惯的休息日');
  }
  if (isSkipDate(dateKey(now))) {
    return publicError(res, 400, 'SKIP_DAY', '今天是免打卡日');
  }

  const result = performCheckin(user, habit, now);
  if (result.alreadyCheckedIn) {
    return res.json({ ok: true, alreadyCheckedIn: true, status: buildStatus(user, now) });
  }

  console.log(`[checkin] ${user.username} ${habit.name} ${dateKey(now)} late=${result.late}`);
  res.status(201).json({
    ok: true,
    alreadyCheckedIn: false,
    habitId: habit.id,
    late: result.late,
    gainedStreak: result.gainedStreak,
    pointsEarned: POINTS_PER_CHECKIN,
    status: buildStatus(user, now),
  });
});

/** 兼容旧客户端的单打卡接口：不带 habitId 时自动挑一个今天未完成且生效的习惯 */
app.post('/api/checkin', authRequired, (req, res) => {
  const now = new Date();
  const user = freshUser(req.user);
  const today = dateKey(now);
  const body = req.body || {};

  if (body.habitId !== undefined) {
    const habit = q.habitById.get(Number(body.habitId));
    if (!habit || habit.user_id !== user.id || habit.archived) {
      return publicError(res, 404, 'HABIT_NOT_FOUND', '习惯不存在');
    }
    if (!isActiveOn(habit, today)) return publicError(res, 400, 'REST_DAY', '今天是休息日');
    const result = performCheckin(user, habit, now);
    return res.status(result.alreadyCheckedIn ? 200 : 201).json({
      ok: true,
      alreadyCheckedIn: result.alreadyCheckedIn,
      habitId: habit.id,
      late: Boolean(result.late),
      status: buildStatus(user, now),
    });
  }

  const pending = q.habitsByUser
    .all(user.id)
    .filter((h) => isActiveOn(h, today) && !q.checkinOn.get(h.id, today));

  if (!pending.length) {
    const active = q.habitsByUser.all(user.id).filter((h) => isActiveOn(h, today));
    if (active.length) {
      return res.json({ ok: true, alreadyCheckedIn: true, status: buildStatus(user, now) });
    }
    return publicError(res, 400, 'NO_ACTIVE_HABIT', '今天没有待打卡的习惯');
  }

  const result = performCheckin(user, pending[0], now);
  res.status(result.alreadyCheckedIn ? 200 : 201).json({
    ok: true,
    alreadyCheckedIn: result.alreadyCheckedIn,
    habitId: pending[0].id,
    late: Boolean(result.late),
    status: buildStatus(user, now),
  });
});

/* ------------------------------- 请假 ------------------------------------ */

app.post('/api/excuse', authRequired, (req, res) => {
  const now = new Date();
  const today = dateKey(now);
  const user = freshUser(req.user);

  const body = req.body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 2 || reason.length > 300) {
    return publicError(res, 400, 'INVALID_REASON', '请填写 2-300 字的借口说明');
  }

  const targetDate = body.date ? String(body.date) : today;
  if (!DATE_RE.test(targetDate)) {
    return publicError(res, 400, 'INVALID_DATE', '日期格式应为 YYYY-MM-DD');
  }
  const earliest = addDays(today, -EXCUSE_LOOKBACK_DAYS);
  if (targetDate > today || targetDate < earliest) {
    return publicError(res, 400, 'DATE_OUT_OF_RANGE', `只能为最近 ${EXCUSE_LOOKBACK_DAYS} 天内的漏签补填借口`);
  }

  if (q.excuseOn.get(user.id, targetDate)) {
    return res.json({ ok: true, alreadyExcused: true, status: buildStatus(user, now) });
  }

  const useLeave = user.leave_balance > 0;
  const tx = db.transaction(() => {
    q.insertExcuse.run(user.id, targetDate, reason, useLeave ? 1 : 0, now.toISOString());
    if (useLeave) q.takeLeave.run(now.toISOString(), user.id);
    if (!user.last_counted_date || targetDate > user.last_counted_date) {
      q.syncUserStreak.run(user.current_streak, user.best_streak, targetDate, now.toISOString(), user.id);
    }
  });
  tx();

  refreshUser(user);

  console.log(`[excuse] ${user.username} ${targetDate} leave=${useLeave}`);

  res.status(201).json({
    ok: true,
    alreadyExcused: false,
    date: targetDate,
    usedLeave: useLeave,
    leaveBalance: user.leave_balance,
    status: buildStatus(user, now),
  });
});

/* ------------------------------- 排行榜 ---------------------------------- */

function boardHandler(type) {
  return (req, res) => {
    const limit = Math.min(LEADERBOARD_MAX, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    res.json(buildBoard(type, req.user, limit));
  };
}

app.get('/api/leaderboard/streak', optionalAuth, boardHandler('streak'));
app.get('/api/leaderboard/total', optionalAuth, boardHandler('total'));
app.get('/api/leaderboard/points', optionalAuth, boardHandler('points'));

/** 兼容旧接口：/api/leaderboard → 连胜榜；带 period 参数时按周/月打卡次数排序 */
app.get('/api/leaderboard', optionalAuth, (req, res) => {
  const period = String(req.query.period || 'all');
  const limit = Math.min(LEADERBOARD_MAX, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));

  if (period === 'week' || period === 'month') {
    const today = dateKey();
    const start = period === 'week' ? startOfWeek(today) : `${today.slice(0, 7)}-01`;
    const anon = !req.user;
    const rows = q.allUsers
      .all()
      .filter((user) => user.is_admin !== 1)
      .map((user) => {
      settleUser(user, today);
      const total = q.countBetween.get(user.id, start, today).n;
      return {
        userId: anon ? null : user.id,
        username: anon ? '匿名用户' : user.username,
        isAdmin: false,
        score: total,
        value: total,
        streak: q.maxStreak.get(user.id).n,
        bestStreak: q.maxBestStreak.get(user.id).n,
        totalCheckins: q.totalCheckins.get(user.id).n,
        points: anon ? null : user.points,
        badges: anon ? [] : badgesFor(user, q.maxBestStreak.get(user.id).n),
        todayStatus: todayStatusOf(user, today, minutesOfDay()),
        isMe: Boolean(req.user && req.user.id === user.id),
        createdAt: user.created_at,
      };
    });
    rows.sort((a, b) => b.score - a.score || b.streak - a.streak);
    return res.json({
      type: 'total',
      period,
      periodLabel: period === 'week' ? '本周' : '本月',
      anonymous: anon,
      range: { start, end: today },
      timezone: BUSINESS_TIMEZONE,
      today,
      total: rows.length,
      rows: rows.slice(0, limit).map((r, i) => ({
        ...r,
        rank: i + 1,
        ...(anon ? { username: `匿名用户${i + 1}` } : {}),
      })),
    });
  }

  res.json(buildBoard('streak', req.user, limit));
});

/* ------------------------------- 商店 ------------------------------------ */

app.post('/api/shop/makeup-card', authRequired, (req, res) => {
  const user = freshUser(req.user);
  const quantity = Math.max(1, Math.min(5, Number((req.body || {}).quantity) || 1));
  const cost = MAKEUP_CARD_COST * quantity;

  if (user.points < cost) {
    return publicError(res, 400, 'NOT_ENOUGH_POINTS', `积分不足，需要 ${cost} 分`, {
      points: user.points,
      cost,
    });
  }

  const tx = db.transaction(() => {
    q.addPoints.run(-cost, nowIso(), user.id);
    q.addMakeup.run(quantity, nowIso(), user.id);
  });
  tx();
  refreshUser(user);

  console.log(`[shop] ${user.username} 兑换补签卡 x${quantity}`);

  res.status(201).json({
    ok: true,
    quantity,
    cost,
    points: user.points,
    makeupCards: user.makeup_cards,
  });
});

/* ------------------------------- 打卡日历 -------------------------------- */

app.get('/api/user/calendar', authRequired, (req, res) => {
  const user = freshUser(req.user);
  const days = Math.min(CALENDAR_MAX_DAYS, Math.max(7, Number.parseInt(req.query.days, 10) || 30));

  const now = new Date();
  const today = dateKey(now);
  const nowMin = minutesOfDay(now);
  const habits = q.habitsByUser.all(user.id);

  const items = [];
  const summary = { done: 0, excused: 0, missed: 0, holiday: 0, rest: 0, pending: 0, vacation: 0 };

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const active = habits.filter((h) => isActiveOn(h, date));
    const checkins = active.map((h) => q.checkinOn.get(h.id, date)).filter(Boolean);
    const excuse = q.excuseOn.get(user.id, date);

    let status;
    if (isVacationOn(user.id, date)) status = 'vacation';
    else if (isSkipDate(date)) status = 'holiday';
    else if (!active.length) status = 'rest';
    else if (checkins.length === active.length) status = 'done';
    else if (excuse) status = 'excused';
    else if (date === today && active.some((h) => nowMin < hhmmToMinutes(h.deadline_time))) status = 'pending';
    else status = 'missed';

    summary[status] += 1;
    items.push({
      date,
      status,
      late: checkins.some((c) => c.late === 1),
      isToday: date === today,
      weekday: weekdayIndex(date),
      doneCount: checkins.length,
      totalCount: active.length,
    });
  }

  res.json({
    days,
    today,
    timezone: BUSINESS_TIMEZONE,
    range: { start: items[0] ? items[0].date : today, end: today },
    items,
    summary,
  });
});

/* ------------------------------- 设置 ------------------------------------ */

app.get('/api/settings', authRequired, (req, res) => {
  const today = dateKey();
  res.json({
    deadline: req.user.deadline || defaultDeadline(),
    userDeadline: req.user.deadline,
    defaultDeadline: defaultDeadline(),
    timezone: BUSINESS_TIMEZONE,
    timezoneLocked: true,
    excuseLookbackDays: EXCUSE_LOOKBACK_DAYS,
    skipDates: Array.from(skipDates()).sort(),
    isSkipToday: isSkipDate(today),
    leavePerMonth: LEAVE_PER_MONTH,
    makeupCardCost: MAKEUP_CARD_COST,
    pointsPerCheckin: POINTS_PER_CHECKIN,
    pointsPerBreak: POINTS_PER_BREAK,
    autoApproveVacation: getSetting('auto_approve_vacation', '1') === '1',
    vacationUntil: req.user.vacation_until,
  });
});

app.put('/api/settings', authRequired, (req, res) => {
  const raw = (req.body || {}).deadline;
  if (raw === null || raw === '' || raw === 'default') {
    q.updateUserDeadline.run(null, nowIso(), req.user.id);
    return res.json({ ok: true, deadline: defaultDeadline(), userDeadline: null });
  }
  if (typeof raw !== 'string' || !TIME_RE.test(raw)) {
    return publicError(res, 400, 'INVALID_DEADLINE', '截止时间格式应为 HH:MM（00:00 - 23:59）');
  }
  q.updateUserDeadline.run(raw, nowIso(), req.user.id);
  res.json({ ok: true, deadline: raw, userDeadline: raw });
});

/* ------------------------------- 休假 ------------------------------------ */

function vacationPublic(row) {
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    reason: row.reason || '',
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
    username: row.username,
  };
}

function syncVacationUntil(userId) {
  const row = q.maxApprovedVacation.get(userId);
  q.setVacationUntil.run(row ? row.d : null, nowIso(), userId);
  return row ? row.d : null;
}

app.post('/api/vacation', authRequired, (req, res) => {
  const user = freshUser(req.user);
  const body = req.body || {};
  const startDate = String(body.startDate || '');
  const endDate = String(body.endDate || startDate);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';

  if (!isValidDateKey(startDate) || !isValidDateKey(endDate)) {
    return publicError(res, 400, 'INVALID_DATE', '日期格式应为 YYYY-MM-DD');
  }
  if (endDate < startDate) {
    return publicError(res, 400, 'INVALID_RANGE', '结束日期不能早于开始日期');
  }

  const today = dateKey();
  if (startDate < addDays(today, -1)) {
    return publicError(res, 400, 'DATE_IN_PAST', '只能申请今天及以后的休假');
  }

  // 最多 3 天（含首尾）
  const days =
    Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
  if (days > 3) {
    return publicError(res, 400, 'TOO_LONG', '一次最多申请 3 天');
  }

  if (q.overlapVacation.get(user.id, endDate, startDate)) {
    return publicError(res, 409, 'OVERLAP', '该时间段已有待审批或已通过的休假');
  }

  const auto = getSetting('auto_approve_vacation', '1') === '1';
  const status = auto ? 'approved' : 'pending';
  const now = nowIso();

  const info = q.insertVacation.run(user.id, startDate, endDate, reason || null, status, now);
  if (auto) {
    q.updateVacation.run('approved', now, null, info.lastInsertRowid);
    syncVacationUntil(user.id);
  }

  const row = q.vacationById.get(info.lastInsertRowid);

  console.log(`[vacation] ${user.username} ${startDate}~${endDate} -> ${status}`);

  res.status(201).json({
    ok: true,
    autoApproved: auto,
    message: auto ? '休假已自动通过' : '休假申请已提交，等待管理员审批',
    request: vacationPublic(row),
  });
});

app.get('/api/vacation/my', authRequired, (req, res) => {
  const rows = q.myVacations.all(req.user.id).map(vacationPublic);
  res.json({
    autoApproveVacation: getSetting('auto_approve_vacation', '1') === '1',
    requests: rows,
  });
});

/* --------------------------- 账号自助修改 -------------------------------- */

app.put('/api/account', authRequired, (req, res) => {
  const body = req.body || {};
  const user = req.user;
  const wantsUsername = typeof body.username === 'string' && body.username.trim() !== '';
  const wantsPassword = typeof body.password === 'string' && body.password !== '';

  if (!wantsUsername && !wantsPassword) {
    return publicError(res, 400, 'INVALID_INPUT', '没有需要修改的内容');
  }
  if (wantsPassword && !verifyPassword(String(body.currentPassword || ''), user.password_hash)) {
    return publicError(res, 403, 'BAD_CURRENT_PASSWORD', '当前密码不正确');
  }

  const tx = db.transaction(() => {
    if (wantsUsername) {
      const name = body.username.trim();
      if (!USERNAME_RE.test(name)) {
        throw Object.assign(new Error('用户名需为 2-24 位字母、数字、下划线或中文'), { status: 400 });
      }
      const taken = q.userByName.get(name);
      if (taken && taken.id !== user.id) {
        throw Object.assign(new Error('该用户名已被占用'), { status: 409 });
      }
      q.updateUsername.run(name, nowIso(), user.id);
      user.username = name;
    }
    if (wantsPassword) {
      if (String(body.password).length < 6 || String(body.password).length > 72) {
        throw Object.assign(new Error('密码长度需为 6-72 位'), { status: 400 });
      }
      q.updatePassword.run(hashPassword(body.password), nowIso(), user.id);
    }
  });

  try {
    tx();
  } catch (err) {
    return publicError(res, err.status || 400, 'INVALID_INPUT', err.message);
  }

  res.json({ ok: true, token: signToken(user), user: serializeUser(user) });
});

/** 修改密码（个人中心） */
app.post('/api/user/change-password', authRequired, (req, res) => {
  const body = req.body || {};
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');

  if (!verifyPassword(oldPassword, req.user.password_hash)) {
    return publicError(res, 403, 'BAD_OLD_PASSWORD', '旧密码不正确');
  }
  if (newPassword.length < 6 || newPassword.length > 72) {
    return publicError(res, 400, 'INVALID_INPUT', '新密码长度需为 6-72 位');
  }
  if (newPassword === oldPassword) {
    return publicError(res, 400, 'SAME_PASSWORD', '新密码不能与旧密码相同');
  }

  q.updatePassword.run(hashPassword(newPassword), nowIso(), req.user.id);
  console.log(`[auth] ${req.user.username} 修改了密码`);

  res.json({ ok: true, token: signToken(req.user) });
});

/* ------------------------------- 管理接口 -------------------------------- */

app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const now = new Date();
  const today = dateKey(now);
  const nowMin = minutesOfDay(now);

  const users = q.allUsers.all().map((user) => {
    settleUser(user, today);
    refreshUser(user);
    return {
      ...serializeUser(user),
      todayStatus: todayStatusOf(user, today, nowMin),
    };
  });

  res.json({ timezone: BUSINESS_TIMEZONE, today, isSkipDay: isSkipDate(today), users });
});

app.post('/api/admin/users/:id/reset', authRequired, adminRequired, (req, res) => {
  const target = q.userById.get(Number(req.params.id));
  if (!target) return publicError(res, 404, 'USER_NOT_FOUND', '用户不存在');

  const date = (req.body || {}).date ? String(req.body.date) : dateKey();
  if (!DATE_RE.test(date)) return publicError(res, 400, 'INVALID_DATE', '日期格式应为 YYYY-MM-DD');

  const tx = db.transaction(() => {
    q.deleteCheckinsOn.run(target.id, date);
    q.deleteExcuseOn.run(target.id, date);
    db.prepare(
      'UPDATE habits SET current_streak = 0, last_counted_date = NULL, updated_at = ? WHERE user_id = ?'
    ).run(nowIso(), target.id);
    q.syncUserStreak.run(0, target.best_streak, null, nowIso(), target.id);
    q.audit.run(req.user.id, 'RESET_CHECKIN', target.id, JSON.stringify({ date }), nowIso());
  });
  tx();

  const refreshed = q.userById.get(target.id);
  res.json({ ok: true, date, user: serializeUser(refreshed), status: buildStatus(refreshed) });
});

app.put('/api/admin/settings', authRequired, adminRequired, (req, res) => {
  const body = req.body || {};
  const patch = {};

  if (body.defaultDeadline !== undefined) {
    if (!TIME_RE.test(String(body.defaultDeadline))) {
      return publicError(res, 400, 'INVALID_DEADLINE', '默认截止时间格式应为 HH:MM');
    }
    patch.default_deadline = String(body.defaultDeadline);
  }
  if (body.skipDates !== undefined) {
    const normalized = normalizeSkipDates(body.skipDates);
    if (normalized === null) {
      return publicError(res, 400, 'INVALID_SKIP_DATES', '免打卡日格式应为 YYYY-MM-DD，逗号分隔');
    }
    patch.skip_dates = normalized.join(',');
  }
  if (body.autoApproveVacation !== undefined) {
    patch.auto_approve_vacation = body.autoApproveVacation ? '1' : '0';
  }
  if (!Object.keys(patch).length) {
    return publicError(res, 400, 'INVALID_INPUT', '没有需要修改的设置');
  }

  for (const [key, value] of Object.entries(patch)) q.setSetting.run(key, value);
  skipDatesCache = null;
  q.audit.run(req.user.id, 'UPDATE_SETTINGS', null, JSON.stringify(patch), nowIso());

  res.json({
    ok: true,
    defaultDeadline: defaultDeadline(),
    skipDates: Array.from(skipDates()).sort(),
    isSkipToday: isSkipDate(dateKey()),
    autoApproveVacation: getSetting('auto_approve_vacation', '1') === '1',
  });
});

app.post('/api/admin/set-skip-dates', authRequired, adminRequired, (req, res) => {
  const normalized = normalizeSkipDates((req.body || {}).dates);
  if (normalized === null) {
    return publicError(res, 400, 'INVALID_SKIP_DATES', '免打卡日格式应为 YYYY-MM-DD，多个用逗号或换行分隔');
  }
  const saved = setSkipDates(normalized);
  q.audit.run(req.user.id, 'SET_SKIP_DATES', null, JSON.stringify(saved), nowIso());
  res.json({ ok: true, skipDates: saved, count: saved.length, isSkipToday: isSkipDate(dateKey()) });
});

/* ---------------------------- 管理员：休假审批 ---------------------------- */

app.get('/api/admin/vacations', authRequired, adminRequired, (req, res) => {
  res.json({
    autoApproveVacation: getSetting('auto_approve_vacation', '1') === '1',
    pending: q.pendingVacations.all().map(vacationPublic),
    recent: q.recentVacations.all().map(vacationPublic),
  });
});

function reviewVacation(req, res, status) {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) ? q.vacationById.get(id) : null;
  if (!row) return publicError(res, 404, 'VACATION_NOT_FOUND', '申请不存在');
  if (row.status !== 'pending') {
    return publicError(res, 409, 'ALREADY_REVIEWED', '该申请已处理过');
  }

  const now = nowIso();
  q.updateVacation.run(status, now, req.user.id, row.id);
  if (status === 'approved') syncVacationUntil(row.user_id);
  q.audit.run(req.user.id, `VACATION_${status.toUpperCase()}`, row.user_id, String(row.id), now);

  console.log(`[admin] ${req.user.username} ${status} 休假 #${row.id}`);

  res.json({ ok: true, id: row.id, status, request: vacationPublic(q.vacationById.get(row.id)) });
}

app.post('/api/admin/vacations/:id/approve', authRequired, adminRequired, (req, res) =>
  reviewVacation(req, res, 'approved')
);
app.post('/api/admin/vacations/:id/reject', authRequired, adminRequired, (req, res) =>
  reviewVacation(req, res, 'rejected')
);

app.post('/api/admin/vacations/approve-all', authRequired, adminRequired, (req, res) => {
  const pending = q.pendingVacations.all();
  const now = nowIso();
  const tx = db.transaction(() => {
    q.approveAllVacations.run(now, req.user.id);
    for (const userId of new Set(pending.map((r) => r.user_id))) syncVacationUntil(userId);
  });
  tx();
  q.audit.run(req.user.id, 'VACATION_APPROVE_ALL', null, String(pending.length), now);
  res.json({ ok: true, approved: pending.length });
});

/* ---------------------------- 管理员：删除账号 ---------------------------- */

app.delete('/api/admin/user/:id', authRequired, adminRequired, (req, res) => {
  const target = q.userById.get(Number(req.params.id));
  if (!target) return publicError(res, 404, 'USER_NOT_FOUND', '用户不存在');
  if (target.id === req.user.id) {
    return publicError(res, 400, 'CANNOT_DELETE_SELF', '不能删除自己的账号');
  }
  if (target.is_admin === 1) {
    return publicError(res, 400, 'CANNOT_DELETE_ADMIN', '不能删除管理员账号');
  }

  const username = target.username;
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  q.audit.run(req.user.id, 'DELETE_USER', target.id, username, nowIso());

  console.log(`[admin] ${req.user.username} 删除了账号 ${username}(#${target.id})`);
  res.json({ ok: true, deleted: username });
});

function normalizeSkipDates(input) {
  if (input === undefined || input === null) return [];
  let pieces;
  if (Array.isArray(input)) pieces = input;
  else if (typeof input === 'string') pieces = input.split(/[\s,，;；]+/);
  else return null;

  const out = new Set();
  for (const piece of pieces) {
    if (typeof piece !== 'string') return null;
    const value = piece.trim();
    if (!value) continue;
    if (!isValidDateKey(value)) return null;
    out.add(value);
  }
  if (out.size > SKIP_DATES_MAX) return null;
  return Array.from(out).sort();
}

/* ------------------------------- 好友 ------------------------------------ */

function resolveBodyUser(body) {
  const payload = body || {};
  if (payload.userId !== undefined && payload.userId !== null) {
    const id = Number(payload.userId);
    return Number.isInteger(id) ? q.userById.get(id) || null : null;
  }
  if (typeof payload.username === 'string' && payload.username.trim()) {
    return q.userByName.get(payload.username.trim()) || null;
  }
  return null;
}

app.post('/api/friends/request', authRequired, (req, res) => {
  const me = req.user;
  const target = resolveBodyUser(req.body);
  if (!target) return publicError(res, 404, 'USER_NOT_FOUND', '对方不存在');
  if (target.id === me.id) return publicError(res, 400, 'CANNOT_FRIEND_SELF', '不能加自己为好友');

  const state = friendshipState(me.id, target.id);
  if (state === 'accepted') return publicError(res, 409, 'ALREADY_FRIENDS', '你们已经是好友了');
  if (state === 'pending_out') {
    return publicError(res, 409, 'REQUEST_EXISTS', '好友申请已发送，等待对方同意');
  }

  const now = nowIso();
  const autoAccepted = state === 'pending_in';
  const tx = db.transaction(() => {
    if (autoAccepted) {
      q.upsertFriendship.run(me.id, target.id, 'accepted', now, now);
      q.upsertFriendship.run(target.id, me.id, 'accepted', now, now);
    } else {
      q.upsertFriendship.run(me.id, target.id, 'pending', now, now);
    }
  });
  tx();

  res.status(autoAccepted ? 200 : 201).json({
    ok: true,
    autoAccepted,
    status: autoAccepted ? 'accepted' : 'pending_out',
    friend: { id: target.id, username: target.username },
  });
});

app.post('/api/friends/accept', authRequired, (req, res) => {
  const me = req.user;
  const requester = resolveBodyUser(req.body);
  if (!requester) return publicError(res, 404, 'USER_NOT_FOUND', '申请人不存在');

  const pending = q.friendshipOne.get(requester.id, me.id);
  if (!pending || pending.status !== 'pending') {
    return publicError(res, 404, 'NO_PENDING_REQUEST', '没有待处理的好友申请');
  }

  const now = nowIso();
  const tx = db.transaction(() => {
    q.upsertFriendship.run(requester.id, me.id, 'accepted', now, now);
    q.upsertFriendship.run(me.id, requester.id, 'accepted', now, now);
  });
  tx();

  res.json({ ok: true, friend: { id: requester.id, username: requester.username }, state: 'accepted' });
});

/** 撤回自己发出的好友申请 */
app.post('/api/friends/cancel', authRequired, (req, res) => {
  const me = req.user;
  const target = resolveBodyUser(req.body);
  if (!target) return publicError(res, 404, 'USER_NOT_FOUND', '对方不存在');

  const pending = q.friendshipOne.get(me.id, target.id);
  if (!pending || pending.status !== 'pending') {
    return publicError(res, 404, 'NO_PENDING_REQUEST', '没有可撤回的申请');
  }

  db.prepare('DELETE FROM friends WHERE id = ?').run(pending.id);
  console.log(`[friend] ${me.username} 撤回了好友申请 -> ${target.username}`);
  res.json({ ok: true, status: 'canceled' });
});

/** 双向删除好友 */
app.post('/api/friends/delete', authRequired, (req, res) => {
  const me = req.user;
  const target = resolveBodyUser(req.body);
  if (!target) return publicError(res, 404, 'USER_NOT_FOUND', '对方不存在');

  const info = db
    .prepare(
      'DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
    )
    .run(me.id, target.id, target.id, me.id);

  if (!info.changes) {
    return publicError(res, 404, 'NOT_FRIENDS', '你们还不是好友');
  }

  console.log(`[friend] ${me.username} 删除了好友 ${target.username}`);
  res.json({ ok: true, status: 'deleted', removed: info.changes });
});

app.get('/api/friends/list', authRequired, (req, res) => {
  const me = freshUser(req.user);
  const today = dateKey();
  const nowMin = minutesOfDay();
  const holiday = isSkipDate(today);

  const friends = q.acceptedFriends.all(me.id).map((row) => {
    settleUser(row, today);
    const todayStatus = todayStatusOf(row, today, nowMin);
    const checkedInToday = todayStatus === 'done' || todayStatus === 'late';
    return {
      id: row.id,
      username: row.username,
      streak: q.maxStreak.get(row.id).n,
      bestStreak: q.maxBestStreak.get(row.id).n,
      todayStatus,
      checkedInToday,
      since: row.friends_since,
      canNudge: !checkedInToday && !holiday && todayStatus !== 'excused' && todayStatus !== 'rest',
    };
  });

  friends.sort((a, b) => b.streak - a.streak);

  const incoming = q.incomingRequests.all(me.id).map((row) => ({
    id: row.id,
    username: row.username,
    requestedAt: row.requested_at,
  }));
  const outgoing = q.outgoingRequests.all(me.id).map((row) => ({
    id: row.id,
    username: row.username,
    requestedAt: row.requested_at,
  }));

  res.json({
    today,
    isSkipDay: holiday,
    friends,
    incoming,
    outgoing,
    counts: { friends: friends.length, incoming: incoming.length, outgoing: outgoing.length },
  });
});

app.post('/api/nudge/:username', authRequired, (req, res) => {
  const me = freshUser(req.user);
  const target = q.userByName.get(String(req.params.username || '').trim());
  if (!target) return publicError(res, 404, 'USER_NOT_FOUND', '对方不存在');
  if (target.id === me.id) return publicError(res, 400, 'CANNOT_NUDGE_SELF', '不用催自己啦');

  if (friendshipState(me.id, target.id) !== 'accepted') {
    return publicError(res, 403, 'NOT_FRIENDS', '只能催自己的好友，先加个好友吧');
  }

  const now = new Date();
  const today = dateKey(now);
  if (isSkipDate(today)) return publicError(res, 400, 'SKIP_DAY', '今天是免打卡日，不用催啦');

  const targetStatus = todayStatusOf(target, today, minutesOfDay(now));
  if (targetStatus === 'done' || targetStatus === 'late') {
    return publicError(res, 400, 'ALREADY_CHECKED_IN', '对方今天已经打卡了，放过他吧');
  }

  const last = q.lastNudgeBetween.get(me.id, target.id);
  if (last) {
    const elapsed = now.getTime() - new Date(last.created_at).getTime();
    if (elapsed < NUDGE_COOLDOWN_MS) {
      return publicError(res, 429, 'NUDGE_TOO_OFTEN', '催得太频繁了，歇一会儿再催', {
        retryAfter: Math.ceil((NUDGE_COOLDOWN_MS - elapsed) / 1000),
      });
    }
  }

  q.insertNudge.run(me.id, target.id, today, now.toISOString());
  res.status(201).json({
    ok: true,
    message: `已催 ${target.username} 打卡，快去写吧！`,
    nudge: { from: me.username, to: target.username, createdAt: now.toISOString(), date: today },
  });
});

/* ------------------------------- 静态资源 -------------------------------- */

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api', (req, res) => {
  publicError(res, 404, 'NOT_FOUND', '接口不存在');
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return publicError(res, 400, 'INVALID_JSON', '请求体不是合法的 JSON');
  }
  if (err && err.type === 'entity.too.large') {
    return publicError(res, 413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  }
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  publicError(res, 500, 'INTERNAL_ERROR', '服务器开小差了，请稍后再试');
});

/* --------------------------------------------------------------------------
 * 16. 启动
 * ------------------------------------------------------------------------ */

seed();
for (const user of q.allUsers.all()) ensureDefaultHabit(user, defaultDeadline());

const server = app.listen(PORT, HOST, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  不拖延 · 强制打卡系统 v3.0 已启动');
  console.log(`  HTTP       http://localhost:${PORT}`);
  console.log(`  Web 管理端 http://localhost:${PORT}/`);
  console.log(`  数据库     ${DB_PATH}`);
  console.log(`  时区       ${BUSINESS_TIMEZONE}（强制）`);
  console.log(`  积分规则   打卡 +${POINTS_PER_CHECKIN} / 断签 -${POINTS_PER_BREAK} / 补签卡 ${MAKEUP_CARD_COST} 分`);
  console.log(`  请假额度   每月 ${LEAVE_PER_MONTH} 次`);
  console.log(`  环境       ${NODE_ENV}`);
  console.log('──────────────────────────────────────────────');
});

function shutdown(signal) {
  console.log(`\n[shutdown] 收到 ${signal}，正在关闭...`);
  server.close(() => {
    try {
      db.close();
    } catch (err) {
      console.error(err);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
