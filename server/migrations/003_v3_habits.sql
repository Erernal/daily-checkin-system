-- ============================================================================
--  不拖延 · v2 → v3 数据库变更（多习惯 / 积分 / 请假额度 / 补签卡 / 设备唯一）
--  SQLite 说明：ALTER TABLE 一次只能 ADD COLUMN，且没有 IF NOT EXISTS；
--  服务启动时会用 PRAGMA table_info 做幂等检查，重复执行也不会报错。
--  手工执行：sqlite3 data/checkin.db < migrations/003_v3_habits.sql
-- ============================================================================

-- ---------- 1. users：设备号 / 积分 / 请假额度 / 补签卡 ----------
ALTER TABLE users ADD COLUMN device_id TEXT;
ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN leave_balance INTEGER NOT NULL DEFAULT 3;
ALTER TABLE users ADD COLUMN leave_month TEXT;                       -- 形如 2026-11，用于月初重置
ALTER TABLE users ADD COLUMN makeup_cards INTEGER NOT NULL DEFAULT 0;

-- 设备号唯一（允许多个 NULL，即未绑定设备的老账号）
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device ON users (device_id) WHERE device_id IS NOT NULL;

-- ---------- 2. habits：打卡项与时间规则 ----------
CREATE TABLE IF NOT EXISTS habits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT    NOT NULL,
  emoji             TEXT    NOT NULL DEFAULT '⏰',
  active_days       TEXT    NOT NULL DEFAULT '1,2,3,4,5,6,7',  -- 1=周一 … 7=周日
  deadline_time     TEXT    NOT NULL DEFAULT '22:00',          -- 每天截止时间 HH:MM
  start_date        TEXT    NOT NULL,                           -- 生效起始日 YYYY-MM-DD
  current_streak    INTEGER NOT NULL DEFAULT 0,
  best_streak       INTEGER NOT NULL DEFAULT 0,
  last_counted_date TEXT,
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_habits_user ON habits (user_id, archived);

-- ---------- 3. checkins：从「用户/天」升级为「习惯/天」 ----------
-- 旧表改为备份，按 habit 重建（迁移脚本会自动为每个用户建一个默认习惯并搬运数据）
ALTER TABLE checkins RENAME TO checkins_v2_backup;

CREATE TABLE checkins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  late       INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  makeup     INTEGER NOT NULL DEFAULT 0,   -- 1 = 补签卡自动补的，不计入总次数
  created_at TEXT    NOT NULL,
  UNIQUE (habit_id, date)
);

CREATE INDEX IF NOT EXISTS idx_checkins_habit_date ON checkins (habit_id, date);
CREATE INDEX IF NOT EXISTS idx_checkins_user_date  ON checkins (user_id, date);

-- ---------- 4. excuses：区分是否消耗请假额度 ----------
ALTER TABLE excuses ADD COLUMN uses_leave INTEGER NOT NULL DEFAULT 1;

-- 免打卡日沿用 settings.skip_dates，无需改表
