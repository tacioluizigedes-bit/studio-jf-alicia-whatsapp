import { WhatsAppService } from './whatsappService';

export interface HumanizedMessageOptions {
  whatsappService: WhatsAppService;
  to: string;
  text: string;
  splitBubbles?: boolean;
}

/**
 * Calcula o atraso dinâmico de digitação humana:
 * - Piso mínimo: 5.000 ms (5 segundos)
 * - Proporcionalidade: ~35 ms por caractere
 * - Jitter humano aleatório: entre 1.000 ms e 2.500 ms
 * - Teto máximo recomendado: 12.000 ms (12 segundos)
 */
export function calculateHumanizedDelay(textLength: number): number {
  const baseFloorMs = 5000; // 5 segundos de piso mínimo
  const charFactorMs = Math.floor(textLength * 35); // 35 ms por caractere
  const randomJitterMs = Math.floor(Math.random() * 1500) + 1000; // 1s a 2.5s de variação

  const calculated = baseFloorMs + charFactorMs + randomJitterMs;
  return Math.min(Math.max(baseFloorMs, calculated), 12000);
}

/**
 * Função Utilitária Assíncrona Não Bloqueante (Promise Delay)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper Principal de Humanização e Presença no WhatsApp:
 * 1. Confirmação de leitura (markRead / sendSeen) após 1.2s de recebimento.
 * 2. Ativação do status visual "digitando..." (composing).
 * 3. Aguarda atraso inteligente proporcional (mínimo de 5s).
 * 4. Pausa presença e entrega a mensagem no WhatsApp.
 */
export async function sendHumanizedMessage(options: HumanizedMessageOptions): Promise<boolean> {
  const { whatsappService, to, text, splitBubbles = false } = options;
  const formattedPhone = to.replace(/\D/g, '');

  try {
    // Passo 1: Simula abertura da conversa e confirmação de leitura (1.2s após mensagem)
    await sleep(1200);
    await whatsappService.markRead(formattedPhone);

    // Se a mensagem for dividida em múltiplos balões de texto (separados por 2 ou mais quebras de linha)
    if (splitBubbles && text.includes('\n\n')) {
      const bubbles = text.split(/\n\n+/).filter((b) => b.trim() !== '');
      if (bubbles.length > 1) {
        let allSuccess = true;
        for (let i = 0; i < bubbles.length; i++) {
          const bubble = bubbles[i].trim();
          const delayMs = i === 0 ? calculateHumanizedDelay(bubble.length) : Math.floor(Math.random() * 2000) + 3000; // 3s a 5s no 2º balão

          console.log(`⌨️ [HUMANIZED TYPING] Balão ${i + 1}/${bubbles.length}: "digitando..." ativo para ${formattedPhone} por ${Math.round(delayMs / 1000)}s`);
          await whatsappService.sendPresenceUpdate(formattedPhone, 'composing');
          await sleep(delayMs);
          await whatsappService.sendPresenceUpdate(formattedPhone, 'paused');

          const sent = await whatsappService.sendMessage(formattedPhone, bubble);
          if (!sent) allSuccess = false;
        }
        return allSuccess;
      }
    }

    // Fluxo Padrão de Balão Único
    const delayMs = calculateHumanizedDelay(text.length);
    console.log(`⌨️ [HUMANIZED TYPING] Status "digitando..." ativo para ${formattedPhone} por ${Math.round(delayMs / 1000)}s (${delayMs} ms)`);

    await whatsappService.sendPresenceUpdate(formattedPhone, 'composing');
    await sleep(delayMs);
    await whatsappService.sendPresenceUpdate(formattedPhone, 'paused');

    return await whatsappService.sendMessage(formattedPhone, text);
  } catch (error) {
    console.error(`❌ [HUMANIZED TYPING] Erro ao enviar mensagem humanizada para ${formattedPhone}:`, error);
    // Fallback de emergência: tenta enviar a mensagem sem presenças
    return await whatsappService.sendMessage(formattedPhone, text);
  }
}
