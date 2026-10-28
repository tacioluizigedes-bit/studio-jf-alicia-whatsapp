/**
 * src/services/whatsappConnection.ts
 * Serviço de inicialização, autenticação via QR Code e escuta de eventos do WhatsApp (Baileys)
 * para o canal comercial oficial do Studio JF Designer (5521960003154).
 */

import path from 'path';
import fs from 'fs';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import type {
  WASocket,
  WAMessage,
  WAMessageKey,
} from '@whiskeysockets/baileys';

// Carregador dinâmico ESM nativo para compatibilidade total com CommonJS / tsx / Node v20-v24
const loadBaileys = new Function(
  'return import("@whiskeysockets/baileys")'
) as () => Promise<typeof import('@whiskeysockets/baileys')>;

import { handleOwnerCommands } from './ownerControlService';
import { handleClientFlow } from './clientFlowService';
import { resolveSenderRole, normalizePhoneDigits } from '../config/phoneRoutingService';
import { SALON_CONFIG } from '../config/salonConfig';
import { WhatsAppClientLike } from '../utils/whatsappHelper';

dotenv.config();

export const STUDIO_OFFICIAL_NUMBER = process.env.STUDIO_OFFICIAL_NUMBER || '5521960003154';
export const OWNER_PERSONAL_NUMBER = process.env.OWNER_PERSONAL_NUMBER || '5521993826303';
export const STUDIO_PIX_KEY = process.env.STUDIO_PIX_KEY || '21960003154';
export const AUTH_FOLDER = process.env.BAILEYS_AUTH_DIR
  ? path.resolve(process.env.BAILEYS_AUTH_DIR)
  : path.resolve(process.cwd(), 'auth_info_baileys');

let activeSocket: WASocket | null = null;
let connectionStatus: 'disconnected' | 'connecting' | 'qr_ready' | 'connected' = 'disconnected';
let latestQrCode: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

// Mapa auxiliar para preservar o JID original e última chave de mensagem de cada cliente
const jidCache = new Map<string, string>();
const lastMessageKeyCache = new Map<string, WAMessageKey>();

/**
 * Normaliza o identificador de origem do WhatsApp (JID) para apenas dígitos com DDI 55 quando aplicável.
 */
export function normalizeWhatsAppSender(rawJid?: string | null, altJid?: string | null): string {
  const candidate =
    rawJid && !rawJid.endsWith('@lid')
      ? rawJid
      : altJid || rawJid || '';

  const withoutDomain = candidate
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '');

  if (!withoutDomain) return '';

  // Se vier apenas DDD + número (10 ou 11 dígitos no Brasil), prefixa DDI 55
  if ((withoutDomain.length === 10 || withoutDomain.length === 11) && !withoutDomain.startsWith('55')) {
    return `55${withoutDomain}`;
  }

  return withoutDomain;
}

/**
 * Formata um número de telefone limpo para o padrão JID do WhatsApp (@s.whatsapp.net)
 */
export function formatPhoneToJid(phoneOrJid: string): string {
  if (!phoneOrJid) return '';
  if (phoneOrJid.includes('@s.whatsapp.net') || phoneOrJid.includes('@lid')) {
    return phoneOrJid;
  }

  const clean = normalizePhoneDigits(phoneOrJid);
  if (!clean) return '';

  // Se já conhecemos o JID exato dessa conversa no cache, priorizamos ele
  const cachedJid = jidCache.get(clean);
  if (cachedJid) {
    return cachedJid;
  }

  const withDdi =
    (clean.length === 10 || clean.length === 11) && !clean.startsWith('55')
      ? `55${clean}`
      : clean;

  return `${withDdi}@s.whatsapp.net`;
}

/**
 * Extrai o texto de uma mensagem do Baileys (suporta texto simples, texto estendido, legenda de imagem/documento e respostas de botão/lista)
 */
export function extractMessageText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '';

  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.documentMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    '';

  // Caso a cliente envie a foto ou PDF do comprovante PIX sem legenda
  if (!text && (m.imageMessage || m.documentMessage)) {
    return '[Comprovante/Mídia enviada pela cliente]';
  }

  return text.trim();
}

/**
 * Envia mensagem de texto de forma assíncrona e blindada (try/catch)
 * para garantir que eventuais oscilações do WhatsApp nunca derrubem o servidor Express.
 */
export async function sendMessage(to: string, text: string): Promise<boolean> {
  const cleanPhone = normalizePhoneDigits(to);
  console.log(`💬 [WHATSAPP OUTBOUND -> ${cleanPhone}]`);
  console.log(`   Mensagem:\n${text}\n----------------------------------`);

  if (!activeSocket || connectionStatus !== 'connected') {
    console.warn(
      `⚠️ [Baileys] Socket ainda não autenticado (status: ${connectionStatus}). Mensagem para ${cleanPhone} registrada apenas em log.`
    );
    return false;
  }

  try {
    const jid = formatPhoneToJid(to);
    if (!jid) return false;

    await activeSocket.sendMessage(jid, { text });
    return true;
  } catch (error) {
    console.error(`❌ [Baileys] Falha segura ao enviar mensagem para ${cleanPhone}:`, error);
    return false;
  }
}

