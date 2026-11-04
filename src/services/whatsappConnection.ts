/**
 * src/services/whatsappConnection.ts
 * Serviço de inicialização, autenticação (QR Code + Código de 8 Dígitos sem câmera),
 * Cofre de Persistência na Nuvem 24/7 e escuta de eventos do WhatsApp (Baileys)
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
import {
  restoreSessionFromVault,
  backupSessionToVault,
  scheduleSessionVaultBackup,
  deleteVaultFile,
  getVaultStatus,
  hasLocalAuthenticatedSession,
} from './whatsappSessionVault';

dotenv.config();

export const STUDIO_OFFICIAL_NUMBER = process.env.STUDIO_OFFICIAL_NUMBER || '5521960003154';
export const OWNER_PERSONAL_NUMBER = process.env.OWNER_PERSONAL_NUMBER || '5521993826303';
export const STUDIO_PIX_KEY = process.env.STUDIO_PIX_KEY || '21960003154';
export const AUTH_FOLDER = process.env.BAILEYS_AUTH_DIR
  ? path.resolve(process.env.BAILEYS_AUTH_DIR)
  : path.resolve(process.cwd(), 'auth_info_baileys');

// Cache em memória dos contatos sincronizados via WhatsApp (Baileys)
export interface WhatsAppContactItem {
  id: string; // JID, ex: 5521999999999@s.whatsapp.net
  phone: string; // apenas dígitos (ex: 5521999999999)
  name?: string;
  notify?: string;
  verifiedName?: string;
}

const syncedWhatsAppContacts = new Map<string, WhatsAppContactItem>();

/**
 * Retorna lista de contatos do WhatsApp conectados e sincronizados
 */
export function getSyncedWhatsAppContacts(): WhatsAppContactItem[] {
  return Array.from(syncedWhatsAppContacts.values()).filter(c => c.phone && c.phone.length >= 8);
}

/**
 * Atualiza ou insere contatos no cache em memória
 */
export function registerWhatsAppContacts(contacts: Array<any>) {
  if (!Array.isArray(contacts)) return;
  for (const c of contacts) {
    if (!c || !c.id || typeof c.id !== 'string') continue;
    if (c.id.endsWith('@g.us') || c.id === 'status@broadcast') continue;

    const cleanDigits = c.id.split('@')[0].replace(/\D/g, '');
    if (!cleanDigits || cleanDigits.length < 8) continue;

    const existing: WhatsAppContactItem | undefined = syncedWhatsAppContacts.get(cleanDigits);
    const name = c.name || c.notify || c.verifiedName || (existing ? existing.name : undefined);

    syncedWhatsAppContacts.set(cleanDigits, {
      id: c.id,
      phone: cleanDigits,
      name: name || undefined,
      notify: c.notify || (existing ? existing.notify : undefined),
      verifiedName: c.verifiedName || (existing ? existing.verifiedName : undefined)
    });
  }
}

let activeSocket: WASocket | null = null;
let connectionStatus: 'disconnected' | 'connecting' | 'qr_ready' | 'connected' = 'disconnected';
let latestQrCode: string | null = null;
let latestPairingCode: string | null = null;
let latestPairingPhone: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let consecutiveLogouts = 0;
let isInitializing = false;

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
 * Retorna o estado atual da conexão com o WhatsApp e do Cofre na Nuvem
 */
export function getWhatsAppConnectionState() {
  const vault = getVaultStatus();
  return {
    status: connectionStatus,
    officialNumber: STUDIO_OFFICIAL_NUMBER,
    ownerPersonalNumber: OWNER_PERSONAL_NUMBER,
    pixKey: STUDIO_PIX_KEY,
    isConnected: connectionStatus === 'connected',
    hasQrCode: !!latestQrCode,
    qrCode: latestQrCode,
    pairingCode: latestPairingCode,
    pairingPhone: latestPairingPhone || STUDIO_OFFICIAL_NUMBER,
    hasSavedSession: hasLocalAuthenticatedSession(AUTH_FOLDER) || vault.hasStoredSession,
    vault,
  };
}

/**
 * Gera um Código de Pareamento de 8 Dígitos (Pairing Code) para conectar o WhatsApp
 * diretamente pelo celular SEM precisar escanear QR Code com a câmera.
 */
