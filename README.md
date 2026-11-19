# 不拖延 · 强制打卡系统 v3

Web 管理端 + 移动 App + 统一后端。**多习惯**打卡：每个习惯可以单独设置生效星期与截止时间，休息日不打卡也不断签；打卡攒积分，断签扣分，积分能换补签卡；排行榜分「连胜 / 总次数 / 积分」三榜。

| 部分 | 技术栈 | 入口 |
| --- | --- | --- |
| 后端 | Node.js 18+ · Express 4 · better-sqlite3 · JWT | `server/server.js` |
| Web 端 | 原生 HTML/CSS/JS 单文件（赛博风） | `server/public/index.html` |
| App 端 | React Native 0.88 · Expo SDK 58 | `app/App.js` |

所有日期与截止判断**强制北京时间（Asia/Shanghai）**，与服务器/手机时区无关。

## v3 模块对照

| 模块 | 落地位置 |
| --- | --- |
| 一、习惯时间配置 | `habits.active_days / deadline_time / start_date`；App `HabitFormModal`（星期多选 + 时间选择），Web 习惯弹窗 |
| 二、结算与通知 | `settleHabit()` 只结算 `active_days` 内的日子；App 用 **weekly** 触发器按每个习惯的生效星期 + 截止前 15 分钟注册通知 |
| 三、多榜 | `GET /api/leaderboard/streak\|total\|points`；两端三 Tab |
| 四、Web 管理 | 打卡按钮 `confirm()` 二次确认；游客可不登录只读排行榜 |
| 五、基础保障 | 注册按 `device_logins` 防一机多号；`leave_balance` 月初重置；积分/补签卡；勋章 🛡️👑；App 的 `API_BASE` 固定为 `http://39.96.213.95:3000` |

---

## 目录结构

```
work2/
├── server/
│   ├── server.js                      # ★ v3 后端
│   ├── public/index.html              # ★ Web 端
│   ├── migrations/
│   │   ├── 002_v2_friends_skipdates.sql
│   │   └── 003_v3_habits.sql          # ★ v2 → v3 变更
│   ├── scripts/{seed-demo,reset-password}.mjs
│   ├── test/{smoke,v2,v3}.mjs         # 44 + 52 + 48 条
│   └── data/                          # SQLite（运行时生成）
├── app/{App.js,index.js,app.json}     # ★ Expo App
└── deploy/{ecosystem.config.js,nginx.conf.example}
```

---

## 一、本地跑起来

```bash
cd server
npm install
npm start                # http://localhost:3000
npm run seed:demo        # 可选：6 个演示用户 + 好友关系（密码 demo1234）
```

Web：浏览器打开 <http://localhost:3000>。

> 管理员账号由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 决定；生产未配置密码会随机生成并只打印一次。测试用 `ADMIN_PASSWORD` 环境变量登录。

App：

```bash
cd app
npm install
npx expo start       # 手机装 Expo Go 扫码
```

App 的服务器地址在 `app/App.js` 顶部：

```js
const API_BASE = 'http://39.96.213.95:3000';
```

真机调试时改成电脑局域网 IP（如 `http://192.168.1.10:3000`）即可，手机与电脑需同一 Wi-Fi。

### 跑测试

```bash
cd server
npm start
npm run smoke     # 44 条：基础接口
npm run test:v2   # 52 条：好友 / 免打卡日 / 周期榜
npm run test:v3   # 48 条：习惯 / 休息日 / 积分 / 请假 / 补签 / 设备
```

> 注册接口有「同 IP 20 次/小时」限流，反复跑测试前重启一次服务即可重置。

---

## 二、核心规则

