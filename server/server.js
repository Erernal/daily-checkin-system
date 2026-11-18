'use strict';

/* ==========================================================================
 *  不拖延 · 防拖延强制打卡系统 —— 后端服务 v2.0（赛博升级版）
 * --------------------------------------------------------------------------
 *  技术栈：Node.js 18+ / Express 4 / better-sqlite3 / JWT
 *
 *  v2.0 新增：
 *   · 强制北京时间（Asia/Shanghai），服务端所有日期计算不再受服务器/用户
 *     本地时区影响；
 *   · 排行榜支持 period=all|week|month（总榜 / 周榜 / 月榜）；
 *   · 好友系统（申请 / 同意 / 列表）与“催打卡”（必须是 accepted 好友）；
 *   · 免打卡日 skip_dates：当天不打卡也不断签，连胜冻结；
 *   · 个人 30 天打卡日历 /api/user/calendar；
 *   · 管理员设置免打卡日 /api/admin/set-skip-dates。
 *
 *  核心规则：
 *   1. “打卡日”= 北京时间的日历日，格式 YYYY-MM-DD。
 *   2. 截止时间前打卡 = done；截止后当天打卡 = late（仍计连胜）。
 *   3. 一整天既没打卡也没请假 = 断签，连胜清零（惰性结算）。
 *   4. 请假 = excused，连胜既不增加也不清零。
 *   5. 免打卡日 = holiday，不打卡也不断签，连胜冻结；当天也不触发强制阻断。
 *   6. 强制阻断：今天过截止仍未打卡/请假，或昨天漏签未补假 → blocked=true。
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

/** 业务时区强制为北京时间：不读系统时区，也不允许普通用户修改 */
const BUSINESS_TIMEZONE = 'Asia/Shanghai';

const DEFAULT_DEADLINE = process.env.DEFAULT_DEADLINE || '22:00';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const EXCUSE_LOOKBACK_DAYS = 7; // 允许补填最近 7 天的借口
const LEADERBOARD_MAX = 200;
const CALENDAR_MAX_DAYS = 90;
const SKIP_DATES_MAX = 365;
const NUDGE_COOLDOWN_MS = 10 * 60 * 1000; // 同一个好友 10 分钟内只能催一次

if (IS_PROD && JWT_SECRET === 'dev-only-secret-please-change-me') {
  console.warn('[warn] 生产环境请务必设置 JWT_SECRET 环境变量！');
}

