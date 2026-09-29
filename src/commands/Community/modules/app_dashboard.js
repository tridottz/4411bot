import { getColor, getDefaultApplicationQuestions, botConfig } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
    LabelBuilder,
    CheckboxBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { safeDeferInteraction } from '../../../utils/interactionValidator.js';
import {
    getApplicationSettings,
    saveApplicationSettings,
    getApplicationRoles,
    saveApplicationRoles,
    getApplicationRoleSettings,
    saveApplicationRoleSettings,
    deleteApplicationRoleSettings,
    getApplications,
    deleteApplication,
} from '../../../utils/database.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { setLogChannel, resolveApplicationLogChannel, resolveLogChannel } from '../../../services/loggingService.js';

async function buildDashboardEmbed(settings, roles, guild, client) {
    const guildConfig = await getGuildConfig(client, guild.id);
    const applicationsChannel = resolveLogChannel(guildConfig, 'applications') || settings.logChannelId;
    const logChannel = applicationsChannel ? `<#${applicationsChannel}>` : '`Sin configurar`';
    const managerRoleList =
        settings.managerRoles?.length > 0
            ? settings.managerRoles.map(id => `<@&${id}>`).join(',')
            : '`Ninguno configurado`';
    const roleList =
        roles.length > 0
            ? roles.map(r => `<@&${r.roleId}> — ${r.name}`).join('\n')
            : '`No hay roles de postulación configurados`';
    const questionCount = settings.questions?.length ?? 0;
    const firstQ =
        settings.questions?.[0]
            ? `\`${settings.questions[0].length > 55 ? settings.questions[0].substring(0, 55) + '…' : settings.questions[0]}\``
            : '`Sin configurar`';

    return new EmbedBuilder()
        .setTitle('Panel de postulaciones')
        .setDescription(`Administra la configuración de postulaciones de **${guild.name}**.\nSelecciona una opción abajo para modificarla.`)
        .setColor(getColor('info'))
        .addFields(
            { name: 'Estado de postulaciones', value: settings.enabled ? 'Activadas' : 'Desactivadas', inline: true },
            { name: 'Canal de registros', value: logChannel, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Roles de gestión', value: managerRoleList, inline: false },
            { name: 'Preguntas', value: `${questionCount} configuradas — primera: ${firstQ}`, inline: false },
            { name: 'Roles de postulación', value: roleList, inline: false },
            {
                name: 'Retención',
                value: `Pendientes: **${settings.pendingApplicationRetentionDays ?? 30}d** · Revisadas: **${settings.reviewedApplicationRetentionDays ?? 14}d**`,
                inline: false,
            },
        )
        .setFooter({ text: 'El panel se cierra tras 15 minutos de inactividad' })
        .setTimestamp();
}

function buildSelectMenu(guildId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`app_cfg_${guildId}`)
        .setPlaceholder('Selecciona un ajuste para configurar...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Canal de registros')
                .setDescription('Define el canal donde se registran las nuevas postulaciones')
                .setValue('log_channel')
                .setEmoji('📢'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Roles de gestión')
                .setDescription('Agrega o quita un rol que puede gestionar postulaciones')
                .setValue('manager_role')
                .setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Editar preguntas')
                .setDescription('Personaliza las preguntas del formulario de postulación')
                .setValue('questions')
                .setEmoji('📝'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Agregar rol de postulación')
                .setDescription('Agrega un rol al que los miembros pueden postularse')
                .setValue('role_add')
                .setEmoji('➕'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Quitar rol de postulación')
                .setDescription('Quita un rol de la lista de postulaciones')
                .setValue('role_remove')
                .setEmoji('➖'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Período de retención')
                .setDescription('Define cuánto se guardan las postulaciones pendientes y revisadas')
                .setValue('retention')
                .setEmoji('🗑️'),
        );
}

function buildButtonRow(settings, guildId, disabled = false) {
    const systemOn = settings.enabled === true;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_cfg_toggle_${guildId}`)
            .setLabel('Postulaciones')
            .setStyle(systemOn ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

async function refreshDashboard(rootInteraction, settings, roles, guildId, client) {
    const selectMenu = buildSelectMenu(guildId);
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [await buildDashboardEmbed(settings, roles, rootInteraction.guild, client)],
        components: [
            buildButtonRow(settings, guildId),
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    }).catch(() => {});
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client, selectedAppName = null) {
        try {
            const guildId = interaction.guild.id;

            await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });

            const [settings, roles] = await Promise.all([
                getApplicationSettings(client, guildId),
                getApplicationRoles(client, guildId),
            ]);

            const guildConfig = await getGuildConfig(client, guildId);
            const applicationsChannel = resolveLogChannel(guildConfig, 'applications') || settings.logChannelId;

            const isCompletelyUnconfigured = 
                !applicationsChannel && 
                !settings.enabled && 
                (settings.managerRoles?.length ?? 0) === 0 && 
                roles.length === 0;

            if (isCompletelyUnconfigured) {
                throw new TitanBotError(
                    'Applications system not set up',
                    ErrorTypes.CONFIGURATION,
                    'El sistema de postulaciones aún no está configurado. Usa `/app-admin establecer` para crear tu primera postulación.',
                );
            }

            if (roles.length === 0) {
                await showGlobalDashboard(interaction, settings, roles, guildId, client);
                return;
            }

            if (selectedAppName) {
                const selectedRole = roles.find(r => r.name.toLowerCase() === selectedAppName.toLowerCase());
                if (selectedRole) {
                    await showApplicationDashboard(interaction, selectedRole, settings, roles, guildId, client);
                    return;
                }
                
            }

            const defaultRole = roles[0];
            await showApplicationDashboard(interaction, defaultRole, settings, roles, guildId, client);

        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in app_dashboard:', error);
            throw new TitanBotError(
                `Applications dashboard failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'No se pudo abrir el panel de postulaciones.',
            );
        }
    },
};

