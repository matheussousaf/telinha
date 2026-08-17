import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';
import { createRoom, getRoom, roomEvents } from './rooms.js';
import { notifyRoomInfo } from './signaling.js';
import { BASE_URL, describeRoom } from './server.js';

const EMBED_REFRESH_MS = 20_000;

// roomId -> { message, user, timer, state: 'waiting' | 'live' | 'ended' }
const tracked = new Map();

export function startBot() {
  wireRoomEvents();

  // GuildPresences is a privileged intent — it powers game detection but must be
  // enabled in the developer portal (Bot → Privileged Gateway Intents). If it
  // isn't, fall back to running without it instead of crashing.
  const client = createClient([GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildPresences]);
  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    if (!/disallowed intents/i.test(err.message)) {
      console.error('[bot] login failed:', err.message);
      return;
    }
    console.warn(
      '[bot] Presence Intent is not enabled in the developer portal — starting WITHOUT game detection.\n' +
        '[bot] Enable it (your app → Bot → Privileged Gateway Intents → Presence Intent), then restart.',
    );
    client.destroy();
    createClient([GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates])
      .login(process.env.DISCORD_TOKEN)
      .catch((err2) => console.error('[bot] login failed:', err2.message));
  });
}

function createClient(intents) {
  const client = new Client({ intents });

  client.once(Events.ClientReady, (c) => console.log(`[bot] logged in as ${c.user.tag}`));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'screenshare') return;
    try {
      await handleScreenshare(interaction);
    } catch (err) {
      console.error('[bot] /screenshare failed:', err);
    }
  });

  // Keep the detected game fresh while a room is tracked: if the streamer
  // switches games (or stops playing), update the room, the embed, and every
  // connected page.
  client.on(Events.PresenceUpdate, (_old, presence) => {
    for (const [roomId, entry] of tracked) {
      if (entry.user.id !== presence.userId) continue;
      const room = getRoom(roomId);
      if (!room) continue;
      const game = detectGame(presence);
      if ((game?.name ?? null) === room.game) continue;
      room.game = game?.name ?? null;
      room.gameIconUrl = game?.iconUrl ?? null;
      notifyRoomInfo(room);
      refreshEmbed(roomId);
    }
  });

  return client;
}

let roomEventsWired = false;

function wireRoomEvents() {
  if (roomEventsWired) return; // guard against double-registration on intent fallback
  roomEventsWired = true;

  roomEvents.on('live', (roomId) => {
    const entry = tracked.get(roomId);
    if (!entry) return;
    entry.state = 'live';
    clearInterval(entry.timer);
    entry.timer = setInterval(() => refreshEmbed(roomId), EMBED_REFRESH_MS);
    refreshEmbed(roomId);
  });

  roomEvents.on('ended', (roomId) => {
    const entry = tracked.get(roomId);
    if (!entry) return;
    entry.state = 'ended';
    clearInterval(entry.timer);
    entry.timer = null;
    refreshEmbed(roomId);
    entry.message.unpin().catch(() => {});
  });
}

// Reads Discord's own client-side game detection from the member's presence.
// Returns null if the user isn't playing, hides their activity, or the
// Presence Intent isn't enabled.
function detectGame(presence) {
  const activity = presence?.activities?.find((a) => a.type === ActivityType.Playing);
  if (!activity) return null;
  let iconUrl = null;
  try {
    iconUrl = activity.assets?.largeImageURL({ size: 256 }) ?? null;
  } catch {
    // some rich-presence assets don't resolve to a CDN URL — fine without
  }
  return { name: activity.name, iconUrl };
}

async function handleScreenshare(interaction) {
  const game = detectGame(interaction.member?.presence);
  const title =
    interaction.options.getString('title') ??
    (game ? game.name : null) ??
    interaction.member?.voice?.channel?.name ??
    `${interaction.user.displayName}'s screen`;

  const room = createRoom(title);
  room.game = game?.name ?? null;
  room.gameIconUrl = game?.iconUrl ?? null;
  const { watchUrl, shareUrl } = describeRoom(room, true);

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [
      '**Your streamer link** — keep it to yourself, anyone with it can broadcast:',
      shareUrl,
      '',
      `Friends watch at: ${watchUrl}`,
      game ? `\n🎮 Detected game: **${game.name}**` : '',
    ].join('\n'),
  });

  if (!interaction.channel) return;

  const message = await interaction.channel.send({
    embeds: [buildEmbed(room, interaction.user, 'waiting')],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('▶ Watch live').setURL(watchUrl),
      ),
    ],
  });

  // Pin needs Manage Messages — skip quietly if the bot doesn't have it.
  message.pin().catch(() => {});

  tracked.set(room.id, { message, user: interaction.user, timer: null, state: 'waiting' });
}

function buildEmbed(room, user, state) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
    .setTitle(room.name)
    .setURL(`${BASE_URL}/watch/${room.id}`);

  const playing = room.game ? `🎮 Playing **${room.game}**\n` : '';
  if (room.gameIconUrl) embed.setThumbnail(room.gameIconUrl);

  if (state === 'waiting') {
    embed.setColor(0x8899aa).setDescription(`${playing}⏳ Waiting for the stream to start…`);
  } else if (state === 'live') {
    embed.setColor(0xed4245).setDescription(`${playing}🔴 **LIVE** — click *Watch live* to open the stream`);
    embed.setFooter({ text: `${room.viewers.size} watching` });
    // Discord fetches this URL itself, so it only works with a public BASE_URL;
    // the ?t= cache-buster changes with each new thumbnail upload.
    if (room.thumbnailAt && !/localhost|127\.0\.0\.1/.test(BASE_URL)) {
      embed.setImage(`${BASE_URL}/thumbs/${room.id}.jpg?t=${room.thumbnailAt}`);
    }
  } else {
    embed.setColor(0x555555).setDescription(`${playing}⏹️ Stream ended.`);
  }
  return embed;
}

async function refreshEmbed(roomId) {
  const entry = tracked.get(roomId);
  const room = getRoom(roomId);
  if (!entry || !room) return;
  try {
    await entry.message.edit({ embeds: [buildEmbed(room, entry.user, entry.state)] });
  } catch (err) {
    // Message deleted or channel gone — stop tracking this room.
    clearInterval(entry.timer);
    tracked.delete(roomId);
    console.warn(`[bot] stopped tracking room ${roomId}: ${err.message}`);
  }
}
