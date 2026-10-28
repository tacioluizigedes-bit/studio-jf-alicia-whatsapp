import { Appointment } from '@prisma/client';
import { WhatsAppService } from './whatsappService';
import { SALON_CONFIG } from '../config/salonConfig';
import { DateTime } from 'luxon';

const whatsappService = new WhatsAppService();

export interface WeeklyOwnerReportData {
  pastWeek: {
    startDateStr: string; // DD/MM
    endDateStr: string;   // DD/MM
    confirmedCount: number;
    depositRevenue: number;
    totalRevenue: number;
    cancelledCount: number;
  };
  nextWeek: {
    startDateStr: string; // DD/MM
    endDateStr: string;   // DD/MM
    totalScheduled: number;
    confirmedCount: number;
    pendingCount: number;
    busiestDaysText: string;
  };
}

// ==========================================
// TEMPLATES DE MENSAGENS OFICIAIS DA ALÍCIA
// ==========================================

export const STUDIO_OFFICIAL_PIX_KEY = '21960003154';

/**
 * Calcula o valor atualizado do sinal: 50% do valor total do procedimento
 */
export function calculateDeposit50Percent(totalAmount: number | string): number {
  const num = typeof totalAmount === 'string' ? parseFloat(totalAmount.replace(',', '.')) : Number(totalAmount);
  if (!num || isNaN(num) || num <= 0) return 20.0;
  return Number((num * 0.5).toFixed(2));
}

/**
 * Template: Cobrança de Sinal (50%) para 1ª vez (PIX ou Link de Cartão) + Regras de Abatimento e Multa 24h
 * Chave Oficial do Studio: 21960003154
 */
export function getDepositRequestMessage({
  customerName,
  serviceName,
  appointmentDateFormatted,
  totalAmount,
  depositAmount,
  depositDeadlineFormatted,
}: {
  customerName: string;
  serviceName: string;
  appointmentDateFormatted: string;
  totalAmount: number | string;
  depositAmount?: number | string;
  depositDeadlineFormatted: string;
}): string {
  const cleanTotal = typeof totalAmount === 'string' ? parseFloat(totalAmount.replace(',', '.')) : Number(totalAmount);
  const cleanDeposit =
    depositAmount !== undefined
      ? typeof depositAmount === 'string'
        ? parseFloat(depositAmount.replace(',', '.'))
        : Number(depositAmount)
      : calculateDeposit50Percent(cleanTotal);

  return (
    `Perfeito, *${customerName}*! Já separei esse horário na nossa agenda: ✨\n\n` +
    `💅 *Procedimento:* ${serviceName}\n` +
    `🗓️ *Data e Horário:* ${appointmentDateFormatted}\n` +
    `💰 *Valor do Serviço:* R$ ${Number(cleanTotal).toFixed(2).replace('.', ',')}\n\n` +
    `⚠️ *Garantia do Horário (Sinal de 50%):*\n` +
    `Para confirmarmos a sua vaga, solicitamos um sinal de **50%** no valor de **R$ ${Number(cleanDeposit).toFixed(2).replace('.', ',')}**.\n` +
    `✅ *O valor do sinal será abatido integralmente no ato do procedimento!*\n\n` +
    `🔑 *Chave PIX Oficial do Studio:* \`21960003154\`\n` +
    `💳 *Não vai fazer via PIX?* O sinal também pode ser pago através do **link de pagamento por cartão** (basta me avisar aqui que já te envio o link!).\n` +
    `⏳ *Prazo para envio do comprovante:* até **${depositDeadlineFormatted}** ` +
    `(após esse horário a vaga é liberada automaticamente).\n\n` +
    `📌 *Política de Falta e Cancelamento (Prazo de 24h):*\n` +
    `Caso você não compareça no dia e não informe dentro do prazo de **24 horas antes do atendimento**, o valor do sinal **não será devolvido e ficará retido como multa**. Para agendar um novo atendimento, será cobrado um **novo sinal**.\n\n` +
    `Assim que realizar o pagamento via Pix ou solicitar o link de cartão, me avise por aqui para confirmarmos de vez! 💖`
  );
}

