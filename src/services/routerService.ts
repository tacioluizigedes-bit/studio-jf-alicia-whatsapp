/**
 * routerService.ts
 * Roteador de mensagens do WhatsApp:
 * - Linha Oficial (5521993826303): Dedicada exclusivamente ao atendimento ao cliente pela Alícia.
 * - Linha Pessoal (Janaína): Painel de comando executivo da dona (definida via OWNER_PERSONAL_NUMBER).
 */

import { handleClientFlow } from './clientFlowService';
import { handleOwnerCommands } from './ownerControlService';
import { SALON_CONFIG } from '../config/salonConfig';
import { CONFIG, resolveSenderRole } from '../config/phoneRoutingService';
import { WhatsAppClientLike } from '../utils/whatsappHelper';

export const STUDIO_OFFICIAL_NUMBER = CONFIG.OFFICIAL_STUDIO_PHONE;
export const OWNER_PERSONAL_NUMBER = CONFIG.OWNER_PERSONAL_PHONE;

/**
 * Normaliza números para comparação segura (apenas dígitos)
 */
export function sanitizePhone(phone?: string | null): string {
  if (!phone) return '';
  return phone.toString().replace(/\D/g, '');
}

/**
 * Verifica se um determinado número corresponde à linha pessoal da proprietária (Janaína - 21993826303)
 */
export function isOwnerPersonalPhone(phone: string): boolean {
  return resolveSenderRole(phone) === 'OWNER';
}

export interface WhatsAppWebhookPayload {
  from?: string;
  body?: string;
  phone?: string;
  text?: string;
  sender?: string;
  senderRole?: 'owner' | 'client';
  data?: {
    key?: {
      remoteJid?: string;
      fromMe?: boolean;
    };
    message?: {
      conversation?: string;
      extendedTextMessage?: {
        text?: string;
      };
    };
  };
  message?: {
    text?: string;
    conversation?: string;
  };
}

/**
 * Ponto de entrada do Webhook de Mensagens
 */
export async function processIncomingWhatsAppMessage(
  whatsappClient: WhatsAppClientLike,
  payload: WhatsAppWebhookPayload
): Promise<any> {
  // Extrai o número de origem de múltiplos formatos de payload
  const rawFrom =
    payload.from ||
    payload.phone ||
    payload.data?.key?.remoteJid ||
    '';

  const fromNumber = sanitizePhone(rawFrom.replace('@s.whatsapp.net', '').replace('@c.us', ''));

  // Extrai o corpo da mensagem
  const rawBody =
    payload.body ||
    payload.text ||
    payload.message?.text ||
    payload.message?.conversation ||
    payload.data?.message?.conversation ||
    payload.data?.message?.extendedTextMessage?.text ||
    '';

  const messageBody = rawBody ? rawBody.trim() : '';

  if (!fromNumber || !messageBody) {
    console.log('⚠️ [ROUTER] Payload inválido ou sem texto/remetente:', payload);
    return { status: 'ignored', reason: 'empty_payload' };
  }

  // 1. Identificação: É a Janaína pelo número pessoal dela?
  const isOwner = isOwnerPersonalPhone(fromNumber) || payload.sender === 'owner' || payload.senderRole === 'owner';

  if (isOwner) {
    console.log(`[Segurança] Comando executivo recebido da Janaína (${fromNumber})`);
    return await handleOwnerCommands(whatsappClient, fromNumber, messageBody);
  }

  // 2. Se não for a dona, trata como atendimento de cliente no canal oficial
  console.log(`[Atendimento] Mensagem de cliente recebida no canal oficial (${fromNumber})`);
  return await handleClientFlow(whatsappClient, fromNumber, messageBody);
}

export default {
  processIncomingWhatsAppMessage,
  STUDIO_OFFICIAL_NUMBER,
  OWNER_PERSONAL_NUMBER,
  sanitizePhone,
  isOwnerPersonalPhone,
};
