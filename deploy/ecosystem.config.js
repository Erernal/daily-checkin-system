// PM2 进程配置：在服务器上执行  pm2 start deploy/ecosystem.config.js
// 注意：SQLite 是单写者数据库，务必保持 单实例 + fork 模式，不要用 cluster。
module.exports = {
  apps: [
    {
      name: 'checkin-api',
      cwd: '/opt/qiangzhi/server',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      time: true,
      out_file: '/var/log/qiangzhi/out.log',
      error_file: '/var/log/qiangzhi/err.log',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '127.0.0.1', // 只监听本机，由 Nginx 对外
        DB_PATH: '/opt/qiangzhi/data/checkin.db',
        JWT_SECRET: 'REPLACE_WITH_openssl_rand_hex_32',
        JWT_EXPIRES_IN: '7d',
        APP_TIMEZONE: 'Asia/Shanghai',
        DEFAULT_DEADLINE: '22:00',
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: 'admin123',
        TRUST_PROXY: 'true',
      },
    },
  ],
};
