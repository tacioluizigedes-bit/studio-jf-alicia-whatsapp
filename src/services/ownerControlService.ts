/**
 * ownerControlService.ts
 * Comandos executivos da Janaína:
 * - Consultar agenda do dia/semana
 * - Bloquear horários por compromisso pessoal (com sigilo absoluto)
 * - Cancelar/desmarcar clientes com disparo de aviso neutro e amigável
 * - Configuração executiva de grade mensal
 */

import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { SALON_CONFIG } from '../config/salonConfig';
import { sendHumanizedMessage, WhatsAppClientLike } from '../utils/whatsappHelper';
import { isBiweeklyTuesdayBlocked, sanitizeToE164, inferAppointmentDurationMinutes, formatDurationLabel } from './appointmentService';
import { OwnerAgendaSetupService } from './ownerAgendaSetupService';
import { extractBookingEntities, extractService, extractTime, extractClientName } from './nlpEntityExtractor';
import { serviceCatalogService } from './serviceCatalogService';
import { scheduleDatabaseVaultBackup } from './whatsappSessionVault';

const ownerAgendaSetupService = new OwnerAgendaSetupService();

export interface PendingOwnerConfirmation {
  type: 'BOOK_OVER_BLOCK' | 'BOOK_OVER_APPOINTMENT';
  ownerPhone: string;
  clientName: string;
  clientPhone: string;
  serviceName: string;
  totalAmount: number;
  durationMinutes: number;
  appointmentDate: Date;
  formattedDateTime: string;
  blockedSlotIds: string[];
  blockReasonText: string;
  createdAt: number;
}

// Armazena confirmações pendentes da Janaína (ex: liberar horário bloqueado para marcar cliente)
export const pendingOwnerConfirmations = new Map<string, PendingOwnerConfirmation>();

export interface PendingLinkRequest {
  clientPhone: string;
  clientName: string;
  serviceName: string;
  depositAmount: number;
  totalAmount: number;
  appointmentId?: string;
  dateStrFormatted?: string;
  requestedAt: number;
}

export const pendingPaymentLinkRequests = new Map<string, PendingLinkRequest>();


/**
 * Remove acentuação e normaliza texto para comparações em NLP
 */
export function normalizeText(str: string): string {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export interface ParsedDateResult {
  targetDate: Date;
  relativeType: 'today' | 'tomorrow' | 'yesterday' | 'weekday' | 'specific' | 'default';
  label: string;
}

/**
 * Interpretador de Datas em Linguagem Natural para o contexto do salão:
 * Suporta "hoje", "amanhã", dias da semana ("quarta", "quinta"), "depois de amanhã",
 * datas específicas ("14/10", "dia 14") e assume "hoje" por padrão.
 */
export function parseDateFromQuery(rawText: string, referenceDate?: DateTime): ParsedDateResult {
  const tz = SALON_CONFIG.timezone;
  const now = (referenceDate || DateTime.now()).setZone(tz);
  const norm = normalizeText(rawText);

  // 1. "depois de amanhã"
  if (norm.includes('depois de amanha')) {
    const dt = now.plus({ days: 2 });
    return {
      targetDate: dt.toJSDate(),
      relativeType: 'specific',
      label: 'depois de amanhã',
    };
  }

  // 2. "amanhã" / "pra amanhã" / "de amanhã"
  if (norm.includes('amanha')) {
    const dt = now.plus({ days: 1 });
    return {
      targetDate: dt.toJSDate(),
      relativeType: 'tomorrow',
      label: 'amanhã',
    };
  }

  // 3. "ontem"
  if (norm.includes('ontem')) {
    const dt = now.minus({ days: 1 });
    return {
      targetDate: dt.toJSDate(),
      relativeType: 'yesterday',
      label: 'ontem',
    };
  }

  // 4. "hoje" / "pra hoje" / "de hoje"
  if (norm.includes('hoje')) {
    return {
      targetDate: now.toJSDate(),
      relativeType: 'today',
      label: 'hoje',
    };
  }

  // 5. Data explícita: DD/MM ou DD/MM/YYYY
  const dateMatch = norm.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : now.year;
    if (year < 100) year += 2000;
    const dt = DateTime.fromObject({ year, month, day }, { zone: tz });
    if (dt.isValid) {
      return {
        targetDate: dt.toJSDate(),
        relativeType: 'specific',
        label: dt.toFormat('dd/MM'),
      };
    }
  }

  // 6. "dia DD" (ex: "dia 14", "dia 20", "dia 03")
  const dayMatch = norm.match(/\bdia\s+(\d{1,2})\b/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    let dt = DateTime.fromObject({ year: now.year, month: now.month, day }, { zone: tz });
    if (dt.isValid && dt < now.startOf('day')) {
      const nextMonth = now.plus({ months: 1 });
      const nextDt = DateTime.fromObject({ year: nextMonth.year, month: nextMonth.month, day }, { zone: tz });
      if (nextDt.isValid) {
        dt = nextDt;
      }
    }
    if (dt.isValid) {
      return {
        targetDate: dt.toJSDate(),
        relativeType: 'specific',
        label: dt.toFormat('dd/MM'),
      };
    }
  }

  // 7. Dias da semana (segunda a domingo)
  const weekdayMap: Record<string, number> = {
    segunda: 1,
    'segunda-feira': 1,
    terca: 2,
    'terca-feira': 2,
    quarta: 3,
    'quarta-feira': 3,
    quinta: 4,
    'quinta-feira': 4,
    sexta: 5,
    'sexta-feira': 5,
    sabado: 6,
    domingo: 7,
  };

  const weekdayMatch = norm.match(
    /\b(segunda(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado|domingo)\b/
  );
  if (weekdayMatch) {
    const key = weekdayMatch[1];
    const targetWeekday = weekdayMap[key];
    if (targetWeekday) {
      const currentWeekday = now.weekday;
      const diffDays = (targetWeekday - currentWeekday + 7) % 7;
      const dt = now.plus({ days: diffDays });
      return {
        targetDate: dt.toJSDate(),
        relativeType: diffDays === 0 ? 'today' : diffDays === 1 ? 'tomorrow' : 'weekday',
        label: key,
      };
    }
  }

  // 8. Padrão: "hoje"
  return {
    targetDate: now.toJSDate(),
    relativeType: 'default',
    label: 'hoje',
  };
}

/**
 * Detecta se a mensagem da Janaína é uma solicitação direta para MARCAR / AGENDAR uma cliente
 * Ex: "Marcar uma cliente amanhã para as 14hs. Extensão de cílios, manutenção. Nome dela: Renata"
 */
export function isOwnerBookingIntent(text: string): boolean {
  const norm = normalizeText(text);
  if (/\b(desmarcar|cancelar|quem ta marcada|quem esta marcada|quais agendamentos|ver agenda|minha agenda)\b/i.test(norm)) {
    return false;
  }
  return /\b(marcar|marca\s+|agendar|agenda\s+uma|agenda\s+a|colocar\s+na\s+agenda|encaixar|reservar)\b/i.test(norm);
}

/**
 * Detecta se a mensagem da Janaína é uma solicitação para LIBERAR / DESBLOQUEAR um horário
 */
export function isOwnerUnblockIntent(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(liberar|libera|desbloquear|desbloqueia|abrir horario|tirar bloqueio|remover bloqueio)\b/i.test(norm);
}

/**
 * Detecta se a mensagem da Janaína é para confirmar o sinal/pagamento de uma cliente
 */
export function isOwnerConfirmDepositIntent(text: string): boolean {
  const norm = normalizeText(text);
  return /\b(confirmar sinal|aprovar sinal|confirmar pix|aprovar pix|sinal pago)\b/i.test(norm);
}

/**
 * Detecta se a resposta da Janaína é um "SIM" para uma confirmação pendente
 */
export function isOwnerPositiveConfirmation(text: string): boolean {
  const norm = normalizeText(text);
  return /^(sim|s|confirmo|confirmar|pode|pode sim|pode liberar|pode marcar|liberar|libera|ok|quero|isso|com certeza|claro|positivo)\b/i.test(
    norm
  );
}

/**
 * Detecta se a resposta da Janaína é um "NÃO" para uma confirmação pendente
 */
export function isOwnerNegativeConfirmation(text: string): boolean {
  const norm = normalizeText(text);
  return /^(nao|n|cancelar|deixa|nao precisa|manter bloqueado|nao liberar)\b/i.test(norm);
}

/**
 * Detecta se a mensagem da Janaína é uma intenção de consulta de agenda
 * Suporta perguntas diretas, dias da semana, "e nos próximos dias?", "quais agendamentos temos confirmados?", "pendentes", etc.
 */

/**
 * Detecta se a mensagem da Janaína é uma pergunta sobre HORÁRIOS LIVRES / DISPONÍVEIS
 * Ex: "Qual outro horário disponível hoje para agendamento?", "tem vaga hoje?", "qual o próximo horário disponível?"
 */
export function isOwnerAvailabilityQueryIntent(text: string): boolean {
  if (isOwnerBookingIntent(text) || isOwnerUnblockIntent(text) || isOwnerConfirmDepositIntent(text)) {
    return false;
  }
  const norm = normalizeText(text);
  return (
    /\b(outro hor[aá]rio|outros hor[aá]rios|pr[oó]ximo hor[aá]rio|pr[oó]ximos hor[aá]rios|hor[aá]rio(?:s)? livre(?:s)?|vaga(?:s)? livre(?:s)?|hor[aá]rios dispon[ií]veis|hor[aá]rio dispon[ií]vel|disponibilidade|tem vaga|tem hor[aá]rio|quais hor[aá]rios est[aã]o livres|qual o pr[oó]ximo|algum hor[aá]rio|vagas hoje|vaga hoje)\b/i.test(
      norm
    )
  );
}

export function isScheduleQueryIntent(text: string): boolean {
  if (isOwnerBookingIntent(text) || isOwnerUnblockIntent(text) || isOwnerConfirmDepositIntent(text)) {
    return false;
  }
  const norm = normalizeText(text);
  return (
    /agenda|agendamento|horarios|atendimentos|o que tem(?:os)?|como est[a|ao]|como t[a|ao]|minha escala|ver grade|consultar|proximos dias|proxima semana|essa semana|esta semana|da semana|do mes|confirmado|pendente|marcada|marcado|clientes|e amanha|e hoje|e segunda|e terca|e quarta|e quinta|e sexta|e sabado|e domingo|nos proximos/i.test(
      norm
    )
  );
}

/**
 * Identifica se a pergunta da Janaína pede uma visão geral / próximos dias / filtro por status
 * (em vez de um único dia específico como "amanhã" ou "dia 29/10").
 */
export function isMultiDayOrStatusQuery(text: string, relativeType: string): boolean {
  const norm = normalizeText(text);
  if (
    /proximos dias|nos proximos|proxima semana|essa semana|esta semana|da semana|do mes|quais agendamento|todos os agendamento|confirmado|pendente|quem ta marcada|quem esta marcada/i.test(
      norm
    )
  ) {
    // Se ela não especificou uma data/dia da semana exato na mesma frase, é consulta panorâmica
    if (relativeType === 'default') {
      return true;
    }
  }
  return false;
}

/**
 * Interpretador Central de Comandos Executivos da Janaína
 * Suporta:
 * - handleOwnerCommands(whatsappClient, ownerPhone, text)
 * - handleOwnerCommands(ownerPhone, text)
 * - handleOwnerCommands(text)
 * - handleOwnerCommands({ text, command, message, phone, ownerPhone, whatsappClient })
 */
/**
 * Encaminha link de pagamento enviado pela Janaína para a cliente correspondente
 */
export async function handleForwardPaymentLink(
  whatsappClient: WhatsAppClientLike | null | undefined,
  ownerPhone: string,
  rawText: string,
  paymentUrl: string
): Promise<string> {
  const nameMatch = rawText.match(/(?:cliente|para|da|do|de|link)\s+([A-ZÀ-Úa-zà-ú]+)/i);
  let targetRequest: PendingLinkRequest | undefined;

  if (nameMatch && nameMatch[1]) {
    const searchName = nameMatch[1].toLowerCase();
    for (const [phone, req] of pendingPaymentLinkRequests.entries()) {
      if (req.clientName.toLowerCase().includes(searchName)) {
        targetRequest = req;
        break;
      }
    }
  }

  if (!targetRequest && pendingPaymentLinkRequests.size > 0) {
    const entries = Array.from(pendingPaymentLinkRequests.values());
    entries.sort((a, b) => b.requestedAt - a.requestedAt);
    targetRequest = entries[0];
  }

  if (!targetRequest) {
    const latestPending = await prisma.appointment.findFirst({
      where: {
        depositStatus: 'PENDING',
        generalStatus: { not: 'CANCELLED' },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (latestPending) {
      targetRequest = {
        clientPhone: latestPending.whatsappPhone,
        clientName: latestPending.clientName,
        serviceName: latestPending.service,
        depositAmount: Number(latestPending.depositAmount),
        totalAmount: Number(latestPending.totalAmount),
        appointmentId: latestPending.id,
        requestedAt: Date.now(),
      };
    }
  }

  if (!targetRequest) {
    const noReqMsg =
      `Jana, identifiquei o link de pagamento (*${paymentUrl}*), mas não encontrei nenhuma cliente aguardando link no momento. 😅\n\n` +
      `Se desejar enviar para uma cliente específica, me envie: *"Link da [Nome]: ${paymentUrl}"*! 💕`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, noReqMsg, 3000);
    }
    return noReqMsg;
  }

  const depositStr = targetRequest.depositAmount.toFixed(2).replace('.', ',');
  const clientMsg =
    `Olá, *${targetRequest.clientName}*! 💳✨ A Janaína já gerou o seu link de pagamento para o sinal (R$ ${depositStr}) do seu agendamento de *${targetRequest.serviceName}*!\n\n` +
    `🔗 *Acesse o link seguro para pagar no cartão:*\n${paymentUrl}\n\n` +
    `✅ *Lembrando:* O valor do sinal será abatido integralmente no ato do seu procedimento.\n` +
    `Assim que concluir o pagamento, por favor me envie o comprovante ou me dê um 'OK' por aqui para confirmarmos de vez a sua vaga na grade! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, targetRequest.clientPhone, clientMsg, 3500);
  }

  pendingPaymentLinkRequests.delete(targetRequest.clientPhone.replace(/\D/g, ''));

  const confirmOwnerMsg =
    `✅ *Link de Pagamento Enviado com Sucesso, Jana!* 💳✨\n\n` +
    `Encaminhei o link diretamente para a cliente *${targetRequest.clientName}* (${targetRequest.clientPhone}).\n` +
    `Assim que ela realizar o pagamento e enviar o comprovante, te aviso imediatamente aqui no canal pessoal para confirmação! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, confirmOwnerMsg, 3500);
  }
  return confirmOwnerMsg;
}

