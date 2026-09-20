module.exports = {
  apps: [
    {
      name: "whatsapp-assistant-bridge",
      script: "index.js",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
