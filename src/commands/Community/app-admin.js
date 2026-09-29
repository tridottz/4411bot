import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ComponentType, LabelBuilder, RoleSelectMenuBuilder } from 'discord.js';
import { createEmbed, successEmbed } from '../../utils/embeds.js';
import { getColor, getApplicationStatusColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import { withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import ApplicationService from '../../services/applicationService.js';
import { 
    getApplicationSettings, 
    saveApplicationSettings, 
    getApplication, 
    getApplications, 
    updateApplication,
    getApplicationRoles,
    saveApplicationRoles,
    getApplicationRoleSettings,
    saveApplicationRoleSettings,
    deleteApplication
} from '../../utils/database.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import appDashboard from './modules/app_dashboard.js';

function getApplicationStatusPresentation(statusValue) {
    const normalized = typeof statusValue === 'string' ? statusValue.trim().toLowerCase() : 'unknown';
    const statusLabel =
        normalized === 'pending' ? 'En progreso' :
        normalized === 'approved' ? 'Aceptada' :
        normalized === 'denied' ? 'Denegada' :
        'Desconocido';
    const statusEmoji =
        normalized === 'pending' ? '🟡' :
        normalized === 'approved' ? '🟢' :
        normalized === 'denied' ? '🔴' :
        '⚪';

    return { normalized, statusLabel, statusEmoji };
}

export default {
    data: new SlashCommandBuilder()
    .setName("app-admin")
    .setDescription("Administra las postulaciones del staff")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
        subcommand
            .setName("establecer")
            .setDescription("Crea una nueva postulación")
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("revisar")
            .setDescription("Aprueba o deniega una postulación")
            .addStringOption((option) =>
                option
                    .setName("id")
                    .setDescription("El ID de la postulación")
                    .setRequired(true),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("lista")
            .setDescription("Lista todas las postulaciones")
            .addStringOption((option) =>
                option
                    .setName("estado")
                    .setDescription("Filtrar por estado")
                    .addChoices(
                        { name: "Pendiente", value: "pending" },
                        { name: "Aprobada", value: "approved" },
                        { name: "Denegada", value: "denied" },
                    ),
            )
            .addStringOption((option) =>
                option.setName("rol").setDescription("Filtrar por ID de rol"),
            )
            .addUserOption((option) =>
                option.setName("usuario").setDescription("Filtrar por usuario"),
            )
            .addNumberOption((option) =>
                option
                    .setName("limite")
                    .setDescription(
                        "Número máximo de postulaciones a mostrar (por defecto: 10)",
                    )
                    .setMinValue(1)
                    .setMaxValue(25),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("dashboard")
            .setDescription("Abre el panel de configuración de postulaciones")
            .addStringOption((option) =>
                option
                    .setName("application")
                    .setDescription("Selecciona una postulación para configurar")
                    .setRequired(false)
                    .setAutocomplete(true),
            ),
    ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Este comando solo puede usarse en un servidor.' });
        }

        const { options, guild, member } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand !== 'dashboard' && subcommand !== 'establecer') {
            await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });
        }

        logger.info(`App-admin command executed: ${subcommand}`, {
            userId: interaction.user.id,
            guildId: guild.id,
            subcommand
        });

        await ApplicationService.checkManagerPermission(interaction.client, guild.id, member);

        if (subcommand === "establecer") {
            await handleSetup(interaction);
        } else if (subcommand === "revisar") {
            await handleReview(interaction);
        } else if (subcommand === "lista") {
            await handleList(interaction);
        } else if (subcommand === "dashboard") {
            const selectedAppName = interaction.options.getString("application");
            await appDashboard.execute(interaction, null, interaction.client, selectedAppName);
        }
    }, { type: 'command', commandName: 'app-admin' })
};