export async function handleOwnerCommands(
  arg1: WhatsAppClientLike | string | { text?: string; command?: string; message?: string; phone?: string; ownerPhone?: string; whatsappClient?: WhatsAppClientLike },
  arg2?: string,
  arg3?: string
): Promise<{ status: string; action: string; reply: string; message: string; response: string }> {
  let whatsappClient: WhatsAppClientLike | null = null;
  let ownerPhone = SALON_CONFIG.ownerPersonalNumber;
  let rawCommandText = '';

  if (typeof arg1 === 'string') {
    if (typeof arg2 === 'string') {
      ownerPhone = arg1;
      rawCommandText = arg2;
    } else {
      rawCommandText = arg1;
    }
  } else if (arg1 && typeof arg1 === 'object' && !('sendMessage' in arg1)) {
    const opts = arg1 as any;
    whatsappClient = opts.whatsappClient || null;
    ownerPhone = opts.ownerPhone || opts.phone || SALON_CONFIG.ownerPersonalNumber;
    rawCommandText = opts.text || opts.command || opts.message || '';
  } else {
    whatsappClient = (arg1 as WhatsAppClientLike) || null;
    ownerPhone = arg2 || SALON_CONFIG.ownerPersonalNumber;
    rawCommandText = arg3 || '';
  }

  const cleanText = (rawCommandText || '').trim();
  const lower = cleanText.toLowerCase();

  // COMANDO 0: Confirmação Pendente da Janaína (ex: liberar horário bloqueado e marcar cliente)
  const pending = pendingOwnerConfirmations.get(ownerPhone);
  if (pending) {
    if (isOwnerPositiveConfirmation(cleanText)) {
      const reply = await executePendingOwnerAction(whatsappClient, ownerPhone, pending);
      scheduleDatabaseVaultBackup();
      return { status: 'success', action: 'confirmed_owner_override', reply, message: reply, response: reply };
    }
    if (isOwnerNegativeConfirmation(cleanText)) {
      pendingOwnerConfirmations.delete(ownerPhone);
      const cancelReply = `Entendido, Jana! Mantive o horário bloqueado na agenda e não realizei o agendamento. 🔒✨`;
      if (whatsappClient) {
        await sendHumanizedMessage(whatsappClient, ownerPhone, cancelReply, 3000);
      }
      return { status: 'success', action: 'cancelled_owner_override', reply: cancelReply, message: cancelReply, response: cancelReply };
    }
  }

    // COMANDO 0.5: Envio de Link de Pagamento de Cartão da Janaína para a Cliente
  const linkMatch = cleanText.match(/(https?:\/\/[^\s]+)/i);
  if (linkMatch) {
    const reply = await handleForwardPaymentLink(whatsappClient, ownerPhone, cleanText, linkMatch[1]);
    return { status: 'success', action: 'forward_payment_link', reply, message: reply, response: reply };
  }

  // COMANDO 0.6: Alteração de Preços / Valores
  if (isOwnerPriceChangeIntent(cleanText)) {
    const reply = await handleOwnerPriceChange(whatsappClient, ownerPhone, cleanText);
    return { status: 'success', action: 'update_service_price', reply, message: reply, response: reply };
  }

  // COMANDO 0.7: Promoções e Descontos
  if (isOwnerPromoIntent(cleanText)) {
    const reply = await handleOwnerPromotion(whatsappClient, ownerPhone, cleanText);
    return { status: 'success', action: 'service_promotion', reply, message: reply, response: reply };
  }

  // COMANDO 0.8: Adicionar / Cadastrar Novo Serviço
  if (isOwnerAddServiceIntent(cleanText)) {
    const reply = await handleOwnerAddService(whatsappClient, ownerPhone, cleanText);
    return { status: 'success', action: 'add_custom_service', reply, message: reply, response: reply };
  }

  // COMANDO 0.9: Listar Promoções / Tabela de Preços
  if (isOwnerListCatalogIntent(cleanText)) {
    const reply = await handleOwnerListCatalog(whatsappClient, ownerPhone, cleanText);
    return { status: 'success', action: 'list_catalog', reply, message: reply, response: reply };
  }

  // COMANDO 1: Montagem / Abertura de Grade Mensal (Prioridade Alta para Fluxo Administrativo)
  if (ownerAgendaSetupService.isAdminIntent(cleanText) || ownerAgendaSetupService.isPhoneInAdminFlow(ownerPhone)) {
    const flowRes = await ownerAgendaSetupService.processAdminMessage(ownerPhone, cleanText);
    scheduleDatabaseVaultBackup();
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, flowRes.reply, 3000);
    }
    return { status: 'success', action: 'agenda_setup', reply: flowRes.reply, message: flowRes.reply, response: flowRes.reply };
  }

  // COMANDO 2: Agendamento Direto pela Janaína (com detecção de horário bloqueado, motivo do bloqueio e confirmação)
  if (isOwnerBookingIntent(cleanText)) {
    const reply = await handleOwnerDirectBooking(whatsappClient, ownerPhone, cleanText);
    scheduleDatabaseVaultBackup();
    return { status: 'success', action: 'owner_direct_booking', reply, message: reply, response: reply };
  }

  // COMANDO 2.5: Liberar / Desbloquear Horário diretamente
  if (isOwnerUnblockIntent(cleanText)) {
    const reply = await handleUnblockSlotByOwner(whatsappClient, ownerPhone, cleanText);
    scheduleDatabaseVaultBackup();
    return { status: 'success', action: 'unblock_slot', reply, message: reply, response: reply };
  }

  // COMANDO 2.6: Confirmar Sinal / PIX de Cliente diretamente pelo WhatsApp da Janaína
  if (isOwnerConfirmDepositIntent(cleanText)) {
    const reply = await handleConfirmDepositByOwner(whatsappClient, ownerPhone, cleanText);
    scheduleDatabaseVaultBackup();
    return { status: 'success', action: 'confirm_deposit_owner', reply, message: reply, response: reply };
  }

  // COMANDO 3: Bloqueio de Horário (Compromisso Pessoal / Sigilo Absoluto)
  // Exemplo: "bloquear 20/10 das 14:00 às 16:00" ou "folga dia 22/10" ou "fechar horário 15/10 10h às 12h"
  if (
    lower.startsWith('bloquear') ||
    lower.startsWith('fechar horário') ||
    lower.startsWith('fechar horario') ||
    lower.startsWith('folga')
  ) {
    const reply = await handleBlockSlot(whatsappClient, ownerPhone, cleanText);
    scheduleDatabaseVaultBackup();
    return { status: 'success', action: 'block_slot', reply, message: reply, response: reply };
  }

  // COMANDO 4: Desmarcar/Cancelar Cliente ou Horário por Ordem da Proprietária
  // Exemplo: "desmarcar cliente Mariana dia 18/10 15h", "desmarcar o horário das 14hs dia 03/11" ou "desmarcar Mariana"
  if (
    lower.startsWith('desmarcar') ||
    lower.startsWith('desmarca') ||
    lower.startsWith('cancelar horário') ||
    lower.startsWith('cancelar horario') ||
    lower.startsWith('cancelar agendamento') ||
    lower.startsWith('cancelar atendimento') ||
    lower.startsWith('cancelar cliente') ||
    /\b(?:desmarcar|desmarca|cancelar|cancela)\s+(?:o\s+|a\s+)?(?:hor[aá]rio|agendamento|atendimento|cliente|vaga)\b/i.test(lower)
  ) {
    const reply = await handleCancelAppointmentByOwner(whatsappClient, ownerPhone, cleanText);
    scheduleDatabaseVaultBackup();
    return { status: 'success', action: 'cancel_appointment', reply, message: reply, response: reply };
  }

  // COMANDO 5: Consulta Flexível de Agenda (NLP / Regex com datas relativas, específicas e próximos dias)
  // Exemplo: "Alícia, o que temos pra amanhã?", "quais agendamentos temos confirmados?", "e nos próximos dias?", "minha agenda"
    // COMANDO 1.8: Pergunta sobre Próximos Horários Disponíveis / Vagas Livres
  if (isOwnerAvailabilityQueryIntent(cleanText)) {
    const { targetDate } = parseDateFromQuery(cleanText);
    const reply = await reportAvailableSlotsToOwner(whatsappClient, ownerPhone, targetDate, cleanText);
    return { status: 'success', action: 'available_slots', reply, message: reply, response: reply };
  }

  if (isScheduleQueryIntent(cleanText)) {
    const parsed = parseDateFromQuery(cleanText);
    if (isMultiDayOrStatusQuery(cleanText, parsed.relativeType)) {
      const reply = await reportUpcomingAgenda(whatsappClient || undefined, ownerPhone, cleanText);
      return { status: 'success', action: 'upcoming_agenda', reply, message: reply, response: reply };
    }
    const reply = await reportDailyAgenda(whatsappClient || undefined, ownerPhone, parsed.targetDate, parsed.relativeType);
    return { status: 'success', action: 'daily_agenda', reply, message: reply, response: reply };
  }

  // MENU EXECUTIVO DE AJUDA (Fallback amigável da Alícia apenas em saudações ou comandos não reconhecidos)
  const menuHelp =
    `Olá, Jana! Alícia conectada ao seu canal pessoal. 💅✨\n\n` +
    `Aqui você tem o controle total do studio e atendo qualquer solicitação sua de forma direta:\n\n` +
    `📌 *Marcar Cliente:* "Marcar uma cliente amanhã às 14h. Manutenção de cílios. Nome: Renata"\n` +
    `📋 *Consultar:* "Minha agenda", "O que temos pra amanhã?", ou "Agenda de quarta"\n` +
    `🏷️ *Alterar Preço:* "Alterar valor Volume Brasileiro para 90"\n` +
    `🎉 *Promoção:* "Promoção Volume Brasileiro por 80" ou "Tirar promoção..."\n` +
    `➕ *Novo Serviço:* "Adicionar serviço Lash Lifting, valor 110, duração 60 min"\n` +
    `🔒 *Bloquear Vaga:* "Bloquear [data] das [início] às [fim]" (ex: "Bloquear 20/10 das 14:00 às 16:00")\n` +
    `🔓 *Liberar Horário:* "Liberar horário de amanhã às 14h"\n` +
    `❌ *Desmarcar:* "Desmarcar cliente [Nome]"\n` +
    `🗓️ *Grade do Mês:* "Montar a agenda do mês"\n\n` +
    `_Lembrete de Segurança: Se você pedir para marcar uma cliente em um horário bloqueado, eu te informo o motivo do bloqueio e pergunto se deseja liberar antes de confirmar!_ 🤐✨`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, menuHelp, 4000);
  }
  return { status: 'success', action: 'help_menu', reply: menuHelp, message: menuHelp, response: menuHelp };
}