| 概念 | 规则 |
| --- | --- |
| 习惯 | 每人 1–20 个，可设名称、图标、生效星期（1=周一…7=周日）、每日截止时间、生效起始日 |
| 休息日 | 当天不在 `active_days` 内 → 显示「今日休息」，不要求打卡、不计入今日待办、不断签 |
| 打卡 | 截止前 `done`，截止后当天 `late`（仍算完成），每个习惯 +10 分 |
| 断签 | 结算时扫描「上次计数日 +1 ~ 昨天」：只在生效日要求打卡，休息日跳过；漏了生效日 → 连胜清零、-20 分 |
| 请假 | 每月 3 次额度，月初自动重置；有额度请假保住连胜，无额度仍可提交借口（解锁 App）但这次断签不保 |
| 补签卡 | 100 分兑换；结算发现漏签时自动消耗一张，记为「补签」：连胜保留、不扣分，且不计入总次数 |
| 连胜 | 取该用户所有习惯中的最大连胜；枚举报：最佳 ≥7 天 🛡️，≥30 天 👑 |
| 免打卡日 | 管理员设置的全员日期，不打卡不断签、不触发阻断 |
| 设备 | 注册时同一设备只能开一个号（查 `device_logins` / `users.device_id`，409）；**登录不拦截**，换机登录会静默把 `users.device_id` 更新为新设备并记录到 `device_logins` |

**强制阻断**（App 全屏遮罩）：今天有生效习惯已过截止仍未完成 / 昨天有生效习惯漏签，且未请假。

---

## 三、API

统一前缀 `/api`，除公开接口外需 `Authorization: Bearer <token>`。

### 账号 / 状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/register` | `{username, password, deviceId?}` |
| POST | `/api/login` | `{username, password, deviceId?}`，换设备不拦截，只静默更新绑定 |
| GET | `/api/status` | 今日聚合状态 + `habits[]` + 积分/额度/补签卡/勋章 |
| GET | `/api/me` | 用户 + 状态 |

### 习惯

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/habits` | 我的习惯（含 `isActiveToday / restToday / checkedIn`） |
| POST | `/api/habits` | `{name, emoji, activeDays:[1..7], deadlineTime:"22:00", startDate}` |
| PUT | `/api/habits/:id` | 同上，支持部分字段 |
| DELETE | `/api/habits/:id` | 归档（软删除） |
| POST | `/api/habits/:id/checkin` | 打卡；休息日返回 400 `REST_DAY` |

`POST /api/checkin` 保留兼容：不带 `habitId` 时自动挑一个今天未完成的习惯。

### 三榜（未登录可读）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/leaderboard/streak` | 当前最长连胜 |
| GET | `/api/leaderboard/total` | 累计打卡次数（不含补签） |
| GET | `/api/leaderboard/points` | 当前积分 |

返回 `{ type, typeLabel, unit, rows:[{rank,username,value,streak,totalCheckins,points,badges,todayStatus,friendship,canNudge,isMe}] }`。
匿名访问时 `friendship/isMe` 为 null，其余字段照常可读。

### 其他

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/excuse` | 请假/借口，消耗额度时保连胜 |
| POST | `/api/shop/makeup-card` | `{quantity}`，100 分/张 |
| GET | `/api/user/calendar?days=30` | 热力图（done/excused/missed/rest/holiday/pending） |
| GET/PUT | `/api/settings` | 个人截止时间、免打卡日、积分规则 |
| PUT | `/api/account` | 改用户名/密码 |
| — | 好友 / 催打卡 / 管理接口 | 同 v2，未变 |

---

## 四、Web 端

- 赛博深色 UI；今日习惯卡片（打卡/编辑/新建），休息日为灰色「今日休息」且没有打卡按钮
- 打卡前**原生 confirm**：`确定完成【习惯名】吗？`，确认后才发请求
- 排行榜三 Tab：连胜榜 / 总次数榜 / 积分榜，前三名奖牌、勋章、自己高亮
- **游客模式**：登录页「不登录，先看看排行榜 →」，只读浏览三个榜单
- 设置页：好友列表与申请、免打卡日、账号、管理员系统设置

## 五、App 端

- 底部三 Tab：打卡 / 排行榜 / 我的
- 打卡页：习惯卡片 + 倒计时 + 积分/额度/补签卡 + 积分商店；新建/编辑习惯弹窗（星期多选 `一二三四五六日` + `HH:MM` 时间）
- 打卡二次确认弹窗（自定义 `ConfirmModal`），成功后顶部滑入 Toast + 随机语录
- 排行榜三榜切换，好友「加好友 / 同意 / 催一下」
- 个人主页：30 天热力图（含休息日）、好友、勋章
- 通知：按每个习惯的**生效星期**注册 `weekly` 通知，时间为截止前 15 分钟；休息日不会响
- 登录/注册自动上报 `deviceId`（expo-device）：注册限一机一号，登录换机不受限

---

## 六、数据库变更（v2 → v3）

完整 SQL 见 [`server/migrations/003_v3_habits.sql`](server/migrations/003_v3_habits.sql)，服务启动时会自动做同样的幂等迁移。

```sql
ALTER TABLE users ADD COLUMN device_id TEXT;
ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN leave_balance INTEGER NOT NULL DEFAULT 3;
ALTER TABLE users ADD COLUMN leave_month TEXT;
ALTER TABLE users ADD COLUMN makeup_cards INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_device ON users (device_id);

CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '⏰',
  active_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
  deadline_time TEXT NOT NULL DEFAULT '22:00',
  start_date TEXT NOT NULL,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_counted_date TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE checkins RENAME TO checkins_v2_backup;
CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  makeup INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (habit_id, date)
);

ALTER TABLE excuses ADD COLUMN uses_leave INTEGER NOT NULL DEFAULT 1;
```

迁移时会给每个老用户建一个「每日打卡」习惯（7 天生效、截止时间沿用其旧设置），把旧 `checkins` 全部挂到这个习惯下，并继承原连胜/最佳记录；旧表保留为 `checkins_v2_backup`。

---

## 七、部署

```bash
# 服务器：Node 22 + pm2 + nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 sqlite3 nginx

rsync -avz --exclude node_modules --exclude data --exclude .env \
  ./server/ user@1.2.3.4:/opt/qiangzhi/server/
rsync -avz ./deploy/ user@1.2.3.4:/opt/qiangzhi/deploy/

cd /opt/qiangzhi/server
npm install --omit=dev
cp .env.example .env && nano .env      # JWT_SECRET / ADMIN_PASSWORD 必改

sudo npm i -g pm2
pm2 start /opt/qiangzhi/deploy/ecosystem.config.js
pm2 save && pm2 startup
```

数据库升级（二选一）：

```bash
# A. 直接启动，服务自动迁移
pm2 restart checkin-api

# B. 手工执行（先备份）
sqlite3 data/checkin.db ".backup 'data/checkin.before-v3.db'"
sqlite3 data/checkin.db < migrations/003_v3_habits.sql
```

> 注意：手工执行 SQL 后仍建议再启动一次服务，让 `migrate()` 完成「默认习惯 + 历史数据搬运」这一步（SQL 文件只是结构变更）。

Nginx / HTTPS / 防火墙 / 备份同前，配置见 `deploy/`。

---

## 八、排错

- **今天没有习惯可打卡**：新用户自带一个「每日打卡」，如果删光了需要重建。
- **打卡按钮灰色**：该习惯今天不在生效星期内（休息日），或已请假/免打卡日。
- **积分变少**：昨天漏签被结算，-20；有补签卡会自动消耗避免扣分。
- **请假没保住连胜**：本月 3 次额度用完了，接口返回 `usedLeave:false`。
- **换手机登录**：直接登录即可，服务端会静默更新设备号，不再报 403。
- **通知不响**：检查通知权限；Android 需允许「闹钟和提醒」并关闭电池优化；休息日不会注册通知。
- **时间对不上**：服务端与 App 都按北京时间计算，手机时区建议设为东八区。

## 九、安全

- 密码 scrypt 加盐；JWT 7 天；登录限流。
- 生产环境必须设置 `JWT_SECRET` 与 `ADMIN_PASSWORD`，并启用 HTTPS。
- 注册按设备号防一机多号（`device_logins`），登录不拦截；催打卡有 403 好友校验 + 10 分钟冷却。
