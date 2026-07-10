// PM2 config for the 24/7 monitor.
//   pm2 start ecosystem.config.cjs
//   pm2 logs cc-monitor      (watch output)
//   pm2 restart cc-monitor   (e.g. after re-login)
//   pm2 save                 (persist across reboots)
//
// Runs monitor-loop.mjs, which itself runs a monitor cycle every 15 minutes.
// PM2 keeps that loop process alive and restarts it if it ever crashes.
module.exports = {
  apps: [
    {
      name: 'cc-monitor',
      script: 'monitor-loop.mjs',
      cwd: __dirname,
      // extra args go to every cycle, e.g.: args: '--threshold 0.8 --min-change 0.01'
      args: '',
      autorestart: true,      // restart if the loop process dies
      restart_delay: 5000,    // wait 5s before restarting
      max_restarts: 100,
      out_file: 'logs/monitor-out.log',
      error_file: 'logs/monitor-err.log',
      time: true,             // timestamp each log line
    },
  ],
}
