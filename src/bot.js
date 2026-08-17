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
import { createRoom, getRoom, listRooms, roomEvents } from './rooms.js';
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

  client.once(Events.ClientReady, (c) => {
    console.log(`[bot] logged in as ${c.user.tag}`);
    startVoiceRosterUpdater(c);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'telinha') return;
    try {
      await handleTelinha(interaction);
    } catch (err) {
      console.error('[bot] /telinha failed:', err);
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

// Mirrors "who is in the room's voice channel right now" into room.voiceRoster
// (RAM only) so the web join screen can offer a click-your-own-face picker.
function rosterFromChannel(channel) {
  return [...channel.members.values()].slice(0, 20).map((m) => ({
    name: m.displayName.slice(0, 32),
    avatarUrl: m.displayAvatarURL({ size: 128, extension: 'png' }),
  }));
}

let rosterTimer = null;

function startVoiceRosterUpdater(client) {
  clearInterval(rosterTimer);
  rosterTimer = setInterval(() => {
    for (const room of listRooms()) {
      if (!room.voiceChannelId) continue;
      const channel = client.channels.cache.get(room.voiceChannelId);
      if (channel?.isVoiceBased?.()) room.voiceRoster = rosterFromChannel(channel);
    }
  }, 10_000);
  rosterTimer.unref?.();
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
    // Nobody sharing anymore — the room itself stays open.
    const entry = tracked.get(roomId);
    if (!entry) return;
    entry.state = 'idle';
    clearInterval(entry.timer);
    entry.timer = null;
    refreshEmbed(roomId);
  });

  roomEvents.on('closed', (roomId) => {
    const entry = tracked.get(roomId);
    if (!entry) return;
    clearInterval(entry.timer);
    const shell = { id: roomId, name: entry.roomName, game: null, gameIconUrl: null, participants: new Map() };
    entry.message.edit({ embeds: [buildEmbed(shell, entry.user, 'closed')], components: [] }).catch(() => {});
    entry.message.unpin().catch(() => {});
    tracked.delete(roomId);
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

async function handleTelinha(interaction) {
  const game = detectGame(interaction.member?.presence);
  const title =
    interaction.options.getString('nome') ??
    interaction.member?.voice?.channel?.name ??
    (game ? game.name : null) ??
    `sala de ${interaction.user.displayName}`;

  const voiceChannel = interaction.member?.voice?.channel ?? null;
  const room = createRoom(title, {
    voiceChannelId: voiceChannel?.id ?? null,
    guildId: interaction.guildId ?? null,
  });
  room.game = game?.name ?? null;
  room.gameIconUrl = game?.iconUrl ?? null;
  if (voiceChannel) room.voiceRoster = rosterFromChannel(voiceChannel);
  const { roomUrl, ownerUrl } = describeRoom(room, true);

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [
      '**Seu link de dono** — com ele você pode encerrar a sala (não compartilhe):',
      ownerUrl,
      '',
      `Link da galera (todo mundo pode compartilhar a tela): ${roomUrl}`,
      game ? `\n🎮 Jogo detectado: **${game.name}**` : '',
    ].join('\n'),
  });

  if (!interaction.channel) return;

  const message = await interaction.channel.send({
    embeds: [buildEmbed(room, interaction.user, 'waiting')],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('▶ Entrar na sala').setURL(roomUrl),
      ),
    ],
  });

  // Pin needs Manage Messages — skip quietly if the bot doesn't have it.
  message.pin().catch(() => {});

  tracked.set(room.id, { message, user: interaction.user, timer: null, state: 'waiting', roomName: room.name });
}

function buildEmbed(room, user, state) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
    .setTitle(room.name)
    .setURL(`${BASE_URL}/room/${room.id}`);

  const playing = room.game ? `🎮 Jogando **${room.game}**\n` : '';
  if (room.gameIconUrl) embed.setThumbnail(room.gameIconUrl);

  if (state === 'waiting') {
    embed.setColor(0x8899aa).setDescription(`${playing}🚪 Sala aberta — entra aí, qualquer um pode compartilhar a tela.`);
  } else if (state === 'live') {
    embed.setColor(0xed4245).setDescription(`${playing}🔴 **AO VIVO** — clica em *Entrar na sala* pra assistir`);
    embed.setFooter({ text: `${room.participants.size} na sala` });
    // Discord fetches this URL itself, so it only works with a public BASE_URL;
    // the ?t= cache-buster changes with each new thumbnail upload.
    if (room.thumbnailAt && !/localhost|127\.0\.0\.1/.test(BASE_URL)) {
      embed.setImage(`${BASE_URL}/thumbs/${room.id}.jpg?t=${room.thumbnailAt}`);
    }
  } else if (state === 'closed') {
    embed.setColor(0x555555).setDescription('🚪 Sala encerrada pelo dono. Valeu!');
  } else {
    embed.setColor(0x555555).setDescription(`${playing}⏸️ Ninguém compartilhando agora — a sala segue aberta.`);
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