/**
 * Gera e envia o Relatório Diário de Agendamentos e Bloqueios
 * Suporta chamada direta reportDailyAgenda(targetDate) ou reportDailyAgenda(whatsappClient, ownerPhone, targetDate)
 */
export async function reportDailyAgenda(
  arg1?: WhatsAppClientLike | Date,
  arg2?: string | Date,
  arg3?: Date,
  relativeType?: string
): Promise<string> {
  let whatsappClient: WhatsAppClientLike | null = null;
  let ownerPhone = SALON_CONFIG.ownerPersonalNumber;
  let targetDate = new Date();

  if (arg1 instanceof Date) {
    targetDate = arg1;
  } else if (arg1 && typeof arg1 === 'object') {
    whatsappClient = arg1 as WhatsAppClientLike;
    if (typeof arg2 === 'string') {
      ownerPhone = arg2;
    }
    if (arg3 instanceof Date) {
      targetDate = arg3;
    } else if (arg2 instanceof Date) {
      targetDate = arg2;
    }
  } else if (arg2 instanceof Date) {
    targetDate = arg2;
  }

  const tz = SALON_CONFIG.timezone;
  const targetDt = DateTime.fromJSDate(targetDate, { zone: tz });
  const startOfDay = targetDt.startOf('day').toJSDate();
  const endOfDay = targetDt.endOf('day').toJSDate();

  // Registra a última data consultada pela Janaína para contexto em comandos subsequentes (ex: "desmarcar o horário das 14hs")
  lastOwnerQueriedDate.set(ownerPhone, { targetDate: targetDt.toJSDate(), timestamp: Date.now() });

  // Se foi uma pergunta genérica ("minha agenda") sem dia específico e hoje estiver vazio,
  // mostra automaticamente o panorama dos próximos dias caso existam agendamentos futuros!
  if (relativeType === 'default') {
    const todayCount = await prisma.appointment.count({
      where: {
        appointmentDate: { gte: startOfDay, lte: endOfDay },
        generalStatus: { not: 'CANCELLED' },
      },
    });
    const futureCount = await prisma.appointment.count({
      where: {
        appointmentDate: { gt: endOfDay },
        generalStatus: { not: 'CANCELLED' },
      },
    });
    if (todayCount === 0 && futureCount > 0) {
      return await reportUpcomingAgenda(whatsappClient || undefined, ownerPhone, 'minha agenda');
    }
  }

  // 1. Busca agendamentos do dia no banco (filtrando cancelados)
  const appointments = await prisma.appointment.findMany({
    where: {
      appointmentDate: {
        gte: startOfDay,
        lte: endOfDay,
      },
      generalStatus: { not: 'CANCELLED' },
    },
    orderBy: { appointmentDate: 'asc' },
  });

  // 2. Busca bloqueios pontuais no banco
  const blockedSlots = await prisma.blockedSlot.findMany({
    where: {
      startTime: { lte: endOfDay },
      endTime: { gte: startOfDay },
    },
    orderBy: { startTime: 'asc' },
  });

  // 3. Monta a lista combinada de eventos
  const eventsList: Array<{ time: string; text: string; sortDt: DateTime; isBlock: boolean }> = [];

  for (const apt of appointments) {
    const aptDt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz });
    let displayClientName = (apt.clientName || '').replace(/\s+(?:às|as|para|no|na)$/i, '').trim();
    if (!displayClientName || /^cliente(\s*\(.*\))?$/i.test(displayClientName)) {
      const nameNoteMatch = (apt.notes || '').match(/cliente:\s*([^|;,\n\]]+)/i);
      if (nameNoteMatch) displayClientName = nameNoteMatch[1].trim();
    }
    let displayService = apt.service;
    if (/studio\s*jf|procedimento\s*studio/i.test(displayService)) {
      const noteMatch = (apt.notes || '').match(/procedimento:\s*([^|;,\n\]]+)/i);
      displayService = noteMatch ? noteMatch[1].trim() : 'Design de Sobrancelha';
    }
    const aptDuration = inferAppointmentDurationMinutes(displayService);
    const aptEndDt = aptDt.plus({ minutes: aptDuration });
    const durLabel = formatDurationLabel(aptDuration);
    let statusLabel = '[Confirmado]';
    if (apt.depositStatus === 'EXEMPT') {
      statusLabel = '[Isenta]';
    } else if (apt.depositStatus === 'CONFIRMED') {
      statusLabel = '[Confirmado]';
    } else if (apt.depositStatus === 'RECEIPT_SENT') {
      statusLabel = '[Comprovante Enviado]';
    } else if (apt.depositStatus === 'PENDING') {
      statusLabel = '[Aguardando PIX]';
    } else if (apt.depositStatus === 'EXPIRED') {
      statusLabel = '[Expirado]';
    }

    eventsList.push({
      time: aptDt.toFormat('HH:mm'),
      text: `• *${aptDt.toFormat('HH:mm')} às ${aptEndDt.toFormat('HH:mm')}* (${durLabel}) - ${displayClientName} (${displayService}) ${statusLabel}`,
      sortDt: aptDt,
      isBlock: false,
    });
  }

  for (const bs of blockedSlots) {
    const bsStart = DateTime.fromJSDate(bs.startTime, { zone: tz });
    const bsEnd = DateTime.fromJSDate(bs.endTime, { zone: tz });
    eventsList.push({
      time: bsStart.toFormat('HH:mm'),
      text: `• *${bsStart.toFormat('HH:mm')} às ${bsEnd.toFormat('HH:mm')}* - 🔒 Horário Bloqueado (Compromisso Interno)`,
      sortDt: bsStart,
      isBlock: true,
    });
  }

  // 4. Verifica bloqueio quinzenal de terça-feira (13:00 às 15:30)
  const midDayCheck = targetDt.set({ hour: 13, minute: 0 }).toJSDate();
  if (isBiweeklyTuesdayBlocked(midDayCheck, 60, tz)) {
    const tStart = targetDt.set({ hour: 13, minute: 0 });
    eventsList.push({
      time: '13:00',
      text: `• *13:00 às 15:30* - 🔒 Horário Bloqueado (Compromisso Interno)`,
      sortDt: tStart,
      isBlock: true,
    });
  }

  eventsList.sort((a, b) => a.sortDt.toMillis() - b.sortDt.toMillis());

  const now = DateTime.now().setZone(tz);
  const isToday = targetDt.hasSame(now, 'day');
  const isTomorrow = targetDt.hasSame(now.plus({ days: 1 }), 'day');
  const formattedDate = targetDt.toFormat('dd/MM');
  const weekdayName = targetDt.setLocale('pt-BR').toFormat('cccc');
  const capitalizedWeekday = weekdayName.charAt(0).toUpperCase() + weekdayName.slice(1);

  let dateTitle = '';
  let dateEmptyRef = '';
  if (isToday) {
    dateTitle = `Hoje (${formattedDate} - ${capitalizedWeekday})`;
    dateEmptyRef = `hoje (${formattedDate} - ${capitalizedWeekday})`;
  } else if (isTomorrow) {
    dateTitle = `Amanhã (${formattedDate} - ${capitalizedWeekday})`;
    dateEmptyRef = `amanhã (${formattedDate} - ${capitalizedWeekday})`;
  } else {
    dateTitle = `${capitalizedWeekday} (${formattedDate})`;
    dateEmptyRef = `${capitalizedWeekday} (${formattedDate})`;
  }

  // Se a grade estiver totalmente vazia
  if (eventsList.length === 0) {
    const emptyMsg = `Jana, para ${dateEmptyRef} ainda não temos nenhum atendimento agendado na grade! Está totalmente livre. ✨`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, emptyMsg, 3000);
    }
    return emptyMsg;
  }

  const totalAppointments = appointments.length;
  const pendingCount = appointments.filter((a) => a.depositStatus === 'PENDING').length;

  let footerText = '';
  if (totalAppointments > 0) {
    const pendingText =
      pendingCount > 0 ? ` (${pendingCount} pendente${pendingCount > 1 ? 's' : ''} de sinal)` : '';
    footerText = `Total de atendimentos: ${totalAppointments}${pendingText}. Precisa alterar ou bloquear algum horário? 💕`;
  } else {
    footerText = `Total de atendimentos: 0 (apenas bloqueios na grade). Precisa alterar ou liberar algum horário? 💕`;
  }

  let report = `📋 *Agenda de ${dateTitle}:* ✨\n\n`;
  report += eventsList.map((e) => e.text).join('\n') + '\n\n';
  report += footerText;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, report, 4000);
  }
  return report;
}

/**
 * Gera e envia o Panorama Completo da Agenda (Hoje + Próximos Dias) agrupado por data,
 * respondendo a perguntas como "quais agendamentos temos confirmados?", "e nos próximos dias?", "agenda da semana", etc.
 */
