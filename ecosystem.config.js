module.exports = {
  apps: [
    {
      name: 'sol-token-sniper',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      },
      // Error and out logs
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      // Merge logs
      merge_logs: true,
      // Time format for logs
      time: true,
      // Restart delay
      restart_delay: 4000,
      // Watch and ignore patterns for the database
      watch_delay: 1000,
      ignore_watch: [
        "node_modules",
        "logs",
        "*.log",
        "*.db",
        "*.db-journal"
      ],
      // Ensure clean shutdown
      kill_timeout: 3000,
      wait_ready: true,
      listen_timeout: 5000,
    },
    // {
    //   name: 'sol-token-sniper-tracker',
    //   script: './dist/tracker/index.js',
    //   instances: 1,
    //   autorestart: true,
    //   watch: false,
    //   max_memory_restart: '1G',
    //   env: {
    //     NODE_ENV: 'production'
    //   },
    //   env_development: {
    //     NODE_ENV: 'development'
    //   },
    //   // Error and out logs
    //   error_file: 'logs/error.log',
    //   out_file: 'logs/out.log',
    //   // Merge logs
    //   merge_logs: true,
    //   // Time format for logs
    //   time: true,
    //   // Restart delay
    //   restart_delay: 4000
    // }
  ]
}; 