/**
 * Atualiza presença visual ('composing' | 'paused' | 'recording') de forma segura
 */
export async function sendPresenceUpdate(
  arg1: string,
  arg2?: string
): Promise<boolean> {
  let to: string;
  let presence: 'composing' | 'paused' | 'recording';

  if (['composing', 'paused', 'recording'].includes(arg1)) {
    presence = arg1 as 'composing' | 'paused' | 'recording';
    to = arg2 || '';
  } else {
    to = arg1;
    presence = (arg2 as 'composing' | 'paused' | 'recording') || 'composing';
  }

  const cleanPhone = normalizePhoneDigits(to);
  console.log(`📡 [WHATSAPP PRESENCE] Status visual '${presence}' para: ${cleanPhone}`);

  if (!activeSocket || connectionStatus !== 'connected') {
    return false;
  }

  try {
    const jid = formatPhoneToJid(to);
    if (!jid) return false;

    await activeSocket.sendPresenceUpdate(presence, jid);
    return true;
  } catch (error) {
    console.warn(`⚠️ [Baileys] Falha segura ao atualizar presença (${presence}) para ${cleanPhone}:`, error);
    return false;
  }
}

/**
 * Marca a última mensagem da conversa como lida (readMessages) de forma segura
 */
export async function markRead(to: string): Promise<boolean> {
  const cleanPhone = normalizePhoneDigits(to);
  console.log(`👀 [WHATSAPP PRESENCE] Marcou mensagem como LIDA para: ${cleanPhone}`);

  if (!activeSocket || connectionStatus !== 'connected') {
    return false;
  }

  try {
    const lastKey = lastMessageKeyCache.get(cleanPhone);
    if (lastKey) {
      await activeSocket.readMessages([lastKey]);
    }
    return true;
  } catch (error) {
    console.warn(`⚠️ [Baileys] Falha segura ao marcar leitura para ${cleanPhone}:`, error);
    return false;
  }
}

/**
 * Adaptador compatível com WhatsAppClientLike (usado por clientFlowService, ownerControlService e jobs)
 */
export const baileysClientAdapter: WhatsAppClientLike & {
  notifyOwnerOfHandover: (clientPhone: string, reason: string, clientLastMessage: string) => Promise<void>;
} = {
  sendMessage,
  sendPresenceUpdate,
  markRead,
  sendSeen: markRead,
  async notifyOwnerOfHandover(clientPhone: string, reason: string, clientLastMessage: string): Promise<void> {
    const ownerPhone = OWNER_PERSONAL_NUMBER || SALON_CONFIG.ownerPhone;
    const notificationText =
      `🚨 *ALERTA DE TRANSBORDO HUMANO - NOVO ATENDIMENTO*\n\n` +
      `📱 *Cliente:* https://wa.me/${normalizePhoneDigits(clientPhone)}\n` +
      `⚠️ *Motivo:* ${reason}\n` +
      `💬 *Última Mensagem da Cliente:* "${clientLastMessage}"\n\n` +
      `👉 Por favor, assuma a conversa diretamente no seu WhatsApp!`;

    await sendMessage(ownerPhone, notificationText);
  },
};

/**
 * Retorna o estado atual da conexão com o WhatsApp
 */
export function getWhatsAppConnectionState() {
  return {
    status: connectionStatus,
    officialNumber: STUDIO_OFFICIAL_NUMBER,
    ownerPersonalNumber: OWNER_PERSONAL_NUMBER,
    pixKey: STUDIO_PIX_KEY,
    isConnected: connectionStatus === 'connected',
    hasQrCode: !!latestQrCode,
    qrCode: latestQrCode,
  };
}

/**
 * Inicializa a conexão oficial do WhatsApp via Baileys, gerando o QR Code no terminal
 * e escutando eventos de conexão e mensagens para o número 5521960003154.
 */
