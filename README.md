# 不拖延 · 防拖延强制打卡系统 v2（赛博版）

Web 管理端 + 移动 App + 统一后端。到点不打卡，手机弹系统级强提醒；再打开 App 会被全屏遮罩拦住，必须写下借口才能继续用。

三端共用一个后端、一套账号、一个 SQLite 数据库；所有日期与截止判断**强制按北京时间（Asia/Shanghai）**。

| 部分 | 技术栈 | 入口 |
| --- | --- | --- |
| 后端 | Node.js 18+ · Express 4 · better-sqlite3 · JWT | `server/server.js` |
| Web 端 | 原生 HTML/CSS/JS 单文件（赛博深色风） | `server/public/index.html` |
| App 端 | React Native 0.88 · Expo SDK 58 | `app/App.js` |

## 本次升级对应模块

| 模块 | 落地位置 |
| --- | --- |
| 0. 赛博 UI | `app/App.js` 的 `C` 主题 + `NeonCard/NeonButton`；`index.html` 的霓虹 CSS |
| 1. 强制北京时间 / 二次确认 / Toast | 后端 `BUSINESS_TIMEZONE` + `zonedParts`；App `beijingToday()`、`ConfirmModal`、`Toast` |
| 2. 排行榜与 Tab | 后端 `/api/leaderboard?period=all\|week\|month`；App 三 Tab + 奖牌 + 自己高亮 |
| 3. 好友与催打卡 | `friends` / `nudges` 表 + 4 个接口；排行榜/好友列表按钮 |
| 4. 免打卡日 | `settings.skip_dates` + `/api/admin/set-skip-dates`；结算与阻断逻辑 |
| 5. 打卡热力图 | `/api/user/calendar`；个人主页 30 格热力图 |
| 6. Web 管理员面板 | Web「设置 → 系统设置」可改免打卡日 |

---

## 目录结构

```
work2/
├── server/
│   ├── server.js                    # ★ v2 后端（全部接口 + 建表 + 规则）
│   ├── public/index.html            # ★ Web 管理端（单文件，赛博风）
│   ├── migrations/
│   │   └── 002_v2_friends_skipdates.sql   # ★ v1 → v2 数据库变更
│   ├── scripts/
│   │   ├── seed-demo.mjs            # 演示数据
│   │   └── reset-password.mjs       # 重置密码
│   ├── test/
│   │   ├── smoke.mjs                # 基础接口 43 条
│   │   └── v2.mjs                   # 新功能 52 条（好友/催打卡/免打卡/周期榜/日历）
│   └── data/                        # SQLite（首次运行生成）
├── app/
│   ├── App.js                       # ★ v2 App（三 Tab、科技风、通知、阻断）
│   ├── index.js / app.json
│   └── .env.example
└── deploy/                          # PM2 / Nginx 示例
```

---

## 一、本地跑起来

```bash
cd server
npm install
npm start                # http://localhost:3000
npm run seed:demo        # 可选：塞 6 个演示用户（密码见脚本说明）
```

> **管理员账号**：由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 环境变量决定。
> 生产环境未设置密码时会随机生成，并只在首次建号的启动日志里打印一次；
> 开发环境未设置时使用内置默认账号（仅限本地，请勿用于线上）。
> 登录后请立即在「设置 → 账号」修改密码，或执行 `node scripts/reset-password.mjs admin 新密码`。

Web：浏览器打开 <http://localhost:3000>。

App：

```bash
cd app
npm install
copy .env.example .env   # macOS/Linux: cp
# 把 EXPO_PUBLIC_API_BASE 改成 http://<电脑局域网IP>:3000
npx expo start
```

手机装 Expo Go 扫码；**手机与电脑要连同一个 Wi-Fi**，先在手机浏览器打开 `http://<IP>:3000/api/health` 确认能通。

> Node 需要 18.17+（建议 20/22 LTS）。`better-sqlite3` 是原生模块，换 Node 大版本后执行 `npm rebuild better-sqlite3`。

