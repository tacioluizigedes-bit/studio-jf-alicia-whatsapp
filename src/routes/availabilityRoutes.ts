import { Router, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { prisma } from '../lib/prisma';
import { SALON_CONFIG } from '../config/salonConfig';
import { isBiweeklyTuesdayBlocked, inferAppointmentDurationMinutes } from '../services/appointmentService';
import { serviceCatalogService } from '../services/serviceCatalogService';

export const availabilityRouter = Router();

/**
 * Catálogo unificado de procedimentos com durações exatas (em minutos)
 * para cálculo de conflitos na grade de horários.
 */
export interface PublicServiceItem {
  id: string;
  name: string;
  category: 'cilios' | 'sobrancelhas';
  categoryLabel: string;
  priceDisplay: string;
  priceMin: number;
  priceMax?: number;
  durationMinutes: number;
  durationLabel: string;
  badge?: string;
}

export interface PublicSlotItem {
  time: string;
  period: 'morning' | 'afternoon';
  available: boolean;
  statusLabel: 'Disponível' | 'Indisponível';
}

export const PUBLIC_BOOKING_SERVICES: PublicServiceItem[] = [
  // Categoria: Cílios
  {
    id: 'tufinhos_seda',
    name: 'Tufinhos de Seda',
    category: 'cilios',
    categoryLabel: 'Cílios',
    priceDisplay: 'R$ 60 a R$ 70',
    priceMin: 60,
    priceMax: 70,
    durationMinutes: 90,
    durationLabel: '1h30',
    badge: 'Rápido & Prático',
  },
  {
    id: 'fio_a_fio_classico',
    name: 'Fio a Fio Clássico',
    category: 'cilios',
    categoryLabel: 'Cílios',
    priceDisplay: 'R$ 75,00',
    priceMin: 75,
    durationMinutes: 90,
    durationLabel: '1h30',
    badge: 'Efeito Natural',
  },
  {
    id: 'volume_brasileiro',
    name: 'Volume Brasileiro',
    category: 'cilios',
    categoryLabel: 'Cílios',
    priceDisplay: 'R$ 80,00',
    priceMin: 80,
    durationMinutes: 90,
    durationLabel: '1h30',
    badge: 'Mais Pedido ⭐',
  },
  {
    id: 'volume_egipcio_fox',
    name: 'Volume Egípcio / Fox Eyes',
    category: 'cilios',
    categoryLabel: 'Cílios',
    priceDisplay: 'R$ 90,00',
    priceMin: 90,
    durationMinutes: 90,
    durationLabel: '1h30',
    badge: 'Olhar Marcante',
  },
  {
    id: 'mega_brasileiro',
    name: 'Mega Brasileiro',
    category: 'cilios',
    categoryLabel: 'Cílios',
    priceDisplay: 'R$ 90,00',
    priceMin: 90,
    durationMinutes: 90,
    durationLabel: '1h30',
    badge: 'Super Volume',
  },

  // Categoria: Sobrancelhas & Manutenções
  {
    id: 'design_sobrancelha',
    name: 'Design de Sobrancelha',
    category: 'sobrancelhas',
    categoryLabel: 'Sobrancelhas & Manutenções',
    priceDisplay: 'R$ 25,00',
    priceMin: 25,
    durationMinutes: 30,
    durationLabel: '30 min',
  },
  {
    id: 'design_henna',
    name: 'Design de Sobrancelha com Henna',
    category: 'sobrancelhas',
    categoryLabel: 'Sobrancelhas & Manutenções',
    priceDisplay: 'R$ 35,00',
    priceMin: 35,
    durationMinutes: 60,
    durationLabel: '1h',
    badge: 'Alinhamento + Cor',
  },
  {
    id: 'manutencao_cilios',
    name: 'Manutenção de Extensão de Cílios',
    category: 'sobrancelhas',
    categoryLabel: 'Sobrancelhas & Manutenções',
    priceDisplay: 'R$ 45 a R$ 65',
    priceMin: 45,
    priceMax: 65,
    durationMinutes: 90,
    durationLabel: '1h30',
    badge: 'Até 20 dias',
  },
  {
    id: 'combo_design_manutencao',
    name: 'Combo Manutenção + Design de Sobrancelha',
    category: 'sobrancelhas',
    categoryLabel: 'Sobrancelhas & Manutenções',
    priceDisplay: 'R$ 85,00',
    priceMin: 85,
    durationMinutes: 120,
    durationLabel: '2h',
    badge: 'Combo Especial',
  },
];

/**
 * Resolve a duração em minutos a partir do serviceId enviado pelo frontend
 */
function resolveServiceDuration(serviceId?: string): { durationMinutes: number; serviceName: string } {
  if (!serviceId) {
    return { durationMinutes: 60, serviceName: 'Procedimento Studio JF' };
  }

  const dynamicFound = serviceCatalogService.findService(serviceId);
  if (dynamicFound) {
    return {
      durationMinutes: dynamicFound.durationMinutes || inferAppointmentDurationMinutes(dynamicFound.name),
      serviceName: dynamicFound.name,
    };
  }

  const configFound = SALON_CONFIG.services.find((s: any) => s.id === serviceId);
  if (configFound) {
    return {
      durationMinutes: configFound.durationMinutes || inferAppointmentDurationMinutes(configFound.name),
      serviceName: configFound.name,
    };
  }

  const publicFound = PUBLIC_BOOKING_SERVICES.find((s) => s.id === serviceId);
  if (publicFound) {
    return {
      durationMinutes: publicFound.durationMinutes,
      serviceName: publicFound.name.replace('deExtensão', 'de Extensão'),
    };
  }

  return {
    durationMinutes: inferAppointmentDurationMinutes(serviceId),
    serviceName: serviceId,
  };
}

/**
 * GET /api/availability?date=YYYY-MM-DD&serviceId=XYZ
 *
 * Cruza em tempo real:
 * 1. Horário comercial (Seg-Sex 09:00-19:00 | Sáb 08:00-18:00 | Dom fechado)
 * 2. Agendamentos ativos (CONFIRMED e PRE_SCHEDULED com sinal válido)
 * 3. Bloqueios pessoais e folgas cadastrados pela Janaína (BlockedSlot)
 * 4. Bloqueio quinzenal fixo das terças-feiras (13:00 às 15:30)
 *
 * REGRA DE OURO DE SIGILO:
 * O payload público NUNCA expõe o motivo da indisponibilidade (se é outra cliente,
 * compromisso pessoal ou bloqueio quinzenal). Todos retornam exatamente "Indisponível".
 */
availabilityRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { date, serviceId } = req.query as { date?: string; serviceId?: string };
    const tz = SALON_CONFIG.timezone || 'America/Sao_Paulo';

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetro "date" inválido. Utilize o formato AAAA-MM-DD.',
      });
    }

    const targetDate = DateTime.fromISO(date, { zone: tz });
    if (!targetDate.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Data inválida fornecida para consulta.',
      });
    }

    const now = DateTime.now().setZone(tz);
    const todayStart = now.startOf('day');
    const requestedDayStart = targetDate.startOf('day');
    const requestedDayEnd = targetDate.endOf('day');

    // Bloqueia datas passadas anteriores a hoje
    if (requestedDayStart < todayStart) {
      return res.json({
        success: true,
        date,
        isOpen: false,
        isPastDate: true,
        message: 'Datas anteriores a hoje estão encerradas.',
        slots: [],
        morningSlots: [],
        afternoonSlots: [],
      });
    }

    // Luxon: 1 = Segunda ... 6 = Sábado, 7 = Domingo
    const weekday = targetDate.weekday;
    if (weekday === 7) {
      return res.json({
        success: true,
        date,
        isOpen: false,
        dayName: 'Domingo',
        message: 'O Studio JF Designer não realiza atendimentos aos domingos.',
        slots: [],
        morningSlots: [],
        afternoonSlots: [],
      });
    }

    // Horário comercial padrão: Seg-Sex (09:00 às 19:00) | Sábados (08:00 às 18:00)
    const isSaturday = weekday === 6;
    const openHour = isSaturday ? 8 : 9;
    const closeHour = isSaturday ? 18 : 19;

    const { durationMinutes, serviceName } = resolveServiceDuration(serviceId);

    // 1. Busca agendamentos ativos do dia no Prisma
    const activeAppointments = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
        depositStatus: { not: 'EXPIRED' },
        appointmentDate: {
          gte: requestedDayStart.toJSDate(),
          lte: requestedDayEnd.toJSDate(),
        },
      },
      select: {
        appointmentDate: true,
        service: true,
      },
    });

    // 2. Busca bloqueios administrativos/pessoais da Janaína para o dia (Sigilo Absoluto: apenas startTime e endTime são lidos)
    const blockedSlots = await prisma.blockedSlot.findMany({
      where: {
        startTime: { lt: requestedDayEnd.toJSDate() },
        endTime: { gt: requestedDayStart.toJSDate() },
      },
      select: {
        startTime: true,
        endTime: true,
      },
    });

    // Converte intervalos ocupados (agendamentos + bloqueios) em janelas numéricas [startMs, endMs]
    const busyWindows: Array<{ startMs: number; endMs: number }> = [];

    for (const app of activeAppointments) {
      const startMs = app.appointmentDate.getTime();
      const appDuration = inferAppointmentDurationMinutes(app.service);
      const endMs = startMs + appDuration * 60 * 1000;
      busyWindows.push({ startMs, endMs });
    }

    for (const block of blockedSlots) {
      busyWindows.push({
        startMs: block.startTime.getTime(),
        endMs: block.endTime.getTime(),
      });
    }

    // 3. Gera a grade de slots de 30 em 30 minutos dentro do expediente (Seg-Sex até 19:30 | Sáb até 18:00)
    const openDateTime = targetDate.set({ hour: openHour, minute: 0, second: 0, millisecond: 0 });
    const closeDateTime = targetDate.set({ hour: closeHour, minute: isSaturday ? 0 : 30, second: 0, millisecond: 0 });

    const stepMinutes = 30;
    let cursor = openDateTime;

    const slots: PublicSlotItem[] = [];

    // Permite início até o último horário de agendamento (19:30 em dias úteis / 18:00 aos sábados)
    while (cursor <= closeDateTime) {
      const slotStartJs = cursor.toJSDate();
      const slotStartMs = slotStartJs.getTime();
      const slotEndMs = slotStartMs + durationMinutes * 60 * 1000;

      // Verifica se já passou (caso a data consultada seja hoje)
      const isPastHour = requestedDayStart.equals(todayStart) && cursor <= now.plus({ minutes: 15 });

      // Verifica bloqueio quinzenal das terças-feiras (13:00 às 15:30)
      const isTuesdayBiweeklyBusy = isBiweeklyTuesdayBlocked(slotStartJs, durationMinutes, tz);

      // Verifica conflito com qualquer agendamento ou bloqueio pessoal da Janaína
      const hasDatabaseConflict = busyWindows.some(
        (win) => slotStartMs < win.endMs && slotEndMs > win.startMs
      );

      // REGRA DE OURO DE SIGILO:
      // Independentemente do motivo (cliente agendada, bloqueio quinzenal de terça, folga ou compromisso pessoal),
      // o retorno público é estritamente booleano + "Disponível" / "Indisponível".
      const isAvailable = !isPastHour && !isTuesdayBiweeklyBusy && !hasDatabaseConflict;
      const period: 'morning' | 'afternoon' = cursor.hour < 12 ? 'morning' : 'afternoon';

      slots.push({
        time: cursor.toFormat('HH:mm'),
        period,
        available: isAvailable,
        statusLabel: isAvailable ? 'Disponível' : 'Indisponível',
      });

      cursor = cursor.plus({ minutes: stepMinutes });
    }

    const morningSlots = slots.filter((s) => s.period === 'morning');
    const afternoonSlots = slots.filter((s) => s.period === 'afternoon');

    return res.json({
      success: true,
      date,
      isOpen: true,
      businessHours: {
        open: openDateTime.toFormat('HH:mm'),
        close: closeDateTime.toFormat('HH:mm'),
      },
      service: {
        id: serviceId || 'default',
        name: serviceName,
        durationMinutes,
      },
      summary: {
        totalSlots: slots.length,
        availableCount: slots.filter((s) => s.available).length,
        unavailableCount: slots.filter((s) => !s.available).length,
      },
      slots,
      morningSlots,
      afternoonSlots,
    });
  } catch (error: any) {
    console.error('Erro ao consultar disponibilidade pública (/api/availability):', error);
    return res.status(500).json({
      success: false,
      error: 'Não foi possível carregar os horários no momento.',
    });
  }
});

/**
 * GET /api/availability/services
 * Retorna o catálogo público de procedimentos para popular o frontend dinamicamente
 */
availabilityRouter.get('/services', (_req: Request, res: Response) => {
  const dynamicServices = serviceCatalogService.getPublicBookingServices();
  res.json({
    success: true,
    whatsappNumber: SALON_CONFIG.officialNumber || '5521960003154',
    services: dynamicServices && dynamicServices.length > 0 ? dynamicServices : PUBLIC_BOOKING_SERVICES,
  });
});