export async function initWhatsAppConnection(): Promise<WASocket | null> {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    connectionStatus = 'connecting';
    const baileys = await loadBaileys();
    const makeWASocket = baileys.makeWASocket || (baileys as any).default;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    let version: [number, number, number] = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) {
        version = latest.version;
      }
    } catch {
      // Mantém versão fallback estável caso não consiga consultar a versão remota
    }

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // Renderizamos manualmente com qrcode-terminal para layout limpo
      logger: pino({ level: 'silent' }) as any,
      browser: ['Studio JF Designer - Alicia AI', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 25000, // Mantém o WebSocket ativo em servidores Cloud (Railway/Render/VPS)
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    activeSocket = sock;

    // Persistência automática de credenciais na pasta auth_info_baileys
    sock.ev.on('creds.update', saveCreds);

    // Monitoramento do estado da conexão e geração de QR Code
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQrCode = qr;
        connectionStatus = 'qr_ready';
        console.log('\n============================================================');
        console.log(`📲 PAREAMENTO WHATSAPP - STUDIO JF DESIGNER (Alícia)`);
        console.log(`📌 Escaneie o QR Code abaixo com o WhatsApp do Studio: ${STUDIO_OFFICIAL_NUMBER} (21 96000-3154)`);
        console.log('============================================================\n');
        qrcode.generate(qr, { small: true });
        console.log('\n============================================================\n');
      }

      if (connection === 'open') {
        latestQrCode = null;
        connectionStatus = 'connected';
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        console.log(`\n✅ [WhatsApp Conectado: ${STUDIO_OFFICIAL_NUMBER}]`);
        console.log(`👑 Linha Executiva da Proprietária (Janaína): ${OWNER_PERSONAL_NUMBER}`);
        console.log(`💠 Chave PIX Oficial Ativa: ${STUDIO_PIX_KEY}\n`);
      }

      if (connection === 'close') {
        connectionStatus = 'disconnected';
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        console.warn(
          `⚠️ [Baileys] Conexão WhatsApp encerrada (código: ${statusCode ?? 'desconhecido'}).`
        );

        if (!isLoggedOut) {
          console.log('🔄 [Baileys] Tentando reconexão automática do WhatsApp em 4 segundos...');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            initWhatsAppConnection().catch((err) =>
              console.error('❌ [Baileys] Erro ao tentar reconectar:', err)
            );
          }, 4000);
        } else {
          console.warn(
            '🚪 [Baileys] Sessão desconectada pelo aparelho (Logged Out). Limpando credenciais antigas para gerar novo QR Code...'
          );
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          } catch (cleanErr) {
            console.error('Erro ao limpar pasta auth_info_baileys:', cleanErr);
          }
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            initWhatsAppConnection().catch((err) =>
              console.error('❌ [Baileys] Erro ao reiniciar pareamento:', err)
            );
          }, 3000);
        }
      }
    });

    // Escuta e roteamento de mensagens recebidas em tempo real
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          if (!msg.message || !msg.key) continue;

          // 1. Ignora mensagens enviadas pelo próprio bot (fromMe: true)
          if (msg.key.fromMe) continue;

          const remoteJid = msg.key.remoteJid || '';

          // 2. Ignora mensagens de grupos (@g.us) e transmissões de status (status@broadcast)
          if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
            continue;
          }

          // 3. Normaliza o número de origem (suportando também remoteJidAlt em contas com LID)
          const remoteJidAlt = (msg.key as any).remoteJidAlt || msg.key.participant || '';
          const fromNumber = normalizeWhatsAppSender(remoteJid, remoteJidAlt);
          if (!fromNumber) continue;

          // Armazena JID e key no cache para leitura (markRead) e resposta direta
          jidCache.set(fromNumber, remoteJid);
          lastMessageKeyCache.set(fromNumber, msg.key);

          // 4. Extrai o conteúdo textual da mensagem
          const messageBody = extractMessageText(msg);
          if (!messageBody) continue;

          // 5. Roteamento Inteligente:
          // Rota A (Janaína / Admin): Remetente é 5521993826303 (OWNER_PERSONAL_NUMBER)
          const senderRole = resolveSenderRole(fromNumber);
          const isOwner =
            senderRole === 'OWNER' ||
            fromNumber === normalizePhoneDigits(OWNER_PERSONAL_NUMBER) ||
            fromNumber.endsWith('21993826303');

          if (isOwner) {
            console.log(`👑 [Rota A - Janaína/Admin] Comando recebido de ${fromNumber}: "${messageBody}"`);
            await handleOwnerCommands(baileysClientAdapter, fromNumber, messageBody);
          } else {
            // Rota B (Clientes do Studio): Qualquer outro número vai para o fluxo da Alícia
            // com delay humanizado >= 5s, presença 'composing', regras de 1ª vez vs cliente antiga e PIX 21960003154
            console.log(`✨ [Rota B - Cliente Studio] Mensagem recebida de ${fromNumber}: "${messageBody}"`);
            await handleClientFlow(baileysClientAdapter, fromNumber, messageBody);
          }
        } catch (msgError) {
          console.error('❌ [Baileys] Erro seguro ao processar mensagem recebida:', msgError);
        }
      }
    });

    return sock;
  } catch (error) {
    console.error('❌ [Baileys] Erro ao inicializar conexão com o WhatsApp:', error);
    connectionStatus = 'disconnected';
    return null;
  }
}

export default {
  initWhatsAppConnection,
  sendMessage,
  sendPresenceUpdate,
  markRead,
  getWhatsAppConnectionState,
  baileysClientAdapter,
  STUDIO_OFFICIAL_NUMBER,
  OWNER_PERSONAL_NUMBER,
  STUDIO_PIX_KEY,
};
