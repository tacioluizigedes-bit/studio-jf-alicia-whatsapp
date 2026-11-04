import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { SALON_CONFIG } from '../config/salonConfig';
import {
  notifyClientViaWhatsApp,
  sendPixPaymentInstructions,
  notifyExemptClientViaWhatsApp,
  notifyOwnerOnConfirmation,
  buildRescheduleWithin24hMessage,
  buildRescheduleOutside24hMessage,
  getDepositRequestMessage,
  getLateRescheduleDepositMessage,
  getDepositExpiringAlertMessage,
  sendDepositExpiringAlert,
  calculateDeposit50Percent,
  STUDIO_OFFICIAL_PIX_KEY,
  WeeklyOwnerReportData
} from './notificationService';
import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';

/**
 * Sanitizador e validador de telefone para o padrão E.164 (ex: +5521993826303)
 */
export function sanitizeToE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return `+${digits}`;
  }
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/**
 * Validador do Bloqueio Quinzenal às Terças-feiras (13:00 às 15:30)
 * Marco inicial: 13/10/2026 (inclusive)
 */
export function isBiweeklyTuesdayBlocked(
  appointmentDate: Date,
  durationMinutes: number = 60,
  tz: string = SALON_CONFIG.timezone
): boolean {
  const dt = DateTime.fromJSDate(appointmentDate, { zone: tz });

  // Apenas terças-feiras (weekday === 2 no Luxon)
  if (dt.weekday !== 2) return false;

  // Marco inicial: 13/10/2026
  const landmarkStart = DateTime.fromISO('2026-10-13', { zone: tz }).startOf('day');
  const dayStart = dt.startOf('day');

  const diffDays = Math.round(dayStart.diff(landmarkStart, 'days').days);

  // Deve ser a partir do marco inicial e em um ciclo exato de 14 em 14 dias
  if (diffDays < 0 || diffDays % 14 !== 0) return false;

  // Minutos do início e fim do agendamento
  const appStartMinutes = dt.hour * 60 + dt.minute;
  const appEndMinutes = appStartMinutes + durationMinutes;

  // Intervalo bloqueado: 13:00 (780 min) às 15:30 (930 min)
  const blockStartMinutes = 13 * 60; // 780
  const blockEndMinutes = 15 * 60 + 30; // 930

  // Há sobreposição se a hora de início for antes do fim do bloqueio E a hora de fim for após o início do bloqueio
  return appStartMinutes < blockEndMinutes && appEndMinutes > blockStartMinutes;
}

/**
 * Validador da Grade Mensal Aberta
 */
export function isDateWithinOpenMonth(appointmentDate: Date, tz: string = SALON_CONFIG.timezone): boolean {
  const now = DateTime.now().setZone(tz);
  const target = DateTime.fromJSDate(appointmentDate, { zone: tz });

  const startOfCurrentMonth = now.startOf('month');
  const endOfCurrentMonth = now.endOf('month');

  return target >= startOfCurrentMonth && target <= endOfCurrentMonth;
}

/**
 * Schema Zod para validação da rota de ingestão de agendamentos da Alícia
 */
export const WebhookAliciaSchema = z.object({
  clientName: z.string().min(2, 'Nome do cliente deve ter pelo menos 2 caracteres'),
  whatsappPhone: z.string().min(8, 'Telefone inválido'),
  service: z.string().min(2, 'Serviço é obrigatório'),
  appointmentDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'Data do agendamento inválida (formato ISO esperado)',
  }),
  totalAmount: z.coerce.number().positive('Valor total deve ser positivo'),
  depositAmount: z.coerce.number().nonnegative().optional(),
  depositDeadline: z.string().optional().refine((val) => !val || !isNaN(Date.parse(val)), {
    message: 'Prazo limite do sinal inválido',
  }),
  durationMinutes: z.coerce.number().optional().default(60),
  notes: z.string().optional(),
});

export type WebhookAliciaInput = z.infer<typeof WebhookAliciaSchema>;

export interface CreateOrUpdateAppointmentInput {
  id?: string;
  customerName?: string;
  clientName?: string;
  customerPhone?: string;
  whatsappPhone?: string;
  serviceName?: string;
  service?: string;
  appointmentDate: Date | string;
  totalAmount: number;
  depositAmount?: number;
  depositStatus?: 'PENDING' | 'RECEIPT_SENT' | 'CONFIRMED' | 'EXPIRED' | 'EXEMPT';
  overallStatus?: 'PRE_BOOKED' | 'CONFIRMED' | 'CANCELLED';
  generalStatus?: 'PRE_SCHEDULED' | 'CONFIRMED' | 'CANCELLED';
  depositDeadline?: Date | string;
  isFirstAppointment?: boolean;
  notes?: string;
  durationMinutes?: number;
}

export interface SlotAvailabilityResult {
  available: boolean;
  reason?: string;
  conflictType?: 'PERSONAL_BLOCK' | 'APPOINTMENT_CONFLICT' | 'CLOSED_MONTH';
  nextAvailableTime?: string;
  suggestedSlots?: string[];
}

/**
 * Calcula a duração exata (em minutos) de cada procedimento do Studio JF Designer:
 * - Design de Sobrancelha simples: 30 minutos (meia hora -> cliente às 10:00 libera às 10:30)
 * - Design com Henna: 60 minutos (1h)
 * - Manutenção de Cílios: 90 minutos (1h30 -> cliente às 18:00 libera às 19:30)
 * - Colocação de Extensão de Cílios: 90 minutos (1h30)
 * - Combo Manutenção de Cílios + Design de Sobrancelha: 120 minutos (2h)
 */
export function inferAppointmentDurationMinutes(serviceName: string): number {
  const raw = (serviceName || '').trim();
  if (!raw) return 60;

  // 1. Duração explícita anotada na string (ex: "(120 min)", "(2h)", "(1h30)")
  const explicitMinMatch = raw.match(/\((\d+)\s*min\)/i);
  if (explicitMinMatch) {
    return parseInt(explicitMinMatch[1], 10);
  }
  const explicitHourMatch = raw.match(/\((\d+)h(\d*)\)/i);
  if (explicitHourMatch) {
    const h = parseInt(explicitHourMatch[1], 10);
    const m = explicitHourMatch[2] ? parseInt(explicitHourMatch[2], 10) : 0;
    return h * 60 + m;
  }

  // 2. Busca exata no catálogo oficial
  const exactMatch = SALON_CONFIG.services.find(
    (s: any) =>
      s.id.toLowerCase() === raw.toLowerCase() ||
      s.name.toLowerCase() === raw.toLowerCase()
  );
  if (exactMatch && typeof exactMatch.durationMinutes === 'number') {
    return exactMatch.durationMinutes;
  }

  // 3. Combo dinâmico composto (ex: "Combo: Colocação Cílios Volume Brasileiro + Design de Sobrancelha" ou "A + B")
  if (raw.toLowerCase().startsWith('combo:') || (raw.includes('+') && !raw.includes('manut_cilios_volume_brasileiro'))) {
    const cleaned = raw.replace(/^combo:\s*/i, '');
    const parts = cleaned.split('+').map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      let sumMinutes = 0;
      for (const part of parts) {
        sumMinutes += inferAppointmentDurationMinutes(part);
      }
      if (sumMinutes > 0) return sumMinutes;
    }
  }

  const norm = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  // Combo Manutenção + Design ou Henna (1h30 + 30min = 2h)
  if (norm.includes('combo') && (norm.includes('manut') || norm.includes('cilios'))) {
    return 120;
  }

  // Estética Facial - Limpeza de Pele Profunda -> 120 minutos (2h)
  if (norm.includes('limpeza de pele') || norm.includes('limpeza facial') || norm.includes('pele profunda') || norm.includes('limpeza')) {
    return 120;
  }

  // Manutenção de Cílios -> 90 minutos (1h30)
  // Ex: Cliente agendada às 18:00 termina às 19:30; próxima só pode agendar às 19:30
  if (norm.includes('manut')) {
    return 90;
  }

  // Design de Sobrancelha com Henna -> 60 minutos (1h)
  if (norm.includes('henna')) {
    return 60;
  }

  // Design de Sobrancelha simples -> 30 minutos (meia hora)
  // Ex: Cliente agendada às 10:00 termina às 10:30; próxima pode agendar às 10:30
  if (norm.includes('design') || norm.includes('sobrancelha')) {
    return 30;
  }

  // Colocação / Extensão de Cílios -> 90 minutos (1h30)
  if (
    norm.includes('cilios') ||
    norm.includes('cilio') ||
    norm.includes('volume') ||
    norm.includes('fio a fio') ||
    norm.includes('egipcio') ||
    norm.includes('fox') ||
    norm.includes('mega') ||
    norm.includes('tufinho')
  ) {
    return 90;
  }

  // Depilação unitária
  if (norm.includes('virilha total') || norm.includes('virilha completa')) return 60;
  if (norm.includes('virilha')) return 45;
  if (norm.includes('meia perna') || norm.includes('1/2 perna')) return 45;
  if (norm.includes('perna inteira') || norm.includes('perna completa')) return 50;
  if (norm.includes('axila')) return 40;
  if (norm.includes('rosto completo')) return 40;
  if (norm.includes('buco') || norm.includes('mento') || norm.includes('umbigo')) return 30;

  return 60;
}

