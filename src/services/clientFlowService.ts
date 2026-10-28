/**
 * clientFlowService.ts
 * Atendimento ao cliente pela Alícia no canal oficial do Studio JF Designer:
 * - Controle de inatividade de 10 min (600.000 ms)
 * - Processamento conversacional e agendamentos
 * - Envio de respostas humanizadas com presença ("digitando...")
 * - Detecção de transbordo humano (handover)
 */

import { AIService } from './aiService';
import { SessionManager } from './sessionManager';
import { WhatsAppClientLike, sendHumanizedMessage } from '../utils/whatsappHelper';
import {
  getDepositRequestMessage,
  getLateRescheduleDepositMessage,
  buildExistingClientConfirmedMessage,
  buildRescheduleWithin24hMessage,
  calculateDeposit50Percent,
  STUDIO_OFFICIAL_PIX_KEY,
} from './notificationService';

export interface ClientBookingRuleParams {
  customerPhone: string;
  customerName?: string;
  serviceName?: string;
  appointmentDateFormatted?: string;
  formattedDate?: string;
  formattedTime?: string;
  history?: {
    confirmedCount: number;
  };
  serviceTotal: number;
  depositAmount?: number;
  depositDeadlineFormatted?: string;
}

export interface ClientBookingRuleResult {
  requiresDeposit: boolean;
  depositAmount: number;
  depositStatus: 'PENDING' | 'EXEMPT';
  overallStatus: 'PRE_BOOKED' | 'CONFIRMED';
  generalStatus: 'PRE_SCHEDULED' | 'CONFIRMED';
  pixKey: string | null;
  replyMessage: string;
}

/**
 * Aplica a regra diferenciada de sinal (1ª Vez vs Cliente Antiga):
 * - 0 atendimentos prévios confirmados: Exige sinal atualizado de 50% do valor do procedimento (via PIX 21960003154 ou link de pagamento por cartão)
 * - 1 ou mais atendimentos confirmados: Isenção total de sinal e confirmação imediata
 */
export function processClientBookingRules(params: ClientBookingRuleParams): ClientBookingRuleResult {
  const confirmedCount = params.history?.confirmedCount ?? 0;
  const isReturningCustomer = confirmedCount >= 1;
  const customerName = params.customerName || 'Cliente';
  const serviceName = params.serviceName || 'Procedimento';
  const totalAmount = Number(params.serviceTotal || 0);
  const formattedDate = params.formattedDate || 'Data agendada';
  const formattedTime = params.formattedTime || 'Horário agendado';
  const appointmentDateFormatted = params.appointmentDateFormatted || `${formattedDate} às ${formattedTime}`;
  const depositDeadlineFormatted = params.depositDeadlineFormatted || '2 horas';

  if (isReturningCustomer) {
    const replyMessage = buildExistingClientConfirmedMessage({
      clientName: customerName,
      service: serviceName,
      formattedDate,
      formattedTime,
      totalAmount: totalAmount.toFixed(2).replace('.', ','),
    });

    return {
      requiresDeposit: false,
      depositAmount: 0,
      depositStatus: 'EXEMPT',
      overallStatus: 'CONFIRMED',
      generalStatus: 'CONFIRMED',
      pixKey: null,
      replyMessage,
    };
  }

  const depositAmount =
    params.depositAmount !== undefined ? Number(params.depositAmount) : calculateDeposit50Percent(totalAmount);
  const replyMessage = getDepositRequestMessage({
    customerName,
    serviceName,
    appointmentDateFormatted,
    totalAmount,
    depositAmount,
    depositDeadlineFormatted,
  });

  return {
    requiresDeposit: true,
    depositAmount,
    depositStatus: 'PENDING',
    overallStatus: 'PRE_BOOKED',
    generalStatus: 'PRE_SCHEDULED',
    pixKey: STUDIO_OFFICIAL_PIX_KEY,
    replyMessage,
  };
}

export interface ReschedulePolicyParams {
  appointmentTime: Date | string;
  requestTime?: Date | string;
  isRegularCustomer?: boolean;
  customerName?: string;
  newDateFormatted?: string;
  depositDeadlineFormatted?: string;
  feeAmount?: number;
}

export interface ReschedulePolicyResult {
  chargeFee: boolean;
  requiredFeeAmount: number;
  hoursNotice: number;
  pixKey: string | null;
  clientNotice: string;
}

/**
 * Avalia a política de remarcação de horários (Regra das 24 horas):
 * - >= 24h de antecedência: Sem cobrança de taxa adicional
 * - < 24h de antecedência: Perde isenção e exige taxa de reserva de R$ 20,00 (Chave PIX: 21960003154)
 */
