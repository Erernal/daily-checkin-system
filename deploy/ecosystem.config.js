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
        // 不要把真实密钥提交到仓库：启动前 export，或改用 pm2 的 env 文件
        //   export JWT_SECRET=$(openssl rand -hex 32)
        JWT_SECRET: process.env.JWT_SECRET || 'CHANGE_ME_openssl_rand_hex_32',
        JWT_EXPIRES_IN: '7d',
        APP_TIMEZONE: 'Asia/Shanghai',
        DEFAULT_DEADLINE: '22:00',
        ADMIN_USERNAME: 'admin',
        // 留空则首次建号时随机生成，并只打印一次
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
        TRUST_PROXY: 'true',
      },
    },
  ],
};
