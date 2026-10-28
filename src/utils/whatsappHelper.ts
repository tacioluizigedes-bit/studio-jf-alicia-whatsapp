/**
 * whatsappHelper.ts
 * Utilitário de humanização com delay inteligente (mínimo de 5s) e simulação de presença visual ("digitando...").
 */

export interface WhatsAppClientLike {
  sendSeen?: (to: string) => Promise<any> | any;
  markRead?: (to: string) => Promise<any> | any;
  sendPresenceUpdate?: (arg1: string, arg2?: string) => Promise<any> | any;
  sendMessage: (to: string, text: string) => Promise<any> | any;
}

export interface HumanizedMessageOptions {
  whatsappService?: WhatsAppClientLike;
  whatsappClient?: WhatsAppClientLike;
  to: string;
  text: string;
  splitBubbles?: boolean;
  delayMs?: number;
}

/**
 * Função Utilitária Assíncrona Não Bloqueante (Promise Delay)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calcula o atraso dinâmico de digitação humana:
 * - Piso mínimo: 5.000 ms (5 segundos)
 * - Proporcionalidade: ~35 ms por caractere
 * - Jitter humano aleatório: entre 1.000 ms e 2.000 ms
 */
export function calculateHumanizedDelay(textLength: number, baseFloorMs: number = 5000): number {
  const charFactorMs = Math.floor(textLength * 35);
  const randomJitterMs = Math.floor(Math.random() * 1500) + 500;
  const calculated = baseFloorMs + charFactorMs + randomJitterMs;
  return Math.min(Math.max(baseFloorMs, calculated), 15000);
}

/**
 * Envia uma mensagem com simulação de digitação e delay humanizado.
 * Suporta assinatura direta: sendHumanizedMessage(whatsappClient, to, text, delayMs)
 * E suporte a objeto de opções: sendHumanizedMessage({ whatsappService, to, text, splitBubbles })
 */
export async function sendHumanizedMessage(
  arg1: WhatsAppClientLike | HumanizedMessageOptions,
  arg2?: string,
  arg3?: string,
  arg4: number = 5000
): Promise<boolean> {
  let whatsappClient: WhatsAppClientLike;
  let to: string;
  let text: string;
  let delayMs: number = 5000;
  let splitBubbles: boolean = false;

  if (typeof arg2 === 'string') {
    // Chamada posicional: (whatsappClient, to, text, delayMs)
    whatsappClient = arg1 as WhatsAppClientLike;
    to = arg2;
    text = arg3 || '';
    delayMs = typeof arg4 === 'number' ? arg4 : 5000;
  } else {
    // Chamada por opções: ({ whatsappService, to, text, splitBubbles, delayMs })
    const opts = arg1 as HumanizedMessageOptions;
    whatsappClient = (opts.whatsappService || opts.whatsappClient)!;
    to = opts.to;
    text = opts.text;
    splitBubbles = !!opts.splitBubbles;
    delayMs = opts.delayMs || 5000;
  }

  const cleanPhone = (to || '').replace(/\D/g, '');

  try {
    // 1. Simula leitura da mensagem (markRead / sendSeen)
    if (whatsappClient.sendSeen) {
      await whatsappClient.sendSeen(cleanPhone);
    } else if (whatsappClient.markRead) {
      await whatsappClient.markRead(cleanPhone);
    }

    // 2. Dispara status de presença "digitando..." (composing)
    if (whatsappClient.sendPresenceUpdate) {
      await whatsappClient.sendPresenceUpdate('composing', cleanPhone);
    }

    // 3. Aguarda intervalo mínimo de 5 segundos + jitter humano
    const naturalDelay = Math.max(5000, delayMs) + Math.floor(Math.random() * 1500);
    console.log(`⌨️ [WHATSAPP HELPER] Humanized typing ativo para ${cleanPhone} por ${(naturalDelay / 1000).toFixed(1)}s`);
    await sleep(naturalDelay);

    // 4. Envia mensagem final
    let success = false;
    if (splitBubbles && text.includes('\n\n')) {
      const parts = text.split(/\n\n+/).filter((p) => p.trim() !== '');
      for (let i = 0; i < parts.length; i++) {
        const bubble = parts[i].trim();
        if (i > 0) {
          if (whatsappClient.sendPresenceUpdate) {
            await whatsappClient.sendPresenceUpdate('composing', cleanPhone);
          }
          await sleep(Math.floor(Math.random() * 2000) + 3000); // 3-5s para balões seguintes
        }
        await whatsappClient.sendMessage(cleanPhone, bubble);
      }
      success = true;
    } else {
      const sendRes = await whatsappClient.sendMessage(cleanPhone, text);
      success = sendRes !== false;
    }

    // 5. Pausa estado de presença
    if (whatsappClient.sendPresenceUpdate) {
      await whatsappClient.sendPresenceUpdate('paused', cleanPhone);
    }

    return success;
  } catch (error) {
    console.error('[WhatsApp Helper] Falha no envio de mensagem humanizada:', error);
    try {
      await whatsappClient.sendMessage(cleanPhone, text);
      return true;
    } catch {
      return false;
    }
  }
}

// Exportações CommonJS e ESModule compatíveis
export default { sendHumanizedMessage, calculateHumanizedDelay, sleep };