async function showApplicationSelector(interaction, roles, settings, guildId, client) {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`app_select_${guildId}`)
        .setPlaceholder('Selecciona una postulación para configurar...')
        .addOptions(
            roles.map(role =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(role.name)
                    .setDescription(`Configurar la postulación ${role.name}`)
                    .setValue(role.roleId)
                    .setEmoji('📋'),
            ),
        );

    const embed = new EmbedBuilder()
        .setTitle('Seleccionar postulación')
        .setDescription('Elige qué rol de postulación quieres configurar.')
        .setColor(getColor('info'));

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(selectMenu)],
    });

    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === interaction.user.id && i.customId === `app_select_${guildId}`,
        time: 600_000,
        max: 1,
    });

    collector.on('collect', async selectInteraction => {
        const deferred = await safeDeferInteraction(selectInteraction);
        if (!deferred) return;
        
        const selectedRoleId = selectInteraction.values[0];
        const selectedRole = roles.find(r => r.roleId === selectedRoleId);

        if (selectedRole) {
            await showApplicationDashboard(interaction, selectedRole, settings, roles, guildId, client);
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(interaction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No se hizo ninguna selección. El panel se cerró.',
            }).catch(() => {});
        }
    });
}

async function showGlobalDashboard(interaction, settings, roles, guildId, client) {
    const selectMenu = buildSelectMenu(guildId);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [await buildDashboardEmbed(settings, roles, interaction.guild, client)],
        components: [
            buildButtonRow(settings, guildId),
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    });

    setupCollectors(interaction, settings, roles, guildId, client, null);
}