### 跑测试

```bash
cd server
npm start           # 终端 A
npm run smoke       # 终端 B：43 条
npm run test:v2     # 终端 B：52 条
```

> 测试用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录管理员，默认取开发环境的本地账号；
> 如果你已经改过管理员密码，运行时带上环境变量：`set ADMIN_PASSWORD=... && npm run smoke`。

---

## 二、核心规则

所有日期按**北京时间**的日历日计算，格式 `YYYY-MM-DD`。

| 概念 | 规则 |
| --- | --- |
| 打卡日 | 北京时间 `00:00`–`23:59` |
| 截止时间 | 每人可自定义 `HH:MM`；没设置就跟随全局默认（`22:00`） |
| 按时打卡 | 截止前 → `done`，连胜 +1 |
| 迟到打卡 | 截止后当天 → `late`，仍算打卡，连胜 +1 |
| 请假 | `excused`：当天不算打卡，连胜**既不加也不清零** |
| 断签 | 一整天没打卡也没请假 → 连胜清零（下次请求时惰性结算） |
| **免打卡日** | `skip_dates` 中的日期 → `holiday`：不打卡不断签，连胜冻结，且不触发强制阻断 |
| 周期榜 | 总榜 = 当前连胜；周榜 = 本周（周一起）打卡次数；月榜 = 本月打卡次数 |

**强制阻断**（App 全屏遮罩，必须填借口）：今天过截止仍未打卡/请假；或昨天漏签未补假。注册当天、免打卡日不触发。

**排行榜排序**：分数降序 → 连胜降序 → 历史最佳降序 → 注册时间升序。前三名用 🥇🥈🥉，自己那行用科技蓝边框高亮。

**好友关系**：`pending` 存一行（发起方→接收方），`accepted` 存两行（双向），因此任意方向查询都很快；双方互相申请会自动成为好友。

---

## 三、API 一览

统一前缀 `/api`，除 `register` / `login` / `health` 外都要 `Authorization: Bearer <token>`。
错误统一 `{ "error": "CODE", "message": "中文说明" }`。

### 账号与状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含 `today` / `timezone` / 版本） |
| POST | `/api/register` | 注册 `{username, password}` |
| POST | `/api/login` | 登录 `{username, password}` |
| GET | `/api/me` | 当前用户 + 今日状态 |
| GET | `/api/status` | 今日状态：`status / blocked / nudges / isSkipDay / secondsUntilDeadline` |
| POST | `/api/checkin` | 打卡（幂等） |
| POST | `/api/excuse` | 请假 `{reason, date?}`，可补最近 7 天 |
| GET/PUT | `/api/settings` | 读写个人截止时间；同时返回 `skipDates` |
| PUT | `/api/account` | 改自己的用户名/密码 |

### 排行榜与日历

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/leaderboard?period=all\|week\|month&limit=200` | 榜单，行内含 `score / streak / friendship / canNudge / todayStatus` |
| GET | `/api/user/calendar?days=30` | 近 N 天（7–90）状态，`items[]` + `summary` |

### 好友与催打卡

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/friends/request` | `{username}` 或 `{userId}` 发起申请；对方已申请则自动互加 |
| POST | `/api/friends/accept` | 同意申请（传申请人 `username`/`userId`） |
| GET | `/api/friends/list` | `{friends, incoming, outgoing, counts}` |
| POST | `/api/nudge/:username` | 催打卡：**必须是 accepted 好友**，否则 403；对方已打卡 400；10 分钟内重复 429 |