/* --------------------------------------------------------------------------
 * 2. 数据库初始化（建表 + 幂等迁移）
 * ------------------------------------------------------------------------ */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  /* ---------- v1 已有表 ---------- */
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

  CREATE TABLE IF NOT EXISTS checkins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,
    late       INTEGER NOT NULL DEFAULT 0,
    note       TEXT,
    created_at TEXT    NOT NULL,
    UNIQUE (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS excuses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,
    reason     TEXT    NOT NULL,
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

  /* ---------- v2 新增：好友关系 ----------
   * 约定：accepted 关系存两行（A→B、B→A），便于任意方向查询；
   *       pending 只存一行（发起方 → 接收方）。
   */
  CREATE TABLE IF NOT EXISTS friends (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted')),
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    UNIQUE (user_id, friend_id),
    CHECK (user_id <> friend_id)
  );

  /* ---------- v2 新增：催打卡记录 ---------- */
  CREATE TABLE IF NOT EXISTS nudges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date         TEXT    NOT NULL,
    created_at   TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins (user_id, date);
  CREATE INDEX IF NOT EXISTS idx_excuses_user_date  ON excuses (user_id, date);
  CREATE INDEX IF NOT EXISTS idx_friends_user       ON friends (user_id, status);
  CREATE INDEX IF NOT EXISTS idx_friends_friend     ON friends (friend_id, status);
  CREATE INDEX IF NOT EXISTS idx_nudges_to_date     ON nudges (to_user_id, date);
`);

/* --------------------------------------------------------------------------
 * 3. 预编译语句
 * ------------------------------------------------------------------------ */

const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY id ASC'),
  insertUser: db.prepare(`
    INSERT INTO users (username, password_hash, is_admin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  updateUserDeadline: db.prepare('UPDATE users SET deadline = ?, updated_at = ? WHERE id = ?'),
  updateUserStreak: db.prepare(
    'UPDATE users SET current_streak = ?, last_counted_date = ?, updated_at = ? WHERE id = ?'
  ),
  updateUserBoth: db.prepare(`
    UPDATE users SET current_streak = ?, best_streak = ?, last_counted_date = ?, updated_at = ?
    WHERE id = ?
  `),
  updateUsername: db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'),

  checkinOn: db.prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?'),
  insertCheckin: db.prepare(
    'INSERT INTO checkins (user_id, date, late, note, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  deleteCheckinOn: db.prepare('DELETE FROM checkins WHERE user_id = ? AND date = ?'),
  countCheckins: db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?'),
  countCheckinsBetween: db.prepare(
    'SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND date BETWEEN ? AND ?'
  ),

  excuseOn: db.prepare('SELECT * FROM excuses WHERE user_id = ? AND date = ?'),
  insertExcuse: db.prepare(
    'INSERT INTO excuses (user_id, date, reason, created_at) VALUES (?, ?, ?, ?)'
  ),
  deleteExcuseOn: db.prepare('DELETE FROM excuses WHERE user_id = ? AND date = ?'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  audit: db.prepare(
    'INSERT INTO audit_log (actor_id, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?)'
  ),

  /* 好友 */
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

  /* 催打卡 */
  insertNudge: db.prepare(
    'INSERT INTO nudges (from_user_id, to_user_id, date, created_at) VALUES (?, ?, ?, ?)'
  ),
  lastNudgeBetween: db.prepare(`
    SELECT * FROM nudges
    WHERE from_user_id = ? AND to_user_id = ?
    ORDER BY id DESC LIMIT 1
  `),
  nudgesTodayFor: db.prepare(`
    SELECT n.id, n.created_at, u.username AS from_username
    FROM nudges n JOIN users u ON u.id = n.from_user_id
    WHERE n.to_user_id = ? AND n.date = ?
    ORDER BY n.id DESC LIMIT 5
  `),
};

/* --------------------------------------------------------------------------
 * 4. 种子数据
 * ------------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();

function seed() {
  const defaults = {
    default_deadline: DEFAULT_DEADLINE,
    site_name: '不拖延',
    skip_dates: '', // 逗号分隔的免打卡日，例如 2026-12-25,2027-01-01
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!q.getSetting.get(key)) q.setSetting.run(key, value);
  }

  const existing = q.userByName.get(ADMIN_USERNAME);
  if (!existing) {
    q.insertUser.run(ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD), 1, nowIso(), nowIso());
    console.log(`[seed] 已创建管理员账号：${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
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
 * 6. 时间工具 —— 全部强制北京时间
 * ------------------------------------------------------------------------ */

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

/** 把任意时刻拆成北京时间的年月日时分秒 */
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

const pad2 = (n) => String(n).padStart(2, '0');

/** 北京时间 YYYY-MM-DD */
function dateKey(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function minutesOfDay(date = new Date()) {
  const p = zonedParts(date);
  return p.hour * 60 + p.minute;
}

function secondsOfDay(date = new Date()) {
  const p = zonedParts(date);
  return p.hour * 3600 + p.minute * 60 + p.second;
}

/** 纯字符串日期加减，不受时区影响 */
function addDays(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** 周一为一周起点 */
function startOfWeek(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
  return addDays(key, -((dow + 6) % 7));
}

/** 1=周一 ... 7=周日 */
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
 * 7. 设置与业务规则
 * ------------------------------------------------------------------------ */

function getSetting(key, fallback = null) {
  const row = q.getSetting.get(key);
  return row ? row.value : fallback;
}

function defaultDeadline() {
  const value = getSetting('default_deadline', DEFAULT_DEADLINE);
  return TIME_RE.test(value) ? value : DEFAULT_DEADLINE;
}

function effectiveDeadline(user) {
  return user && TIME_RE.test(user.deadline || '') ? user.deadline : defaultDeadline();
}

/* ---------------- 免打卡日 ---------------- */

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
  for (const d of skipDates()) {
    if (d >= fromDate && (!best || d < best)) best = d;
  }
  return best;
}

function setSkipDates(list) {
  const sorted = Array.from(new Set(list)).sort();
  q.setSetting.run('skip_dates', sorted.join(','));
  skipDatesCache = null;
  return sorted;
}

/* ---------------- 断签结算 ---------------- */

/**
 * 惰性结算：把 last_counted_date 推进到昨天。
 * 期间若存在“非免打卡日且无打卡无请假”的日子，则连胜清零。
 */
function settleUser(user, today = dateKey()) {
  const marker = user.last_counted_date;
  if (!marker) return user;

  const yesterday = addDays(today, -1);
  if (marker >= yesterday) return user;

  let missed = false;
  let cursor = addDays(marker, 1);
  let guard = 0;
  while (cursor <= yesterday && guard < 400) {
    if (!isSkipDate(cursor) && !q.checkinOn.get(user.id, cursor) && !q.excuseOn.get(user.id, cursor)) {
      missed = true;
    }
    cursor = addDays(cursor, 1);
    guard += 1;
  }

  const nextStreak = missed ? 0 : user.current_streak;
  q.updateUserStreak.run(nextStreak, yesterday, nowIso(), user.id);
  user.current_streak = nextStreak;
  user.last_counted_date = yesterday;
  return user;
}

/** 某一天的展示状态：done | late | excused | holiday | missed | pending */
function todayStatusFor(user, today, deadline, nowMin) {
  const checkin = q.checkinOn.get(user.id, today);
  if (checkin) return checkin.late === 1 ? 'late' : 'done';

  const excuse = q.excuseOn.get(user.id, today);
  if (excuse) return 'excused';

  if (isSkipDate(today)) return 'holiday';

  return nowMin >= hhmmToMinutes(deadline) ? 'missed' : 'pending';
}

function statusLabel(status) {
  return (
    {
      pending: '待打卡',
      done: '已打卡',
      late: '迟到',
      excused: '已请假',
      missed: '漏签',
      holiday: '免打卡',
    }[status] || status
  );
}

/** 今日完整状态 + 强制阻断判定 */
function buildStatus(user, now = new Date()) {
  const today = dateKey(now);
  const yesterday = addDays(today, -1);
  const deadline = effectiveDeadline(user);
  const nowMin = minutesOfDay(now);
  const nowSec = secondsOfDay(now);
  const deadlineMin = hhmmToMinutes(deadline);
  const passed = nowMin >= deadlineMin;
  const holiday = isSkipDate(today);

  const checkin = q.checkinOn.get(user.id, today);
  const excuse = q.excuseOn.get(user.id, today);
  const status = todayStatusFor(user, today, deadline, nowMin);

  // ---- 强制阻断 ----
  let blocked = false;
  let blockDate = null;
  let blockReason = null;

  if (!holiday) {
    if (!checkin && !excuse && passed) {
      blocked = true;
      blockDate = today;
      blockReason = 'TODAY_DEADLINE_PASSED';
    } else {
      const registeredAt = dateKey(new Date(user.created_at));
      const yesterdaySettled =
        yesterday >= registeredAt && !isSkipDate(yesterday)
          ? Boolean(q.checkinOn.get(user.id, yesterday) || q.excuseOn.get(user.id, yesterday))
          : true;
      if (!yesterdaySettled) {
        blocked = true;
        blockDate = yesterday;
        blockReason = 'YESTERDAY_MISSED';
      }
    }
  }

  const totalCheckins = q.countCheckins.get(user.id).n;
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
    },
    today,
    timezone: BUSINESS_TIMEZONE,
    deadline,
    serverTime: now.toISOString(),
    isSkipDay: holiday,
    nextSkipDate: nextSkipDate(today),
    status,
    statusLabel: statusLabel(status),
    checkedIn: Boolean(checkin),
    checkedInAt: checkin ? checkin.created_at : null,
    late: Boolean(checkin && checkin.late === 1),
    excused: Boolean(excuse),
    excuseReason: excuse ? excuse.reason : null,
    streak: user.current_streak,
    bestStreak: user.best_streak,
    totalCheckins,
    blocked,
    blockDate,
    blockReason,
    deadlinePassed: passed,
    secondsUntilDeadline: passed ? 0 : Math.max(0, deadlineMin * 60 - nowSec),
    nudges,
  };
}

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    deadline: user.deadline,
    streak: user.current_streak,
    bestStreak: user.best_streak,
    lastCountedDate: user.last_counted_date,
    createdAt: user.created_at,
  };
}