async function showApplicationDashboard(rootInteraction, selectedRole, settings, roles, guildId, client) {
    const roleObj = rootInteraction.guild.roles.cache.get(selectedRole.roleId);

    const guildConfig = await getGuildConfig(client, guildId);
    const appSettings = await getApplicationRoleSettings(client, guildId, selectedRole.roleId);
    const questions = appSettings.questions || settings.questions || [];
    const appLogChannelId = resolveApplicationLogChannel(guildConfig, appSettings, settings);
    const isEnabled = selectedRole.enabled !== false; 

    const logChannelDisplay = appLogChannelId 
        ? `<#${appLogChannelId}>` 
        : '`Usa el canal de registros global`';
    
    const questionsDisplay = questions.length > 0
        ? questions.map((q, i) => `${i + 1}. \`${q.length > 60 ? q.substring(0, 60) + '…' : q}\``).join('\n')
        : '`Usa las preguntas globales`';
    
    const managerRolesDisplay = settings.managerRoles && settings.managerRoles.length > 0
        ? settings.managerRoles.map(id => `<@&${id}>`).join(',')
        : '`Ninguno configurado`';

    const embed = new EmbedBuilder()
        .setTitle('📋 Panel de postulación')
        .setDescription(`Configuración de **${selectedRole.name}**`)
        .setColor(isEnabled ? getColor('success') : getColor('error'))
        .addFields(
            { 
                name: 'Rol', 
                value: roleObj ? roleObj.toString() : `<@&${selectedRole.roleId}>`, 
                inline: true 
            },
            { 
                name: 'Estado de la postulación', 
                value: isEnabled ? '✅ **Activada**' : '❌ **Desactivada**', 
                inline: true 
            },
            { name: '\u200B', value: '\u200B', inline: true },
            { 
                name: 'Preguntas', 
                value: questionsDisplay,
                inline: false 
            },
            { 
                name: 'Canal de registros', 
                value: logChannelDisplay,
                inline: true 
            },
            { 
                name: 'Roles de gestión',
                value: managerRolesDisplay,
                inline: true 
            },
            { 
                name: 'Período de retención',
                value: `Pendientes: **${settings.pendingApplicationRetentionDays ?? 30}d** · Revisadas: **${settings.reviewedApplicationRetentionDays ?? 14}d**`,
                inline: false 
            },
        )
        .setFooter({ text: 'El panel se cierra tras 10 minutos de inactividad' })
        .setTimestamp();

    const configMenu = buildApplicationSelectMenu(guildId, selectedRole.roleId);

    const controlButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_toggle_${selectedRole.roleId}`)
            .setLabel(isEnabled ? 'Desactivar postulación' : 'Activar postulación')
            .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`app_delete_${selectedRole.roleId}`)
            .setLabel('Eliminar postulación')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️'),
    );

    const menuRow = new ActionRowBuilder().addComponents(configMenu);

    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [embed],
        components: [menuRow, controlButtons],
    });

    setupCollectors(rootInteraction, settings, roles, guildId, client, selectedRole.roleId);
}

function setupCollectors(interaction, settings, roles, guildId, client, selectedRoleId) {
    const customIdPrefix = selectedRoleId ? `app_cfg_${selectedRoleId}` : `app_cfg_${guildId}`;
    
    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === interaction.user.id && 
            (selectedRoleId 
                ? i.customId === customIdPrefix
                : (i.customId === `app_cfg_${guildId}` || i.customId === `app_select_${guildId}`)),
        time: 600_000,
    });

    collector.on('collect', async selectInteraction => {
        const selectedOption = selectInteraction.values[0];
        try {
            
            if (!selectInteraction.isStringSelectMenu()) {
                return;
            }
            switch (selectedOption) {
                case 'log_channel':
                    await handleLogChannel(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'manager_role':
                    await handleManagerRole(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'questions':
                    await handleQuestions(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'role_add':
                    await handleRoleAdd(selectInteraction, interaction, settings, roles, guildId, client);
                    break;
                case 'role_remove':
                    await handleRoleRemove(selectInteraction, interaction, settings, roles, guildId, client);
                    break;
                case 'retention':
                    await handleRetention(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
            }
        } catch (error) {
            if (error instanceof TitanBotError) {
                logger.debug(`Applications config validation error: ${error.message}`);
            } else {
                logger.error('Unexpected applications dashboard error:', error);
            }

            const errorMessage =
                error instanceof TitanBotError
                    ? error.userMessage || 'Ocurrió un error al procesar tu selección.'
                    : 'Ocurrió un error inesperado al actualizar la configuración.';

            if (!selectInteraction.replied && !selectInteraction.deferred) {
                await safeDeferInteraction(selectInteraction);
            }

            await replyUserError(selectInteraction, {
                type: ErrorTypes.CONFIGURATION,
                message: errorMessage,
            }).catch(() => {});
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = new EmbedBuilder()
                .setTitle('\u23f0 Panel expirado')
                .setDescription('Este panel se cerró por inactividad. Vuelve a usar el comando para continuar.')
                .setColor(getColor('error'));
                
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [timeoutEmbed],
                components: [],
            }).catch(() => {});
        }
    });

    if (!selectedRoleId) {
        const globalToggleCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_cfg_toggle_${guildId}`,
            time: 600_000,
        });

        globalToggleCollector.on('collect', async toggleInteraction => {
            const deferred = await safeDeferInteraction(toggleInteraction);
            if (!deferred) return;
            
            try {
                const wasEnabled = settings.enabled === true;
                settings.enabled = !wasEnabled;

                await saveApplicationSettings(interaction.client, guildId, settings);

                const updatedSettings = await getApplicationSettings(interaction.client, guildId);
                const updatedRoles = await getApplicationRoles(interaction.client, guildId);
                await showGlobalDashboard(interaction, updatedSettings, updatedRoles, guildId, interaction.client);

                await toggleInteraction.followUp({
                    embeds: [successEmbed(
                        wasEnabled ? '🔴 Postulaciones desactivadas' : '🟢 Postulaciones activadas',
                        `El sistema de postulaciones ahora está **${wasEnabled ? 'desactivado' : 'activado'}**.\n\n${
                            wasEnabled 
                                ? 'Los miembros ya no podrán postularse a roles.' 
                                : 'Los miembros ya pueden postularse a roles.'
                        }`,
                    )],
                    flags: MessageFlags.Ephemeral,
                });

            } catch (error) {
                logger.error('Error toggling global application status:', error);
                await replyUserError(toggleInteraction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'Ocurrió un error al cambiar el estado de las postulaciones.',
                });
            }
        });

        globalToggleCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('Configuración expirada')
                    .setDescription('Esta sesión del panel expiró por inactividad (10 minutos).\n\nPara seguir configurando tus postulaciones, vuelve a usar el comando.')
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });
    }

    if (selectedRoleId) {
        const btnCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_delete_${selectedRoleId}`,
            time: 600_000,
        });

        btnCollector.on('collect', async btnInteraction => {
            
            const appRoleForDelete = roles.find(r => r.roleId === selectedRoleId);
            const appNameForDelete = appRoleForDelete?.name ?? 'esta postulación';

            const confirmModal = new ModalBuilder()
                .setCustomId('app_delete_confirm')
                .setTitle('Confirmar eliminación');

            const deleteWarningText = new TextDisplayBuilder()
                .setContent(`⚠️ Estás a punto de eliminar permanentemente **${appNameForDelete}**. Todas las postulaciones y ajustes guardados de este rol se borrarán y no se podrán recuperar.`);

            const deleteCheckbox = new CheckboxBuilder()
                .setCustomId('confirm_delete')
                .setDefault(false);

            const deleteCheckboxLabel = new LabelBuilder()
                .setLabel('Confirmo: esto no se puede deshacer')
                .setCheckboxComponent(deleteCheckbox);

            confirmModal
                .addTextDisplayComponents(deleteWarningText)
                .addLabelComponents(deleteCheckboxLabel);

            try {
                await btnInteraction.showModal(confirmModal);
            } catch (error) {
                logger.error('Error showing delete confirmation modal:', error);
                await replyUserError(btnInteraction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'No se pudo mostrar la confirmación. Inténtalo de nuevo.',
                }).catch(() => {});
                return;
            }

            try {
                const confirmSubmit = await btnInteraction.awaitModalSubmit({
                    time: 60_000,
                    filter: i =>
                        i.customId === 'app_delete_confirm' && i.user.id === btnInteraction.user.id,
                }).catch(() => null);

                if (!confirmSubmit) {
                    await replyUserError(btnInteraction, {
                        type: ErrorTypes.VALIDATION,
                        message: 'Se canceló la eliminación de la postulación.',
                    });
                    return;
                }

                const confirmed = confirmSubmit.fields.getCheckbox('confirm_delete');
                if (!confirmed) {
                    await replyUserError(confirmSubmit, { type: ErrorTypes.VALIDATION, message: 'Debes marcar la casilla de confirmación para eliminar la postulación.' });
                    return;
                }

                await handleDeleteApplication(confirmSubmit, selectedRoleId, guildId, roles, client);
                collector.stop();
                btnCollector.stop();

            } catch (error) {
                logger.error('Error confirming application deletion:', error);
                await replyUserError(btnInteraction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'Ocurrió un error al eliminar la postulación.',
                });
            }
        });

        btnCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('Configuración expirada')
                    .setDescription('Esta sesión del panel expiró por inactividad (10 minutos).\n\nPara seguir configurando tus postulaciones, vuelve a usar el comando.')
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });

        const toggleCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_toggle_${selectedRoleId}`,
            time: 900_000,
        });

        toggleCollector.on('collect', async toggleInteraction => {
            const deferred = await safeDeferInteraction(toggleInteraction);
            if (!deferred) return;
            
            try {
                
                const roleIndex = roles.findIndex(r => r.roleId === selectedRoleId);
                if (roleIndex === -1) {
                    await replyUserError(toggleInteraction, {
                        type: ErrorTypes.USER_INPUT,
                        message: 'No se encontró el rol de postulación.',
                    });
                    return;
                }

                const wasEnabled = roles[roleIndex].enabled !== false;
                roles[roleIndex].enabled = !wasEnabled;

                await saveApplicationRoles(interaction.client, guildId, roles);

                const updatedRole = roles[roleIndex];
                const updatedSettings = await getApplicationSettings(interaction.client, guildId);
                await showApplicationDashboard(interaction, updatedRole, updatedSettings, roles, guildId, interaction.client);

                await toggleInteraction.followUp({
                    embeds: [successEmbed(
                        wasEnabled ? '🔴 Postulación desactivada' : '🟢 Postulación activada',
                        `La postulación **${updatedRole.name}** ahora está **${wasEnabled ? 'desactivada' : 'activada'}**.\n\n${
                            wasEnabled 
                                ? 'Esta postulación ya no aparecerá en las opciones de `/apply enviar`.' 
                                : 'Esta postulación ahora aparecerá en las opciones de `/apply enviar`.'
                        }`,
                    )],
                    flags: MessageFlags.Ephemeral,
                });

            } catch (error) {
                logger.error('Error toggling application status:', error);
                await replyUserError(toggleInteraction, {
                    type: ErrorTypes.UNKNOWN,
                    message: 'Ocurrió un error al cambiar el estado de la postulación.',
                });
            }
        });

        toggleCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('Configuración expirada')
                    .setDescription('Esta sesión del panel expiró por inactividad (10 minutos).\n\nPara seguir configurando tus postulaciones, vuelve a usar el comando.')
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });
    }
}

