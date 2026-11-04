import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { send24hReminderNotification, sendWeeklyClientReminderNotification } from '../services/notificationService';
import { WhatsAppService } from '../services/whatsappService';
import { DateTime } from 'luxon';
import { SALON_CONFIG } from '../config/salonConfig';

const whatsappService = new WhatsAppService();

let cronTask: any = null;
let mondayCronTask: any = null;
let arrivalCronTask: any = null;

/**
 * Função responsável por buscar agendamentos de todas as clientes para o dia seguinte (1 dia antes / ~24h)
 * e disparar lembretes de confirmação de presença TANTO para a cliente QUANTO para a Janaína.
 */
export async function process24hReminders() {
  try {
    const tz = SALON_CONFIG.timezone;
    const now = DateTime.now().setZone(tz);

    const tomorrowStart = now.plus({ days: 1 }).startOf('day').toJSDate();
    const tomorrowEnd = now.plus({ days: 1 }).endOf('day').toJSDate();
    const windowStart = now.hour >= 8 ? tomorrowStart : now.plus({ hours: 23 }).toJSDate();
    const windowEnd = now.hour >= 8 ? tomorrowEnd : now.plus({ hours: 25 }).toJSDate();

    const upcomingAppointments = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
        depositStatus: { in: ['CONFIRMED', 'EXEMPT'] },
        reminderSent24h: false,
        appointmentDate: {
          gte: windowStart,
          lte: windowEnd,
        },
      },
      orderBy: { appointmentDate: 'asc' },
    });

    if (upcomingAppointments.length === 0) {
      return { processedCount: 0 };
    }

    console.log(`⏰ [CRON LEMBRETE 1 DIA ANTES] Encontrados ${upcomingAppointments.length} agendamento(s) para disparo de lembrete.`);

    let sentCount = 0;
    for (const apt of upcomingAppointments) {
      try {
        const cleanPhone = (apt.whatsappPhone || '').replace(/\D/g, '');
        let clientSent = false;
        if (cleanPhone.length >= 10 && !cleanPhone.endsWith('00000000')) {
          clientSent = await send24hReminderNotification(apt);
        }

        // Também envia lembrete de véspera para a Janaína
        let ownerSent = false;
        if (SALON_CONFIG.ownerPhone) {
          const aptDt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz }).setLocale('pt-BR');
          const ownerMsg =
            `📅 *Lembrete de Atendimento Confirmado (Amanhã):*\n` +
            `👤 *${apt.clientName}* - ${apt.service}\n` +
            `🗓️ ${aptDt.toFormat('dd/MM/yyyy')} às ${aptDt.toFormat('HH:mm')}\n` +
            `💰 Valor: R$ ${Number(apt.totalAmount).toFixed(2).replace('.', ',')}`;
          ownerSent = await whatsappService.sendMessage(SALON_CONFIG.ownerPhone, ownerMsg);
        }

        if (clientSent || ownerSent) {
          await prisma.appointment.update({
            where: { id: apt.id },
            data: { reminderSent24h: true },
          });
          sentCount++;
          console.log(`✅ [CRON LEMBRETE 1 DIA ANTES] Lembrete entregue para ${apt.clientName} e Janaína.`);
        }
      } catch (err) {
        console.error(`❌ [CRON LEMBRETE 1 DIA ANTES] Erro ao enviar lembrete para ${apt.id}:`, err);
      }
    }

    return { processedCount: sentCount };
  } catch (error) {
    console.error('❌ [CRON LEMBRETE 1 DIA ANTES] Erro ao processar rotina de lembretes:', error);
    return { processedCount: 0, error };
  }
}

/**
 * Dispara o lembrete na hora/proximidade do atendimento (estilo MinhaAgenda:
 * "Atendimento: Michele Novo - Manutenção... 03/11/2026 às 19:00")
 * tanto para a Janaína quanto para a cliente!
 */
export async function processArrivalTimeReminders() {
  try {
    const tz = SALON_CONFIG.timezone;
    const now = DateTime.now().setZone(tz);
    const windowStart = now.minus({ minutes: 5 }).toJSDate();
    const windowEnd = now.plus({ minutes: 20 }).toJSDate();

    const imminentAppointments = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
        depositStatus: { in: ['CONFIRMED', 'EXEMPT'] },
        appointmentDate: {
          gte: windowStart,
          lte: windowEnd,
        },
      },
      orderBy: { appointmentDate: 'asc' },
    });

    const pendingArrival = imminentAppointments.filter(
      (apt) => !(apt.notes || '').includes('[LembreteHoraEnviado]')
    );

    if (pendingArrival.length === 0) {
      return { processedCount: 0 };
    }

    let sentCount = 0;
    for (const apt of pendingArrival) {
      try {
        const aptDt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz }).setLocale('pt-BR');
        const dateStr = aptDt.toFormat('dd/MM/yyyy');
        const timeStr = aptDt.toFormat('HH:mm');

        // 1. Alerta estilo MinhaAgenda para a Janaína
        let ownerSent = false;
        if (SALON_CONFIG.ownerPhone) {
          const ownerAlert =
            `🔔 *Atendimento: ${apt.clientName} - ${apt.service}*\n` +
            `🗓️ ${dateStr} às ${timeStr}\n` +
            `💰 Valor: R$ ${Number(apt.totalAmount).toFixed(2).replace('.', ',')}`;
          ownerSent = await whatsappService.sendMessage(SALON_CONFIG.ownerPhone, ownerAlert);
        }

        // 2. Lembrete de horário para a Cliente (se tiver telefone válido)
        let clientSent = false;
        const cleanPhone = (apt.whatsappPhone || '').replace(/\D/g, '');
        if (cleanPhone.length >= 10 && !cleanPhone.endsWith('00000000')) {
          const clientAlert =
            `✨ *Lembrete de Atendimento — Studio JF*\n\n` +
            `Oi, *${apt.clientName}*! Passando para lembrar do seu atendimento confirmado de *${apt.service}* hoje (*${dateStr}*) às *${timeStr}*.\n` +
            `📍 Local: ${SALON_CONFIG.address}\n\n` +
            `Estamos te esperando! 💖`;
          clientSent = await whatsappService.sendMessage(apt.whatsappPhone, clientAlert);
        }

        if (ownerSent || clientSent) {
          const updatedNotes = apt.notes
            ? `${apt.notes} | [LembreteHoraEnviado]`
            : '[LembreteHoraEnviado]';
          await prisma.appointment.update({
            where: { id: apt.id },
            data: { notes: updatedNotes },
          });
          sentCount++;
        }
      } catch (err) {
        console.error(`❌ [LEMBRETE HORA] Erro ao disparar alerta de horário para ${apt.id}:`, err);
      }
    }

    return { processedCount: sentCount };
  } catch (error) {
    console.error('❌ [LEMBRETE HORA] Erro na verificação de lembretes do horário:', error);
    return { processedCount: 0, error };
  }
}