function publicError(res, status, code, message, extra) {
  return res.status(status).json(Object.assign({ error: code, message }, extra || {}));
}

/* ---------------- 好友关系 ---------------- */

/** 一次性取回与 me 相关的全部关系，避免排行榜 N+1 */
function buildFriendMap(meId) {
  const map = new Map();
  const pendingIn = new Set();
  const pendingOut = new Set();

  for (const row of q.friendshipsOf.all(meId, meId)) {
    const other = row.user_id === meId ? row.friend_id : row.user_id;
    if (row.status === 'accepted') {
      map.set(other, 'accepted');
    } else if (row.user_id === meId) {
      pendingOut.add(other);
    } else {
      pendingIn.add(other);
    }
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

/* ---------------- 排行榜周期 ---------------- */

function periodRange(period, today) {
  if (period === 'week') return { start: startOfWeek(today), end: today, label: '本周' };
  if (period === 'month') return { start: `${today.slice(0, 7)}-01`, end: today, label: '本月' };
  return { start: null, end: null, label: '总榜' };
}

/* --------------------------------------------------------------------------
 * 8. 简易限流
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
 * 9. Express 应用
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
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(`[api] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms.toFixed(1)}ms`);
    }
  });
  next();
});

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return publicError(res, 401, 'UNAUTHORIZED', '请先登录');

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return publicError(
      res,
      401,
      expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      expired ? '登录已过期，请重新登录' : '登录凭证无效'
    );
  }

  const user = q.userById.get(Number(payload.sub));
  if (!user) return publicError(res, 401, 'USER_NOT_FOUND', '账号不存在或已被删除');

  req.user = user;
  next();
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.is_admin !== 1) {
    return publicError(res, 403, 'FORBIDDEN', '需要管理员权限');
  }
  next();
}

/** 结算 + 返回最新用户（断签惰性结算的唯一入口） */
function freshUser(user) {
  settleUser(user, dateKey());
  return user;
}

/* ------------------------------- 健康检查 -------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'qiangzhi-checkin',
    version: '2.0.0',
    env: NODE_ENV,
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

app.post('/api/register', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit({ key: `reg:${ip}`, limit: 20, windowMs: 3600_000 })) {
    return publicError(res, 429, 'TOO_MANY_REQUESTS', '注册过于频繁，请稍后再试');
  }

  const { username, password } = req.body || {};
  const problem = validateCredentials(username, password);
  if (problem) return publicError(res, 400, 'INVALID_INPUT', problem);

  const name = String(username).trim();
  if (q.userByName.get(name)) {
    return publicError(res, 409, 'USERNAME_TAKEN', '该用户名已被注册');
  }

  const now = nowIso();
  const info = q.insertUser.run(name, hashPassword(password), 0, now, now);
  const user = q.userById.get(info.lastInsertRowid);

  console.log(`[auth] 新用户注册：${user.username} (#${user.id})`);
  res.status(201).json({ token: signToken(user), user: serializeUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
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

  freshUser(user);
  res.json({ token: signToken(user), user: serializeUser(user) });
});

/* ------------------------------- 打卡状态 -------------------------------- */

app.get('/api/me', authRequired, (req, res) => {
  const user = freshUser(req.user);
  res.json({ user: serializeUser(user), status: buildStatus(user) });
});

app.get('/api/status', authRequired, (req, res) => {
  const user = freshUser(req.user);
  res.json(buildStatus(user));
});

app.post('/api/checkin', authRequired, (req, res) => {
  const now = new Date();
  const today = dateKey(now);
  const user = freshUser(req.user);

  const existing = q.checkinOn.get(user.id, today);
  if (existing) {
    return res.status(200).json({
      ok: true,
      alreadyCheckedIn: true,
      status: buildStatus(user, now),
    });
  }

  const deadline = effectiveDeadline(user);
  const late = minutesOfDay(now) >= hhmmToMinutes(deadline) ? 1 : 0;
  const yesterday = addDays(today, -1);
  const continuing = user.last_counted_date === yesterday;
  const nextStreak = continuing ? user.current_streak + 1 : 1;
  const nextBest = Math.max(user.best_streak, nextStreak);
  const note = typeof (req.body || {}).note === 'string' ? String(req.body.note).slice(0, 200) : null;

  const tx = db.transaction(() => {
    q.insertCheckin.run(user.id, today, late, note, now.toISOString());
    q.updateUserBoth.run(nextStreak, nextBest, today, now.toISOString(), user.id);
  });
  tx();

  user.current_streak = nextStreak;
  user.best_streak = nextBest;
  user.last_counted_date = today;

  console.log(`[checkin] ${user.username} ${today} late=${late} streak=${nextStreak}`);

  res.status(201).json({
    ok: true,
    alreadyCheckedIn: false,
    late: late === 1,
    gainedStreak: nextStreak,
    status: buildStatus(user, now),
  });
});

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
    return publicError(
      res,
      400,
      'DATE_OUT_OF_RANGE',
      `只能为最近 ${EXCUSE_LOOKBACK_DAYS} 天内的漏签补填借口`
    );
  }

  if (q.checkinOn.get(user.id, targetDate)) {
    return publicError(res, 409, 'ALREADY_CHECKED_IN', '该日期已打卡，无需填写借口');
  }

  if (q.excuseOn.get(user.id, targetDate)) {
    return res.json({ ok: true, alreadyExcused: true, status: buildStatus(user, now) });
  }

  const tx = db.transaction(() => {
    q.insertExcuse.run(user.id, targetDate, reason, now.toISOString());
    if (!user.last_counted_date || targetDate > user.last_counted_date) {
      q.updateUserStreak.run(user.current_streak, targetDate, now.toISOString(), user.id);
      user.last_counted_date = targetDate;
    }
  });
  tx();

  console.log(`[excuse] ${user.username} ${targetDate} reason=${reason.slice(0, 30)}`);

  res.status(201).json({
    ok: true,
    alreadyExcused: false,
    date: targetDate,
    status: buildStatus(user, now),
  });
});

