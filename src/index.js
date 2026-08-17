try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on real environment variables
}

// server.js reads env at import time, so load it dynamically after the env is set up.
await import('./server.js');

if (process.env.DISCORD_TOKEN) {
  const { startBot } = await import('./bot.js');
  startBot();
} else {
  console.log('[bot] DISCORD_TOKEN not set — running in web-only mode');
}
