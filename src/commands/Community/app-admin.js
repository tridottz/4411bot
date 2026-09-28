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
        normalized === 'pendiente' ? 'En progreso' :
        normalized === 'aprobado' ? 'Aceptado' :
        normalized === 'denegado' ? 'Denegado' :
        'Unknown';
    const statusEmoji =
        normalized === 'pendiente' ? '🟡' :
        normalized === 'aprobado' ? '🟢' :
        normalized === 'denegado' ? '🔴' :
        '⚪';

    return { normalized, statusLabel, statusEmoji };
}

export default {
    data: new SlashCommandBuilder()
    .setName("app-admin")
    .setDescription("Manage staff applications")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
        subcommand
            .setName("establecer")
            .setDescription("Postulate")
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("revisar")
            .setDescription("Aprueba o niega una postulacion")
            .addStringOption((option) =>
                option
                    .setName("id")
                    .setDescription("El id de postulacion")
                    .setRequired(true),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("list")
            .setDescription("Lista d todas las postulaciones")
            .addStringOption((option) =>
                option
                    .setName("Estado")
                    .setDescription("Filtrar por estado")
                    .addChoices(
                        { name: "Pendiente", value: "pendiente" },
                        { name: "Aprobado", value: "aprobado" },
                        { name: "Denegado", value: "denegado" },
                    ),
            )
            .addStringOption((option) =>
                option.setName("role").setDescription("Filtrar po ID de rol"),
            )
            .addUserOption((option) =>
                option.setName("user").setDescription("Filtrar por usuario"),
            )
            .addNumberOption((option) =>
                option
                    .setName("limite")
                    .setDescription(
                        "El numero maximo de postulaciones por mostrar (default: 10)",
                    )
                    .setMinValue(1)
                    .setMaxValue(25),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("dashboard")
            .setDescription("Open the applications configuration dashboard")
            .addStringOption((option) =>
                option
                    .setName("postulacion")
                    .setDescription("Selecciona una postulacion para configurar")
                    .setRequired(false)
                    .setAutocomplete(true),
            ),
    ),

    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Este comando solo puede ser utilizado en un servidor.' });
        }

        const { options, guild, member } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand !== 'dashboard' && subcommand !== 'setup') {
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
            const selectedAppName = interaction.options.getString("postulacion");
            await appDashboard.execute(interaction, null, interaction.client, selectedAppName);
        }
    }, { type: 'command', commandName: 'app-admin' })
};