/* ------------------------------- 排行榜 ---------------------------------- */

app.get('/api/leaderboard', authRequired, (req, res) => {
  const period = ['all', 'week', 'month'].includes(String(req.query.period))
    ? String(req.query.period)
    : 'all';
  const limit = Math.min(
    LEADERBOARD_MAX,
    Math.max(1, Number.parseInt(req.query.limit, 10) || 50)
  );

  const now = new Date();
  const today = dateKey(now);
  const nowMin = minutesOfDay(now);
  const { start, end, label } = periodRange(period, today);
  const friendMap = buildFriendMap(req.user.id);

  const all = q.allUsers.all().map((user) => {
    settleUser(user, today);
    const deadline = effectiveDeadline(user);
    const todayStatus = todayStatusFor(user, today, deadline, nowMin);
    const score =
      period === 'all' ? user.current_streak : q.countCheckinsBetween.get(user.id, start, end).n;
    const friendship = friendMap.get(user.id) || (user.id === req.user.id ? 'self' : 'none');
    const checkedInToday = todayStatus === 'done' || todayStatus === 'late';

    return {
      userId: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1,
      score,
      streak: user.current_streak,
      bestStreak: user.best_streak,
      todayStatus,
      deadline,
      friendship,
      canNudge:
        friendship === 'accepted' &&
        !checkedInToday &&
        !isSkipDate(today) &&
        user.id !== req.user.id,
      isMe: user.id === req.user.id,
      createdAt: user.created_at,
    };
  });

  all.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.streak !== a.streak) return b.streak - a.streak;
    if (b.bestStreak !== a.bestStreak) return b.bestStreak - a.bestStreak;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });

  const rows = all.map((row, index) => ({ rank: index + 1, ...row }));

  res.json({
    period,
    periodLabel: label,
    range: { start, end },
    generatedAt: now.toISOString(),
    timezone: BUSINESS_TIMEZONE,
    today,
    isSkipDay: isSkipDate(today),
    total: rows.length,
    rows: rows.slice(0, limit).map((row) => ({ ...row, isMe: row.userId === req.user.id })),
    me: rows.find((row) => row.userId === req.user.id) || null,
  });
});