### 管理员

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/users` | 用户列表 + 今日状态 |
| POST | `/api/admin/users/:id/reset` | 重置某人打卡 `{date?, resetStreak?}` |
| PUT | `/api/admin/settings` | `{defaultDeadline?, skipDates?}` |
| POST | `/api/admin/set-skip-dates` | `{dates: "2026-12-25,2027-01-01"}` 或数组 |

`/api/status` 返回示例：

```json
{
  "today": "2026-11-18",
  "timezone": "Asia/Shanghai",
  "status": "pending",
  "statusLabel": "待打卡",
  "isSkipDay": false,
  "nextSkipDate": "2026-12-25",
  "streak": 21,
  "bestStreak": 30,
  "totalCheckins": 42,
  "blocked": false,
  "deadlinePassed": false,
  "secondsUntilDeadline": 42600,
  "nudges": [{ "id": 3, "from": "小满", "createdAt": "2026-11-18T09:00:00.000Z" }]
}
```

`status` 取值：`pending` / `done` / `late` / `excused` / `missed` / `holiday`。

---

## 四、Web 管理端

- 登录/注册；赛博深色 UI（霓虹描边、等宽数字、网格底纹）
- 今日状态卡：状态、连胜、最佳、累计、倒计时；免打卡日显示紫色横幅
- 一键打卡 / 请假
- 排行榜：**总榜 / 周榜 / 月榜**切换，前三奖牌，自己高亮
- 排行榜「互动」列（与 App 一致）：
  - 今天未打卡且不是自己 → 不是好友显示「加好友」（空心），好友显示「催一下」（实心发光）
  - 对方已申请你 → 「同意」；你已申请 → 「已申请」；已打卡/请假/自己 → 不显示按钮
- 设置页「我的好友」：好友列表、待处理申请（可直接同意）、好友的今日状态与催打卡
- 管理员：每行「重置」按钮；「设置 → 系统设置」可改默认截止时间和**免打卡日**
- 普通用户可在设置里改自己的截止时间、免打卡日列表、账号密码

> 页面本身走 `Cache-Control: no-cache`，改完刷新即可；若仍是旧页面请 `Ctrl+F5` 强刷。

---

## 五、App 端要点（`app/App.js`）

1. **赛博主题**：`#0A0E17` 深色底、`#1E1E24` 卡片、`#00E5FF` / `#B388FF` 霓虹描边与 `shadow` 发光；数字统一等宽字体。
2. **强制北京时间**：`beijingToday()` 用 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })` 取日期，缺 tz 数据时退回 UTC+8 手算，绝不读手机本地时区。
3. **二次确认**：点打卡先弹自定义 `ConfirmModal`（不是原生 Alert），文案「今天是 YYYY-MM-DD（北京时间），确定要打卡吗？」。
4. **打卡成功 Toast**：从屏幕顶部滑入的深色半透明 + 青色边框提示，随机励志语录。
5. **底部三 Tab**：打卡 / 排行榜 / 个人主页；选中项青色高亮 + 顶部指示条。
6. **排行榜**：总榜/周榜/月榜；🥇🥈🥉；自己青色边框；未打卡的非自己用户显示「加好友」（空心）或「催一下」（实心发光）。
7. **个人主页**：30 天热力图（绿=打卡、黄=请假、灰=漏签、青=免打卡）+ 我的好友 + 待处理申请。
8. **强提醒**：进入 App 请求通知权限；按截止时间注册「提前 15 分钟」+「到点」两条每日本地通知（Android MAX 渠道）。
9. **强制阻断**：`blocked=true` 时全屏 Modal 无法关闭，提交借口后才消失。
10. **点通知**：冷启动/热启动都会回到打卡页并刷新状态。

---

## 六、数据库变更（v1 → v2）

完整 SQL 见 [`server/migrations/002_v2_friends_skipdates.sql`](server/migrations/002_v2_friends_skipdates.sql)，服务启动时也会自动做同样的幂等迁移。

```sql
-- 好友关系
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

-- 催打卡记录
CREATE TABLE IF NOT EXISTS nudges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_friends_user   ON friends (user_id, status);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends (friend_id, status);
CREATE INDEX IF NOT EXISTS idx_nudges_to_date ON nudges (to_user_id, date);