function buildApplicationSelectMenu(guildId, roleId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`app_cfg_${roleId}`)
        .setPlaceholder('Selecciona un ajuste para configurar...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Canal de registros')
                .setDescription('Define el canal donde se registran las postulaciones')
                .setValue('log_channel')
                .setEmoji('📢'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Roles de gestión')
                .setDescription('Agrega o quita un rol que puede gestionar postulaciones')
                .setValue('manager_role')
                .setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Editar preguntas')
                .setDescription('Personaliza las preguntas del formulario de postulación')
                .setValue('questions')
                .setEmoji('📝'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Período de retención')
                .setDescription('Define cuánto se guardan las postulaciones pendientes y revisadas')
                .setValue('retention')
                .setEmoji('🗑️'),
        );
}

async function handleLogChannel(selectInteraction, rootInteraction, settings, roles, guildId, client, selectedRoleId) {
    let currentChannel = settings.logChannelId;
    if (selectedRoleId) {
        const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
        currentChannel = roleSettings.logChannelId || settings.logChannelId;
    }

    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_log_channel_modal_${guildId}_${selectedRoleId || 'global'}`)
        .setTitle('Configurar canal de registros');

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('log_channel')
        .setPlaceholder('Selecciona un canal de texto...')
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true);

    const channelLabel = new LabelBuilder()
        .setLabel('Canal de registros')
        .setDescription('Canal donde se registrarán las nuevas postulaciones')
        .setChannelSelectMenuComponent(channelSelect);

    modal.addLabelComponents(channelLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_log_channel_modal_${guildId}_${selectedRoleId || 'global'}`,
        });

        const channelId = modalSubmission.fields.getField('log_channel').values[0];
        const channel = selectInteraction.guild.channels.cache.get(channelId);

        if (selectedRoleId) {
            const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
            roleSettings.logChannelId = channelId;
            await saveApplicationRoleSettings(client, guildId, selectedRoleId, roleSettings);
        } else {
            await setLogChannel(client, guildId, 'applications', channelId);
            settings.logChannelId = channelId;
            await saveApplicationSettings(client, guildId, settings);
        }

        await modalSubmission.reply({
            embeds: [successEmbed('Canal de registros actualizado', `Los registros de postulaciones ahora se enviarán a ${channel ?? `<#${channelId}>`}.\nTambién puedes administrarlo desde \`/logging dashboard\`.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId, client);
    } catch (error) {
        if (error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in log channel modal:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: 'Ocurrió un error al actualizar el canal de registros.',
        });
    }
}

async function handleManagerRole(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_manager_role_modal_${guildId}`)
        .setTitle('Configurar roles de gestión');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('manager_roles')
        .setPlaceholder('Selecciona roles para darles acceso de gestión...')
        .setMinValues(1)
        .setMaxValues(5)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Roles de gestión')
        .setDescription('Los roles seleccionados se activarán o desactivarán como roles de gestión')
        .setRoleSelectMenuComponent(roleSelect);

    modal.addLabelComponents(roleLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_manager_role_modal_${guildId}`,
        });

        const selectedRoleIds = modalSubmission.fields.getField('manager_roles').values;
        const roleSet = new Set(settings.managerRoles ?? []);

        for (const roleId of selectedRoleIds) {
            if (roleSet.has(roleId)) {
                roleSet.delete(roleId);
            } else {
                roleSet.add(roleId);
            }
        }

        settings.managerRoles = Array.from(roleSet);
        await saveApplicationSettings(client, guildId, settings);

        const finalList = settings.managerRoles.length > 0
            ? settings.managerRoles.map(id => `<@&${id}>`).join(',')
            : '`Ninguno`';

        await modalSubmission.reply({
            embeds: [successEmbed('Roles de gestión actualizados', `Roles de gestión actuales: ${finalList}`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId, client);
    } catch (error) {
        if (error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in manager role modal:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: 'Ocurrió un error al actualizar los roles de gestión.',
        });
    }
}