/* ------------------------------- 好友系统 -------------------------------- */

/** 把 {username} / {userId} 解析成用户行 */
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
  if (state === 'accepted') {
    return publicError(res, 409, 'ALREADY_FRIENDS', '你们已经是好友了');
  }
  if (state === 'pending_out') {
    return publicError(res, 409, 'REQUEST_EXISTS', '好友申请已发送，等待对方同意');
  }

  const now = nowIso();
  const autoAccepted = state === 'pending_in';

  const tx = db.transaction(() => {
    if (autoAccepted) {
      // 对方先申请了我，我这次申请直接互加
      q.upsertFriendship.run(me.id, target.id, 'accepted', now, now);
      q.upsertFriendship.run(target.id, me.id, 'accepted', now, now);
    } else {
      q.upsertFriendship.run(me.id, target.id, 'pending', now, now);
    }
  });
  tx();

  console.log(
    `[friend] ${me.username} -> ${target.username} ${autoAccepted ? '互相申请自动成为好友' : '发送申请'}`
  );

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

  if (!requester) {
    return publicError(res, 404, 'USER_NOT_FOUND', '申请人不存在');
  }

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

  console.log(`[friend] ${me.username} 同意了 ${requester.username} 的好友申请`);

  res.json({
    ok: true,
    friend: { id: requester.id, username: requester.username },
    state: 'accepted',
  });
});