-- settings 是 KV 表，新增的是一行
INSERT OR IGNORE INTO settings (key, value) VALUES ('skip_dates', '');
DELETE FROM settings WHERE key = 'timezone';   -- 时区已强制，旧配置清理
```

`users` / `checkins` / `excuses` / `audit_log` 结构不变；周榜月榜与热力图都由现有表实时推导，不需要新表。

升级已有库：

```bash
pm2 stop checkin-api
sqlite3 data/checkin.db < migrations/002_v2_friends_skipdates.sql   # 可选，直接启动也会自动迁移
pm2 start checkin-api
```

---

## 七、部署到云服务器

Ubuntu 22.04 为例。

```bash
# 1) Node
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 sqlite3 nginx

# 2) 上传（本地执行，排除 node_modules/data/.env）
rsync -avz --exclude node_modules --exclude data --exclude .env \
  ./server/ user@1.2.3.4:/opt/qiangzhi/server/
rsync -avz ./deploy/ user@1.2.3.4:/opt/qiangzhi/deploy/

# 3) 依赖 + 环境变量
cd /opt/qiangzhi/server
npm install --omit=dev
cp .env.example .env && nano .env      # JWT_SECRET / ADMIN_PASSWORD 必改

# 4) PM2（SQLite 必须单实例，不要 cluster）
sudo npm i -g pm2
sudo mkdir -p /var/log/qiangzhi && sudo chown -R $USER:$USER /var/log/qiangzhi
pm2 start /opt/qiangzhi/deploy/ecosystem.config.js
pm2 save && pm2 startup

# 5) Nginx + HTTPS
sudo cp /opt/qiangzhi/deploy/nginx.conf.example /etc/nginx/sites-available/checkin.conf
sudo ln -s /etc/nginx/sites-available/checkin.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d checkin.example.com

# 6) 防火墙：只放 22/80/443
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

备份（每天 4 点）：

```cron
0 4 * * * sqlite3 /opt/qiangzhi/data/checkin.db ".backup '/opt/qiangzhi/backup/checkin-$(date +\%F).db'"
```

App 打包时把 `.env` 的 `EXPO_PUBLIC_API_BASE` 改成 `https://checkin.example.com`。

---

## 八、联调排错

**手机连不上后端**
1. 手机浏览器访问 `http://<电脑IP>:3000/api/health`；
2. 检查同一 Wi-Fi、Windows 防火墙放行 3000；
3. Windows：`netsh advfirewall firewall add rule name="node3000" dir=in action=allow protocol=TCP localport=3000`。

**通知不弹**
- 系统允许通知；Android 12+ 允许「闹钟和提醒」，关闭电池优化、允许自启动；
- iOS 用真机，模拟器不可靠；
- App 内「发一条测试通知」验证链路。

**时间对不上**
- 服务端固定北京时间；手机时区若不在东八区，App 顶部日期仍显示北京时间（用 Intl 生成）；
- 本地通知按手机本地时间触发，建议手机时区也设为北京，避免“提醒早了/晚了”。

**好友按钮不出现**
- 只有「今天未打卡且不是自己」的行才显示加好友/催一下；
- 「催一下」要求 accepted 好友，且不在免打卡日、对方确实没打卡。

**忘记管理员密码**

```bash
cd /opt/qiangzhi/server
node scripts/reset-password.mjs admin 新密码
```

**清空重来**

```bash
pm2 stop checkin-api && rm -f /opt/qiangzhi/data/checkin.db* && pm2 start checkin-api
```

---

## 九、安全与限制

- 密码 `scrypt` 加盐哈希；JWT 7 天过期；登录限流（同 IP+账号 15 分钟 10 次）。
- 催打卡严格的 403 校验 + 10 分钟冷却，防止骚扰。
- SQLite 适合单机、千级用户；横向扩容需换 PostgreSQL/MySQL。
- 通知是**本地通知**，不依赖推送服务；受系统省电策略影响可能延迟。
- 生产必改：`JWT_SECRET`、管理员密码、开 HTTPS、只暴露 80/443。