async function handleSetup(interaction) {
    
    if (interaction.deferred || interaction.replied) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Esta interacción ya está en proceso. Por favor, vuelve a usar el comando.' });
    }

    const modal = new ModalBuilder()
        .setCustomId('app_setup_modal')
        .setTitle('Agrega una nueva postulación');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('role_id')
        .setPlaceholder('Selecciona el rol al que se postularán los usuarios')
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Rol de la postulación')
        .setDescription('El rol al que los usuarios se están postulando')
        .setRoleSelectMenuComponent(roleSelect);

    const appNameInput = new TextInputBuilder()
        .setCustomId('app_name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ej.: Moderador, Ayudante, Desarrollador')
        .setMaxLength(50)
        .setMinLength(1)
        .setRequired(true);

    const appNameLabel = new LabelBuilder()
        .setLabel('Nombre de la postulación')
        .setTextInputComponent(appNameInput);

    const q1Input = new TextInputBuilder()
        .setCustomId('app_question_1')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('¿Por qué quieres este rol?')
        .setMaxLength(100)
        .setMinLength(1)
        .setRequired(true);

    const q1Label = new LabelBuilder()
        .setLabel('Pregunta 1 (obligatoria)')
        .setTextInputComponent(q1Input);

    const q2Input = new TextInputBuilder()
        .setCustomId('app_question_2')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('¿Tienes experiencia? Si es así, especifica cuál')
        .setMaxLength(100)
        .setRequired(false);

    const q2Label = new LabelBuilder()
        .setLabel('Pregunta 2 (opcional)')
        .setTextInputComponent(q2Input);

    const q3Input = new TextInputBuilder()
        .setCustomId('app_question_3')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(false);

    const q3Label = new LabelBuilder()
        .setLabel('Pregunta 3 (opcional)')
        .setTextInputComponent(q3Input);

    modal.addLabelComponents(roleLabel, appNameLabel, q1Label, q2Label, q3Label);

    await interaction.showModal(modal);

    const submitted = await interaction.awaitModalSubmit({
        time: 15 * 60 * 1000, 
        filter: (i) =>
            i.customId === 'app_setup_modal' &&
            i.user.id === interaction.user.id,
    }).catch(() => null);

    if (!submitted) {
        logger.info('App setup modal dismissed or timed out', { guildId: interaction.guild.id, userId: interaction.user.id });
        return;
    }

    const appName = submitted.fields.getTextInputValue('app_name').trim();
    const selectedRoles = submitted.fields.getSelectedRoles('role_id');
    const roleId = selectedRoles.first()?.id;

    if (!roleId) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: 'Debes seleccionar un rol para la postulación.' });
        return;
    }

    const questions = [
        submitted.fields.getTextInputValue('app_question_1').trim(),
        submitted.fields.getTextInputValue('app_question_2').trim(),
        submitted.fields.getTextInputValue('app_question_3').trim(),
    ].filter(q => q.length > 0);

    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'El rol seleccionado no existe.' });
        return;
    }

    const existingRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    if (existingRoles.some(r => r.roleId === roleId)) {
        await replyUserError(submitted, { type: ErrorTypes.CONFIGURATION, message: `El rol ${role} ya está configurado para una postulación.` });
        return;
    }

    existingRoles.push({
        roleId: roleId,
        name: appName,
        enabled: true,  
    });

    await saveApplicationRoles(interaction.client, interaction.guild.id, existingRoles);

    const settings = await getApplicationSettings(interaction.client, interaction.guild.id);
    if (!settings.enabled) {
        await ApplicationService.updateSettings(interaction.client, interaction.guild.id, { enabled: true });
    }

    await saveApplicationRoleSettings(interaction.client, interaction.guild.id, roleId, { questions });

    await submitted.reply({
        embeds: [successEmbed(
            '✅ Postulación creada',
            `La postulación **${appName}** fue creada para ${role}.\n\nPuedes personalizar el canal de registros, los roles de moderación, las preguntas y el período de retención en el panel.`,
        )],
        flags: ['Ephemeral'],
    });

    setTimeout(() => {
        appDashboard.execute(submitted, null, interaction.client, appName);
    }, 500);
}