/**
 * Template: Cobrança de Sinal (50%) por Remarcação com menos de 24h / Falta
 * Chave Oficial do Studio: 21960003154
 */
export function getLateRescheduleDepositMessage({
  customerName,
  newDateFormatted,
  depositAmount,
  totalAmount,
  depositDeadlineFormatted,
}: {
  customerName: string;
  newDateFormatted: string;
  depositAmount?: number | string;
  totalAmount?: number | string;
  depositDeadlineFormatted: string;
}): string {
  const cleanDeposit =
    depositAmount !== undefined
      ? typeof depositAmount === 'string'
        ? parseFloat(depositAmount.replace(',', '.'))
        : Number(depositAmount)
      : totalAmount !== undefined
      ? calculateDeposit50Percent(totalAmount)
      : 20.0;

  return (
    `Poxa, *${customerName}*, sinto muito pelo imprevisto! 🥺\n\n` +
    `Como o aviso foi feito com menos de 24 horas do atendimento reservado (ou por ausência no dia), ` +
    `o sinal anterior não é devolvido (ficando retido como multa) e, para agendar um novo atendimento (*${newDateFormatted}*), ` +
    `é necessário o pagamento de um **novo sinal (50%)** no valor de **R$ ${Number(cleanDeposit).toFixed(2).replace('.', ',')}** ` +
    `(que será abatido no ato do procedimento).\n\n` +
    `🔑 *Chave PIX Oficial do Studio:* \`21960003154\`\n` +
    `💳 *Pagamento por Cartão:* Se não for fazer em PIX, o sinal pode ser feito através do **link de pagamento por cartão** (só me pedir o link por aqui!).\n` +
    `⏳ *Prazo de envio:* até **${depositDeadlineFormatted}**.\n\n` +
    `Assim que enviar o comprovante por aqui, já deixo a nova data 100% garantida! 💕`
  );
}

/**
 * Template: Alerta de Vencimento de Pré-Agendamento
 */
export function getDepositExpiringAlertMessage({
  customerName,
  depositDeadlineFormatted,
}: {
  customerName: string;
  depositDeadlineFormatted: string;
}): string {
  return (
    `Oi, *${customerName}*! Passando rapidinho para avisar que a sua pré-reserva ` +
    `está aguardando a confirmação do sinal (50%) até às **${depositDeadlineFormatted}**. ⏳\n\n` +
    `🔑 *Chave PIX:* \`21960003154\`\n` +
    `💳 _Caso prefira pagar no cartão, me avise que envio o link de pagamento por cartão!_\n\n` +
    `Se já realizou o pagamento, por favor envie o comprovante por aqui para não perder o seu horário! ✨`
  );
}

/**
 * Mensagem 1.1: Solicitação do Sinal (Pré-agendamento - Cliente Nova)
 */
export function buildNewClientDepositRequestMessage(data: {
  clientName: string;
  service: string;
  formattedDate: string;
  formattedTime: string;
  totalAmount: string | number;
  depositAmount?: string | number;
  pixKey?: string;
  depositDeadlineFormatted: string;
}): string {
  return getDepositRequestMessage({
    customerName: data.clientName,
    serviceName: data.service,
    appointmentDateFormatted: `${data.formattedDate} às ${data.formattedTime}`,
    totalAmount: data.totalAmount,
    depositAmount: data.depositAmount,
    depositDeadlineFormatted: data.depositDeadlineFormatted,
  });
}

/**
 * Mensagem 1.2: Confirmação do Sinal e Regras de Atendimento (Cliente Nova)
 */
