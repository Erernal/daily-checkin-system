-- ============================================================================
--  拒绝摆烂 NoSlack · v3 → v4 数据库变更
--  （休假审批 / 特殊勋章 / 改密码 / 管理员删号不需要改表，靠现有表与接口）
--  手工执行：sqlite3 data/checkin.db < migrations/004_v4_vacation.sql
--  服务启动时也会用 PRAGMA 做同样的幂等迁移。
-- ============================================================================

-- ---------- 1. 休假申请 ----------
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

CREATE INDEX IF NOT EXISTS idx_vacation_user   ON vacation_requests (user_id, status);
CREATE INDEX IF NOT EXISTS idx_vacation_status ON vacation_requests (status);

-- ---------- 2. users：休假截止日 + 特殊勋章标记 ----------
ALTER TABLE users ADD COLUMN vacation_until TEXT;              -- 已通过休假的最大结束日
ALTER TABLE users ADD COLUMN badge_early INTEGER NOT NULL DEFAULT 0;  -- 🐦 连续 7 天 08:00 前
ALTER TABLE users ADD COLUMN badge_edge  INTEGER NOT NULL DEFAULT 0;  -- 🦉 连续 7 天截止前 1 小时

-- ---------- 3. checkins：打卡时刻特征（用于勋章判定） ----------
ALTER TABLE checkins ADD COLUMN early INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkins ADD COLUMN edge  INTEGER NOT NULL DEFAULT 0;

-- ---------- 4. 休假自动审批开关（settings 是 KV 表） ----------
INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_approve_vacation', '1');