async function handleQuestions(selectInteraction, rootInteraction, settings, roles, guildId, client, selectedRoleId) {
    let currentQuestions = settings.questions ?? [];
    
    if (selectedRoleId) {
        const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
        currentQuestions = roleSettings.questions ?? currentQuestions;
    }

    const modal = new ModalBuilder()
        .setCustomId('app_cfg_questions')
        .setTitle('Editar preguntas de postulación')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q1')
                    .setLabel('Pregunta 1 (obligatoria)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[0] ?? '')
                    .setMaxLength(100)
                    .setMinLength(1)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q2')
                    .setLabel('Pregunta 2 (opcional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[1] ?? '')
                    .setMaxLength(100)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q3')
                    .setLabel('Pregunta 3 (opcional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[2] ?? '')
                    .setMaxLength(100)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q4')
                    .setLabel('Pregunta 4 (opcional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[3] ?? '')
                    .setMaxLength(100)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q5')
                    .setLabel('Pregunta 5 (opcional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[4] ?? '')
                    .setMaxLength(100)
                    .setRequired(false),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'app_cfg_questions' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newQuestions = ['q1', 'q2', 'q3', 'q4', 'q5']
        .map(key => submitted.fields.getTextInputValue(key).trim())
        .filter(Boolean);

    if (newQuestions.length === 0) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: 'Se requiere al menos una pregunta.' });
        return;
    }

    if (selectedRoleId) {
        
        const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
        roleSettings.questions = newQuestions;
        await saveApplicationRoleSettings(client, guildId, selectedRoleId, roleSettings);
    } else {
        
        settings.questions = newQuestions;
        await saveApplicationSettings(client, guildId, settings);
    }

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Preguntas actualizadas',
                newQuestions.length !== 1
                    ? `Se guardaron ${newQuestions.length} preguntas.`
                    : 'Se guardó 1 pregunta.',
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, settings, roles, guildId, client);
}

async function handleRoleAdd(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_role_add_modal_${guildId}`)
        .setTitle('Agregar rol de postulación');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('application_role')
        .setPlaceholder('Selecciona el rol al que los miembros pueden postularse...')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Rol de postulación')
        .setDescription('Selecciona el rol de Discord al que los miembros se postularán')
        .setRoleSelectMenuComponent(roleSelect);

    const nameInput = new TextInputBuilder()
        .setCustomId('role_name')
        .setLabel('Nombre a mostrar (vacío = nombre del rol)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(50)
        .setRequired(false);

    modal.addLabelComponents(roleLabel);
    modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_role_add_modal_${guildId}`,
        });

        const roleId = modalSubmission.fields.getField('application_role').values[0];
        const role = selectInteraction.guild.roles.cache.get(roleId);
        const customName = modalSubmission.fields.getTextInputValue('role_name').trim() || role?.name || roleId;

        if (roles.some(r => r.roleId === roleId)) {
            await replyUserError(modalSubmission, { type: ErrorTypes.UNKNOWN, message: `${role ?? roleId} ya es un rol de postulación.` });
            return;
        }

        roles.push({ roleId, name: customName });
        await saveApplicationRoles(client, guildId, roles);
        await saveApplicationRoleSettings(client, guildId, roleId, {
            questions: getDefaultApplicationQuestions(),
        });

        await modalSubmission.reply({
            embeds: [successEmbed('Rol agregado', `${role ?? roleId} se agregó como **${customName}**.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId, client);
    } catch (error) {
        if (error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in role add modal:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: 'Ocurrió un error al agregar el rol de postulación.',
        });
    }
}

async function handleRoleRemove(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    if (roles.length === 0) {
        await replyUserError(selectInteraction, {
            type: ErrorTypes.USER_INPUT,
            message: 'No hay roles de postulación configurados para quitar.',
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_role_remove_modal_${guildId}`)
        .setTitle('Quitar rol de postulación');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('remove_role')
        .setPlaceholder('Selecciona el rol que quieres quitar...')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Quitar rol de postulación')
        .setDescription('Selecciona el rol que quieres quitar de la lista de postulaciones')
        .setRoleSelectMenuComponent(roleSelect);

    modal.addLabelComponents(roleLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_role_remove_modal_${guildId}`,
        });

        const roleId = modalSubmission.fields.getField('remove_role').values[0];
        const index = roles.findIndex(r => r.roleId === roleId);

        if (index === -1) {
            await replyUserError(modalSubmission, { type: ErrorTypes.USER_INPUT, message: `<@&${roleId}> no está en la lista de roles de postulación.` });
            return;
        }

        roles.splice(index, 1);
        await saveApplicationRoles(client, guildId, roles);

        await modalSubmission.reply({
            embeds: [successEmbed('Rol quitado', `<@&${roleId}> se quitó de los roles de postulación.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId, client);
    } catch (error) {
        if (error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in role remove modal:', error);
        await replyUserError(selectInteraction, {
            type: ErrorTypes.UNKNOWN,
            message: 'Ocurrió un error al quitar el rol de postulación.',
        });
    }
}

async function handleRetention(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId('app_cfg_retention')
        .setTitle('Períodos de retención');

    const retentionInfo = new TextDisplayBuilder()
        .setContent(
            '**Pendientes** — cuánto tiempo se guardan las postulaciones sin responder o en progreso antes de eliminarse automáticamente.\n' +
            '**Revisadas** — cuánto tiempo se guardan las postulaciones aprobadas o denegadas.\n' +
            '-# Escribe un número entero entre 1 y 3650 (máximo 10 años).',
        );

    const pendingLabel = new LabelBuilder()
        .setLabel('Retención de pendientes (días)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('pending_days')
                .setStyle(TextInputStyle.Short)
                .setValue(String(settings.pendingApplicationRetentionDays ?? 30))
                .setMaxLength(4)
                .setMinLength(1)
                .setRequired(true),
        );

    const reviewedLabel = new LabelBuilder()
        .setLabel('Retención de revisadas (días)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('reviewed_days')
                .setStyle(TextInputStyle.Short)
                .setValue(String(settings.reviewedApplicationRetentionDays ?? 14))
                .setMaxLength(4)
                .setMinLength(1)
                .setRequired(true),
        );

    modal
        .addTextDisplayComponents(retentionInfo)
        .addLabelComponents(pendingLabel, reviewedLabel);

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'app_cfg_retention' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const pendingDays = parseInt(submitted.fields.getTextInputValue('pending_days').trim(), 10);
    const reviewedDays = parseInt(submitted.fields.getTextInputValue('reviewed_days').trim(), 10);

    if (isNaN(pendingDays) || pendingDays < 1 || pendingDays > 3650) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'La retención de pendientes debe ser un número entero entre **1** y **3650** días.' });
        return;
    }

    if (isNaN(reviewedDays) || reviewedDays < 1 || reviewedDays > 3650) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'La retención de revisadas debe ser un número entero entre **1** y **3650** días.' });
        return;
    }

    settings.pendingApplicationRetentionDays = pendingDays;
    settings.reviewedApplicationRetentionDays = reviewedDays;
    await saveApplicationSettings(client, guildId, settings);

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Retención actualizada',
                `Las postulaciones pendientes se guardarán **${pendingDays} días**.\nLas postulaciones revisadas se guardarán **${reviewedDays} días**.`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, settings, roles, guildId, client);
}