export async function requestWhatsAppPairingCode(customPhone?: string): Promise<{
  success: boolean;
  code?: string;
  formattedCode?: string;
  phone?: string;
  error?: string;
}> {
  try {
    if (connectionStatus === 'connected') {
      return {
        success: true,
        code: 'CONECTADO',
        formattedCode: 'JÁ CONECTADO',
        phone: STUDIO_OFFICIAL_NUMBER,
      };
    }

    const rawPhone = customPhone || STUDIO_OFFICIAL_NUMBER;
    let digits = normalizePhoneDigits(rawPhone);
    if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
      digits = `55${digits}`;
    }

    if (digits.length < 12) {
      return {
        success: false,
        error: 'Número de telefone inválido. Use DDI + DDD + Número (ex: 5521960003154).',
      };
    }

    // Se não houver socket ativo ou se a sessão local estiver corrompida, reinicia limpo para pareamento
    if (!activeSocket || hasLocalAuthenticatedSession(AUTH_FOLDER)) {
      try {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      } catch {}
      await initWhatsAppConnection(true);
      await new Promise((r) => setTimeout(r, 2200));
    }

    if (!activeSocket || typeof activeSocket.requestPairingCode !== 'function') {
      return {
        success: false,
        error: 'Socket do WhatsApp ainda está inicializando. Aguarde 3 segundos e tente novamente.',
      };
    }

    const code = await activeSocket.requestPairingCode(digits);
    const cleanCode = (code || '').trim().toUpperCase();
    const formattedCode =
      cleanCode.length === 8 ? `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}` : cleanCode;

    latestPairingCode = formattedCode;
    latestPairingPhone = digits;

    console.log('\n============================================================');
    console.log(`🔑 CÓDIGO DE PAREAMENTO WHATSAPP (SEM CÂMERA): ${formattedCode}`);
    console.log(`📱 Número alvo: +${digits}`);
    console.log('============================================================\n');

    return {
      success: true,
      code: cleanCode,
      formattedCode,
      phone: digits,
    };
  } catch (err: any) {
    console.error('❌ [Baileys] Erro ao solicitar Pairing Code:', err?.message || err);
    return {
      success: false,
      error: err?.message || 'Não foi possível gerar o código de pareamento agora. Tente novamente em alguns segundos.',
    };
  }
}

/**
 * Permite forçar reconexão ou limpar a sessão caso a proprietária troque de aparelho
 */
export async function forceReconnectWhatsApp(clearAllCredentials: boolean = false): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (activeSocket) {
      activeSocket.ev.removeAllListeners('connection.update');
      activeSocket.end(undefined);
      activeSocket = null;
    }
  } catch {}

  if (clearAllCredentials) {
    latestQrCode = null;
    latestPairingCode = null;
    try {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    } catch {}
    await deleteVaultFile('baileys-session.enc');
  }

  await initWhatsAppConnection(clearAllCredentials);
}

/**
 * Watchdog 24/7: Verifica a cada 90 segundos se a conexão caiu silenciosamente e a reativa
 */
function ensureWatchdogStarted() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (connectionStatus === 'disconnected' && !reconnectTimer && !isInitializing) {
      console.log('🛡️ [WATCHDOG 24/7] Conexão inativa detectada. Acionando auto-recuperação...');
      initWhatsAppConnection().catch((err) =>
        console.error('❌ [WATCHDOG 24/7] Falha ao recuperar conexão:', err)
      );
    }
  }, 90 * 1000);
}

/**
 * Inicializa a conexão oficial do WhatsApp via Baileys, restaurando automaticamente a sessão
 * do Cofre na Nuvem (sem pedir QR Code em redeploys) e escutando eventos para 5521960003154.
 */
