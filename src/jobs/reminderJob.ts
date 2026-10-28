import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { send24hReminderNotification, sendWeeklyClientReminderNotification } from '../services/notificationService';
import { DateTime } from 'luxon';
import { SALON_CONFIG } from '../config/salonConfig';

let cronTask: any = null;
let mondayCronTask: any = null;

/**
 * Função responsável por buscar agendamentos de todas as clientes para o dia seguinte (1 dia antes / ~24h)
 * e disparar lembretes de confirmação de presença.
 */
export async function process24hReminders() {
  try {
    const tz = SALON_CONFIG.timezone;
    const now = DateTime.now().setZone(tz);

    // Abrange todos os agendamentos de amanhã (1 dia antes) a partir das 08h do dia anterior,
    // ou dentro da janela de até 26h de antecedência
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
        const sent = await send24hReminderNotification(apt);
        if (sent) {
          await prisma.appointment.update({
            where: { id: apt.id },
            data: { reminderSent24h: true },
          });
          sentCount++;
          console.log(`✅ [CRON LEMBRETE 1 DIA ANTES] Lembrete entregue para ${apt.clientName} (${apt.whatsappPhone}).`);
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
 * Função responsável por enviar na Segunda-feira o lembrete da semana para TODAS as clientes
 * que estão agendadas na semana vigente (Segunda a Sábado).
 */
export async function processMondayWeeklyClientReminders(forceRun: boolean = false) {
  try {
    const tz = SALON_CONFIG.timezone;
    const now = DateTime.now().setZone(tz);

    // Só executa nas segundas-feiras (weekday === 1 no Luxon) a partir das 08h, a menos que forceRun = true
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
 * 1) Lembrete 1 dia antes (verificado a cada hora)
 * 2) Lembrete de Segunda-feira para todas as clientes agendadas na semana ('0 9 * * 1')
 */
export function start24hReminderJob() {
  const tz = SALON_CONFIG.timezone || 'America/Sao_Paulo';
  console.log('⏱️ [JOB] Rotina de Lembrete (1 dia antes + Segunda-feira semanal para clientes) agendada.');

  // Executa na subida do servidor
  process24hReminders().catch((err) =>
    console.error('Erro na primeira execução do job de lembrete 24h:', err)
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

  // Disparo dedicado toda segunda-feira às 09:00
  mondayCronTask = cron.schedule(
    '0 9 * * 1',
    async () => {
      console.log('🌸 [CRON SEGUNDA 09H] Disparando lembrete semanal para todas as clientes agendadas na semana...');
      await processMondayWeeklyClientReminders(true);
    },
    { timezone: tz }
  );

  return { cronTask, mondayCronTask };
}
