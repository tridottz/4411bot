import { SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

import birthdaySet from './modules/birthday_set.js';
import birthdayInfo from './modules/birthday_info.js';
import birthdayList from './modules/birthday_list.js';
import birthdayRemove from './modules/birthday_remove.js';
import nextBirthdays from './modules/next_birthdays.js';
import birthdaySetchannel from './modules/birthday_setchannel.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
export default {
    data: new SlashCommandBuilder()
        .setName('cumpleaños')
        .setDescription('Comandos del sistema de cumples')
        .addSubcommand(subcommand =>
            subcommand
                .setName('establecer')
                .setDescription('Establece tu fecha de cumple')
                .addIntegerOption(option =>
                    option
                        .setName('mes')
                        .setDescription('Mes de tu cumple (1-12)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(12)
                )
                .addIntegerOption(option =>
                    option
                        .setName('día')
                        .setDescription('Dia de tu cumple (1-31)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(31)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('información')
                .setDescription('Ver información de cumpleaños')
                .addUserOption(option =>
                    option
                        .setName('usuario')
                        .setDescription('Revisa el cumple de un usuario')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('lista')
                .setDescription('La lista de cumpleaños del servidor!')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('borrar')
                .setDescription('Quita tu cumpleaños')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('cercanos')
                .setDescription('Ver los cumpleaños más cercanos')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('canal')
                .setDescription('Establece o desactiva los cumpleaños. (Manage Server required)')
                .addChannelOption(option =>
                    option
                        .setName('canal')
                        .setDescription('Eo canal de texto para estos anuncios. Déjalo vacío para eliminarlo.')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false)
                )
        ),

    async execute(interaction, config, client) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'establecer':
                return await birthdaySet.execute(interaction, config, client);
            case 'información':
                return await birthdayInfo.execute(interaction, config, client);
            case 'lista':
                return await birthdayList.execute(interaction, config, client);
            case 'borrar':
                return await birthdayRemove.execute(interaction, config, client);
            case 'cercanos':
                return await nextBirthdays.execute(interaction, config, client);
            case 'canal':
                return await birthdaySetchannel.execute(interaction, config, client);
            default:
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Unknown subcommand' });
        }
    }
};