/**
 * Função responsável por enviar na Segunda-feira o lembrete da semana para TODAS as clientes
 * que estão agendadas na semana vigente (Segunda a Sábado).
 */
export async function processMondayWeeklyClientReminders(forceRun: boolean = false) {
  try {
    const tz = SALON_CONFIG.timezone;
    const now = DateTime.now().setZone(tz);

    if (!forceRun && (now.weekday !== 1 || now.hour < 8)) {
      return { processedCount: 0 };
    }

    const weekMondayTag = `[LembreteSemanal:${now.startOf('week').toISODate()}]`;
    const weekStart = now.toJSDate();
    const weekEnd = now.endOf('week').toJSDate();

    const weekAppointments = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
        depositStatus: { in: ['CONFIRMED', 'EXEMPT'] },
        appointmentDate: {
          gte: weekStart,
          lte: weekEnd,
        },
      },
      orderBy: { appointmentDate: 'asc' },
    });

    const pendingWeekly = weekAppointments.filter(
      (apt) => !(apt.notes || '').includes(weekMondayTag)
    );

    if (pendingWeekly.length === 0) {
      return { processedCount: 0 };
    }

    console.log(`📅 [CRON SEGUNDA-FEIRA] Enviando lembrete semanal para ${pendingWeekly.length} cliente(s) agendada(s) na semana...`);

    let sentCount = 0;
    for (const apt of pendingWeekly) {
      try {
        const sent = await sendWeeklyClientReminderNotification(apt);
        if (sent) {
          const updatedNotes = apt.notes ? `${apt.notes} | ${weekMondayTag}` : weekMondayTag;
          await prisma.appointment.update({
            where: { id: apt.id },
            data: { notes: updatedNotes },
          });
          sentCount++;
          console.log(`✅ [CRON SEGUNDA-FEIRA] Lembrete da semana entregue para ${apt.clientName} (${apt.whatsappPhone}).`);
        }
      } catch (err) {
        console.error(`❌ [CRON SEGUNDA-FEIRA] Erro ao enviar lembrete semanal para ${apt.id}:`, err);
      }
    }

    return { processedCount: sentCount };
  } catch (error) {
    console.error('❌ [CRON SEGUNDA-FEIRA] Erro ao processar lembretes semanais das clientes:', error);
    return { processedCount: 0, error };
  }
}

/**
 * Inicia os jobs recorrentes de lembrete:
 * 1) Lembrete 1 dia antes (verificado a cada hora — envia para Cliente e Janaína)
 * 2) Lembrete na hora do atendimento (verificado a cada 5 minutos — envia para Janaína e Cliente)
 * 3) Lembrete de Segunda-feira para todas as clientes agendadas na semana ('0 9 * * 1')
 */
export function start24hReminderJob() {
  const tz = SALON_CONFIG.timezone || 'America/Sao_Paulo';
  console.log('⏱️ [JOB] Rotinas de Lembrete MinhaAgenda (24h antes + Hora do Atendimento + Segunda-feira) agendadas.');

  process24hReminders().catch((err) =>
    console.error('Erro na primeira execução do job de lembrete 24h:', err)
  );
  processArrivalTimeReminders().catch((err) =>
    console.error('Erro na primeira execução do job de lembrete de horário:', err)
  );
  processMondayWeeklyClientReminders().catch((err) =>
    console.error('Erro na verificação inicial do lembrete semanal de segunda-feira:', err)
  );

  // Executa a cada hora no minuto 0
  cronTask = cron.schedule(
    '0 * * * *',
    async () => {
      console.log('🔄 [CRON LEMBRETES] Executando verificação de lembretes (1 dia antes e semanal de segunda)...');
      await process24hReminders();
      await processMondayWeeklyClientReminders();
    },
    { timezone: tz }
  );

  // Verifica a cada 5 minutos se há atendimento começando agora / em 15 min (alerta MinhaAgenda)
  arrivalCronTask = cron.schedule(
    '*/5 * * * *',
    async () => {
      await processArrivalTimeReminders();
    },
    { timezone: tz }
  );

  // Disparo dedicado toda segunda-feira às 09:00
  mondayCronTask = cron.schedule(
    '0 9 * * 1',
    async () => {
      console.log('🌸 [CRON SEGUNDA 09H] Disparando lembrete semanal para todas as clientes agendadas na semana...');
      await processMondayWeeklyClientReminders(true);
    },
    { timezone: tz }
  );

  return { cronTask, mondayCronTask, arrivalCronTask };
}