export function checkReschedulePolicy(params: ReschedulePolicyParams): ReschedulePolicyResult {
  const aptDate = params.appointmentTime instanceof Date ? params.appointmentTime : new Date(params.appointmentTime);
  const reqDate = params.requestTime
    ? params.requestTime instanceof Date
      ? params.requestTime
      : new Date(params.requestTime)
    : new Date();

  const diffMs = aptDate.getTime() - reqDate.getTime();
  const hoursNotice = diffMs / (1000 * 60 * 60);
  const customerName = params.customerName || 'Cliente';

  if (hoursNotice >= 24) {
    return {
      chargeFee: false,
      requiredFeeAmount: 0,
      hoursNotice: Math.round(hoursNotice),
      pixKey: null,
      clientNotice: buildRescheduleWithin24hMessage({ clientName: customerName }),
    };
  }

  const requiredFeeAmount = params.feeAmount !== undefined ? Number(params.feeAmount) : 20.00;
  const clientNotice = getLateRescheduleDepositMessage({
    customerName,
    newDateFormatted: params.newDateFormatted || 'nova data escolhida',
    depositAmount: requiredFeeAmount,
    depositDeadlineFormatted: params.depositDeadlineFormatted || '2 horas',
  });

  return {
    chargeFee: true,
    requiredFeeAmount,
    hoursNotice: Math.round(hoursNotice),
    pixKey: STUDIO_OFFICIAL_PIX_KEY,
    clientNotice,
  };
}

export interface ClientFlowServices {
  aiService: AIService;
  sessionManager: SessionManager;
  handoverSessions?: Set<string>;
}

let defaultServices: ClientFlowServices | null = null;

export function setClientFlowServices(services: ClientFlowServices) {
  defaultServices = services;
}

/**
 * Ponto de entrada do fluxo conversacional da cliente
 */
export async function handleClientFlow(
  whatsappClient: WhatsAppClientLike,
  clientPhone: string,
  messageBody: string,
  services?: ClientFlowServices
): Promise<{ status: string; reply: string; isTimeoutReset: boolean; isHandoverTriggered: boolean }> {
  const activeServices = services || defaultServices;
  if (!activeServices) {
    throw new Error('Serviços do clientFlowService não foram inicializados.');
  }

  const { aiService, sessionManager, handoverSessions } = activeServices;
  const cleanPhone = clientPhone.replace(/\D/g, '');

  // 1. Verifica se a cliente já está em atendimento humano direto com a Janaína
  if (handoverSessions && handoverSessions.has(cleanPhone)) {
    console.log(`⏸️ [TRANSBORDO ATIVO] Cliente ${cleanPhone} está em conversa direta com a proprietária.`);
    return {
      status: 'handover_active',
      reply: '',
      isTimeoutReset: false,
      isHandoverTriggered: true,
    };
  }

  // 2. Valida janela de inatividade estrita de 10 minutos (600.000 ms)
  const sessionCheck = await sessionManager.validateAndTouchSession(cleanPhone);

  if (sessionCheck.isTimeout) {
    const timeoutMsg = sessionCheck.timeoutMessage;
    const aiResult = await aiService.processMessage({
      clientPhone: cleanPhone,
      messageText: messageBody,
      senderRole: 'client',
      conversationHistory: sessionCheck.session.conversationHistory,
    });

    const fullReply = `${timeoutMsg}\n\n${aiResult.reply}`;
    sessionManager.updateHistory(cleanPhone, messageBody, aiResult.reply);

    await sendHumanizedMessage(whatsappClient, cleanPhone, fullReply, 5000);

    return {
      status: 'success',
      reply: fullReply,
      isTimeoutReset: true,
      isHandoverTriggered: !!aiResult.isHandoverTriggered,
    };
  }

  // 3. Processamento normal de IA / Agendamentos com a Alícia
  const aiResult = await aiService.processMessage({
    clientPhone: cleanPhone,
    messageText: messageBody,
    senderRole: 'client',
    conversationHistory: sessionCheck.session.conversationHistory,
  });

  sessionManager.updateHistory(cleanPhone, messageBody, aiResult.reply);

  await sendHumanizedMessage(whatsappClient, cleanPhone, aiResult.reply, 5000);

  // 4. Se a IA solicitar transbordo humano, aciona alerta
  if (aiResult.isHandoverTriggered && handoverSessions) {
    handoverSessions.add(cleanPhone);
    if ((whatsappClient as any).notifyOwnerOfHandover) {
      await (whatsappClient as any).notifyOwnerOfHandover(
        cleanPhone,
        aiResult.handoverReason || 'Solicitação de atendimento humano',
        messageBody
      );
    }
  }

  return {
    status: 'success',
    reply: aiResult.reply,
    isTimeoutReset: false,
    isHandoverTriggered: !!aiResult.isHandoverTriggered,
  };
}

export default {
  handleClientFlow,
  setClientFlowServices,
  processClientBookingRules,
  checkReschedulePolicy,
};
