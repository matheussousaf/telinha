import { REST, Routes } from 'discord.js';
import { commandData } from './commands.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on real environment variables
}

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_CLIENT_ID;
if (!token || !appId) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env first (see .env.example).');
  process.exit(1);
}

const rest = new REST().setToken(token);
const route = process.env.GUILD_ID
  ? Routes.applicationGuildCommands(appId, process.env.GUILD_ID)
  : Routes.applicationCommands(appId);

await rest.put(route, { body: commandData });
console.log(
  process.env.GUILD_ID
    ? `Registered ${commandData.length} command(s) in guild ${process.env.GUILD_ID}.`
    : `Registered ${commandData.length} global command(s) — can take up to an hour to appear.`,
);
