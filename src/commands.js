import { SlashCommandBuilder } from 'discord.js';

export const commandData = [
  new SlashCommandBuilder()
    .setName('telinha')
    .setDescription('Cria uma sala de screenshare com o nome do seu canal de voz')
    .addStringOption((o) =>
      o.setName('nome').setDescription('Nome da sala (padrão: seu canal de voz)').setRequired(false),
    )
    .toJSON(),
];
