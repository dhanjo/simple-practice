module.exports = {
  apps: [
    {
      name: 'simple-practice-api',
      script: 'npx',
      args: 'tsx src/server.ts',
      cwd: __dirname,
      instances: 1, // Must be 1 — only one browser session at a time
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 15000, // 15s to allow test to finish
      listen_timeout: 10000,
    },
  ],
};