export async function reportUpcomingAgenda(
  whatsappClient?: WhatsAppClientLike,
  ownerPhone: string = SALON_CONFIG.ownerPersonalNumber,
  rawQueryText: string = ''
): Promise<string> {
  const tz = SALON_CONFIG.timezone;
  const now = DateTime.now().setZone(tz);
  const startOfToday = now.startOf('day').toJSDate();
  const norm = normalizeText(rawQueryText);

  const onlyPending = norm.includes('pendente') && !norm.includes('confirmado');

  // Busca todos os agendamentos ativos de hoje em diante (ou dentro do mês aberto)
  const allAppointments = await prisma.appointment.findMany({
    where: {
      appointmentDate: { gte: startOfToday },
      generalStatus: { not: 'CANCELLED' },
      depositStatus: { not: 'EXPIRED' },
      ...(onlyPending ? { depositStatus: 'PENDING' } : {}),
    },
    orderBy: { appointmentDate: 'asc' },
  });

  const blockedSlots = await prisma.blockedSlot.findMany({
    where: {
      endTime: { gte: startOfToday },
    },
    orderBy: { startTime: 'asc' },
  });

  if (allAppointments.length === 0 && blockedSlots.length === 0) {
    const emptyMsg =
      `Jana, ainda não temos nenhum atendimento agendado para hoje nem para os próximos dias na grade! Está totalmente livre. ✨`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, emptyMsg, 3000);
    }
    return emptyMsg;
  }

  // Agrupa por dia (dd/MM/yyyy)
  const groupedByDay = new Map<string, { header: string; items: string[] }>();

  for (const apt of allAppointments) {
    const aptDt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz });
    let displayClientName = (apt.clientName || '').replace(/\s+(?:às|as|para|no|na)$/i, '').trim();
    if (!displayClientName || /^cliente(\s*\(.*\))?$/i.test(displayClientName)) {
      const nameNoteMatch = (apt.notes || '').match(/cliente:\s*([^|;,\n\]]+)/i);
      if (nameNoteMatch) displayClientName = nameNoteMatch[1].trim();
    }
    let displayService = apt.service;
    if (/studio\s*jf|procedimento\s*studio/i.test(displayService)) {
      const noteMatch = (apt.notes || '').match(/procedimento:\s*([^|;,\n\]]+)/i);
      displayService = noteMatch ? noteMatch[1].trim() : 'Design de Sobrancelha';
    }
    const aptDuration = inferAppointmentDurationMinutes(displayService);
    const aptEndDt = aptDt.plus({ minutes: aptDuration });
    const durLabel = formatDurationLabel(aptDuration);
    const dayKey = aptDt.toFormat('yyyy-MM-dd');
    const weekday = aptDt.setLocale('pt-BR').toFormat('cccc');
    const capWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    const header = `📅 *${capWeekday} (${aptDt.toFormat('dd/MM')})*`;

    let badge = '✅ [Confirmado]';
    if (apt.depositStatus === 'EXEMPT') {
      badge = '💖 [Isenta]';
    } else if (apt.depositStatus === 'PENDING') {
      badge = `⏳ [Aguardando PIX R$ ${Number(apt.depositAmount).toFixed(0)}]`;
    } else if (apt.depositStatus === 'RECEIPT_SENT') {
      badge = '🧾 [Comprovante Enviado]';
    }

    const line = `  • *${aptDt.toFormat('HH:mm')} às ${aptEndDt.toFormat('HH:mm')}* (${durLabel}) - ${displayClientName} | ${displayService} (R$ ${Number(apt.totalAmount).toFixed(0)}) ${badge}`;

    if (!groupedByDay.has(dayKey)) {
      groupedByDay.set(dayKey, { header, items: [] });
    }
    groupedByDay.get(dayKey)!.items.push(line);
  }

  for (const bs of blockedSlots) {
    const bsStart = DateTime.fromJSDate(bs.startTime, { zone: tz });
    const bsEnd = DateTime.fromJSDate(bs.endTime, { zone: tz });
    const dayKey = bsStart.toFormat('yyyy-MM-dd');
    const weekday = bsStart.setLocale('pt-BR').toFormat('cccc');
    const capWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    const header = `📅 *${capWeekday} (${bsStart.toFormat('dd/MM')})*`;
    const line = `  • *${bsStart.toFormat('HH:mm')} às ${bsEnd.toFormat('HH:mm')}* - 🔒 Horário Bloqueado (Compromisso Interno)`;

    if (!groupedByDay.has(dayKey)) {
      groupedByDay.set(dayKey, { header, items: [] });
    }
    groupedByDay.get(dayKey)!.items.push(line);
  }

  const confirmedCount = allAppointments.filter(
    (a) => a.generalStatus === 'CONFIRMED' || a.depositStatus === 'CONFIRMED' || a.depositStatus === 'EXEMPT'
  ).length;
  const pendingCount = allAppointments.filter((a) => a.depositStatus === 'PENDING').length;

  const sortedDays = Array.from(groupedByDay.entries()).sort(([k1], [k2]) => k1.localeCompare(k2));

  let report = `📋 *Panorama da Agenda - Próximos Dias (Studio JF):* ✨\n\n`;
  for (const [, group] of sortedDays) {
    report += `${group.header}\n${group.items.join('\n')}\n\n`;
  }

  report +=
    `📊 *Resumo Geral:* ${allAppointments.length} atendimento(s) na grade ` +
    `(${confirmedCount} confirmado(s)/isenta(s) e ${pendingCount} aguardando sinal PIX).\n` +
    `Para ver um dia específico, basta digitar ex: *"Agenda de segunda"* ou *"O que temos dia 29/10?"* 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, report, 4000);
  }
  return report;
}

/**
 * Bloqueia períodos com SIGILO ABSOLUTO:
 * O motivo gravado é interno, e para as clientes o horário fica indisponível sem justificativas.
 */
export async function handleBlockSlot(
  whatsappClient: WhatsAppClientLike | null | undefined,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  const tz = SALON_CONFIG.timezone;
  const now = DateTime.now().setZone(tz);
  const parsedDate = parseDateFromQuery(rawText);

  const targetDt = DateTime.fromJSDate(parsedDate.targetDate, { zone: tz });
  let targetYear = targetDt.year;
  let targetMonth = targetDt.month;
  let targetDay = targetDt.day;

  let startHour = -1;
  let startMinute = 0;
  let endHour = -1;
  let endMinute = 0;

  // 1. Caso Folga do dia inteiro
  if (rawText.toLowerCase().includes('folga')) {
    startHour = 8;
    startMinute = 0;
    endHour = 19;
    endMinute = 0;
  } else {
    // Limpa expressões de data antes do regex de horas para evitar "dia 28" ser interpretado como hora 28
    const cleanedForTime = rawText
      .replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g, '')
      .replace(/\bdia\s+\d{1,2}\b/gi, '');

    // 2. Parsing de intervalo: "das 14:00 às 16:00" ou "14h às 16h" ou "14:00 as 16:00"
    const timeRangeMatch = cleanedForTime.match(
      /(?:das?|de)?\s*(\d{1,2})(?::(\d{2}))?h?\s*(?:às|as|ate|até|-)\s*(\d{1,2})(?::(\d{2}))?h?/i
    );
    if (timeRangeMatch) {
      startHour = parseInt(timeRangeMatch[1], 10);
      startMinute = timeRangeMatch[2] ? parseInt(timeRangeMatch[2], 10) : 0;
      endHour = parseInt(timeRangeMatch[3], 10);
      endMinute = timeRangeMatch[4] ? parseInt(timeRangeMatch[4], 10) : 0;
    } else {
      // 3. Parsing de horário único/pontual: "Bloquear vaga às 20:40 hoje" ou "bloquear 20:40" ou "bloquear às 14h"
      const singleTimeMatch = cleanedForTime.match(
        /(?:às|as|para|das|de)?\s*(\d{1,2})(?:[:h](\d{2}))?\s*(?:hs|hrs|h|horas)?\b/i
      );
      if (singleTimeMatch && singleTimeMatch[1]) {
        const parsedH = parseInt(singleTimeMatch[1], 10);
        if (parsedH >= 0 && parsedH <= 23) {
          startHour = parsedH;
          startMinute = singleTimeMatch[2] ? parseInt(singleTimeMatch[2], 10) : 0;

          // Se informou só início (ex: 20:40), bloqueia 1 hora (20:40 às 21:40)
          endHour = startHour + 1;
          endMinute = startMinute;
          if (endHour >= 24) {
            endHour = 23;
            endMinute = 59;
          }
        }
      }
    }
  }

  if (startHour === -1 || endHour === -1) {
    const errorMsg =
      `Jana, não consegui identificar os horários para o bloqueio. 😅\n\n` +
      `Por favor, use o formato:\n` +
      `• Intervalo: *"Bloquear hoje das 14:00 às 16:00"*\n` +
      `• Horário específico: *"Bloquear vaga às 20:40 hoje"*\n` +
      `• Folga: *"Folga dia 22/10"* ✨`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, errorMsg, 4000);
    }
    return errorMsg;
  }

  const startDt = DateTime.fromObject(
    { year: targetYear, month: targetMonth, day: targetDay, hour: startHour, minute: startMinute },
    { zone: tz }
  );

  const endDt = DateTime.fromObject(
    { year: targetYear, month: targetMonth, day: targetDay, hour: endHour, minute: endMinute },
    { zone: tz }
  );

  // 4. REGRA DE SEGURANÇA: Verifica se existem clientes já agendadas no período!
  const startJs = startDt.toJSDate();
  const endJs = endDt.toJSDate();

  const dayStart = startDt.startOf('day').toJSDate();
  const dayEnd = endDt.endOf('day').toJSDate();

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

  const conflictingAppointments = dayAppointments.filter((a) => {
    const aStartMs = a.appointmentDate.getTime();
    let srv = a.service;
    if (/studio\s*jf|procedimento\s*studio/i.test(srv)) {
      const noteMatch = (a.notes || '').match(/procedimento:\s*([^|;,\n]+)/i);
      srv = noteMatch ? noteMatch[1].trim() : 'Design de Sobrancelha';
    }
    const dur = inferAppointmentDurationMinutes(srv);
    const aEndMs = aStartMs + dur * 60 * 1000;
    return aStartMs < endJs.getTime() && aEndMs > startJs.getTime();
  });

  if (conflictingAppointments.length > 0) {
    const aptsList = conflictingAppointments.map(a => {
      const aTime = DateTime.fromJSDate(a.appointmentDate, { zone: tz }).toFormat('HH:mm');
      let srv = a.service;
      if (/studio\s*jf|procedimento\s*studio/i.test(srv)) {
        const noteMatch = (a.notes || '').match(/procedimento:\s*([^|;,\n]+)/i);
        srv = noteMatch ? noteMatch[1].trim() : 'Design de Sobrancelha';
      }
      return `• *${a.clientName}* às ${aTime} (${srv})`;
    }).join('\n');

    const warningMsg =
      `⚠️ *Atenção, Jana! Conflito de Horário!* ⚠️\n\n` +
      `No período que você solicitou bloquear (*${startDt.toFormat('HH:mm')} às ${endDt.toFormat('HH:mm')}*), já existem clientes agendadas na sua grade:\n\n` +
      `${aptsList}\n\n` +
      `🔒 O bloqueio *NÃO* foi aplicado para evitar que atendimentos marcados sejam perdidos.\n\n` +
      `Se você realmente precisa bloquear esse horário:\n` +
      `1️⃣ Desmarque a cliente primeiro (ex: *"Desmarcar cliente [Nome]"*)\n` +
      `2️⃣ Ou ajuste o intervalo do bloqueio para não coincidir com elas! 💕`;

    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, warningMsg, 5000);
    }
    return warningMsg;
  }

  // 5. Se livre de conflitos, cria o bloqueio com sigilo absoluto
  await prisma.blockedSlot.create({
    data: {
      title: 'Compromisso Pessoal',
      reason: 'INTERNAL_UNAVAILABLE',
      startTime: startJs,
      endTime: endJs,
      isRecurring: false,
    },
  });

  const formattedPeriod = `${startDt.toFormat('dd/MM/yyyy')} das ${startDt.toFormat('HH:mm')} às ${endDt.toFormat('HH:mm')}`;
  const confirmationMsg =
    `🔒 *Horário Bloqueado com Sucesso, Jana!*\n\n` +
    `Período trancado: *${formattedPeriod}*.\n\n` +
    `A grade foi atualizada. Se alguma cliente consultar esse período no canal oficial (${SALON_CONFIG.officialNumber}), ` +
    `eu apenas informarei que o horário não está vago, sem justificar o motivo. 🤐✨`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, confirmationMsg, 5000);
  }
  return confirmationMsg;
}

/**
 * Desmarcar agendamento por ordem executiva da Janaína:
 * 1. Cancela no banco
 * 2. Notifica a cliente com mensagem cordial e neutra (sem expor motivos pessoais)
 * 3. Envia confirmação à Janaína
 */
const lastOwnerQueriedDate = new Map<string, { targetDate: Date; timestamp: number }>();

/**
 * Desmarca uma cliente por comando da Janaína (por nome, por data + horário, ou apenas horário):
 * 1. Altera status para CANCELLED no banco
 * 2. Notifica a cliente com mensagem cordial e neutra (sem expor motivos pessoais)
 * 3. Envia confirmação à Janaína
 */
export async function handleCancelAppointmentByOwner(
  whatsappClient: WhatsAppClientLike | null | undefined,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  const tz = SALON_CONFIG.timezone;
  const parsedDate = parseDateFromQuery(rawText);
  const hasExplicitDate = parsedDate.relativeType !== 'default';
  const timeInfo = extractTime(rawText);
  const targetTimeStr = timeInfo?.timeStr; // ex: "14:00"
  const extractedName = extractClientName(rawText);

  // Determina a data de referência (explícita na frase ou última data consultada pela Janaína nos últimos 15 min)
  let effectiveDate: Date | null = hasExplicitDate ? parsedDate.targetDate : null;
  if (!effectiveDate) {
    const lastQueried = lastOwnerQueriedDate.get(ownerPhone);
    if (lastQueried && Date.now() - lastQueried.timestamp < 15 * 60 * 1000) {
      effectiveDate = lastQueried.targetDate;
    }
  }

  const filterByTimeAndName = (list: any[]) => {
    let filtered = list;
    if (targetTimeStr) {
      const [th, tm] = targetTimeStr.split(':').map(Number);
      const targetMinOfDay = th * 60 + (tm || 0);
      filtered = filtered.filter((apt) => {
        const aptDt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz });
        const startMin = aptDt.hour * 60 + aptDt.minute;
        const dur = inferAppointmentDurationMinutes(apt.service);
        const endMin = startMin + dur;
        return startMin === targetMinOfDay || (targetMinOfDay >= startMin && targetMinOfDay < endMin);
      });
    }
    if (extractedName && extractedName.length >= 2) {
      const normSearch = normalizeText(extractedName);
      filtered = filtered.filter((apt) => normalizeText(apt.clientName).includes(normSearch));
    }
    return filtered;
  };

  let candidates: any[] = [];

  // 1. Se temos uma data específica (ex: "dia 03/11", "amanhã", "hoje", ou última data consultada)
  if (effectiveDate) {
    const dt = DateTime.fromJSDate(effectiveDate, { zone: tz });
    const dayStart = dt.startOf('day').toJSDate();
    const dayEnd = dt.endOf('day').toJSDate();

    const dayApts = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
        depositStatus: { not: 'EXPIRED' },
        appointmentDate: { gte: dayStart, lte: dayEnd },
      },
      orderBy: { appointmentDate: 'asc' },
    });

    candidates = filterByTimeAndName(dayApts);
  }

  // 2. Se não encontrou na data específica (ou nenhuma data foi informada), busca em todos os agendamentos ativos
  if (candidates.length === 0 && (extractedName || targetTimeStr)) {
    const allActive = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
        depositStatus: { not: 'EXPIRED' },
      },
      orderBy: { appointmentDate: 'asc' },
    });
    candidates = filterByTimeAndName(allActive);
  }

  // 3. Caso a Janaína tenha dito "Desmarcar horário das 14h" para um horário que na verdade estava BLOQUEADO (BlockedSlot)
  if (candidates.length === 0 && targetTimeStr) {
    const checkDate = effectiveDate || parsedDate.targetDate;
    const dt = DateTime.fromJSDate(checkDate, { zone: tz });
    const [th, tm] = targetTimeStr.split(':').map(Number);
    const slotDt = dt.set({ hour: th, minute: tm || 0, second: 0, millisecond: 0 }).toJSDate();
    const overlappingBlocks = await prisma.blockedSlot.findMany({
      where: {
        startTime: { lte: slotDt },
        endTime: { gt: slotDt },
      },
    });
    if (overlappingBlocks.length > 0) {
      return await handleUnblockSlotByOwner(whatsappClient, ownerPhone, rawText);
    }
  }

  if (candidates.length === 0) {
    const descParts: string[] = [];
    if (extractedName) descParts.push(`cliente "${extractedName}"`);
    if (targetTimeStr) descParts.push(`horário das ${targetTimeStr}`);
    if (hasExplicitDate) descParts.push(`dia ${parsedDate.label}`);
    const searchSummary = descParts.length > 0 ? descParts.join(' no ') : rawText;

    const notFoundMsg =
      `Jana, não encontrei nenhum agendamento ativo para ${searchSummary}.\n\n` +
      `Digite *"Minha agenda"* ou *"Agenda dia DD/MM"* para ver os atendimentos marcados! 💕`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, notFoundMsg, 4000);
    }
    return notFoundMsg;
  }

  // Pega o agendamento correspondente (primeiro candidato compatível)
  const targetApt = candidates[0];

  // 1. Atualiza status no banco para CANCELLED
  await prisma.appointment.update({
    where: { id: targetApt.id },
    data: {
      generalStatus: 'CANCELLED',
      notes: targetApt.notes
        ? `${targetApt.notes} | [Desmarcado por ordem da Janaína]`
        : '[Desmarcado por ordem da Janaína]',
    },
  });

  // 2. Notifica a cliente no WhatsApp dela com mensagem cuidadosa e neutra (se tiver telefone real)
  const clientNotification =
    `Olá! Tudo bem? Aqui é a Alícia do Studio JF Designer. ✨\n\n` +
    `Passando para avisar que, por um imprevisto em nossa escala interna de atendimento, precisaremos reagendar o seu horário reservado.\n\n` +
    `Podemos verificar juntas uma nova data que fique excelente para você? Peço desculpas pelo transtorno! 💕`;

  if (whatsappClient && targetApt.whatsappPhone && !targetApt.whatsappPhone.endsWith('0000000')) {
    try {
      await sendHumanizedMessage(whatsappClient, targetApt.whatsappPhone, clientNotification, 4000);
    } catch (err) {
      console.error(`Falha ao disparar aviso de reagendamento para cliente ${targetApt.whatsappPhone}:`, err);
    }
  }

  // 3. Confirmação executiva para a Janaína
  const targetDt = DateTime.fromJSDate(targetApt.appointmentDate, { zone: tz });
  const durMin = inferAppointmentDurationMinutes(targetApt.service);
  const endDt = targetDt.plus({ minutes: durMin });
  const formattedAptDate = `${targetDt.toFormat('dd/MM/yyyy')} das ${targetDt.toFormat('HH:mm')} às ${endDt.toFormat('HH:mm')}`;
  const ownerConfirm =
    `✅ *Atendimento Desmarcado com Sucesso, Jana!* ✨\n\n` +
    `👤 *Cliente:* ${targetApt.clientName}\n` +
    `💅 *Procedimento:* ${targetApt.service}\n` +
    `🗓️ *Horário Liberado:* ${formattedAptDate}\n\n` +
    `O agendamento foi cancelado e a vaga das *${targetDt.toFormat('HH:mm')}* já está livre novamente na sua grade! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, ownerConfirm, 4500);
  }
  return ownerConfirm;
}

