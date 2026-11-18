/**
 * 重置某个用户的登录密码（含管理员）——忘记密码时用
 *
 * 用法：
 *   node scripts/reset-password.mjs admin 新密码
 *   DB_PATH=/opt/qiangzhi/data/checkin.db node scripts/reset-password.mjs admin 新密码
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('用法：node scripts/reset-password.mjs <用户名> <新密码>');
  process.exit(1);
}
if (password.length < 6 || password.length > 72) {
  console.error('密码长度需为 6-72 位');
  process.exit(1);
}

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(process.cwd(), 'data', 'checkin.db');

if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);
const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);

if (!user) {
  console.error(`用户不存在：${username}`);
  db.close();
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');

db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
  `scrypt$${salt}$${hash}`,
  new Date().toISOString(),
  user.id
);

console.log(`✓ 已重置用户「${user.username}」的密码（id=${user.id}）`);
db.close();
