import { SlashCommandBuilder } from 'discord.js';

export const commandData = [
  new SlashCommandBuilder()
    .setName('screenshare')
    .setDescription('Create a screenshare room and post the watch link in this channel')
    .addStringOption((o) =>
      o.setName('title').setDescription('Stream title (defaults to your voice channel name)').setRequired(false),
    )
    .toJSON(),
];