/**
 * Formata o motivo do bloqueio para exibição exclusiva à Janaína
 */
function formatBlockedSlotReasonForOwner(
  blockedSlots: Array<{ title: string; reason: string | null; startTime: Date; endTime: Date }>,
  isTuesdayBiweekly: boolean,
  tz: string
): string {
  const reasons: string[] = [];

  for (const bs of blockedSlots) {
    const s = DateTime.fromJSDate(bs.startTime, { zone: tz }).toFormat('HH:mm');
    const e = DateTime.fromJSDate(bs.endTime, { zone: tz }).toFormat('HH:mm');
    const customReason =
      bs.reason && bs.reason !== 'INTERNAL_UNAVAILABLE'
        ? `${bs.title} - ${bs.reason}`
        : bs.title || 'Compromisso Pessoal / Interno';
    reasons.push(`${customReason} (bloqueado das ${s} às ${e})`);
  }

  if (isTuesdayBiweekly) {
    reasons.push('Bloqueio Quinzenal de Terça-feira (13:00 às 15:30 - Compromisso Pessoal)');
  }

  return reasons.join(' | ') || 'Compromisso Pessoal / Bloqueio Interno';
}

/**
 * Executa a ação pendente após confirmação ("Sim" / "Pode liberar") da Janaína:
 * 1. Libera o(s) horário(s) bloqueado(s) no banco (BlockedSlot)
 * 2. Registra o agendamento confirmado para a cliente solicitada
 * 3. Notifica a Janaína da conclusão da tarefa
 */