async function handleDeleteApplication(confirmSubmit, selectedRoleId, guildId, roles, client) {
    try {
        
        const roleIndex = roles.findIndex(r => r.roleId === selectedRoleId);
        if (roleIndex === -1) {
            await replyUserError(confirmSubmit, { type: ErrorTypes.USER_INPUT, message: 'No se encontró el rol de postulación.' });
            return;
        }

        const deletedRole = roles[roleIndex];

        roles.splice(roleIndex, 1);

        await saveApplicationRoles(client, guildId, roles);

        await deleteApplicationRoleSettings(client, guildId, selectedRoleId);

        const allApplications = await getApplications(client, guildId);
        const applicationsToDelete = allApplications.filter(app => app.roleId === selectedRoleId);

        for (const app of applicationsToDelete) {
            await deleteApplication(client, guildId, app.id, app.userId);
        }

        await confirmSubmit.reply({
            embeds: [
                successEmbed(
                    '🗑️ Postulación eliminada',
                    `La postulación de <@&${selectedRoleId}> (**${deletedRole.name}**) se eliminó permanentemente.\n\n` +
                    `Eliminadas: **${applicationsToDelete.length}** ${applicationsToDelete.length !== 1 ? 'postulaciones' : 'postulación'}`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

    } catch (error) {
        logger.error('Error in handleDeleteApplication:', error);
        await replyUserError(confirmSubmit, { type: ErrorTypes.UNKNOWN, message: 'Ocurrió un error al eliminar la postulación. Inténtalo de nuevo.' });
    }
}