export function buildNewClientDepositConfirmedMessage(data: {
  formattedDate: string;
  formattedTime: string;
  address: string;
}): string {
  return (
    `Comprovante recebido e validado com sucesso! 🎉\n\n` +
    `Seu horário está 100% confirmado:\n\n` +
    `🗓️ ${data.formattedDate} às ${data.formattedTime}\n` +
    `📍 Endereço: ${data.address}\n\n` +
    `📌 *Informações importantes sobre o seu sinal (50%):*\n` +
    `• O valor do sinal será **abatido integralmente no ato do procedimento**.\n` +
    `• Te enviarei um lembrete 1 dia antes do seu atendimento.\n` +
    `• ⚠️ Caso não compareça no dia e não informe dentro do prazo de **24 horas antes do atendimento**, o valor do sinal **não será devolvido e ficará como multa**. Para agendar um novo atendimento, será cobrado um **novo sinal**.\n\n` +
    `Estamos ansiosas para te receber! Qualquer dúvida, estou por aqui. 🥰`
  );
}

/**
 * Mensagem 2.1: Confirmação Imediata (Cliente Recorrente / Isenta de Sinal)
 */
export function buildExistingClientConfirmedMessage(data: {
  clientName: string;
  service: string;
  formattedDate: string;
  formattedTime: string;
  totalAmount: string;
}): string {
  return (
    `Oi, ${data.clientName}, maravilhosa! É sempre um prazer cuidar de você! 💕\n\n` +
    `Seu horário já está garantido e confirmado:\n\n` +
    `💅 Procedimento: ${data.service}\n` +
    `🗓️ Data: ${data.formattedDate} às ${data.formattedTime}\n` +
    `💰 Valor: R$ ${data.totalAmount}\n\n` +
    `✨ *Atenção à nossa política de agendamento:*\n` +
    `Por ser nossa cliente recorrente, você tem **isenção do pagamento de sinal**! Porém, caso precise alterar a data ou horário, é necessário avisar com no mínimo **24 horas de antecedência**.\n\n` +
    `⚠️ Caso não compareça no dia e não informe dentro do prazo de 24 horas antes do atendimento, para agendar um novo atendimento será cobrado o sinal de **50%** (via PIX ou link de pagamento por cartão, abatido no ato do procedimento).\n\n` +
    `Combinado? Te vejo em breve! Se precisar de algo antes, só me chamar. ✨`
  );
}

/**
 * Mensagem 3.1: Lembrete de Atendimento 1 Dia Antes (Véspera / 24h antes para todas as clientes)
 */
export function build24hReminderMessage(data: {
  clientName: string;
  formattedDate: string;
  formattedTime: string;
  service: string;
  address: string;
}): string {
  return (
    `Olá, *${data.clientName}*! Tudo bem? Passando um dia antes para lembrar do seu atendimento amanhã no *Studio JF Designer*! 💖\n\n` +
    `🗓️ *Data:* Amanhã, ${data.formattedDate} às ${data.formattedTime}\n` +
    `💅 *Procedimento:* ${data.service}\n` +
    `📍 *Local:* ${data.address}\n\n` +
    `Você confirma a sua presença?\n` +
    `Por favor, responda com:\n` +
    `1️⃣ para *SIM, CONFIRMO*\n` +
    `2️⃣ para *PRECISO REMARCAR*\n\n` +
    `📌 *Lembrete Importante:* O valor do sinal (quando aplicável) será abatido no ato do procedimento. Caso não compareça no dia e não informe dentro do prazo de 24 horas antes do atendimento, o valor do sinal não será devolvido (ficando como multa), e para agendar um novo atendimento será cobrado um novo sinal (50%). Aguardo sua confirmação! ✨`
  );
}

/**
 * Mensagem 3.2: Lembrete Semanal de Segunda-Feira (para todas as clientes agendadas na semana)
 */
export function buildWeeklyClientReminderMessage(data: {
  clientName: string;
  weekdayName: string;
  formattedDate: string;
  formattedTime: string;
  service: string;
  address: string;
}): string {
  return (
    `Bom dia e ótima semana, *${data.clientName}*! 🌸✨\n\n` +
    `Aqui é a Alícia, do *Studio JF Designer*. Passando nesta segunda-feira para lembrar que temos um encontro marcado nesta semana para cuidar de você:\n\n` +
    `🗓️ *Dia:* ${data.weekdayName} (${data.formattedDate}) às *${data.formattedTime}*\n` +
    `💅 *Procedimento:* ${data.service}\n` +
    `📍 *Local:* ${data.address}\n\n` +
    `📌 *Lembrete:* O valor do sinal (quando pago) é abatido no ato do procedimento. Caso precise de qualquer alteração, lembre-se de nos avisar com no mínimo **24 horas de antecedência** (em caso de falta ou aviso com menos de 24h, o sinal não é devolvido, ficando como multa, e um novo agendamento exigirá novo sinal de 50%).\n\n` +
    `Um dia antes do seu horário eu passo novamente por aqui para confirmar sua presença! Qualquer dúvida, estou à disposição. 💕`
  );
}