async function handleSetup(interaction) {
    
    if (interaction.deferred || interaction.replied) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Esta interaccion esta en proceso. Porfavor prueba usar el comando de nuevo.' });
    }

    const modal = new ModalBuilder()
        .setCustomId('app_setup_modal')
        .setTitle('Agrega una nueva postulacion');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('role_id')
        .setPlaceholder('Selecciona el rol al que los usuarios se postularan')
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Rol de postulacion')
        .setDescription('El rol al que los usuarios se estan postulando')
        .setRoleSelectMenuComponent(roleSelect);

    const appNameInput = new TextInputBuilder()
        .setCustomId('app_name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., Moderator, Helper, Developer')
        .setMaxLength(50)
        .setMinLength(1)
        .setRequired(true);

    const appNameLabel = new LabelBuilder()
        .setLabel('Nombre de postulacion')
        .setTextInputComponent(appNameInput);

    const q1Input = new TextInputBuilder()
        .setCustomId('app_question_1')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Por que quieres este rol?')
        .setMaxLength(100)
        .setMinLength(1)
        .setRequired(true);

    const q1Label = new LabelBuilder()
        .setLabel('Pregunta 1 (Obligatoria)')
        .setTextInputComponent(q1Input);

    const q2Input = new TextInputBuilder()
        .setCustomId('app_question_2')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Tienes expriencia? Si es asi, especifica cual')
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
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: 'Debes seleccionar al menos un rol para postularte.' });
        return;
    }

    const questions = [
        submitted.fields.getTextInputValue('app_question_1').trim(),
        submitted.fields.getTextInputValue('app_question_2').trim(),
        submitted.fields.getTextInputValue('app_question_3').trim(),
    ].filter(q => q.length > 0);

    const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'El rol seleccionado es desconocido.' });
        return;
    }

    const existingRoles = await getApplicationRoles(interaction.client, interaction.guild.id);
    if (existingRoles.some(r => r.roleId === roleId)) {
        await replyUserError(submitted, { type: ErrorTypes.CONFIGURATION, message: `El rol ${role} ya esta configurado para una postulacion.` });
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
            '✅ Postulacion creada,
            `**${appName}** La solicitud fue creada para ${role}.\n\nPuedes personalizar el canal de registros, roles de moderacion, preguntas, y el periodo de retencion en el dashboard.`,
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
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Solicitud no encontrada.' });
    }

    if (application.status !== "pending") {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Esta solicitud esta siendo procesada' });
    }

    const appEmbed = createEmbed({
        title: `Revisar solicitud`,
        description: `**Usuario:** <@${application.userId}>\n**Solicitud:** ${application.roleName}\n**ID de solicitud:** \`${appId}\``,
        color: 'informacion',
    });

    if (application.answers && application.answers.length > 0) {
        application.answers.forEach((item, index) => {
            appEmbed.addFields({
                name: `Q${index + 1}: ${item.question}`,
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
        const isApprove = buttonInteraction.customId.includes('aprobar');

        const reasonModal = new ModalBuilder()
            .setCustomId(`app_review_reason_${appId}_${isApprove ? 'aprobar' : 'denegar'}`)
            .setTitle(`${isApprove ? 'Aprobar' : 'Denegar'} Solicitud - Razon`);

        reasonModal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('review_reason')
                    .setLabel('Razon (opcional)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Dinos la razon...')
                    .setMaxLength(500)
                    .setRequired(false),
            ),
        );

        await buttonInteraction.showModal(reasonModal);

        try {
            const reasonSubmit = await buttonInteraction.awaitModalSubmit({
                time: 5 * 60 * 1000, 
                filter: i =>
                    i.customId === `app_review_reason_${appId}_${isApprove ? 'aprobar' : 'denegar'}` &&
                    i.user.id === buttonInteraction.user.id,
            }).catch(() => null);

            if (!reasonSubmit) return;

            const reason = reasonSubmit.fields.getTextInputValue('review_reason').trim() || "Ninguna razon contribuida.";
            const action = isApprove ? 'approve' : 'denegar';
            const status = isApprove ? 'approved' : 'denegada';

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
                const statusColor = getApplicationStatusColor(status);
                const reviewStatus = getApplicationStatusPresentation(status);
                const dmEmbed = createEmbed({
                    title: `${reviewStatus.statusEmoji} Application ${reviewStatus.statusLabel}`,
                    description: `Tu solicitud de **${application.roleName}** ha sido **${status}**\n` +
                        `**Nota:** ${reason}\n\n` +
                        `Usa \`/postulacion estado id:${appId}\` para ver detalles.`
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
                    const statusColor = getApplicationStatusColor(status);
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
                                const reviewStatus = getApplicationStatusPresentation(status);
                                const newEmbed = EmbedBuilder.from(embed)
                                    .setColor(statusColor)
                                    .spliceFields(0, 1, {
                                        name: "Status",
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
                        `Solicitud ${status}`,
                        `La solicitud fue **${status}**.`,
                    ),
                ],
                flags: ["Ephemeral"],
            });

        } catch (error) {
            logger.error('Error revisando la solicitud:', error);
            await replyUserError(buttonInteraction, { type: ErrorTypes.UNKNOWN, message: 'Ocurrio un error al intentar revisar la solicitud.' });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = createEmbed({
                title: 'Review Timeout',
                description: 'The review buttons have timed out.',
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
    const status = interaction.options.getString("status");
    const user = interaction.options.getUser("user");
    const limit = interaction.options.getNumber("limit") || 10;

    const filters = {};
    
    if (status) {
        filters.status = status;
    } else {
        filters.status = 'pendiente';
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
                title: "Sin solicitudes encontradas", 
                description: "Sin solicitudes encontradas siguendo el criterio. \n\nDe igual forma los roles fueron aplicados:" 
            });

            applicationRoles.forEach((appRole, index) => {
                const role = interaction.guild.roles.cache.get(appRole.roleId);
                embed.addFields({
                    name: `${index + 1}. ${appRole.name}`,
                    value: `**Role:** ${role ?`<@&${appRole.roleId}>`: 'Rol no encontrado'}\n**Disponible para postulaciones:** Si`,
                    inline: false
                });
            });

            embed.setFooter({
                text: "Los usuarios pueden postularse con /postulacion crear o ver los roles disponibles con /postulacion lista"
            });

            return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ["Ephemeral"] });
        } else {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: 'Sin solicitudes encontradas y sin roles configurados.\n' +
                    'Usa `/postulaciones-admin roles agregar` para configurar los roles de solicitudes primero.'
            });
        }
    }

    applications = applications
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);

    const embed = createEmbed({ title: "Solicitudes creadas", description: `Mostrando ${applications.length} solicitudes`, });

    applications.forEach((app) => {
        const statusView = getApplicationStatusPresentation(app?.status);
        const roleName = app?.roleName || 'Rol desconocido';
        const username = app?.username || 'Usuario desconocido';
        const createdAt = app?.createdAt ? new Date(app.createdAt) : null;
        const createdAtDisplay = createdAt && !Number.isNaN(createdAt.getTime())
            ? createdAt.toLocaleString()
            : 'Unknown date';

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