app.get('/api/friends/list', authRequired, (req, res) => {
  const me = freshUser(req.user);
  const today = dateKey();
  const nowMin = minutesOfDay();
  const holidays = isSkipDate(today);

  const friends = q.acceptedFriends.all(me.id).map((row) => {
    const deadline = effectiveDeadline(row);
    const todayStatus = todayStatusFor(row, today, deadline, nowMin);
    const checkedInToday = todayStatus === 'done' || todayStatus === 'late';
    return {
      id: row.id,
      username: row.username,
      streak: row.current_streak,
      bestStreak: row.best_streak,
      todayStatus,
      checkedInToday,
      deadline,
      since: row.friends_since,
      canNudge: !checkedInToday && !holidays && todayStatus !== 'excused',
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
    isSkipDay: holidays,
    friends,
    incoming,
    outgoing,
    counts: {
      friends: friends.length,
      incoming: incoming.length,
      outgoing: outgoing.length,
    },
  });
});

/* ------------------------------- 催打卡 ---------------------------------- */

app.post('/api/nudge/:username', authRequired, (req, res) => {
  const me = freshUser(req.user);
  const username = String(req.params.username || '').trim();
  const target = q.userByName.get(username);

  if (!target) return publicError(res, 404, 'USER_NOT_FOUND', '对方不存在');
  if (target.id === me.id) return publicError(res, 400, 'CANNOT_NUDGE_SELF', '不用催自己啦');

  // 核心权限校验：必须是 accepted 好友
  if (friendshipState(me.id, target.id) !== 'accepted') {
    return publicError(res, 403, 'NOT_FRIENDS', '只能催自己的好友，先加个好友吧');
  }

  const now = new Date();
  const today = dateKey(now);
  const nowMin = minutesOfDay(now);

  if (isSkipDate(today)) {
    return publicError(res, 400, 'SKIP_DAY', '今天是免打卡日，不用催啦');
  }

  const targetStatus = todayStatusFor(target, today, effectiveDeadline(target), nowMin);
  if (targetStatus === 'done' || targetStatus === 'late') {
    return publicError(res, 400, 'ALREADY_CHECKED_IN', '对方今天已经打卡了，放过他吧');
  }

  const last = q.lastNudgeBetween.get(me.id, target.id);
  if (last) {
    const elapsed = now.getTime() - new Date(last.created_at).getTime();
    if (elapsed < NUDGE_COOLDOWN_MS) {
      const retryAfter = Math.ceil((NUDGE_COOLDOWN_MS - elapsed) / 1000);
      return publicError(res, 429, 'NUDGE_TOO_OFTEN', '催得太频繁了，歇一会儿再催', {
        retryAfter,
      });
    }
  }

  q.insertNudge.run(me.id, target.id, today, now.toISOString());

  console.log(`[nudge] ${me.username} -> ${target.username} (${today})`);

  res.status(201).json({
    ok: true,
    message: `已催 ${target.username} 打卡，快去写吧！`,
    nudge: {
      from: me.username,
      to: target.username,
      createdAt: now.toISOString(),
      date: today,
    },
  });
});

/* ------------------------------- 打卡日历 -------------------------------- */

app.get('/api/user/calendar', authRequired, (req, res) => {
  const user = freshUser(req.user);
  const days = Math.min(
    CALENDAR_MAX_DAYS,
    Math.max(7, Number.parseInt(req.query.days, 10) || 30)
  );

  const now = new Date();
  const today = dateKey(now);
  const nowMin = minutesOfDay(now);
  const deadline = effectiveDeadline(user);
  const passed = nowMin >= hhmmToMinutes(deadline);

  const items = [];
  const summary = { done: 0, excused: 0, missed: 0, holiday: 0, pending: 0 };

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const checkin = q.checkinOn.get(user.id, date);
    const excuse = q.excuseOn.get(user.id, date);

    let status;
    if (checkin) status = 'done';
    else if (excuse) status = 'excused';
    else if (isSkipDate(date)) status = 'holiday';
    else if (date === today && !passed) status = 'pending';
    else status = 'missed';

    summary[status] += 1;
    items.push({
      date,
      status,
      late: Boolean(checkin && checkin.late === 1),
      isToday: date === today,
      weekday: weekdayIndex(date),
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
    deadline: effectiveDeadline(req.user),
    userDeadline: req.user.deadline,
    defaultDeadline: defaultDeadline(),
    timezone: BUSINESS_TIMEZONE,
    timezoneLocked: true,
    excuseLookbackDays: EXCUSE_LOOKBACK_DAYS,
    skipDates: Array.from(skipDates()).sort(),
    isSkipToday: isSkipDate(today),
  });
});

app.put('/api/settings', authRequired, (req, res) => {
  const body = req.body || {};
  const raw = body.deadline;

  if (raw === null || raw === '' || raw === 'default') {
    q.updateUserDeadline.run(null, nowIso(), req.user.id);
    return res.json({
      ok: true,
      deadline: defaultDeadline(),
      userDeadline: null,
      defaultDeadline: defaultDeadline(),
      timezone: BUSINESS_TIMEZONE,
    });
  }

  if (typeof raw !== 'string' || !TIME_RE.test(raw)) {
    return publicError(res, 400, 'INVALID_DEADLINE', '截止时间格式应为 HH:MM（00:00 - 23:59）');
  }

  q.updateUserDeadline.run(raw, nowIso(), req.user.id);
  res.json({
    ok: true,
    deadline: raw,
    userDeadline: raw,
    defaultDeadline: defaultDeadline(),
    timezone: BUSINESS_TIMEZONE,
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
        throw Object.assign(new Error('用户名需为 2-24 位字母、数字、下划线或中文'), {
          status: 400,
          code: 'INVALID_INPUT',
        });
      }
      const taken = q.userByName.get(name);
      if (taken && taken.id !== user.id) {
        throw Object.assign(new Error('该用户名已被占用'), { status: 409, code: 'USERNAME_TAKEN' });
      }
      q.updateUsername.run(name, nowIso(), user.id);
      user.username = name;
    }
    if (wantsPassword) {
      if (String(body.password).length < 6 || String(body.password).length > 72) {
        throw Object.assign(new Error('密码长度需为 6-72 位'), {
          status: 400,
          code: 'INVALID_INPUT',
        });
      }
      q.updatePassword.run(hashPassword(body.password), nowIso(), user.id);
    }
  });

  try {
    tx();
  } catch (err) {
    return publicError(res, err.status || 400, err.code || 'INVALID_INPUT', err.message);
  }

  res.json({ ok: true, token: signToken(user), user: serializeUser(user) });
});