export async function executePendingOwnerAction(
  whatsappClient: WhatsAppClientLike | null | undefined,
  ownerPhone: string,
  pending: PendingOwnerConfirmation
): Promise<string> {
  pendingOwnerConfirmations.delete(ownerPhone);

  // 1. Se havia bloqueios pontuais na tabela BlockedSlot, libera/remove-os
  if (pending.blockedSlotIds && pending.blockedSlotIds.length > 0) {
    await prisma.blockedSlot.deleteMany({
      where: {
        id: { in: pending.blockedSlotIds },
      },
    });
  }

  // 2. Cria o agendamento confirmado diretamente por ordem da Janaína
  const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000);

    await prisma.appointment.create({
    data: {
      clientName: pending.clientName,
      whatsappPhone: sanitizeToE164(pending.clientPhone || '5521900000000'),
      service: pending.serviceName,
      appointmentDate: pending.appointmentDate,
      totalAmount: new Prisma.Decimal(pending.totalAmount),
      depositAmount: new Prisma.Decimal(0),
      depositStatus: 'EXEMPT',
      generalStatus: 'CONFIRMED',
      depositDeadline: deadline,
      confirmedAt: new Date(),
      confirmedBy: 'Janaína (Direto)',
      isFirstAppointment: false,
      notes:
        pending.type === 'BOOK_OVER_APPOINTMENT'
          ? `[Agendado pela Janaína no próximo horário livre após término de procedimento anterior: ${pending.blockReasonText}]`
          : `[Agendado diretamente pela Janaína após confirmar liberação de bloqueio: ${pending.blockReasonText}]`,
    },
  });

  const confirmMsg =
    pending.type === 'BOOK_OVER_APPOINTMENT'
      ? `✅ *Cliente Agendada no Próximo Horário Livre, Jana!* ✨\n\n` +
        `👤 *Cliente:* ${pending.clientName}\n` +
        `💅 *Procedimento:* ${pending.serviceName} (${formatDurationLabel(pending.durationMinutes)} - R$ ${pending.totalAmount.toFixed(2).replace('.', ',')})\n` +
        `🗓️ *Data e Horário:* ${pending.formattedDateTime}\n\n` +
        `Agendada logo após o término do procedimento anterior, sem encavalar clientes! 💕`
      : `✅ *Horário Liberado e Cliente Agendada com Sucesso, Jana!* ✨\n\n` +
        `🔓 *Horário liberado:* ${pending.blockReasonText}\n` +
        `👤 *Cliente:* ${pending.clientName}\n` +
        `💅 *Procedimento:* ${pending.serviceName} (${formatDurationLabel(pending.durationMinutes)} - R$ ${pending.totalAmount.toFixed(2).replace('.', ',')})\n` +
        `🗓️ *Data e Horário:* ${pending.formattedDateTime}\n\n` +
        `O bloqueio foi removido e o agendamento já consta como *Confirmado* na sua agenda! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, confirmMsg, 4000);
  }
  return confirmMsg;
}

/**
 * Atende solicitações diretas de agendamento enviadas pela Janaína:
 * - Extrai cliente, serviço, data e horário.
 * - Calcula a duração exata do procedimento (ex: 90min Manutenção de Cílios, 30min Design de Sobrancelha).
 * - Se houver outra cliente em atendimento no intervalo, avisa a Janaína a que horas o procedimento termina
 *   (ex: cliente às 18:00 de manutenção de cílios termina às 19:30; design de sobrancelha dura 30min)
 *   e oferece agendar logo após o término.
 * - Se o horário estiver bloqueado, informa o motivo do bloqueio, pergunta se ela deseja realmente liberar o horário
 *   e aguarda confirmação para executar a tarefa.
 * - Se o horário estiver livre, executa o agendamento imediatamente.
 */
export async function handleOwnerDirectBooking(
  whatsappClient: WhatsAppClientLike | null | undefined,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  const tz = SALON_CONFIG.timezone;
  const parsedDate = parseDateFromQuery(rawText);
  const timeInfo = extractTime(rawText);
  const extractedSrv = extractService(rawText);
  const extractedName = extractClientName(rawText);

  if (!timeInfo?.timeStr) {
    const askTimeMsg =
      `Jana, entendi que você quer marcar uma cliente! 💕\n` +
      `Por favor, me informe o horário desejado (ex: *"Marcar cliente Renata amanhã às 14h manutenção de cílios"*). ✨`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, askTimeMsg, 3500);
    }
    return askTimeMsg;
  }

  // Se a Janaína especificou uma data explícita, salva no contexto; se omitiu a data, usa a última data que ela estava consultando/montando (até 15 min)
  let baseDate = parsedDate.targetDate;
  if (parsedDate.relativeType !== 'default') {
    lastOwnerQueriedDate.set(ownerPhone, { targetDate: baseDate, timestamp: Date.now() });
  } else {
    const recentCtx = lastOwnerQueriedDate.get(ownerPhone);
    if (recentCtx && Date.now() - recentCtx.timestamp < 15 * 60 * 1000) {
      baseDate = recentCtx.targetDate;
    }
  }

  const [hourStr, minStr] = timeInfo.timeStr.split(':');
  const targetDt = DateTime.fromJSDate(baseDate, { zone: tz }).set({
    hour: parseInt(hourStr, 10),
    minute: parseInt(minStr || '0', 10),
    second: 0,
    millisecond: 0,
  });

  if (!extractedSrv) {
    const askServiceMsg =
      `Jana, identifiquei o horário (${targetDt.toFormat('HH:mm')}), mas não consegui identificar qual procedimento a cliente vai fazer! 💅✨\n\n` +
      `Por favor, me informe o serviço desejado (ex: *Tufinhos de Seda*, *Volume Brasileiro*, *Design de Sobrancelha* ou *Henna*) para eu agendar certinho na grade com o tempo e valor corretos! 💕`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, askServiceMsg, 3500);
    }
    return askServiceMsg;
  }

  const serviceName = extractedSrv.name;
  const totalAmount = extractedSrv.price;
  const durationMinutes = extractedSrv.durationMinutes;
  const durationLabel = formatDurationLabel(durationMinutes);
  const clientName = extractedName || 'Cliente (Agendada pela Janaína)';

  // Extrai telefone opcional se a Janaína tiver digitado algum celular na mensagem
  const phoneMatch = rawText.replace(/\b\d{1,2}[\/\-]\d{1,2}\b/g, '').match(/\b(?:\+?55)?\s*\(?21\)?\s*9?\d{4}[-\s]?\d{4}\b/);
  const clientPhone = phoneMatch ? sanitizeToE164(phoneMatch[0]) : '5521900000000';

  const startJs = targetDt.toJSDate();
  const endDt = targetDt.plus({ minutes: durationMinutes });
  const endJs = endDt.toJSDate();

  const weekdayRaw = targetDt.setLocale('pt-BR').toFormat('cccc');
  const capWeekday = weekdayRaw.charAt(0).toUpperCase() + weekdayRaw.slice(1);
  const formattedDateTime = `${targetDt.toFormat('dd/MM/yyyy')} (${capWeekday}) das ${targetDt.toFormat('HH:mm')} às ${endDt.toFormat('HH:mm')} (${durationLabel})`;

  // 0. Evita duplicidade caso a Janaína reenvie o agendamento da mesma cliente corrigindo a data ou o procedimento
  if (extractedName) {
    const normNewClient = normalizeText(clientName);
    const recentCandidates = await prisma.appointment.findMany({
      where: {
        generalStatus: { not: 'CANCELLED' },
      },
    });
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const duplicateIds = recentCandidates
      .filter((apt) => {
        if (normalizeText(apt.clientName) !== normNewClient) return false;
        const isSameDateTime = apt.appointmentDate.getTime() === startJs.getTime();
        const isJustCreatedByOwner =
          apt.confirmedBy?.includes('Jana') && apt.createdAt && apt.createdAt.getTime() >= tenMinAgo;
        return isSameDateTime || isJustCreatedByOwner;
      })
      .map((apt) => apt.id);

    if (duplicateIds.length > 0) {
      await prisma.appointment.deleteMany({
        where: { id: { in: duplicateIds } },
      });
    }
  }

  // 1. Verifica se já existe outra cliente agendada cujo tempo de procedimento conflite com este horário
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
    const existingStartMs = existing.appointmentDate.getTime();
    const existingDuration = inferAppointmentDurationMinutes(existing.service);
    const existingEndMs = existingStartMs + existingDuration * 60 * 1000;

    if (startJs.getTime() < existingEndMs && endJs.getTime() > existingStartMs) {
      const existingStartDt = DateTime.fromMillis(existingStartMs, { zone: tz });
      const existingEndDt = DateTime.fromMillis(existingEndMs, { zone: tz });
      const existingDurLabel = formatDurationLabel(existingDuration);
      const nextEndDt = existingEndDt.plus({ minutes: durationMinutes });
      const nextFormattedDateTime = `${existingEndDt.toFormat('dd/MM/yyyy')} (${capWeekday}) das ${existingEndDt.toFormat('HH:mm')} às ${nextEndDt.toFormat('HH:mm')} (${durationLabel})`;

      pendingOwnerConfirmations.set(ownerPhone, {
        type: 'BOOK_OVER_APPOINTMENT',
        ownerPhone,
        clientName,
        clientPhone,
        serviceName,
        totalAmount,
        durationMinutes,
        appointmentDate: existingEndDt.toJSDate(),
        formattedDateTime: nextFormattedDateTime,
        blockedSlotIds: [],
        blockReasonText: `${existing.clientName} (${existing.service} das ${existingStartDt.toFormat('HH:mm')} às ${existingEndDt.toFormat('HH:mm')})`,
        createdAt: Date.now(),
      });

      const conflictMsg =
        `⚠️ *Atenção, Jana! Procedimento em Andamento Nesse Horário*\n\n` +
        `Às *${targetDt.toFormat('HH:mm')}* você estará atendendo a cliente *${existing.clientName}* ` +
        `(*${existing.service}*, duração de *${existingDurLabel}* — das *${existingStartDt.toFormat('HH:mm')} às ${existingEndDt.toFormat('HH:mm')}*).\n\n` +
        `👉 Para não chegarem duas clientes juntas enquanto você ainda está atendendo, a próxima cliente só pode agendar às **${existingEndDt.toFormat('HH:mm')}**!\n\n` +
        `Deseja que eu agende a cliente *${clientName}* (*${serviceName}*) logo em seguida, para as **${existingEndDt.toFormat('HH:mm')}**?\n` +
        `👉 Responda **SIM** para confirmar às *${existingEndDt.toFormat('HH:mm')}*! 💕`;

      if (whatsappClient) {
        await sendHumanizedMessage(whatsappClient, ownerPhone, conflictMsg, 4000);
      }
      return conflictMsg;
    }
  }

  // 2. Verifica se o horário está inicialmente bloqueado na tabela BlockedSlot ou no bloqueio quinzenal de terça
  const overlappingBlocks = await prisma.blockedSlot.findMany({
    where: {
      startTime: { lt: endJs },
      endTime: { gt: startJs },
    },
  });

  const isTuesdayBiweekly = isBiweeklyTuesdayBlocked(startJs, durationMinutes, tz);

  if (overlappingBlocks.length > 0 || isTuesdayBiweekly) {
    const blockReasonText = formatBlockedSlotReasonForOwner(overlappingBlocks, isTuesdayBiweekly, tz);

    pendingOwnerConfirmations.set(ownerPhone, {
      type: 'BOOK_OVER_BLOCK',
      ownerPhone,
      clientName,
      clientPhone,
      serviceName,
      totalAmount,
      durationMinutes,
      appointmentDate: startJs,
      formattedDateTime,
      blockedSlotIds: overlappingBlocks.map((b) => b.id),
      blockReasonText,
      createdAt: Date.now(),
    });

    const promptConfirmMsg =
      `⚠️ *Atenção, Jana! Horário Inicialmente Bloqueado*\n\n` +
      `Você pediu para agendar a cliente *${clientName}* (*${serviceName}*) para **${formattedDateTime}**, ` +
      `porém esse horário consta como bloqueado na sua grade.\n\n` +
      `📌 *Motivo do bloqueio:* ${blockReasonText}\n\n` +
      `Você deseja realmente **liberar esse horário** e confirmar o agendamento da cliente *${clientName}*?\n` +
      `👉 Responda **SIM** (ou *"Pode liberar"*) para eu liberar o horário e concluir o agendamento agora mesmo! 💕`;

    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, promptConfirmMsg, 4000);
    }
    return promptConfirmMsg;
  }

  // 3. Se não estiver bloqueado nem em conflito, efetiva o agendamento diretamente na agenda
  const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000);

  let comboBreakdownText = '';
  if (extractedSrv.subServices && extractedSrv.subServices.length > 1) {
    comboBreakdownText =
      `📋 *Procedimentos identificados (${extractedSrv.subServices.length} no combo):*\n` +
      extractedSrv.subServices.map((s: any) => `  • ${s.name} (${formatDurationLabel(s.durationMinutes)} - R$ ${s.price.toFixed(2).replace('.', ',')})`).join('\n') +
      `\n⏱️ *Tempo total somado:* ${durationLabel} | *Valor total:* R$ ${totalAmount.toFixed(2).replace('.', ',')}\n\n`;
  }

  const comboNotes = extractedSrv.subServices && extractedSrv.subServices.length > 1
    ? `[Combo de ${extractedSrv.subServices.length} Procedimentos: ${extractedSrv.subServices.map((s: any) => `${s.name} (R$ ${s.price}, ${s.durationMinutes}min)`).join(' + ')} | Duração total: ${durationMinutes} min]`
    : '[Agendado diretamente pela Janaína]';

  await prisma.appointment.create({
    data: {
      clientName,
      whatsappPhone: clientPhone,
      service: serviceName,
      appointmentDate: startJs,
      totalAmount: new Prisma.Decimal(totalAmount),
      depositAmount: new Prisma.Decimal(0),
      depositStatus: 'EXEMPT',
      generalStatus: 'CONFIRMED',
      depositDeadline: deadline,
      confirmedAt: new Date(),
      confirmedBy: 'Janaína (Direto)',
      isFirstAppointment: false,
      notes: comboNotes,
    },
  });

  const isComboBooking = Boolean(extractedSrv.subServices && extractedSrv.subServices.length > 1);
  const procedureDisplayLine = isComboBooking
    ? `💅 *Procedimento:* ${serviceName}\n`
    : `💅 *Procedimento:* ${serviceName} (${durationLabel} - R$ ${totalAmount.toFixed(2).replace('.', ',')})\n`;

  const directBookedMsg =
    `✅ *Agendamento Realizado com Sucesso, Jana!* ✨\n\n` +
    `👤 *Cliente:* ${clientName}\n` +
    procedureDisplayLine +
    comboBreakdownText +
    `🗓️ *Data e Horário:* ${formattedDateTime}\n` +
    `⏭️ *Próximo horário livre após ela:* ${endDt.toFormat('HH:mm')}\n\n` +
    `Já está registrado como *Confirmado* na sua agenda! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, directBookedMsg, 4000);
  }
  return directBookedMsg;
}

/**
 * Permite à Janaína liberar/desbloquear horários diretamente por comando de voz/texto
 */