/**
 * Mensagem 4.1: Remarcação dentro do prazo (Mais de 24h de antecedência)
 */
export function buildRescheduleWithin24hMessage(data: { clientName: string }): string {
  return (
    `Entendido, ${data.clientName}! Como você está nos avisando com mais de 24h de antecedência, vamos alterar seu horário sem nenhum custo adicional.\n\n` +
    `Qual o melhor dia e período para você na nossa grade deste mês? 🗓️`
  );
}

/**
 * Mensagem 4.2: Remarcação fora do prazo (Menos de 24h de antecedência)
 */
export function buildRescheduleOutside24hMessage(data: {
  clientName: string;
  depositAmount?: string | number;
  newDateFormatted?: string;
  depositDeadlineFormatted?: string;
}): string {
  return getLateRescheduleDepositMessage({
    customerName: data.clientName,
    newDateFormatted: data.newDateFormatted || 'nova data escolhida',
    depositAmount: data.depositAmount ?? 20.00,
    depositDeadlineFormatted: data.depositDeadlineFormatted || '2 horas',
  });
}

// ==========================================
// MÉTODOS DE DISPARO DE MENSAGENS
// ==========================================

/**
 * Notifica a cliente via WhatsApp com as instruções e confirmação oficial do agendamento após o sinal ser aprovado.
 */
export async function notifyClientViaWhatsApp(appointment: Appointment): Promise<boolean> {
  const appointmentDt = DateTime.fromJSDate(appointment.appointmentDate, { zone: SALON_CONFIG.timezone }).setLocale('pt-BR');
  const formattedDate = appointmentDt.toFormat("dd/MM/yyyy (cccc)");
  const formattedTime = appointmentDt.toFormat("HH:mm");

  const message = buildNewClientDepositConfirmedMessage({
    formattedDate,
    formattedTime,
    address: SALON_CONFIG.address
  });

  return await whatsappService.sendMessage(appointment.whatsappPhone, message);
}

/**
 * Notifica a cliente antiga com a confirmação imediata isenta de sinal.
 */
export async function notifyExemptClientViaWhatsApp(appointment: Appointment): Promise<boolean> {
  const appointmentDt = DateTime.fromJSDate(appointment.appointmentDate, { zone: SALON_CONFIG.timezone }).setLocale('pt-BR');
  const formattedDate = appointmentDt.toFormat("dd/MM/yyyy (cccc)");
  const formattedTime = appointmentDt.toFormat("HH:mm");

  const message = buildExistingClientConfirmedMessage({
    clientName: appointment.clientName,
    service: appointment.service,
    formattedDate,
    formattedTime,
    totalAmount: Number(appointment.totalAmount).toFixed(2).replace('.', ',')
  });

  return await whatsappService.sendMessage(appointment.whatsappPhone, message);
}

/**
 * Notifica a cliente nova com as informações do Pix para pagamento do sinal de pré-agendamento.
 */
export async function sendPixPaymentInstructions(
  appointment: Appointment,
  pixKey: string = STUDIO_OFFICIAL_PIX_KEY,
  depositDeadlineFormatted: string
): Promise<boolean> {
  const appointmentDt = DateTime.fromJSDate(appointment.appointmentDate, { zone: SALON_CONFIG.timezone }).setLocale('pt-BR');
  const formattedDate = appointmentDt.toFormat("dd/MM/yyyy (cccc)");
  const formattedTime = appointmentDt.toFormat("HH:mm");

  const message = getDepositRequestMessage({
    customerName: appointment.clientName,
    serviceName: appointment.service,
    appointmentDateFormatted: `${formattedDate} às ${formattedTime}`,
    totalAmount: Number(appointment.totalAmount),
    depositAmount: Number(appointment.depositAmount),
    depositDeadlineFormatted,
  });

  return await whatsappService.sendMessage(appointment.whatsappPhone, message);
}