/* ------------------------------- 管理接口 -------------------------------- */

app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const now = new Date();
  const today = dateKey(now);
  const nowMin = minutesOfDay(now);

  const users = q.allUsers.all().map((user) => {
    settleUser(user, today);
    return {
      ...serializeUser(user),
      todayStatus: todayStatusFor(user, today, effectiveDeadline(user), nowMin),
      totalCheckins: q.countCheckins.get(user.id).n,
    };
  });

  res.json({ timezone: BUSINESS_TIMEZONE, today, isSkipDay: isSkipDate(today), users });
});

app.post('/api/admin/users/:id/reset', authRequired, adminRequired, (req, res) => {
  const targetId = Number(req.params.id);
  const target = Number.isInteger(targetId) ? q.userById.get(targetId) : null;
  if (!target) return publicError(res, 404, 'USER_NOT_FOUND', '用户不存在');

  const today = dateKey();
  const body = req.body || {};
  const date = body.date ? String(body.date) : today;
  if (!DATE_RE.test(date)) {
    return publicError(res, 400, 'INVALID_DATE', '日期格式应为 YYYY-MM-DD');
  }
  const resetStreak = body.resetStreak !== false;

  const tx = db.transaction(() => {
    q.deleteCheckinOn.run(target.id, date);
    q.deleteExcuseOn.run(target.id, date);
    if (resetStreak) {
      q.updateUserStreak.run(0, null, nowIso(), target.id);
      target.current_streak = 0;
      target.last_counted_date = null;
    }
    q.audit.run(
      req.user.id,
      'RESET_CHECKIN',
      target.id,
      JSON.stringify({ date, resetStreak }),
      nowIso()
    );
  });
  tx();

  console.log(`[admin] ${req.user.username} 重置了 ${target.username} 的 ${date} 记录`);

  const refreshed = q.userById.get(target.id);
  res.json({
    ok: true,
    date,
    user: serializeUser(refreshed),
    status: buildStatus(refreshed),
  });
});