export async function handleUnblockSlotByOwner(
  whatsappClient: WhatsAppClientLike | null | undefined,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  const tz = SALON_CONFIG.timezone;
  const parsedDate = parseDateFromQuery(rawText);
  const timeInfo = extractTime(rawText);
  const targetDt = DateTime.fromJSDate(parsedDate.targetDate, { zone: tz });

  const startOfDay = targetDt.startOf('day').toJSDate();
  const endOfDay = targetDt.endOf('day').toJSDate();

  const blocks = await prisma.blockedSlot.findMany({
    where: {
      startTime: { lte: endOfDay },
      endTime: { gte: startOfDay },
    },
  });

  const matchingBlocks = blocks.filter((b) => {
    if (!timeInfo?.timeStr) return true;
    const [h, m] = timeInfo.timeStr.split(':').map(Number);
    const checkDt = targetDt.set({ hour: h, minute: m || 0, second: 0, millisecond: 0 }).toJSDate();
    return checkDt >= b.startTime && checkDt < b.endTime;
  });

  if (matchingBlocks.length === 0) {
    const noneMsg = `Jana, não encontrei nenhum bloqueio ativo para ${targetDt.toFormat('dd/MM/yyyy')}${timeInfo?.timeStr ? ` às ${timeInfo.timeStr}` : ''}. O horário já está livre! ✨`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, noneMsg, 3500);
    }
    return noneMsg;
  }

  await prisma.blockedSlot.deleteMany({
    where: { id: { in: matchingBlocks.map((b) => b.id) } },
  });

  const unlockedMsg =
    `🔓 *Horário Liberado com Sucesso, Jana!* ✨\n\n` +
    `Removi ${matchingBlocks.length} bloqueio(s) do dia *${targetDt.toFormat('dd/MM/yyyy')}*` +
    `${timeInfo?.timeStr ? ` (horário das ${timeInfo.timeStr})` : ''}.\n` +
    `A vaga já está disponível novamente na sua grade! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, unlockedMsg, 3500);
  }
  return unlockedMsg;
}

/**
 * Permite à Janaína confirmar o sinal de uma cliente diretamente pelo WhatsApp
 */
export async function handleConfirmDepositByOwner(
  whatsappClient: WhatsAppClientLike | null | undefined,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  const cleaned = rawText
    .replace(/^(confirmar sinal|aprovar sinal|confirmar pix|aprovar pix|sinal pago)\s*(da|do|de|cliente)?/i, '')
    .trim();

  const pendingApt = await prisma.appointment.findFirst({
    where: {
      generalStatus: { not: 'CANCELLED' },
      depositStatus: { in: ['PENDING', 'RECEIPT_SENT'] },
      ...(cleaned.length >= 2 ? { clientName: { contains: cleaned } } : {}),
    },
    orderBy: { appointmentDate: 'asc' },
  });

  if (!pendingApt) {
    const notFound = `Jana, não encontrei nenhum pré-agendamento aguardando confirmação de sinal${cleaned ? ` para "${cleaned}"` : ''}. ✨`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, notFound, 3500);
    }
    return notFound;
  }

  await prisma.appointment.update({
    where: { id: pendingApt.id },
    data: {
      depositStatus: 'CONFIRMED',
      generalStatus: 'CONFIRMED',
      confirmedAt: new Date(),
      confirmedBy: 'Janaína (WhatsApp)',
    },
  });

  const aptDt = DateTime.fromJSDate(pendingApt.appointmentDate, { zone: SALON_CONFIG.timezone });
  const confirmMsg =
    `✅ *Sinal Confirmado com Sucesso, Jana!* ✨\n\n` +
    `O agendamento de *${pendingApt.clientName}* (${pendingApt.service} em ${aptDt.toFormat("dd/MM 'às' HH:mm")}) ` +
    `está 100% confirmado na sua agenda! 💖`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, confirmMsg, 3500);
  }
  return confirmMsg;
}

export default {
  handleOwnerCommands,
  reportDailyAgenda,
  handleBlockSlot,
  handleCancelAppointmentByOwner,
  handleOwnerDirectBooking,
  handleUnblockSlotByOwner,
  handleConfirmDepositByOwner,
  executePendingOwnerAction,
  pendingOwnerConfirmations,
};


/**
 * Calcula e relata para a Janaína os horários e vagas livres após o último atendimento do dia
 */
export async function reportAvailableSlotsToOwner(
  whatsappClient: WhatsAppClientLike | null | undefined,
  ownerPhone: string,
  targetDate: Date,
  rawText: string
): Promise<string> {
  const tz = SALON_CONFIG.timezone;
  const targetDt = DateTime.fromJSDate(targetDate, { zone: tz });
  const dayStart = targetDt.startOf('day').toJSDate();
  const dayEnd = targetDt.endOf('day').toJSDate();

  const appointments = await prisma.appointment.findMany({
    where: {
      generalStatus: { not: 'CANCELLED' },
      depositStatus: { not: 'EXPIRED' },
      appointmentDate: { gte: dayStart, lte: dayEnd },
    },
    orderBy: { appointmentDate: 'asc' },
  });

  const blockedSlots = await prisma.blockedSlot.findMany({
    where: {
      startTime: { lt: dayEnd },
      endTime: { gt: dayStart },
    },
    orderBy: { startTime: 'asc' },
  });

  const busyWindows: Array<{ startMs: number; endMs: number; label: string }> = [];
  for (const apt of appointments) {
    const aptDt = DateTime.fromJSDate(apt.appointmentDate, { zone: tz });
    let serviceName = apt.service;
    if (/studio\s*jf|procedimento\s*studio/i.test(serviceName)) {
      const noteMatch = (apt.notes || '').match(/procedimento:\s*([^|;,\n]+)/i);
      serviceName = noteMatch ? noteMatch[1].trim() : 'Design de Sobrancelha';
    }
    const dur = inferAppointmentDurationMinutes(serviceName);
    const end = aptDt.plus({ minutes: dur });
    busyWindows.push({
      startMs: aptDt.toMillis(),
      endMs: end.toMillis(),
      label: `${apt.clientName} (${aptDt.toFormat('HH:mm')} às ${end.toFormat('HH:mm')})`,
    });
  }

  for (const bs of blockedSlots) {
    const s = DateTime.fromJSDate(bs.startTime, { zone: tz });
    const e = DateTime.fromJSDate(bs.endTime, { zone: tz });
    busyWindows.push({
      startMs: s.toMillis(),
      endMs: e.toMillis(),
      label: `Bloqueio (${s.toFormat('HH:mm')} às ${e.toFormat('HH:mm')})`,
    });
  }

  // Verifica bloqueio quinzenal de terça-feira
  const midDayCheck = targetDt.set({ hour: 13, minute: 0 }).toJSDate();
  if (isBiweeklyTuesdayBlocked(midDayCheck, 60, tz)) {
    const tStart = targetDt.set({ hour: 13, minute: 0 });
    const tEnd = targetDt.set({ hour: 15, minute: 30 });
    busyWindows.push({
      startMs: tStart.toMillis(),
      endMs: tEnd.toMillis(),
      label: `Bloqueio Quinzenal (13:00 às 15:30)`,
    });
  }

  busyWindows.sort((a, b) => a.startMs - b.startMs);

  const isSaturday = targetDt.weekday === 6;
  const openHour = isSaturday ? 8 : 9;
  const closeHour = isSaturday ? 18 : 20;
  const closeMin = isSaturday ? 0 : 40;

  const openDt = targetDt.set({ hour: openHour, minute: 0, second: 0, millisecond: 0 });
  const closeDt = targetDt.set({ hour: closeHour, minute: closeMin, second: 0, millisecond: 0 });

  // Detecção de horário de corte "após / depois das HH:mm"
  const afterMatch = rawText.match(/(?:ap[oó]s|depois\s+d[ae]s?|a\s+partir\s+d[ae]s?)\s*(\d{1,2})(?:[:h](\d{2}))?/i);
  let filterAfterDt: DateTime | null = null;
  if (afterMatch) {
    const h = parseInt(afterMatch[1], 10);
    const m = afterMatch[2] ? parseInt(afterMatch[2], 10) : 0;
    filterAfterDt = targetDt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  }

  const rawIntervals: Array<{ start: DateTime; end: DateTime }> = [];
  let cursor = openDt;

  for (const busy of busyWindows) {
    const bStart = DateTime.fromMillis(busy.startMs, { zone: tz });
    const bEnd = DateTime.fromMillis(busy.endMs, { zone: tz });

    if (bStart > cursor && cursor < closeDt) {
      const intEnd = bStart < closeDt ? bStart : closeDt;
      if (intEnd.diff(cursor, 'minutes').minutes >= 30) {
        rawIntervals.push({ start: cursor, end: intEnd });
      }
    }
    if (bEnd > cursor) {
      cursor = bEnd;
    }
  }

  if (cursor < closeDt) {
    if (closeDt.diff(cursor, 'minutes').minutes >= 30) {
      rawIntervals.push({ start: cursor, end: closeDt });
    }
  }

  // Aplica filtro de "após" se fornecido
  let freeIntervals = rawIntervals;
  if (filterAfterDt) {
    const fDt = filterAfterDt;
    freeIntervals = [];
    for (const interval of rawIntervals) {
      if (interval.end <= fDt) continue;
      const effectiveStart = interval.start < fDt ? fDt : interval.start;
      if (interval.end.diff(effectiveStart, 'minutes').minutes >= 30) {
        freeIntervals.push({ start: effectiveStart, end: interval.end });
      }
    }
  }

  const formattedDate = targetDt.toFormat('dd/MM');
  const weekdayName = targetDt.setLocale('pt-BR').toFormat('cccc');
  const capWeekday = weekdayName.charAt(0).toUpperCase() + weekdayName.slice(1);

  if (freeIntervals.length === 0) {
    const reason = filterAfterDt ? `após as ${filterAfterDt.toFormat('HH:mm')}` : `para hoje (${formattedDate} - ${capWeekday})`;
    const msg = `Jana, ${reason} a sua grade já está 100% preenchida! Não temos outros horários livres até o encerramento do expediente (${closeDt.toFormat('HH:mm')}). ✨`;
    if (whatsappClient) {
      await sendHumanizedMessage(whatsappClient, ownerPhone, msg, 3500);
    }
    return msg;
  }

  // Determina o próximo horário disponível
  // Se a consulta foi geral ("qual outro horário disponível hoje?") e temos atendimentos agendados,
  // localiza o intervalo livre imediatamente após os atendimentos agendados
  let chosenInterval = freeIntervals[0];
  let afterBusyEvent: { startMs: number; endMs: number; label: string } | null = null;

  if (!filterAfterDt && busyWindows.length > 0) {
    // Procura o primeiro intervalo que começa após ou durante os atendimentos
    const lastBusy = busyWindows[busyWindows.length - 1];
    const postBusyInterval = freeIntervals.find(i => i.start.toMillis() >= lastBusy.endMs);
    if (postBusyInterval) {
      chosenInterval = postBusyInterval;
      afterBusyEvent = lastBusy;
    }
  }

  const nextAvailableTime = chosenInterval.start.toFormat('HH:mm');

  let contextText = '';
  if (filterAfterDt) {
    contextText = `Após as *${filterAfterDt.toFormat('HH:mm')}*, o próximo horário disponível é logo às *${nextAvailableTime}*! ✨\n\n`;
  } else if (afterBusyEvent) {
    const lastEnd = DateTime.fromMillis(afterBusyEvent.endMs, { zone: tz }).toFormat('HH:mm');
    contextText = `O próximo horário disponível na grade (após o término do atendimento das ${lastEnd}) é logo às *${nextAvailableTime}*! ✨\n\n`;
  } else {
    contextText = `O próximo horário disponível hoje é às *${nextAvailableTime}*! ✨\n\n`;
  }

  let intervalsListText = `Horários livres na grade (${formattedDate} - ${capWeekday}):\n`;
  for (const interval of freeIntervals) {
    const diffMin = Math.round(interval.end.diff(interval.start, 'minutes').minutes);
    const hours = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    const durStr = hours > 0 ? (mins > 0 ? `${hours}h${mins}min` : `${hours}h`) : `${mins}min`;
    intervalsListText += `• *${interval.start.toFormat('HH:mm')} às ${interval.end.toFormat('HH:mm')}* (${durStr} livres)\n`;
  }

  const fullMsg =
    `📋 *Horários Disponíveis, Jana!* ✨\n\n` +
    contextText +
    intervalsListText +
    `\nSe quiser agendar alguma cliente, é só me mandar: *"Marcar cliente [Nome] às [Horário] [Procedimento]"*! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, fullMsg, 4000);
  }
  return fullMsg;
}

/**
 * ============================================================================
 * GESTÃO EXECUTIVA DE CATÁLOGO, PREÇOS E PROMOÇÕES (JANAÍNA)
 * ============================================================================
 */

export function isOwnerPriceChangeIntent(cleanText: string): boolean {
  const norm = normalizeText(cleanText);
  if (/promo/i.test(norm)) return false;
  if (/adicionar|cadastrar|novo/i.test(norm)) return false;
  return (
    /(?:alterar|mudar|atualizar|trocar)\s+(?:o\s+)?(?:valor|pre[çc]o)\s*(?:d[oe]\s+|para\s+)?/i.test(norm) ||
    /(?:valor|pre[çc]o)\s+(?:d[oe]\s+)?(.+?)\s+(?:para|por)\s*(?:r\$\s*)?\d+/i.test(norm)
  );
}

export function isOwnerPromoIntent(cleanText: string): boolean {
  const norm = normalizeText(cleanText);
  return (
    /(?:tirar|encerrar|remover|cancelar|finalizar)\s+(?:a\s+)?promo[çc][aã]o/i.test(norm) ||
    /(?:promo[çc][aã]o|desconto)\s*(?:n[oe]\s+|d[oe]\s+)?(.+?)\s*(?:de\s+(?:r\$\s*)?\d+(?:[.,]\d{1,2})?\s+)?(?:por|para)\s*(?:r\$\s*)?\d+/i.test(norm) ||
    /(?:colocar|ativar)\s+(?:em\s+)?promo[çc][aã]o/i.test(norm) ||
    norm.startsWith('promocao ') ||
    norm.startsWith('promocao:')
  );
}

export function isOwnerAddServiceIntent(cleanText: string): boolean {
  const norm = normalizeText(cleanText);
  return /(?:adicionar|cadastrar|novo)\s+servi[çc]o/i.test(norm);
}

export function isOwnerListCatalogIntent(cleanText: string): boolean {
  const norm = normalizeText(cleanText);
  return (
    /(?:ver|listar|quais|consultar|mostrar)\s+(?:as\s+)?promo[çc][oõ]es/i.test(norm) ||
    /(?:ver|listar|consultar|mostrar)\s+(?:a\s+|os\s+)?(?:tabela|valores|pre[çc]os|servi[çc]os|procedimentos|catalogo)/i.test(norm) ||
    /\btabela\s+de\s+(?:valores|pre[çc]os|servi[çc]os|procedimentos)\b/i.test(norm) ||
    /\b(?:valores|pre[çc]os)\s+d[eao]s?\s+(?:cilios|sobrancelhas?|depila[çc][aã]o|epila[çc][aã]o|limpeza|procedimentos|servi[çc]os)\b/i.test(norm) ||
    norm === 'promocoes' ||
    norm === 'promocao' ||
    norm === 'precos' ||
    norm === 'valores' ||
    norm === 'servicos' ||
    norm === 'tabela'
  );
}