/**
 * Dispara o alerta de vencimento de pré-agendamento (sinal PIX próximo do vencimento).
 */
export async function sendDepositExpiringAlert(
  appointment: Appointment,
  depositDeadlineFormatted?: string
): Promise<boolean> {
  const deadlineDt = DateTime.fromJSDate(appointment.depositDeadline, { zone: SALON_CONFIG.timezone });
  const formattedDeadline = depositDeadlineFormatted || deadlineDt.toFormat('HH:mm (dd/MM)');

  const message = getDepositExpiringAlertMessage({
    customerName: appointment.clientName,
    depositDeadlineFormatted: formattedDeadline,
  });

  return await whatsappService.sendMessage(appointment.whatsappPhone, message);
}

/**
 * Dispara notificação de lembrete 24h (1 dia antes) para a cliente.
 */
export async function send24hReminderNotification(appointment: Appointment): Promise<boolean> {
  const appointmentDt = DateTime.fromJSDate(appointment.appointmentDate, { zone: SALON_CONFIG.timezone }).setLocale('pt-BR');
  const formattedDate = appointmentDt.toFormat("dd/MM/yyyy");
  const formattedTime = appointmentDt.toFormat("HH:mm");

  const message = build24hReminderMessage({
    clientName: appointment.clientName,
    formattedDate,
    formattedTime,
    service: appointment.service,
    address: SALON_CONFIG.address
  });

  return await whatsappService.sendMessage(appointment.whatsappPhone, message);
}

/**
 * Dispara notificação de lembrete semanal de segunda-feira para a cliente agendada na semana.
 */
export async function sendWeeklyClientReminderNotification(appointment: Appointment): Promise<boolean> {
  const appointmentDt = DateTime.fromJSDate(appointment.appointmentDate, { zone: SALON_CONFIG.timezone }).setLocale('pt-BR');
  const weekdayRaw = appointmentDt.toFormat('cccc');
  const weekdayName = weekdayRaw.charAt(0).toUpperCase() + weekdayRaw.slice(1);
  const formattedDate = appointmentDt.toFormat('dd/MM/yyyy');
  const formattedTime = appointmentDt.toFormat('HH:mm');

  const message = buildWeeklyClientReminderMessage({
    clientName: appointment.clientName,
    weekdayName,
    formattedDate,
    formattedTime,
    service: appointment.service,
    address: SALON_CONFIG.address,
  });

  return await whatsappService.sendMessage(appointment.whatsappPhone, message);
}

/**
 * Notificação Imediata (Push/Alerta) para a dona do studio (gestora) via WhatsApp.
 */