async function handleReview(interaction) {
    const appId = interaction.options.getString("id");

    const application = await getApplication(
        interaction.client,
        interaction.guild.id,
        appId,
    );
    if (!application) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Postulación no encontrada.' });
    }

    if (application.status !== "pending") {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Esta postulación ya fue procesada.' });
    }

    const appEmbed = createEmbed({
        title: `Revisar postulación`,
        description: `**Usuario:** <@${application.userId}>\n**Postulación:** ${application.roleName}\n**ID de postulación:** \`${appId}\``,
        color: 'info',
    });

    if (application.answers && application.answers.length > 0) {
        application.answers.forEach((item, index) => {
            appEmbed.addFields({
                name: `P${index + 1}: ${item.question}`,
                value: item.answer || '*Sin respuesta*',
                inline: false
            });
        });
    }

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_review_approve_${appId}`)
            .setLabel('Aprobar')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`app_review_deny_${appId}`)
            .setLabel('Denegar')
            .setStyle(ButtonStyle.Danger),
    );

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [appEmbed],
        components: [buttonRow],
        flags: ["Ephemeral"],
    });

    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i =>
            i.user.id === interaction.user.id &&
            (i.customId.startsWith(`app_review_approve_${appId}`) ||
             i.customId.startsWith(`app_review_deny_${appId}`)),
        time: 300_000, 
        max: 1,
    });

    collector.on('collect', async buttonInteraction => {
        const isApprove = buttonInteraction.customId.includes('approve');

        const reasonModal = new ModalBuilder()
            .setCustomId(`app_review_reason_${appId}_${isApprove ? 'approve' : 'deny'}`)
            .setTitle(`${isApprove ? 'Aprobar' : 'Denegar'} postulación - Razón`);

        reasonModal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('review_reason')
                    .setLabel('Razón (opcional)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Escribe la razón...')
                    .setMaxLength(500)
                    .setRequired(false),
            ),
        );

        await buttonInteraction.showModal(reasonModal);

        try {
            const reasonSubmit = await buttonInteraction.awaitModalSubmit({
                time: 5 * 60 * 1000, 
                filter: i =>
                    i.customId === `app_review_reason_${appId}_${isApprove ? 'approve' : 'deny'}` &&
                    i.user.id === buttonInteraction.user.id,
            }).catch(() => null);

            if (!reasonSubmit) return;

            const reason = reasonSubmit.fields.getTextInputValue('review_reason').trim() || "No se proporcionó una razón.";
            const action = isApprove ? 'approve' : 'deny';
            const status = isApprove ? 'approved' : 'denied';
            const reviewStatus = getApplicationStatusPresentation(status);
            const statusText = reviewStatus.statusLabel.toLowerCase();
            const statusColor = getApplicationStatusColor(status);

            const updatedApplication = await ApplicationService.reviewApplication(
                reasonSubmit.client,
                interaction.guild.id,
                appId,
                {
                    action,
                    reason,
                    reviewerId: reasonSubmit.user.id
                }
            );

            try {
                const user = await reasonSubmit.client.users.fetch(application.userId);
                const dmEmbed = createEmbed({
                    title: `${reviewStatus.statusEmoji} Postulación ${statusText}`,
                    description: `Tu postulación para **${application.roleName}** fue **${statusText}**.\n` +
                        `**Nota:** ${reason}\n\n` +
                        `Usa \`/apply estado id:${appId}\` para ver los detalles.`
                }).setColor(statusColor);

                await user.send({ embeds: [dmEmbed] });
            } catch (error) {
                logger.warn('No se pudo enviar mensaje al postulante', {
                    error: error.message,
                    userId: application.userId,
                    applicationId: appId
                });
            }

            if (application.logMessageId && application.logChannelId) {
                try {
                    const logChannel = interaction.guild.channels.cache.get(
                        application.logChannelId,
                    );
                    if (logChannel) {
                        const logMessage = await logChannel.messages.fetch(
                            application.logMessageId,
                        );
                        if (logMessage) {
                            const embed = logMessage.embeds[0];
                            if (embed) {
                                const newEmbed = EmbedBuilder.from(embed)
                                    .setColor(statusColor)
                                    .spliceFields(0, 1, {
                                        name: "Estado",
                                        value: `${reviewStatus.statusEmoji} ${reviewStatus.statusLabel}`,
                                    });

                                await logMessage.edit({
                                    embeds: [newEmbed],
                                    components: [],
                                });
                            }
                        }
                    }
                } catch (error) {
                    logger.warn('Fallo al intentar modificar el registro para la postulacion', {
                        error: error.message,
                        applicationId: appId,
                        logMessageId: application.logMessageId
                    });
                }
            }

            if (isApprove) {
                try {
                    const member = await interaction.guild.members.fetch(
                        application.userId,
                    );
                    await member.roles.add(application.roleId);
                } catch (error) {
                    logger.error('Error al intentar asignar el rol al solicitante aprobado', {
                        error: error.message,
                        userId: application.userId,
                        roleId: application.roleId,
                        applicationId: appId
                    });
                }
            }

            await reasonSubmit.reply({
                embeds: [
                    successEmbed(
                        `Postulación ${statusText}`,
                        `La postulación fue **${statusText}**.`,
                    ),
                ],
                flags: ["Ephemeral"],
            });

        } catch (error) {
            logger.error('Error revisando la postulación:', error);
            await replyUserError(buttonInteraction, { type: ErrorTypes.UNKNOWN, message: 'Ocurrió un error al revisar la postulación.' });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = createEmbed({
                title: 'Tiempo agotado',
                description: 'Los botones de revisión expiraron.',
                color: 'warning',
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [timeoutEmbed],
                components: [],
            }).catch(() => {});
        }
    });
}