/** 管理员：更新全局设置（默认截止时间 / 免打卡日） */
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

  if (!Object.keys(patch).length) {
    return publicError(res, 400, 'INVALID_INPUT', '没有需要修改的设置');
  }

  for (const [key, value] of Object.entries(patch)) q.setSetting.run(key, value);
  skipDatesCache = null;
  q.audit.run(req.user.id, 'UPDATE_SETTINGS', null, JSON.stringify(patch), nowIso());

  res.json({
    ok: true,
    defaultDeadline: defaultDeadline(),
    timezone: BUSINESS_TIMEZONE,
    skipDates: Array.from(skipDates()).sort(),
    isSkipToday: isSkipDate(dateKey()),
  });
});

/** 管理员：只设置免打卡日（App/Web 表单专用） */
app.post('/api/admin/set-skip-dates', authRequired, adminRequired, (req, res) => {
  const normalized = normalizeSkipDates((req.body || {}).dates);
  if (normalized === null) {
    return publicError(
      res,
      400,
      'INVALID_SKIP_DATES',
      '免打卡日格式应为 YYYY-MM-DD，多个用逗号或换行分隔'
    );
  }

  const saved = setSkipDates(normalized);
  q.audit.run(req.user.id, 'SET_SKIP_DATES', null, JSON.stringify(saved), nowIso());

  console.log(`[admin] ${req.user.username} 更新免打卡日：${saved.join(',') || '（空）'}`);

  res.json({
    ok: true,
    skipDates: saved,
    count: saved.length,
    isSkipToday: isSkipDate(dateKey()),
  });
});

/** 把 "2026-12-25,2027-01-01" / 数组 / 换行文本 统一成有序去重数组；非法返回 null */
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

/* ------------------------------- 静态资源 -------------------------------- */

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: '1h',
    setHeaders(res, filePath) {
      // 页面与接口相关资源不缓存，保证更新后刷新即可看到新版
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

/* ------------------------------- 错误处理 -------------------------------- */

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
 * 10. 启动
 * ------------------------------------------------------------------------ */

seed();

const server = app.listen(PORT, HOST, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  不拖延 · 强制打卡系统 v2.0 已启动');
  console.log(`  HTTP       http://localhost:${PORT}`);
  console.log(`  Web 管理端 http://localhost:${PORT}/`);
  console.log(`  数据库     ${DB_PATH}`);
  console.log(`  时区       ${BUSINESS_TIMEZONE}（强制）`);
  console.log(`  默认截止   ${defaultDeadline()}`);
  console.log(`  免打卡日   ${Array.from(skipDates()).join(', ') || '（未设置）'}`);
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