export async function handleOwnerPriceChange(
  whatsappClient: WhatsAppClientLike | null,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  let match = rawText.match(/(?:alterar|mudar|atualizar|trocar)\s+(?:o\s+)?(?:valor|pre[çc]o)\s*(?:d[oe]\s+)?(.+?)\s+(?:para|por)\s*(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/i);
  if (!match) {
    match = rawText.match(/(?:valor|pre[çc]o)\s*(?:d[oe]\s+)?(.+?)\s+(?:para|por)\s*(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/i);
  }

  if (!match) {
    const errorMsg = `Não entendi o valor ou procedimento, Jana! ✨\n\nVocê pode me mandar assim:\n*"Alterar valor do Volume Brasileiro para 90"*\nou\n*"Mudar preço Design de Sobrancelha para 30"* 💕`;
    if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, errorMsg, 3000);
    return errorMsg;
  }

  const serviceQuery = match[1].trim();
  const newPrice = parseFloat(match[2].replace(',', '.'));

  const result = serviceCatalogService.updateServicePrice(serviceQuery, newPrice, false);

  if (!result.success || !result.service) {
    const notFoundMsg = `⚠️ *Procedimento não encontrado, Jana!*\n\nProcurei por "*${serviceQuery}*", mas não achei na tabela atual.\nSe quiser cadastrar como um novo procedimento, é só me mandar:\n*"Adicionar serviço ${serviceQuery}, valor ${newPrice}, duração 60 min"* 💕`;
    if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, notFoundMsg, 3000);
    return notFoundMsg;
  }

  const successMsg =
    `✨ *Valor Atualizado com Sucesso, Jana!* 💅\n\n` +
    `O procedimento *${result.service.name}* teve seu valor alterado:\n` +
    `💰 *Novo valor oficial:* R$ ${Number(result.service.price).toFixed(2).replace('.', ',')}\n\n` +
    `Já sincronizei na minha inteligência de atendimento e no painel online (/agendar) para as clientes! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, successMsg, 3000);
  }
  return successMsg;
}

export async function handleOwnerPromotion(
  whatsappClient: WhatsAppClientLike | null,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  // 1. Encerrar promoção
  const removeMatch = rawText.match(/(?:tirar|encerrar|remover|cancelar|finalizar)\s+(?:a\s+)?promo[çc][aã]o\s*(?:d[oe]\s+)?(.+)/i);
  if (removeMatch) {
    const serviceQuery = removeMatch[1].trim();
    const result = serviceCatalogService.removePromotion(serviceQuery);
    if (!result.success || !result.service) {
      const notFoundMsg = `⚠️ Não encontrei o procedimento "*${serviceQuery}*" para remover a promoção, Jana! Verifique o nome e tente novamente. 💕`;
      if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, notFoundMsg, 3000);
      return notFoundMsg;
    }

    const cancelMsg =
      `✨ *Promoção Encerrada com Sucesso, Jana!* 🌸\n\n` +
      `O procedimento *${result.service.name}* voltou ao seu valor regular:\n` +
      `💰 *Valor normal:* R$ ${Number(result.service.price).toFixed(2).replace('.', ',')}\n\n` +
      `Já retirei a oferta do painel online (/agendar) e minhas respostas para as clientes já foram normalizadas! 💕`;
    if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, cancelMsg, 3000);
    return cancelMsg;
  }

  // 2. Ativar promoção
  let promoMatch = rawText.match(/(?:promo[çc][aã]o|desconto)\s*(?:n[oe]\s+|d[oe]\s+)?(.+?)\s*(?:de\s+(?:r\$\s*)?\d+(?:[.,]\d{1,2})?\s+)?(?:por|para)\s*(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/i);
  if (!promoMatch) {
    promoMatch = rawText.match(/(?:colocar\s+em\s+promo[çc][aã]o|ativar\s+promo[çc][aã]o)\s*(?:d[oe]\s+)?(.+?)\s+(?:por|para)\s*(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/i);
  }
  if (!promoMatch) {
    promoMatch = rawText.match(/promo[çc][aã]o:?\s*(.+?)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)$/i);
  }

  if (!promoMatch) {
    const helpPromo =
      `Para ativar uma promoção, você pode me mandar assim, Jana:\n` +
      `*"Promoção Volume Brasileiro por 80"*\n` +
      `ou\n` +
      `*"Promoção Design de Sobrancelha de 25 por 20"*\n\n` +
      `E para encerrar:\n` +
      `*"Tirar promoção do Volume Brasileiro"* 💕`;
    if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, helpPromo, 3000);
    return helpPromo;
  }

  const serviceQuery = promoMatch[1].trim();
  const promoPrice = parseFloat(promoMatch[2].replace(',', '.'));

  const result = serviceCatalogService.updateServicePrice(serviceQuery, promoPrice, true);

  if (!result.success || !result.service) {
    const notFoundMsg = `⚠️ *Procedimento não encontrado, Jana!*\n\nNão encontrei nenhum serviço com o nome "*${serviceQuery}*".\nVerifique o nome cadastrado e tente novamente! 💕`;
    if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, notFoundMsg, 3000);
    return notFoundMsg;
  }

  const origStr = result.service.originalPrice ? `R$ ${Number(result.service.originalPrice).toFixed(2).replace('.', ',')}` : '';
  const promoStr = `R$ ${Number(result.service.price).toFixed(2).replace('.', ',')}`;

  const successMsg =
    `🎉 *Promoção Ativada com Sucesso, Jana!* ✨\n\n` +
    `O procedimento *${result.service.name}* entrou em oferta especial:\n` +
    (origStr ? `🔥 De: ~${origStr}~\n` : '') +
    `🏷️ *Por apenas: ${promoStr}*\n\n` +
    `Já destaquei a promoção no painel online (/agendar) para as clientes e vou oferecer com carinho esse desconto aqui no WhatsApp! 💖`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, successMsg, 3000);
  }
  return successMsg;
}

export async function handleOwnerAddService(
  whatsappClient: WhatsAppClientLike | null,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  const bodyText = rawText.replace(/^(?:adicionar|cadastrar|novo)\s+servi[çc]o\s*:?\s*/i, '').trim();

  const priceMatch = bodyText.match(/(?:valor|pre[çc]o|custo|por)\s*(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)/i);
  let durationMinutes = 60;
  const durationMatch = bodyText.match(/(?:dura[çc][aã]o|tempo)\s*(\d+)h\s*(\d+)?/i);
  if (durationMatch) {
    const h = parseInt(durationMatch[1], 10);
    const m = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
    durationMinutes = h * 60 + m;
  } else {
    const minMatch = bodyText.match(/(?:dura[çc][aã]o|tempo)\s*(\d+)\s*(?:min|m)?/i);
    if (minMatch) {
      durationMinutes = parseInt(minMatch[1], 10);
    }
  }

  let serviceName = bodyText;
  const delimiterMatch = bodyText.match(/^(.+?)(?:,|\s+(?:valor|pre[çc]o|custo|dura[çc][aã]o|tempo))/i);
  if (delimiterMatch) {
    serviceName = delimiterMatch[1].trim();
  }

  if (!priceMatch) {
    const helpMsg =
      `Jana, para adicionar um novo procedimento preciso do nome e do valor! ✨\n\n` +
      `Exemplo de envio:\n` +
      `*"Adicionar serviço Lash Lifting, valor 110, duração 60 min"*\nou\n` +
      `*"Cadastrar serviço Brow Lamination, valor 90, tempo 45"* 💕`;
    if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, helpMsg, 3000);
    return helpMsg;
  }

  const price = parseFloat(priceMatch[1].replace(',', '.'));

  const result = serviceCatalogService.addCustomService({
    name: serviceName,
    price,
    durationMinutes,
  });

  if (!result.success || !result.service) {
    const errorMsg = `⚠️ ${result.message || 'Não consegui adicionar o procedimento, Jana.'}`;
    if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, errorMsg, 3000);
    return errorMsg;
  }

  const successMsg =
    `✨ *Novo Procedimento Cadastrado com Sucesso, Jana!* 🌸\n\n` +
    `📌 *Procedimento:* ${result.service.name}\n` +
    `💰 *Valor:* R$ ${Number(result.service.price).toFixed(2).replace('.', ',')}\n` +
    `⏱️ *Duração:* ${formatDurationLabel(result.service.durationMinutes)} (${result.service.durationMinutes} min)\n` +
    `📂 *Categoria:* ${result.service.category}\n\n` +
    `O procedimento já está disponível imediatamente para as clientes agendarem no painel online (/agendar) e pelo WhatsApp! 💕`;

  if (whatsappClient) {
    await sendHumanizedMessage(whatsappClient, ownerPhone, successMsg, 3000);
  }
  return successMsg;
}

export async function handleOwnerListCatalog(
  whatsappClient: WhatsAppClientLike | null,
  ownerPhone: string,
  rawText: string
): Promise<string> {
  const norm = normalizeText(rawText);

  if (/promo/i.test(norm)) {
    const promos = serviceCatalogService.getActivePromotions();
    if (promos.length === 0) {
      const msg = `Jana, no momento não temos nenhuma promoção ativa no catálogo! ✨\n\nPara colocar um procedimento em promoção, basta me enviar:\n*"Promoção [Nome do Procedimento] por R$ [Valor]"* 💕`;
      if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, msg, 3000);
      return msg;
    }

    let msg = `🔥 *Promoções Ativas no Studio JF:* ✨\n\n`;
    for (const p of promos) {
      const orig = p.originalPrice ? `~R$ ${Number(p.originalPrice).toFixed(2).replace('.', ',')}~ ` : '';
      msg += `• *${p.name}*: ${orig}*R$ ${Number(p.price).toFixed(2).replace('.', ',')}*\n`;
    }
    msg += `\nPara alterar ou encerrar, basta me enviar: *"Tirar promoção [Procedimento]"*! 💕`;
    if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, msg, 3000);
    return msg;
  }

  const services = serviceCatalogService.getAllServices();
  const filterLashesOnly = /\bcilios\b/i.test(norm) && !/\bsobrancelh/i.test(norm) && !/\b(?:depila|epila)/i.test(norm);
  const filterBrowsOnly = /\bsobrancelh/i.test(norm) && !/\bcilios\b/i.test(norm) && !/\b(?:depila|epila)/i.test(norm);
  const filterWaxOnly = /\b(?:depila|epila|limpeza)/i.test(norm) && !/\bcilios\b/i.test(norm) && !/\bsobrancelh/i.test(norm);

  let msg = `📋 *Tabela de Procedimentos e Valores - Studio JF:* ✨\n\n`;
  const lashes = services.filter(s => s.category.includes('cilios'));
  const brows = services.filter(s => s.category.includes('sobrancelha'));
  const waxAndSkin = services.filter(s => !s.category.includes('cilios') && !s.category.includes('sobrancelha'));

  if (lashes.length > 0 && (!filterBrowsOnly && !filterWaxOnly)) {
    msg += `👁️ *Cílios (Colocação & Manutenção):*\n`;
    const listToRender = filterLashesOnly ? lashes : lashes.slice(0, 12);
    for (const s of listToRender) {
      const promoBadge = s.isPromotional ? ' 🔥 [PROMO]' : '';
      const durStr = formatDurationLabel(s.durationMinutes);
      msg += `• ${s.name} (${durStr}): *R$ ${Number(s.price).toFixed(2).replace('.', ',')}*${promoBadge}\n`;
    }
    msg += `\n`;
  }

  if (brows.length > 0 && (!filterLashesOnly && !filterWaxOnly)) {
    msg += `✨ *Sobrancelhas:*\n`;
    for (const s of brows) {
      const promoBadge = s.isPromotional ? ' 🔥 [PROMO]' : '';
      const durStr = formatDurationLabel(s.durationMinutes);
      msg += `• ${s.name} (${durStr}): *R$ ${Number(s.price).toFixed(2).replace('.', ',')}*${promoBadge}\n`;
    }
    msg += `\n`;
  }

  if (waxAndSkin.length > 0 && (filterWaxOnly || (!filterLashesOnly && !filterBrowsOnly))) {
    msg += `🌸 *Depilação & Estética Facial:*\n`;
    const listToRender = filterWaxOnly ? waxAndSkin : waxAndSkin.slice(0, 8);
    for (const s of listToRender) {
      const promoBadge = s.isPromotional ? ' 🔥 [PROMO]' : '';
      const durStr = formatDurationLabel(s.durationMinutes);
      msg += `• ${s.name} (${durStr}): *R$ ${Number(s.price).toFixed(2).replace('.', ',')}*${promoBadge}\n`;
    }
    msg += `\n`;
  }

  msg += `_Para alterar qualquer valor ou tempo, acesse a aba "💅 Procedimentos, Tempos & Valores" no Dashboard ou me envie:_\n`;
  msg += `_"Alterar valor [procedimento] para [preço]"_ 💕`;

  if (whatsappClient) await sendHumanizedMessage(whatsappClient, ownerPhone, msg, 4000);
  return msg;
}