export async function notifyOwnerOnConfirmation(
  appointment: Appointment,
  confirmedBy: string = 'Alícia'
): Promise<boolean> {
  try {
    const ownerPhone = SALON_CONFIG.ownerPhone;
    if (!ownerPhone) {
      console.warn('⚠️ [NOTIFICAÇÃO DONA] Telefone da proprietária não configurado.');
      return false;
    }

    const appointmentDt = DateTime.fromJSDate(appointment.appointmentDate, { zone: SALON_CONFIG.timezone }).setLocale('pt-BR');
    const formattedDateTime = `${appointmentDt.toFormat('dd/MM/yyyy')} às ${appointmentDt.toFormat('HH:mm')}`;
    const depositAmountFormatted = Number(appointment.depositAmount).toFixed(2).replace('.', ',');
    const totalAmountFormatted = Number(appointment.totalAmount).toFixed(2).replace('.', ',');
    const statusLabel = appointment.depositStatus === 'EXEMPT' ? 'ISENTA DE SINAL (CLIENTE ANTIGA)' : `R$ ${depositAmountFormatted}`;

    const message =
      `🔔 *Novo Agendamento Confirmado!*\n\n` +
      `👤 *Cliente:* ${appointment.clientName}\n` +
      `📱 *Contato:* ${appointment.whatsappPhone}\n` +
      `💅 *Serviço:* ${appointment.service}\n` +
      `🗓️ *Data e Horário:* ${formattedDateTime}\n` +
      `💰 *Status Sinal:* ${statusLabel} (Total: R$ ${totalAmountFormatted})\n` +
      `📝 *Confirmado por:* ${confirmedBy || 'Alícia'}`;

    console.log(`📲 [NOTIFICAÇÃO DONA] Disparando notificação de confirmação para ${ownerPhone}...`);
    const sent = await whatsappService.sendMessage(ownerPhone, message);
    if (sent) {
      console.log(`✅ [NOTIFICAÇÃO DONA] Notificação entregue com sucesso à proprietária (${ownerPhone}).`);
    } else {
      console.warn(`⚠️ [NOTIFICAÇÃO DONA] Falha no envio da notificação para a proprietária.`);
    }
    return sent;
  } catch (error) {
    console.error('❌ [NOTIFICAÇÃO DONA] Erro ao enviar notificação para a proprietária:', error);
    return false;
  }
}

/**
 * Gera o template formatado da mensagem do resumo semanal para o WhatsApp da dona do studio.
 */
export function buildWeeklyReportMessage(data: WeeklyOwnerReportData): string {
  const depositRevStr = data.pastWeek.depositRevenue.toFixed(2).replace('.', ',');
  const totalRevStr = data.pastWeek.totalRevenue.toFixed(2).replace('.', ',');

  return (
    `📊 *RESUMO SEMANAL DO STUDIO* 📊\n\n` +
    `🗓️ *Semana Encerrada (${data.pastWeek.startDateStr} a ${data.pastWeek.endDateStr}):*\n` +
    `- Atendimentos Confirmados: ${data.pastWeek.confirmedCount}\n` +
    `- Receita de Sinais: R$ ${depositRevStr} (Total Estimado: R$ ${totalRevStr})\n` +
    `- Agendamentos Cancelados/Expirados: ${data.pastWeek.cancelledCount}\n\n` +
    `🔮 *Panorama da Próxima Semana (${data.nextWeek.startDateStr} a ${data.nextWeek.endDateStr}):*\n` +
    `- Total Pré-agendado: ${data.nextWeek.totalScheduled}\n` +
    `- Sinais já Garantidos: ${data.nextWeek.confirmedCount}\n` +
    `- Sinais Pendentes de Confirmação: ${data.nextWeek.pendingCount}\n` +
    `- Dias com maior movimento: ${data.nextWeek.busiestDaysText}\n\n` +
    `💡 _Dica da Alícia: "Atenção aos sinais pendentes para liberar os horários caso não paguem no prazo!"_`
  );
}

/**
 * Dispara o envio do relatório semanal para a proprietária.
 */
export async function notifyOwnerWeeklyReport(data: WeeklyOwnerReportData): Promise<boolean> {
  try {
    const ownerPhone = SALON_CONFIG.ownerPhone;
    if (!ownerPhone) {
      console.warn('⚠️ [RELATÓRIO SEMANAL] Telefone da proprietária não configurado.');
      return false;
    }

    const message = buildWeeklyReportMessage(data);

    console.log(`📊 [RELATÓRIO SEMANAL] Enviando resumo semanal para a proprietária (${ownerPhone})...`);
    const sent = await whatsappService.sendMessage(ownerPhone, message);
    if (sent) {
      console.log(`✅ [RELATÓRIO SEMANAL] Resumo semanal entregue com sucesso à proprietária!`);
    } else {
      console.warn(`⚠️ [RELATÓRIO SEMANAL] Falha no envio do resumo semanal para a proprietária.`);
    }
    return sent;
  } catch (error) {
    console.error('❌ [RELATÓRIO SEMANAL] Erro inesperado ao enviar resumo semanal para a proprietária:', error);
    return false;
  }
}
