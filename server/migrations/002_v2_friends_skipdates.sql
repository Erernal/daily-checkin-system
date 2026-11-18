-- ============================================================================
--  不拖延 · 强制打卡系统 v1 → v2 数据库变更
--  适用于已有 v1 数据的 SQLite 库；服务启动时也会自动执行同样的幂等迁移。
--  用法：sqlite3 data/checkin.db < migrations/002_v2_friends_skipdates.sql
-- ============================================================================

-- 1) 好友关系表
--    约定：accepted 关系存两行（A→B、B→A），pending 只存一行（发起方→接收方）
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

-- 2) 催打卡记录表（用于展示“被催”和 10 分钟频率限制）
CREATE TABLE IF NOT EXISTS nudges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT    NOT NULL,          -- 北京时间 YYYY-MM-DD
  created_at   TEXT    NOT NULL
);

-- 3) 查询索引
CREATE INDEX IF NOT EXISTS idx_friends_user   ON friends (user_id, status);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends (friend_id, status);
CREATE INDEX IF NOT EXISTS idx_nudges_to_date ON nudges (to_user_id, date);

-- 4) settings 新增免打卡日（settings 是 KV 表，新增的是“一行”而不是“一列”）
INSERT OR IGNORE INTO settings (key, value) VALUES ('skip_dates', '');

-- 5) 时区已强制为 Asia/Shanghai，旧的 timezone 配置行可以清理（可选）
DELETE FROM settings WHERE key = 'timezone';

-- 说明：
--   · users / checkins / excuses / audit_log 表结构不变；
--   · 排行榜周榜/月榜不新增表，直接对 checkins.date 做区间统计；
--   · 打卡日历也不新增表，由 checkins / excuses / skip_dates 实时推导。
