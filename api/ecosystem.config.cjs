module.exports = {
  apps: [
    {
      // `bun run serve`: runs the TypeScript sources directly (Node strips the types) and restarts on change
      name: 'development',
      script: 'src/server.ts',
      interpreter: 'node',
      node_args: '--env-file-if-exists=.env',
      max_memory_restart: '512M',
      autorestart: true,
      kill_timeout: 10000,
    },
    {
      // `bun run start`: run `bun run build` first
      name: 'production',
      script: 'build/server.js',
      interpreter: 'node',
      node_args: '--env-file-if-exists=.env',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      autorestart: true,
      kill_timeout: 10000, // time for the graceful shutdown (sockets closed, SQLite checkpointed)
    },
  ],
};