export async function initWhatsAppConnection(skipVaultRestore: boolean = false): Promise<WASocket | null> {
  if (isInitializing) return activeSocket;
  isInitializing = true;

  try {
    ensureWatchdogStarted();

    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    // 1. Antes de iniciar o Baileys, restaura automaticamente a sessão salva na nuvem caso o disco local tenha sido zerado pelo Render
    if (!skipVaultRestore && !hasLocalAuthenticatedSession(AUTH_FOLDER)) {
      await restoreSessionFromVault(AUTH_FOLDER);
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

    // Importante: ['Ubuntu', 'Chrome', '20.0.04'] é exigido pelo WhatsApp para permitir tanto QR Code quanto Código de 8 Dígitos (Pairing Code)
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }) as any,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 20000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 1500,
    });

    activeSocket = sock;

    // Persistência automática de credenciais na pasta local E no Cofre da Nuvem (AES-256)
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      scheduleSessionVaultBackup(AUTH_FOLDER, 8000);
    });

    // Monitoramento de contatos sincronizados pelo WhatsApp
    sock.ev.on('contacts.upsert', (contacts: any) => {
      registerWhatsAppContacts(contacts);
    });
    sock.ev.on('contacts.update', (contacts: any) => {
      registerWhatsAppContacts(contacts);
    });

    // Monitoramento do estado da conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQrCode = qr;
        connectionStatus = 'qr_ready';
        console.log('\n============================================================');
        console.log(`📲 PAREAMENTO WHATSAPP - STUDIO JF DESIGNER (Alícia)`);
        console.log(`📌 Opção 1 (Sem câmera): Acesse /qr e clique em "Gerar Código de 8 Dígitos"`);
        console.log(`📌 Opção 2 (QR Code): Escaneie com o WhatsApp ${STUDIO_OFFICIAL_NUMBER}`);
        console.log('============================================================\n');
        qrcode.generate(qr, { small: true });
        console.log('\n============================================================\n');
      }

      if (connection === 'open') {
        latestQrCode = null;
        latestPairingCode = null;
        connectionStatus = 'connected';
        consecutiveLogouts = 0;

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        console.log(`\n✅ [WhatsApp Conectado 24/7: ${STUDIO_OFFICIAL_NUMBER}]`);
        console.log(`👑 Linha Executiva da Proprietária (Janaína): ${OWNER_PERSONAL_NUMBER}`);
        console.log(`💠 Chave PIX Oficial Ativa: ${STUDIO_PIX_KEY}\n`);

        // Salva imediatamente a sessão autenticada no Cofre da Nuvem para blindar contra futuros deploys
        backupSessionToVault(AUTH_FOLDER).catch(() => {});
      }

      if (connection === 'close') {
        connectionStatus = 'disconnected';
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;
        const isBadSession = statusCode === DisconnectReason.badSession || statusCode === 500;

        console.warn(
          `⚠️ [Baileys] Conexão WhatsApp encerrada (código: ${statusCode ?? 'desconhecido'}).`
        );

        // Caso 1: Conflito de deploy (container antigo vs container novo no Render) -> aguarda 20s sem apagar credenciais
        if (isReplaced) {
          console.log(
            '⏳ [Baileys] Conexão assumida por nova instância de deploy (440). Aguardando 20s em standby seguro...'
          );
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            initWhatsAppConnection().catch((err) =>
              console.error('❌ [Baileys] Erro ao reconectar após standby:', err)
            );
          }, 20000);
          return;
        }

        // Caso 2: Sessão corrompida localmente (500) -> restaura do Cofre da Nuvem sem pedir QR Code
        if (isBadSession) {
          console.log('☁️🔄 [Baileys] Restaurando sessão íntegra do Cofre na Nuvem após erro 500...');
          await restoreSessionFromVault(AUTH_FOLDER, true);
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            initWhatsAppConnection(true).catch(() => {});
          }, 4000);
          return;
        }

        // Caso 3: Oscilação normal de rede / restartRequired (515) / timeout (408) -> reconecta rápido
        if (!isLoggedOut) {
          const delayMs = statusCode === DisconnectReason.restartRequired ? 1500 : 4000;
          console.log(`🔄 [Baileys] Reconectando automaticamente o WhatsApp em ${delayMs / 1000}s...`);
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            initWhatsAppConnection().catch((err) =>
              console.error('❌ [Baileys] Erro ao tentar reconectar:', err)
            );
          }, delayMs);
          return;
        }

        // Caso 4: Logged Out (401)
        consecutiveLogouts += 1;
        if (consecutiveLogouts === 1) {
          console.warn(
            '☁️🛡️ [Baileys] Recebido código 401. Tentando recuperar sessão do Cofre na Nuvem antes de solicitar novo pareamento...'
          );
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          } catch {}
          const restored = await restoreSessionFromVault(AUTH_FOLDER, true);
          if (restored) {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              initWhatsAppConnection(true).catch(() => {});
            }, 3000);
            return;
          }
        }

        console.warn(
          '🚪 [Baileys] Sessão desconectada pelo aparelho. Limpando credenciais para permitir novo pareamento via Código ou QR...'
        );
        try {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        } catch (cleanErr) {
          console.error('Erro ao limpar pasta auth_info_baileys:', cleanErr);
        }
        await deleteVaultFile('baileys-session.enc');

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          initWhatsAppConnection(true).catch((err) =>
            console.error('❌ [Baileys] Erro ao reiniciar pareamento:', err)
          );
        }, 3000);
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

          // Registra o remetente nos contatos sincronizados
          const pushName = msg.pushName || (msg as any).verifiedBizName;
          registerWhatsAppContacts([
            { id: remoteJid, name: pushName, notify: pushName }
          ]);

          // 4. Extrai o conteúdo textual da mensagem
          const messageBody = extractMessageText(msg);
          if (!messageBody) continue;

          // 5. Roteamento Inteligente:
          // Rota A (Janaína / Admin): Remetente é 5521993826303 (OWNER_PERSONAL_NUMBER)
          const senderRole = resolveSenderRole(fromNumber);
          const isOwner =
            senderRole === 'OWNER' ||
            fromNumber === normalizePhoneDigits(OWNER_PERSONAL_NUMBER) ||
            fromNumber.endsWith('21993826303') ||
            fromNumber.endsWith('2193826303') ||
            fromNumber.endsWith('993826303') ||
            fromNumber.endsWith('93826303');

          if (isOwner) {
            console.log(`👑 [Rota A - Janaína/Admin] Comando recebido de ${fromNumber}: "${messageBody}"`);
            await handleOwnerCommands(baileysClientAdapter, fromNumber, messageBody);
          } else {
            // Rota B (Clientes do Studio): Qualquer outro número vai para o fluxo da Alícia
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
  } finally {
    isInitializing = false;
  }
}

export default {
  initWhatsAppConnection,
  requestWhatsAppPairingCode,
  forceReconnectWhatsApp,
  sendMessage,
  sendPresenceUpdate,
  markRead,
  getWhatsAppConnectionState,
  getSyncedWhatsAppContacts,
  registerWhatsAppContacts,
  baileysClientAdapter,
  STUDIO_OFFICIAL_NUMBER,
  OWNER_PERSONAL_NUMBER,
  STUDIO_PIX_KEY,
};
