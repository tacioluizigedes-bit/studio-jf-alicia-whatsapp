import { SALON_CONFIG } from '../config/salonConfig';
import {
  baileysClientAdapter,
  getWhatsAppConnectionState,
} from './whatsappConnection';

export class WhatsAppService {
  private apiUrl: string;
  private apiToken: string;
  private instanceId: string;

  constructor() {
    this.apiUrl = process.env.WHATSAPP_API_URL || '';
    this.apiToken = process.env.WHATSAPP_API_TOKEN || '';
    this.instanceId = process.env.WHATSAPP_INSTANCE_ID || '';
  }

  /**
   * Marca a mensagem como lida no WhatsApp da cliente (sendSeen / markRead)
   */
  async markRead(to: string): Promise<boolean> {
    const formattedPhone = to.replace(/\D/g, '');

    if (getWhatsAppConnectionState().isConnected) {
      return await baileysClientAdapter.markRead!(formattedPhone);
    }

    console.log(`👀 [WHATSAPP PRESENCE] Marcou mensagem como LIDA para: ${formattedPhone}`);

    if (!this.apiUrl || !this.apiToken) {
      return true;
    }

    try {
      const endpoint = `${this.apiUrl}/chat/markRead/${this.instanceId}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.apiToken
        },
        body: JSON.stringify({
          number: formattedPhone,
          read: true
        })
      });
      return response.ok;
    } catch (error) {
      console.warn('Erro ao atualizar marcação de leitura:', error);
      return false;
    }
  }

  /**
   * Alias para markRead compatível com diferentes providers
   */
  async sendSeen(to: string): Promise<boolean> {
    return await this.markRead(to);
  }

  /**
   * Atualiza o estado de presença visual no WhatsApp da cliente ('composing' | 'paused' | 'recording')
   * Aceita tanto (to, presence) quanto (presence, to)
   */
  async sendPresenceUpdate(arg1: string, arg2?: string): Promise<boolean> {
    if (getWhatsAppConnectionState().isConnected) {
      return await baileysClientAdapter.sendPresenceUpdate!(arg1, arg2);
    }

    let to: string;
    let presence: 'composing' | 'paused' | 'recording';

    if (['composing', 'paused', 'recording'].includes(arg1)) {
      presence = arg1 as any;
      to = arg2 || '';
    } else {
      to = arg1;
      presence = (arg2 as any) || 'composing';
    }

    const formattedPhone = to.replace(/\D/g, '');
    console.log(`📡 [WHATSAPP PRESENCE] Status visual '${presence}' para: ${formattedPhone}`);

    if (!this.apiUrl || !this.apiToken) {
      return true;
    }

    try {
      const endpoint = `${this.apiUrl}/chat/sendPresence/${this.instanceId}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.apiToken
        },
        body: JSON.stringify({
          number: formattedPhone,
          presence: presence
        })
      });
      return response.ok;
    } catch (error) {
      console.warn('Erro ao atualizar presença visual no WhatsApp:', error);
      return false;
    }
  }

  /**
   * Envia uma mensagem de texto via Baileys (se conectado) ou via API do WhatsApp.
   */
  async sendMessage(to: string, text: string): Promise<boolean> {
    const formattedPhone = to.replace(/\D/g, '');

    if (getWhatsAppConnectionState().isConnected) {
      return await baileysClientAdapter.sendMessage(formattedPhone, text);
    }

    console.log(`💬 [WHATSAPP OUTBOUND] Para: ${formattedPhone}`);
    console.log(`   Mensagem:\n${text}\n----------------------------------`);

    if (!this.apiUrl || !this.apiToken) {
      return true;
    }

    try {
      const endpoint = `${this.apiUrl}/message/sendText/${this.instanceId}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.apiToken
        },
        body: JSON.stringify({
          number: formattedPhone,
          text: text
        })
      });

      if (!response.ok) {
        console.error(`Erro ao enviar mensagem WhatsApp (${response.status}):`, await response.text());
        return false;
      }

      return true;
    } catch (error) {
      console.error('Erro na requisição para o provedor de WhatsApp:', error);
      return false;
    }
  }

  /**
   * Notifica a proprietária do salão sobre um transbordo humano necessário.
   */
  async notifyOwnerOfHandover(clientPhone: string, reason: string, clientLastMessage: string): Promise<void> {
    const ownerPhone = SALON_CONFIG.ownerPhone;
    const notificationText = 
      `🚨 *ALERTA DE TRANSBORDO HUMANO - NOVO ATENDIMENTO*\n\n` +
      `📱 *Cliente:* whatsapp.me/${clientPhone.replace(/\D/g, '')}\n` +
      `⚠️ *Motivo:* ${reason}\n` +
      `💬 *Última Mensagem da Cliente:* "${clientLastMessage}"\n\n` +
      `👉 Por favor, assuma a conversa diretamente no seu WhatsApp!`;

    await this.sendMessage(ownerPhone, notificationText);
  }
}