async function handleList(interaction) {
    const status = interaction.options.getString("estado");
    const user = interaction.options.getUser("usuario");
    const limit = interaction.options.getNumber("limite") || 10;

    const filters = {};
    
    if (status) {
        filters.status = status;
    } else {
        filters.status = 'pending';
    }

    let applications = await getApplications(
        interaction.client,
        interaction.guild.id,
        filters,
    );

    if (!user) {
        applications = await Promise.all(
            applications.map(async (app) => {
                try {
                    await interaction.guild.members.fetch(app.userId);
                    return app; 
                } catch {
                    
                    await deleteApplication(interaction.client, interaction.guild.id, app.id, app.userId);
                    return null; 
                }
            })
        ).then(results => results.filter(Boolean)); 
    }

    if (user) {
        applications = applications.filter((app) => app.userId === user.id);
    }

    if (applications.length === 0) {
        const applicationRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
        
        if (applicationRoles.length > 0) {
            const embed = createEmbed({ 
                title: "No se encontraron postulaciones", 
                description: "No hay postulaciones que coincidan con los filtros.\n\nPero estas son las postulaciones configuradas:" 
            });

            applicationRoles.forEach((appRole, index) => {
                const role = interaction.guild.roles.cache.get(appRole.roleId);
                embed.addFields({
                    name: `${index + 1}. ${appRole.name}`,
                    value: `**Rol:** ${role ?`<@&${appRole.roleId}>`: 'Rol no encontrado'}\n**Disponible para postularse:** Sí`,
                    inline: false
                });
            });

            embed.setFooter({
                text: "Los usuarios pueden postularse con /apply enviar o ver las postulaciones disponibles con /apply lista"
            });

            return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
        } else {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: 'No se encontraron postulaciones y no hay roles configurados.\n' +
                    'Usa `/app-admin establecer` para configurar primero una postulación.'
            });
        }
    }

    applications = applications
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);

    const embed = createEmbed({ title: "Postulaciones", description: `Mostrando ${applications.length} postulación(es)`, });

    applications.forEach((app) => {
        const statusView = getApplicationStatusPresentation(app?.status);
        const roleName = app?.roleName || 'Rol desconocido';
        const username = app?.username || 'Usuario desconocido';
        const createdAt = app?.createdAt ? new Date(app.createdAt) : null;
        const createdAtDisplay = createdAt && !Number.isNaN(createdAt.getTime())
            ? createdAt.toLocaleString()
            : 'Fecha desconocida';

        embed.addFields({
            name: `${statusView.statusEmoji} ${roleName} - ${username}`,
            value:
                `**ID:** \`${app.id}\`\n` +
                `**Estado:** ${statusView.statusEmoji} ${statusView.statusLabel}\n` +
                `**Fecha:** ${createdAtDisplay}`,
            inline: true,
        });
    });

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed],
        flags: ["Ephemeral"],
    });
}