/**
 * Formata a duração em minutos para exibição amigável ("30 min", "1h", "1h30", "2h")
 */
export function formatDurationLabel(durationMinutes: number): string {
  if (durationMinutes < 60) return `${durationMinutes} min`;
  const h = Math.floor(durationMinutes / 60);
  const m = durationMinutes % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

export class AppointmentService {
  /**
   * Retorna a quantidade de agendamentos anteriores confirmados da cliente pelo WhatsApp
   */
  async getClientConfirmedCount(whatsappPhone: string): Promise<number> {
    const sanitizedPhone = sanitizeToE164(whatsappPhone);
    return await prisma.appointment.count({
      where: {
        whatsappPhone: sanitizedPhone,
        generalStatus: 'CONFIRMED',
      },
    });
  }

  /**
   * Calcula os próximos horários livres no mesmo dia respeitando a duração de cada procedimento
   */
  async getAvailableSlotsAfter(
    referenceDate: Date,
    durationMinutes: number = 60,
    tz: string = SALON_CONFIG.timezone
  ): Promise<string[]> {
    const dt = DateTime.fromJSDate(referenceDate, { zone: tz });
    if (!dt.isValid || dt.weekday === 7) return [];

    const dayStart = dt.startOf('day');
    const dayEnd = dt.endOf('day');

    const dayAppointments = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
        depositStatus: { not: 'EXPIRED' },
        appointmentDate: {
          gte: dayStart.toJSDate(),
          lte: dayEnd.toJSDate(),
        },
      },
      select: {
        appointmentDate: true,
        service: true,
      },
    });

    const dayBlocks = await prisma.blockedSlot.findMany({
      where: {
        startTime: { lt: dayEnd.toJSDate() },
        endTime: { gt: dayStart.toJSDate() },
      },
      select: {
        startTime: true,
        endTime: true,
      },
    });

    const busyWindows: Array<{ startMs: number; endMs: number }> = [];
    for (const apt of dayAppointments) {
      const startMs = apt.appointmentDate.getTime();
      const aptDuration = inferAppointmentDurationMinutes(apt.service);
      busyWindows.push({ startMs, endMs: startMs + aptDuration * 60 * 1000 });
    }
    for (const b of dayBlocks) {
      busyWindows.push({ startMs: b.startTime.getTime(), endMs: b.endTime.getTime() });
    }

    const isSaturday = dt.weekday === 6;
    const openHour = isSaturday ? 8 : 9;
    const lastSlotHour = isSaturday ? 18 : 19;
    const lastSlotMin = isSaturday ? 0 : 30;

    const openDt = dt.set({ hour: openHour, minute: 0, second: 0, millisecond: 0 });
    const lastSlotDt = dt.set({ hour: lastSlotHour, minute: lastSlotMin, second: 0, millisecond: 0 });

    const allFreeSlots: Array<{ timeStr: string; startMs: number }> = [];
    let cursor = openDt;
    while (cursor <= lastSlotDt) {
      const sMs = cursor.toJSDate().getTime();
      const eMs = sMs + durationMinutes * 60 * 1000;
      const tuesdayBlocked = isBiweeklyTuesdayBlocked(cursor.toJSDate(), durationMinutes, tz);
      const hasConflict = busyWindows.some((w) => sMs < w.endMs && eMs > w.startMs);

      if (!tuesdayBlocked && !hasConflict) {
        allFreeSlots.push({ timeStr: cursor.toFormat('HH:mm'), startMs: sMs });
      }
      cursor = cursor.plus({ minutes: 30 });
    }

    const refMs = referenceDate.getTime();
    const afterRef = allFreeSlots.filter((s) => s.startMs >= refMs).map((s) => s.timeStr);
    if (afterRef.length > 0) {
      return afterRef.slice(0, 3);
    }
    return allFreeSlots.slice(0, 3).map((s) => s.timeStr);
  }

  /**
   * Valida se um determinado horário está disponível para agendamento,
   * respeitando rigorosamente o tempo de cada procedimento (ex: 90min Manutenção de Cílios, 30min Design de Sobrancelha).
   */
  async isSlotAvailable(appointmentDate: Date, durationMinutes: number = 60): Promise<SlotAvailabilityResult> {
    const tz = SALON_CONFIG.timezone;

    // 1. Verifica bloqueio quinzenal às terças (Regra de Sigilo Absoluto: NUNCA expõe detalhes à cliente)
    if (isBiweeklyTuesdayBlocked(appointmentDate, durationMinutes, tz)) {
      const suggested = await this.getAvailableSlotsAfter(appointmentDate, durationMinutes, tz);
      return {
        available: false,
        conflictType: 'PERSONAL_BLOCK',
        nextAvailableTime: suggested[0],
        suggestedSlots: suggested,
        reason: 'Horário indisponível na agenda.',
      };
    }

    // 2. Verifica se a data está dentro do mês aberto
    if (!isDateWithinOpenMonth(appointmentDate)) {
      return {
        available: false,
        conflictType: 'CLOSED_MONTH',
        reason: 'A agenda para esta data ainda não está aberta. O atendimento aceita marcações dentro do mês vigente.',
      };
    }

    const appStart = appointmentDate;
    const appEnd = new Date(appointmentDate.getTime() + durationMinutes * 60 * 1000);

    // 3. Verifica bloqueios executivos cadastrados pela Janaína na base (REGRA DE SIGILO ABSOLUTO)
    const blockedSlot = await prisma.blockedSlot.findFirst({
      where: {
        startTime: { lt: appEnd },
        endTime: { gt: appStart },
      },
    });

    if (blockedSlot) {
      const suggested = await this.getAvailableSlotsAfter(blockedSlot.endTime, durationMinutes, tz);
      return {
        available: false,
        conflictType: 'PERSONAL_BLOCK',
        nextAvailableTime: suggested[0],
        suggestedSlots: suggested,
        reason: 'Horário indisponível na agenda.',
      };
    }

    // 4. Verifica conflitos com TODOS os agendamentos ativos do dia, usando a duração real de cada procedimento!
    const targetDt = DateTime.fromJSDate(appStart, { zone: tz });
    const dayStart = targetDt.startOf('day').toJSDate();
    const dayEnd = targetDt.endOf('day').toJSDate();

    const dayAppointments = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
        depositStatus: { not: 'EXPIRED' },
        appointmentDate: {
          gte: dayStart,
          lte: dayEnd,
        },
      },
      orderBy: { appointmentDate: 'asc' },
    });

    for (const existing of dayAppointments) {
      const existingStart = existing.appointmentDate.getTime();
      const existingDuration = inferAppointmentDurationMinutes(existing.service);
      const existingEnd = existingStart + existingDuration * 60 * 1000;

      if (appStart.getTime() < existingEnd && appEnd.getTime() > existingStart) {
        const existingEndDate = new Date(existingEnd);
        const existingEndFormatted = DateTime.fromJSDate(existingEndDate, { zone: tz }).toFormat('HH:mm');
        const suggested = await this.getAvailableSlotsAfter(existingEndDate, durationMinutes, tz);
        const nextSlot = suggested.includes(existingEndFormatted)
          ? existingEndFormatted
          : suggested[0] || existingEndFormatted;

        return {
          available: false,
          conflictType: 'APPOINTMENT_CONFLICT',
          nextAvailableTime: nextSlot,
          suggestedSlots: suggested.length > 0 ? suggested : [existingEndFormatted],
          reason: `Já existe um procedimento agendado neste horário (disponível a partir das ${nextSlot}).`,
        };
      }
    }

    return { available: true };
  }

  /**
   * Persiste ou atualiza imediatamente o agendamento no banco de dados.
   * Suporta os nomes customerName / clientName, customerPhone / whatsappPhone, serviceName / service,
   * overallStatus ('PRE_BOOKED', 'CONFIRMED', 'CANCELLED') e generalStatus ('PRE_SCHEDULED', 'CONFIRMED', 'CANCELLED').
   */
  async createOrUpdateAppointment(input: CreateOrUpdateAppointmentInput) {
    const clientName = (input.customerName || input.clientName || 'Cliente WhatsApp').trim();
    const phone = sanitizeToE164(input.customerPhone || input.whatsappPhone || '');
    const service = (input.serviceName || input.service || 'Design de Sobrancelha').trim();

    let appointmentDate: Date;
    if (input.appointmentDate instanceof Date) {
      appointmentDate = input.appointmentDate;
    } else if (typeof input.appointmentDate === 'string') {
      if (input.appointmentDate.includes('T') && (input.appointmentDate.includes('-') || input.appointmentDate.includes('Z') || input.appointmentDate.includes('+'))) {
        appointmentDate = new Date(input.appointmentDate);
      } else {
        appointmentDate = DateTime.fromISO(input.appointmentDate, { zone: SALON_CONFIG.timezone }).toJSDate();
      }
    } else {
      appointmentDate = new Date();
    }

    let depositDeadline: Date;
    if (input.depositDeadline instanceof Date) {
      depositDeadline = input.depositDeadline;
    } else if (input.depositDeadline && typeof input.depositDeadline === 'string') {
      depositDeadline = new Date(input.depositDeadline);
    } else {
      depositDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000);
    }

    const depositStatus = input.depositStatus || 'PENDING';
    const generalStatus: 'PRE_SCHEDULED' | 'CONFIRMED' | 'CANCELLED' =
      input.overallStatus === 'PRE_BOOKED'
        ? 'PRE_SCHEDULED'
        : input.overallStatus === 'CONFIRMED' || input.generalStatus === 'CONFIRMED'
        ? 'CONFIRMED'
        : input.overallStatus === 'CANCELLED' || input.generalStatus === 'CANCELLED'
        ? 'CANCELLED'
        : input.generalStatus || 'PRE_SCHEDULED';

    const isFirstAppointment = input.isFirstAppointment !== undefined ? input.isFirstAppointment : true;
    const totalAmount = new Prisma.Decimal(input.totalAmount);
    const depositAmount =
      input.depositAmount !== undefined
        ? new Prisma.Decimal(input.depositAmount)
        : depositStatus === 'EXEMPT'
        ? new Prisma.Decimal(0)
        : new Prisma.Decimal(calculateDeposit50Percent(Number(input.totalAmount)));

    let existing = null;
    if (input.id) {
      existing = await prisma.appointment.findUnique({ where: { id: input.id } });
    }
    if (!existing && phone) {
      existing = await prisma.appointment.findFirst({
        where: {
          whatsappPhone: phone,
          appointmentDate,
          generalStatus: { not: 'CANCELLED' },
        },
      });
    }

    let appointment;
    if (existing) {
      appointment = await prisma.appointment.update({
        where: { id: existing.id },
        data: {
          clientName,
          service,
          appointmentDate,
          totalAmount,
          depositAmount,
          depositStatus,
          generalStatus,
          depositDeadline,
          isFirstAppointment,
          notes: input.notes !== undefined ? input.notes : existing.notes,
        },
      });
    } else {
      appointment = await prisma.appointment.create({
        data: {
          id: input.id,
          clientName,
          whatsappPhone: phone,
          service,
          appointmentDate,
          totalAmount,
          depositAmount,
          depositStatus,
          generalStatus,
          depositDeadline,
          isFirstAppointment,
          notes: input.notes || null,
        },
      });
    }

    const pixKey = SALON_CONFIG.pixKey || STUDIO_OFFICIAL_PIX_KEY;
    const deadlineLuxon = DateTime.fromJSDate(appointment.depositDeadline, { zone: SALON_CONFIG.timezone });
    const depositDeadlineFormatted = deadlineLuxon.toFormat('HH:mm (dd/MM)');
    const isExistingClient = !appointment.isFirstAppointment;

    return {
      success: true,
      appointmentId: appointment.id,
      id: appointment.id,
      customerName: appointment.clientName,
      clientName: appointment.clientName,
      customerPhone: appointment.whatsappPhone,
      whatsappPhone: appointment.whatsappPhone,
      serviceName: appointment.service,
      service: appointment.service,
      appointmentDate: appointment.appointmentDate.toISOString(),
      totalAmount: Number(appointment.totalAmount),
      depositAmount: Number(appointment.depositAmount),
      depositStatus: appointment.depositStatus,
      generalStatus: appointment.generalStatus,
      overallStatus: appointment.generalStatus === 'PRE_SCHEDULED' ? 'PRE_BOOKED' : appointment.generalStatus,
      isFirstAppointment: appointment.isFirstAppointment,
      depositDeadline: appointment.depositDeadline.toISOString(),
      depositDeadlineFormatted,
      pixKey,
      pixPayload: isExistingClient ? null : `PIX-JF-${appointment.id.slice(0, 8).toUpperCase()}`,
      message: isExistingClient
        ? 'Agendamento confirmado com sucesso com isenção de sinal (Cliente Antiga)!'
        : 'Pré-agendamento registrado com sucesso. Aguardando envio de sinal Pix.',
      appointment,
    };
  }

  /**
   * Registra um novo agendamento com aplicação da regra de sinal diferenciada (Cliente Nova vs Cliente Antiga)
   */
  async createAliciaAppointment(input: WebhookAliciaInput) {
    const validated = WebhookAliciaSchema.parse(input);
    const sanitizedPhone = sanitizeToE164(validated.whatsappPhone);
    const appointmentDate = new Date(validated.appointmentDate);
    const durationMinutes = validated.durationMinutes || inferAppointmentDurationMinutes(validated.service);

    // 1. Valida se o horário está disponível
    const availability = await this.isSlotAvailable(appointmentDate, durationMinutes);
    if (!availability.available) {
      throw new Error(availability.reason || 'Horário indisponível na agenda.');
    }

    // 2. Consulta histórico da cliente na base
    const confirmedCount = await this.getClientConfirmedCount(sanitizedPhone);
    const isExistingClient = confirmedCount > 0;
    const isFirstAppointment = !isExistingClient;

    let depositStatus: 'PENDING' | 'EXEMPT' = 'PENDING';
    let generalStatus: 'PRE_SCHEDULED' | 'CONFIRMED' = 'PRE_SCHEDULED';
    let calculatedDeposit = 0;

    if (isExistingClient) {
      // CASO B: Cliente Antiga (1+ agendamento confirmado) -> ISENTA DE SINAL
      depositStatus = 'EXEMPT';
      generalStatus = 'CONFIRMED';
      calculatedDeposit = 0;
    } else {
      // CASO A: Cliente Nova (0 agendamentos) -> EXIGE SINAL DE 50%
      depositStatus = 'PENDING';
      generalStatus = 'PRE_SCHEDULED';
      calculatedDeposit =
        validated.depositAmount !== undefined
          ? validated.depositAmount
          : calculateDeposit50Percent(validated.totalAmount);
    }

    const depositDeadline = validated.depositDeadline
      ? new Date(validated.depositDeadline)
      : new Date(Date.now() + 2 * 60 * 60 * 1000);

    const record = await this.createOrUpdateAppointment({
      customerName: validated.clientName,
      customerPhone: sanitizedPhone,
      serviceName: validated.service,
      appointmentDate,
      totalAmount: validated.totalAmount,
      depositAmount: calculatedDeposit,
      depositStatus,
      overallStatus: generalStatus === 'PRE_SCHEDULED' ? 'PRE_BOOKED' : generalStatus,
      depositDeadline,
      isFirstAppointment,
      notes: validated.notes || undefined,
    });

    const appointment = record.appointment;
    const pixKey = record.pixKey;
    const depositDeadlineFormatted = record.depositDeadlineFormatted;

    // Dispara mensagens do WhatsApp conforme o tipo de cliente
    if (isExistingClient) {
      // Notifica cliente antiga (Isenta)
      try {
        await notifyExemptClientViaWhatsApp(appointment);
        await notifyOwnerOnConfirmation(appointment, 'Alícia (Isenção Cliente Antiga)');
      } catch (err) {
        console.warn('⚠️ Não foi possível disparar WhatsApp para cliente antiga:', err);
      }
    } else {
      // Notifica cliente nova (Instruções do Pix)
      try {
        await sendPixPaymentInstructions(appointment, pixKey, depositDeadlineFormatted);
      } catch (err) {
        console.warn('⚠️ Não foi possível disparar WhatsApp inicial de Pix:', err);
      }
    }

    return {
      success: true,
      appointmentId: appointment.id,
      clientName: appointment.clientName,
      whatsappPhone: appointment.whatsappPhone,
      service: appointment.service,
      appointmentDate: appointment.appointmentDate.toISOString(),
      totalAmount: Number(appointment.totalAmount),
      depositAmount: Number(appointment.depositAmount),
      depositStatus: appointment.depositStatus,
      generalStatus: appointment.generalStatus,
      isFirstAppointment: appointment.isFirstAppointment,
      depositDeadline: appointment.depositDeadline.toISOString(),
      depositDeadlineFormatted,
      pixKey,
      pixPayload: isExistingClient ? null : `PIX-JF-${appointment.id.slice(0, 8).toUpperCase()}`,
      message: isExistingClient
        ? 'Agendamento confirmado com sucesso com isenção de sinal (Cliente Antiga)!'
        : 'Pré-agendamento registrado com sucesso. Aguardando envio do sinal via Pix (Cliente Nova).',
    };
  }

  /**
   * Solicitação de Remarcação de Horário com política de 24h
   */
  async requestReschedule(id: string, newDateIso: string, durationMinutes: number = 60) {
    const existing = await prisma.appointment.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Agendamento com ID ${id} não encontrado.`);
    }

    const tz = SALON_CONFIG.timezone;
    const now = DateTime.now().setZone(tz);
    const originalDate = DateTime.fromJSDate(existing.appointmentDate, { zone: tz });
    const newDate = new Date(newDateIso);

    // Valida disponibilidade do novo horário
    const availability = await this.isSlotAvailable(newDate, durationMinutes);
    if (!availability.available) {
      throw new Error(availability.reason || 'Novo horário indisponível.');
    }

    // Calcula se o aviso foi feito com >= 24h de antecedência do horário original
    const hoursNotice = originalDate.diff(now, 'hours').hours;
    const isWithinDeadline = hoursNotice >= 24;

    if (isWithinDeadline) {
      // Remarcação dentro do prazo (>= 24h) -> Sem penalidade
      const updated = await prisma.appointment.update({
        where: { id },
        data: {
          appointmentDate: newDate,
          notes: existing.notes ? `${existing.notes} | [Remarcado >24h]` : '[Remarcado >24h]',
        },
      });

      const messageText = buildRescheduleWithin24hMessage({ clientName: existing.clientName });
      return {
        success: true,
        penaltyApplied: false,
        hoursNotice: Math.round(hoursNotice),
        message: messageText,
        appointment: updated,
      };
    } else {
      // Remarcação fora do prazo (< 24h) -> Perde isenção / exige cobrança de novo sinal de 50%
      const totalAmountNum = Number(existing.totalAmount);
      const newDepositAmount = calculateDeposit50Percent(totalAmountNum);
      const depositDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000);

      const newDateDt = DateTime.fromJSDate(newDate, { zone: tz }).setLocale('pt-BR');
      const newDateFormatted = `${newDateDt.toFormat('dd/MM/yyyy (cccc)')} às ${newDateDt.toFormat('HH:mm')}`;
      const deadlineDt = DateTime.fromJSDate(depositDeadline, { zone: tz });
      const depositDeadlineFormatted = deadlineDt.toFormat('HH:mm (dd/MM)');

      const updated = await prisma.appointment.update({
        where: { id },
        data: {
          appointmentDate: newDate,
          depositStatus: 'PENDING',
          generalStatus: 'PRE_SCHEDULED',
          depositAmount: new Prisma.Decimal(newDepositAmount),
          depositDeadline,
          notes: existing.notes ? `${existing.notes} | [Remarcado <24h - Sinal Exigido]` : '[Remarcado <24h - Sinal Exigido]',
        },
      });

      const messageText = getLateRescheduleDepositMessage({
        customerName: existing.clientName,
        newDateFormatted,
        depositAmount: newDepositAmount,
        depositDeadlineFormatted,
      });

      return {
        success: true,
        penaltyApplied: true,
        hoursNotice: Math.round(hoursNotice),
        depositAmountRequired: newDepositAmount,
        pixKey: SALON_CONFIG.pixKey || STUDIO_OFFICIAL_PIX_KEY,
        depositDeadlineFormatted,
        message: messageText,
        appointment: updated,
      };
    }
  }

  /**
   * Confirmação manual de sinal pelo operador
   */
  async confirmDeposit(id: string, confirmedBy: string = 'Operador', notes?: string) {
    const existing = await prisma.appointment.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Agendamento com ID ${id} não encontrado.`);
    }

    if (existing.depositStatus === 'CONFIRMED') {
      return { success: true, message: 'Sinal já estava confirmado anteriormente.', appointment: existing };
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: {
        depositStatus: 'CONFIRMED',
        generalStatus: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedBy: confirmedBy || 'Operador',
        notes: notes ? (existing.notes ? `${existing.notes} | ${notes}` : notes) : existing.notes,
      },
    });

    try {
      await notifyClientViaWhatsApp(updated);
    } catch (err) {
      console.error('Erro ao notificar cliente via WhatsApp após confirmação de sinal:', err);
    }

    try {
      await notifyOwnerOnConfirmation(updated, confirmedBy || 'Operador');
    } catch (err) {
      console.error('Erro ao notificar dona do studio via WhatsApp após confirmação de sinal:', err);
    }

    return {
      success: true,
      message: 'Sinal confirmado com sucesso! Cliente e proprietária notificados via WhatsApp.',
      appointment: updated,
    };
  }

  /**
   * Marcação de envio de comprovante pela cliente
   */
  async markReceiptSent(id: string, notes?: string) {
    const existing = await prisma.appointment.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Agendamento com ID ${id} não encontrado.`);
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: {
        depositStatus: 'RECEIPT_SENT',
        notes: notes ? (existing.notes ? `${existing.notes} | [Comprovante]: ${notes}` : `[Comprovante]: ${notes}`) : existing.notes,
      },
    });

    return {
      success: true,
      message: 'Comprovante marcado como recebido com prioridade no dashboard.',
      appointment: updated,
    };
  }

  /**
   * Cancelamento manual do agendamento
   */
  async cancelAppointment(id: string, reason?: string) {
    const existing = await prisma.appointment.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Agendamento com ID ${id} não encontrado.`);
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: {
        generalStatus: 'CANCELLED',
        notes: reason ? (existing.notes ? `${existing.notes} | [Cancelado]: ${reason}` : `[Cancelado]: ${reason}`) : existing.notes,
      },
    });

    return {
      success: true,
      message: 'Agendamento cancelado e horário liberado.',
      appointment: updated,
    };
  }

  /**
   * Exclusão definitiva de agendamento (ex: duplicado ou cancelado)
   */
  async deleteAppointment(id: string) {
    const existing = await prisma.appointment.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Agendamento com ID ${id} não encontrado.`);
    }
    await prisma.appointment.delete({ where: { id } });
    return {
      success: true,
      message: 'Agendamento excluído definitivamente.',
    };
  }

  /**
   * Rotina de expiração automática: cancela agendamentos PENDING cujo prazo expirou
   */
  async expirePendingDeposits() {
    const now = new Date();

    const expiredItems = await prisma.appointment.findMany({
      where: {
        depositStatus: 'PENDING',
        depositDeadline: { lt: now },
        generalStatus: { not: 'CANCELLED' },
      },
    });

    if (expiredItems.length === 0) {
      return { expiredCount: 0 };
    }

    const updateResult = await prisma.appointment.updateMany({
      where: {
        id: { in: expiredItems.map((item) => item.id) },
      },
      data: {
        depositStatus: 'EXPIRED',
        generalStatus: 'CANCELLED',
      },
    });

    console.log(`⏰ [CRON SINAIS] ${updateResult.count} pré-agendamento(s) expirados por falta de sinal.`);
    return { expiredCount: updateResult.count, expiredIds: expiredItems.map((i) => i.id) };
  }

  /**
   * Dashboard Semanal com métricas agregadas, clientes isentas, e bloqueios de agenda recorrentes
   */
  async getWeeklyDashboard(startDateStr?: string, endDateStr?: string, statusFilter?: string) {
    const tz = SALON_CONFIG.timezone;
    const nowLuxon = DateTime.now().setZone(tz);

    let start: DateTime;
    let end: DateTime;

    if (startDateStr && endDateStr) {
      start = DateTime.fromISO(startDateStr, { zone: tz }).startOf('day');
      end = DateTime.fromISO(endDateStr, { zone: tz }).endOf('day');
    } else {
      start = nowLuxon.startOf('week');
      end = nowLuxon.endOf('week');
    }

    const startJS = start.toJSDate();
    const endJS = end.toJSDate();

    const whereClause: Prisma.AppointmentWhereInput = {
      appointmentDate: {
        gte: startJS,
        lte: endJS,
      },
    };

    if (statusFilter && statusFilter !== 'ALL') {
      if (statusFilter === 'PENDING') {
        whereClause.depositStatus = 'PENDING';
      } else if (statusFilter === 'RECEIPT_SENT') {
        whereClause.depositStatus = 'RECEIPT_SENT';
      } else if (statusFilter === 'CONFIRMED') {
        whereClause.depositStatus = 'CONFIRMED';
      } else if (statusFilter === 'EXEMPT') {
        whereClause.depositStatus = 'EXEMPT';
      } else if (statusFilter === 'EXPIRED') {
        whereClause.depositStatus = 'EXPIRED';
      }
    }

    const [appointments, aggregateConfirmed, aggregateExempt, totalCount, pendingCount, receiptSentCount, exemptCount, expiredCount] =
      await Promise.all([
        prisma.appointment.findMany({
          where: whereClause,
          orderBy: { appointmentDate: 'asc' },
        }),
        prisma.appointment.aggregate({
          where: {
            appointmentDate: { gte: startJS, lte: endJS },
            depositStatus: 'CONFIRMED',
            generalStatus: { not: 'CANCELLED' },
          },
          _sum: {
            depositAmount: true,
            totalAmount: true,
          },
          _count: {
            id: true,
          },
        }),
        prisma.appointment.aggregate({
          where: {
            appointmentDate: { gte: startJS, lte: endJS },
            depositStatus: 'EXEMPT',
            generalStatus: { not: 'CANCELLED' },
          },
          _sum: {
            totalAmount: true,
          },
          _count: {
            id: true,
          },
        }),
        prisma.appointment.count({
          where: { appointmentDate: { gte: startJS, lte: endJS }, generalStatus: { not: 'CANCELLED' } },
        }),
        prisma.appointment.count({
          where: { appointmentDate: { gte: startJS, lte: endJS }, depositStatus: 'PENDING', generalStatus: { not: 'CANCELLED' } },
        }),
        prisma.appointment.count({
          where: { appointmentDate: { gte: startJS, lte: endJS }, depositStatus: 'RECEIPT_SENT', generalStatus: { not: 'CANCELLED' } },
        }),
        prisma.appointment.count({
          where: { appointmentDate: { gte: startJS, lte: endJS }, depositStatus: 'EXEMPT', generalStatus: { not: 'CANCELLED' } },
        }),
        prisma.appointment.count({
          where: {
            appointmentDate: { gte: startJS, lte: endJS },
            OR: [{ depositStatus: 'EXPIRED' }, { generalStatus: 'CANCELLED' }],
          },
        }),
      ]);

    const now = new Date();

    const schedule: any[] = appointments.map((apt) => {
      const isPending = apt.depositStatus === 'PENDING';
      const deadline = new Date(apt.depositDeadline);
      const diffMs = deadline.getTime() - now.getTime();
      const timeLeftMinutes = isPending ? Math.max(0, Math.floor(diffMs / (1000 * 60))) : null;

      const isExpiringSoon = isPending && timeLeftMinutes !== null && timeLeftMinutes <= 30 && timeLeftMinutes > 0;
      const isExpired = isPending && diffMs <= 0;

      const aptDt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz }).setLocale('pt-BR');
      let cleanClientName = (apt.clientName || '').replace(/\s+(?:às|as|para|no|na)$/i, '').trim();
      if (!cleanClientName || /^cliente(\s*\(.*\))?$/i.test(cleanClientName)) {
        const nameNoteMatch = (apt.notes || '').match(/cliente:\s*([^|;,\n\]]+)/i);
        if (nameNoteMatch) cleanClientName = nameNoteMatch[1].trim();
      }
      let cleanService = apt.service;
      if (/studio\s*jf|procedimento\s*studio/i.test(cleanService)) {
        const noteMatch = (apt.notes || '').match(/procedimento:\s*([^|;,\n\]]+)/i);
        cleanService = noteMatch ? noteMatch[1].trim() : 'Design de Sobrancelha';
      }
      const aptDuration = inferAppointmentDurationMinutes(cleanService);
      const aptEndDt = aptDt.plus({ minutes: aptDuration });

      return {
        id: apt.id,
        clientName: cleanClientName,
        customerName: cleanClientName,
        whatsappPhone: apt.whatsappPhone,
        customerPhone: apt.whatsappPhone,
        service: cleanService,
        serviceName: cleanService,
        durationMinutes: aptDuration,
        durationLabel: formatDurationLabel(aptDuration),
        appointmentDate: apt.appointmentDate.toISOString(),
        dateKey: aptDt.toISODate(),
        startTimeStr: aptDt.toFormat('HH:mm'),
        endTimeStr: aptEndDt.toFormat('HH:mm'),
        formattedDate: aptDt.toFormat('dd/MM (cccc)'),
        formattedTime: `${aptDt.toFormat('HH:mm')} às ${aptEndDt.toFormat('HH:mm')}`,
        totalAmount: Number(apt.totalAmount),
        depositAmount: Number(apt.depositAmount),
        depositStatus: apt.depositStatus,
        generalStatus: apt.generalStatus,
        overallStatus: apt.generalStatus === 'PRE_SCHEDULED' ? 'PRE_BOOKED' : apt.generalStatus,
        isFirstAppointment: apt.isFirstAppointment,
        reminderSent24h: apt.reminderSent24h,
        depositDeadline: apt.depositDeadline.toISOString(),
        confirmedAt: apt.confirmedAt ? apt.confirmedAt.toISOString() : null,
        confirmedBy: apt.confirmedBy,
        notes: apt.notes,
        timeLeftMinutes,
        isExpiringSoon,
        isExpired,
        isBlockedSlot: false,
      };
    });

    // Injeta visualmente o Bloqueio Quinzenal na terça-feira caso pertença à semana filtrada
    let cursor = start.startOf('day');
    while (cursor <= end) {
      const checkDate = cursor.set({ hour: 13, minute: 0 }).toJSDate();
      if (isBiweeklyTuesdayBlocked(checkDate, 60, tz)) {
        const dateStr = cursor.setLocale('pt-BR').toFormat('dd/MM (cccc)');
        schedule.push({
          id: `blocked-tuesday-${cursor.toISODate()}`,
          clientName: 'Compromisso Pessoal',
          whatsappPhone: 'N/A',
          service: 'Bloqueio Quinzenal de Agenda',
          appointmentDate: cursor.set({ hour: 13, minute: 0 }).toISODate(),
          dateKey: cursor.toISODate(),
          startTimeStr: '13:00',
          endTimeStr: '15:30',
          durationMinutes: 150,
          formattedDate: dateStr,
          formattedTime: '13:00 às 15:30',
          totalAmount: 0,
          depositAmount: 0,
          depositStatus: 'BLOCKED',
          generalStatus: 'CANCELLED',
          isFirstAppointment: false,
          notes: 'Bloqueio Quinzenal Recorrente de Agenda (Terças 13h - 15h30)',
          isBlockedSlot: true,
        });
      }
      cursor = cursor.plus({ days: 1 });
    }

    // Injeta os bloqueios pontuais cadastrados pela Janaína no banco (BlockedSlot)
    const dbBlockedSlots = await prisma.blockedSlot.findMany({
      where: {
        startTime: { lte: endJS },
        endTime: { gte: startJS },
      },
      orderBy: { startTime: 'asc' },
    });

    dbBlockedSlots.forEach((bs) => {
      const bsDt = DateTime.fromJSDate(bs.startTime, { zone: tz }).setLocale('pt-BR');
      const bsEndDt = DateTime.fromJSDate(bs.endTime, { zone: tz }).setLocale('pt-BR');
      const durMin = Math.max(30, Math.round(bsEndDt.diff(bsDt, 'minutes').minutes));
      schedule.push({
        id: bs.id,
        clientName: 'Compromisso Pessoal / Indisponível',
        whatsappPhone: 'N/A',
        service: bs.title || 'Bloqueio Executivo',
        appointmentDate: bs.startTime.toISOString(),
        dateKey: bsDt.toISODate(),
        startTimeStr: bsDt.toFormat('HH:mm'),
        endTimeStr: bsEndDt.toFormat('HH:mm'),
        durationMinutes: durMin,
        formattedDate: bsDt.toFormat('dd/MM (cccc)'),
        formattedTime: `${bsDt.toFormat('HH:mm')} às ${bsEndDt.toFormat('HH:mm')}`,
        totalAmount: 0,
        depositAmount: 0,
        depositStatus: 'BLOCKED',
        generalStatus: 'CANCELLED',
        isFirstAppointment: false,
        notes: bs.reason || 'Compromisso Pessoal (Sigilo Interno)',
        isBlockedSlot: true,
      });
    });

    // Re-ordena o cronograma por data
    schedule.sort((a, b) => new Date(a.appointmentDate).getTime() - new Date(b.appointmentDate).getTime());

    const confirmedDepositsCount = (aggregateConfirmed._count.id || 0) + (aggregateExempt._count.id || 0);
    const confirmedDepositsTotal = Number(aggregateConfirmed._sum.depositAmount || 0);
    const totalExpectedRevenue =
      Number(aggregateConfirmed._sum.totalAmount || 0) + Number(aggregateExempt._sum.totalAmount || 0);

    const lossRate =
      totalCount > 0 ? Number(((expiredCount / totalCount) * 100).toFixed(1)) : 0;

    return {
      period: {
        startDate: start.toISODate() || '',
        endDate: end.toISODate() || '',
        formattedPeriod: `${start.toFormat('dd/MM')} a ${end.toFormat('dd/MM/yyyy')}`,
      },
      metrics: {
        totalAppointments: totalCount,
        confirmedDepositsCount,
        confirmedDepositsTotal,
        totalExpectedRevenue,
        pendingDepositsCount: pendingCount + receiptSentCount,
        pendingOnlyCount: pendingCount,
        receiptSentCount,
        exemptCount,
        expiredDepositsCount: expiredCount,
        lossRate,
      },
      schedule,
    };
  }

  /**
   * Agregação analítica para o Resumo Semanal da Proprietária
   */
  async getWeeklyOwnerReportData(referenceDate?: Date): Promise<WeeklyOwnerReportData> {
    const tz = SALON_CONFIG.timezone;
    const ref = referenceDate
      ? DateTime.fromJSDate(referenceDate, { zone: tz })
      : DateTime.now().setZone(tz);

    const pastWeekStart = ref.startOf('week');
    const pastWeekEnd = ref.endOf('week');

    const nextWeekStart = ref.plus({ weeks: 1 }).startOf('week');
    const nextWeekEnd = ref.plus({ weeks: 1 }).endOf('week');

    const [pastConfirmedAgg, pastCancelledOrExpiredCount] = await Promise.all([
      prisma.appointment.aggregate({
        where: {
          appointmentDate: {
            gte: pastWeekStart.toJSDate(),
            lte: pastWeekEnd.toJSDate(),
          },
          depositStatus: { in: ['CONFIRMED', 'EXEMPT'] },
        },
        _sum: {
          depositAmount: true,
          totalAmount: true,
        },
        _count: {
          id: true,
        },
      }),
      prisma.appointment.count({
        where: {
          appointmentDate: {
            gte: pastWeekStart.toJSDate(),
            lte: pastWeekEnd.toJSDate(),
          },
          OR: [{ depositStatus: 'EXPIRED' }, { generalStatus: 'CANCELLED' }],
        },
      }),
    ]);

    const [nextWeekActiveAppointments, nextWeekConfirmedCount, nextWeekPendingCount] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          appointmentDate: {
            gte: nextWeekStart.toJSDate(),
            lte: nextWeekEnd.toJSDate(),
          },
          generalStatus: { not: 'CANCELLED' },
          depositStatus: { not: 'EXPIRED' },
        },
        select: {
          id: true,
          appointmentDate: true,
          depositStatus: true,
        },
      }),
      prisma.appointment.count({
        where: {
          appointmentDate: {
            gte: nextWeekStart.toJSDate(),
            lte: nextWeekEnd.toJSDate(),
          },
          depositStatus: { in: ['CONFIRMED', 'EXEMPT'] },
        },
      }),
      prisma.appointment.count({
        where: {
          appointmentDate: {
            gte: nextWeekStart.toJSDate(),
            lte: nextWeekEnd.toJSDate(),
          },
          depositStatus: { in: ['PENDING', 'RECEIPT_SENT'] },
          generalStatus: { not: 'CANCELLED' },
        },
      }),
    ]);

    const dayCounts: Record<string, number> = {
      Segunda: 0,
      Terça: 0,
      Quarta: 0,
      Quinta: 0,
      Sexta: 0,
      Sábado: 0,
      Domingo: 0,
    };

    const weekdayIndexToName: Record<number, string> = {
      1: 'Segunda',
      2: 'Terça',
      3: 'Quarta',
      4: 'Quinta',
      5: 'Sexta',
      6: 'Sábado',
      7: 'Domingo',
    };

    for (const apt of nextWeekActiveAppointments) {
      const dt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz });
      const name = weekdayIndexToName[dt.weekday];
      if (name) {
        dayCounts[name] = (dayCounts[name] || 0) + 1;
      }
    }

    let maxDayCount = 0;
    for (const count of Object.values(dayCounts)) {
      if (count > maxDayCount) {
        maxDayCount = count;
      }
    }

    let busiestDaysText = 'Nenhum agendamento ainda';
    if (maxDayCount > 0) {
      const topDays = Object.entries(dayCounts)
        .filter(([_, count]) => count === maxDayCount)
        .map(([day]) => day);

      if (topDays.length === 1) {
        busiestDaysText = `${topDays[0]} (${maxDayCount} agendamento${maxDayCount > 1 ? 's' : ''})`;
      } else if (topDays.length === 2) {
        busiestDaysText = `${topDays[0]} e ${topDays[1]}`;
      } else {
        busiestDaysText = `${topDays.slice(0, -1).join(', ')} e ${topDays[topDays.length - 1]}`;
      }
    }

    return {
      pastWeek: {
        startDateStr: pastWeekStart.toFormat('dd/MM'),
        endDateStr: pastWeekEnd.toFormat('dd/MM'),
        confirmedCount: pastConfirmedAgg._count.id || 0,
        depositRevenue: Number(pastConfirmedAgg._sum.depositAmount || 0),
        totalRevenue: Number(pastConfirmedAgg._sum.totalAmount || 0),
        cancelledCount: pastCancelledOrExpiredCount,
      },
      nextWeek: {
        startDateStr: nextWeekStart.toFormat('dd/MM'),
        endDateStr: nextWeekEnd.toFormat('dd/MM'),
        totalScheduled: nextWeekActiveAppointments.length,
        confirmedCount: nextWeekConfirmedCount,
        pendingCount: nextWeekPendingCount,
        busiestDaysText,
      },
    };
  }

  /**
   * Cria agendamento diretamente pelo painel MinhaAgenda da Janaína (/dashboard)
   */
  async createOwnerDashboardAppointment(input: {
    clientName: string;
    whatsappPhone?: string;
    service?: string;
    serviceName?: string;
    date?: string; // YYYY-MM-DD
    dateStr?: string; // YYYY-MM-DD
    time?: string; // HH:mm
    timeStr?: string; // HH:mm
    totalAmount: number;
    durationMinutes?: number;
    statusMode?: 'EXEMPT' | 'CONFIRMED' | 'PENDING';
    depositStatus?: 'EXEMPT' | 'CONFIRMED' | 'PENDING';
    notes?: string;
  }) {
    const tz = SALON_CONFIG.timezone;
    const cleanName = (input.clientName || '').trim();
    if (!cleanName || cleanName.length < 2) {
      throw new Error('Informe o nome da cliente.');
    }
    const cleanService = (input.service || input.serviceName || '').trim();
    if (!cleanService) {
      throw new Error('Selecione o procedimento.');
    }

    const dStr = (input.date || input.dateStr || '').trim();
    const tStr = (input.time || input.timeStr || '09:00').trim();

    const dt = DateTime.fromISO(`${dStr}T${tStr}`, { zone: tz });
    if (!dt.isValid) {
      throw new Error('Data ou horário inválido.');
    }

    const rawPhone = (input.whatsappPhone || '').replace(/\D/g, '');
    const cleanPhone = rawPhone.length >= 8 ? sanitizeToE164(rawPhone) : '5521900000000';
    const total = Math.max(0, Number(input.totalAmount) || 0);
    const mode = input.statusMode || input.depositStatus || 'EXEMPT';

    const depositAmt =
      mode === 'EXEMPT' ? 0 : Math.round(total * 0.3 * 100) / 100;
    const depositStatus = mode === 'PENDING' ? 'PENDING' : mode === 'CONFIRMED' ? 'CONFIRMED' : 'EXEMPT';
    const generalStatus = mode === 'PENDING' ? 'PRE_SCHEDULED' : 'CONFIRMED';

    const created = await prisma.appointment.create({
      data: {
        clientName: cleanName,
        whatsappPhone: cleanPhone,
        service: cleanService,
        appointmentDate: dt.toJSDate(),
        totalAmount: new Prisma.Decimal(total),
        depositAmount: new Prisma.Decimal(depositAmt),
        depositStatus,
        generalStatus,
        depositDeadline: dt.plus({ hours: 2 }).toJSDate(),
        confirmedAt: generalStatus === 'CONFIRMED' ? new Date() : null,
        confirmedBy: generalStatus === 'CONFIRMED' ? 'Janaína (MinhaAgenda)' : null,
        isFirstAppointment: mode !== 'EXEMPT',
        notes: input.notes ? `[MinhaAgenda]: ${input.notes}` : '[Agendado pela Janaína no MinhaAgenda]',
      },
    });

    return {
      success: true,
      message: 'Agendamento registrado com sucesso na agenda!',
      id: created.id,
      clientName: created.clientName,
      appointment: created,
    };
  }

  /**
   * Edita agendamento diretamente pelo painel MinhaAgenda da Janaína (/dashboard)
   * Permite remarcar data/horário, trocar procedimento, alterar valor, telefone ou status
   */
  async editOwnerDashboardAppointment(
    id: string,
    input: {
      clientName?: string;
      whatsappPhone?: string;
      service?: string;
      serviceName?: string;
      date?: string; // YYYY-MM-DD
      dateStr?: string; // YYYY-MM-DD
      time?: string; // HH:mm
      timeStr?: string; // HH:mm
      totalAmount?: number;
      durationMinutes?: number;
      statusMode?: 'EXEMPT' | 'CONFIRMED' | 'PENDING';
      depositStatus?: 'EXEMPT' | 'CONFIRMED' | 'PENDING';
      notes?: string;
    }
  ) {
    const tz = SALON_CONFIG.timezone;
    const existing = await prisma.appointment.findUnique({ where: { id } });
    if (!existing) {
      throw new Error('Agendamento não encontrado.');
    }

    const dStr = (input.date || input.dateStr || '').trim();
    const tStr = (input.time || input.timeStr || '').trim();

    let newDateJs = existing.appointmentDate;
    if (dStr && tStr) {
      const dt = DateTime.fromISO(`${dStr}T${tStr}`, { zone: tz });
      if (!dt.isValid) {
        throw new Error('Nova data ou horário inválido.');
      }
      newDateJs = dt.toJSDate();
    } else if (tStr) {
      const currentDt = DateTime.fromJSDate(existing.appointmentDate, { zone: tz });
      const dt = DateTime.fromISO(`${currentDt.toFormat('yyyy-MM-dd')}T${tStr}`, { zone: tz });
      if (dt.isValid) newDateJs = dt.toJSDate();
    }

    const total =
      input.totalAmount !== undefined ? Math.max(0, Number(input.totalAmount)) : Number(existing.totalAmount);

    let depositStatus = existing.depositStatus;
    let generalStatus = existing.generalStatus;
    let depositAmount = Number(existing.depositAmount);
    let isFirst = existing.isFirstAppointment;

    const newMode = input.statusMode || input.depositStatus;
    if (newMode) {
      if (newMode === 'EXEMPT') {
        depositStatus = 'EXEMPT';
        generalStatus = 'CONFIRMED';
        depositAmount = 0;
        isFirst = false;
      } else if (newMode === 'CONFIRMED') {
        depositStatus = 'CONFIRMED';
        generalStatus = 'CONFIRMED';
        depositAmount = Math.round(total * 0.3 * 100) / 100;
      } else if (newMode === 'PENDING') {
        depositStatus = 'PENDING';
        generalStatus = 'PRE_SCHEDULED';
        depositAmount = Math.round(total * 0.3 * 100) / 100;
      }
    }

    let cleanPhone = existing.whatsappPhone;
    if (input.whatsappPhone !== undefined) {
      const digits = input.whatsappPhone.replace(/\D/g, '');
      cleanPhone = digits.length >= 8 ? sanitizeToE164(digits) : '5521900000000';
    }

    const newService = (input.service || input.serviceName || '').trim();

    const updated = await prisma.appointment.update({
      where: { id },
      data: {
        clientName: input.clientName ? input.clientName.trim() : existing.clientName,
        whatsappPhone: cleanPhone,
        service: newService ? newService : existing.service,
        appointmentDate: newDateJs,
        totalAmount: new Prisma.Decimal(total),
        depositAmount: new Prisma.Decimal(depositAmount),
        depositStatus,
        generalStatus,
        isFirstAppointment: isFirst,
        confirmedAt: generalStatus === 'CONFIRMED' ? existing.confirmedAt || new Date() : existing.confirmedAt,
        confirmedBy: generalStatus === 'CONFIRMED' ? existing.confirmedBy || 'Janaína (MinhaAgenda)' : existing.confirmedBy,
        notes: input.notes !== undefined ? input.notes : existing.notes,
      },
    });

    return {
      success: true,
      message: 'Agendamento atualizado com sucesso!',
      id: updated.id,
      service: updated.service,
      totalAmount: Number(updated.totalAmount),
      appointment: updated,
    };
  }

  /**
   * Cria bloqueio de horário / compromisso pessoal pelo painel MinhaAgenda (/dashboard)
   */
  async createBlockedSlotFromDashboard(input: {
    date?: string; // YYYY-MM-DD
    dateStr?: string; // YYYY-MM-DD
    startTime?: string; // HH:mm
    startTimeStr?: string; // HH:mm
    endTime?: string; // HH:mm
    endTimeStr?: string; // HH:mm
    fullDay?: boolean;
    title?: string;
    reason?: string;
  }) {
    const tz = SALON_CONFIG.timezone;
    const dStr = (input.date || input.dateStr || '').trim();
    const startStr = input.fullDay ? '08:00' : input.startTime || input.startTimeStr || '09:00';
    const endStr = input.fullDay ? '22:00' : input.endTime || input.endTimeStr || '10:00';

    const startDt = DateTime.fromISO(`${dStr}T${startStr}`, { zone: tz });
    let endDt = DateTime.fromISO(`${dStr}T${endStr}`, { zone: tz });
    if (!startDt.isValid || !endDt.isValid) {
      throw new Error('Data ou horário do bloqueio inválido.');
    }
    if (endDt <= startDt) {
      endDt = startDt.plus({ minutes: 60 });
    }

    const titleLabel = (input.title || input.reason || 'Compromisso Pessoal').trim();

    const block = await prisma.blockedSlot.create({
      data: {
        title: titleLabel,
        reason: (input.reason || 'INTERNAL_UNAVAILABLE').trim(),
        startTime: startDt.toJSDate(),
        endTime: endDt.toJSDate(),
        isRecurring: false,
      },
    });

    return {
      success: true,
      message: 'Horário bloqueado na grade com sucesso!',
      id: block.id,
      block,
    };
  }

  /**
   * Remove bloqueio de horário pelo painel MinhaAgenda (/dashboard)
   */
  async deleteBlockedSlotFromDashboard(id: string) {
    const cleanId = String(id || '').replace(/^block-/, '');
    const existing = await prisma.blockedSlot.findUnique({ where: { id: cleanId } });
    if (!existing) {
      throw new Error('Bloqueio não encontrado no banco (bloqueios quinzenais fixos não podem ser excluídos por aqui).');
    }
    await prisma.blockedSlot.delete({ where: { id: cleanId } });
    return {
      success: true,
      message: 'Horário desbloqueado e liberado na grade!',
    };
  }

  /**
   * Retorna lista consolidada de clientes (CRM MinhaAgenda) com histórico de atendimentos
   */
  async getClientsCrmList() {
    const tz = SALON_CONFIG.timezone;
    const all = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
      },
      orderBy: { appointmentDate: 'desc' },
    });

    const map = new Map<
      string,
      {
        key: string;
        name: string;
        clientName: string;
        phone: string;
        whatsappPhone: string;
        appointmentsCount: number;
        visitsCount: number;
        totalSpent: number;
        lastAppointmentDate: string;
        lastVisitIso: string;
        lastVisitFormatted: string;
        lastService: string;
        isRecurring: boolean;
        history: Array<{
          id: string;
          service: string;
          formattedDate: string;
          formattedTime: string;
          totalAmount: number;
          depositStatus: string;
        }>;
      }
    >();

    for (const apt of all) {
      const cleanName = (apt.clientName || '').replace(/\s+(?:às|as|para|no|na)$/i, '').trim();
      if (!cleanName || /^cliente/i.test(cleanName)) continue;

      const normKey = cleanName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      const aptDt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz }).setLocale('pt-BR');
      const dur = inferAppointmentDurationMinutes(apt.service);
      const aptEnd = aptDt.plus({ minutes: dur });
      const amt = Number(apt.totalAmount);

      if (!map.has(normKey)) {
        const ph = apt.whatsappPhone || '5521900000000';
        const iso = apt.appointmentDate.toISOString();
        map.set(normKey, {
          key: normKey,
          name: cleanName,
          clientName: cleanName,
          phone: ph,
          whatsappPhone: ph,
          appointmentsCount: 0,
          visitsCount: 0,
          totalSpent: 0,
          lastAppointmentDate: iso,
          lastVisitIso: iso,
          lastVisitFormatted: aptDt.toFormat("dd/MM/yyyy 'às' HH:mm"),
          lastService: apt.service,
          isRecurring: apt.depositStatus === 'EXEMPT' || !apt.isFirstAppointment,
          history: [],
        });
      }

      const entry = map.get(normKey)!;
      entry.visitsCount += 1;
      entry.appointmentsCount = entry.visitsCount;
      entry.totalSpent += amt;
      if (apt.whatsappPhone && apt.whatsappPhone !== '5521900000000' && entry.whatsappPhone === '5521900000000') {
        entry.whatsappPhone = apt.whatsappPhone;
        entry.phone = apt.whatsappPhone;
      }
      if (apt.depositStatus === 'EXEMPT' || entry.visitsCount > 1) {
        entry.isRecurring = true;
      }
      entry.history.push({
        id: apt.id,
        service: apt.service,
        formattedDate: aptDt.toFormat('dd/MM/yyyy (ccc)'),
        formattedTime: `${aptDt.toFormat('HH:mm')} às ${aptEnd.toFormat('HH:mm')}`,
        totalAmount: amt,
        depositStatus: apt.depositStatus,
      });
    }

    const clients = Array.from(map.values()).sort((a, b) => a.clientName.localeCompare(b.clientName, 'pt-BR'));
    return {
      totalClients: clients.length,
      clients,
    };
  }
}

export const defaultAppointmentService = new AppointmentService();
export const appointmentService = defaultAppointmentService;

export async function createOrUpdateAppointment(input: CreateOrUpdateAppointmentInput) {
  return defaultAppointmentService.createOrUpdateAppointment(input);
}
