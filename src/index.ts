import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CalendarService } from './services/calendarService';
import { AIService } from './services/aiService';
import { WhatsAppService } from './services/whatsappService';
import { SessionManager } from './services/sessionManager';
import { sendHumanizedMessage } from './services/humanizedPresenceHelper';
import { SALON_CONFIG } from './config/salonConfig';
import { appointmentRouter } from './routes/appointmentRoutes';
import { availabilityRouter } from './routes/availabilityRoutes';
import { startExpirationJob } from './jobs/expirationJob';
import { startWeeklyReportJob } from './jobs/weeklyReportJob';
import { start24hReminderJob } from './jobs/reminderJob';
import { startSessionCleanupJob } from './jobs/sessionCleanupJob';

import { processIncomingWhatsAppMessage, STUDIO_OFFICIAL_NUMBER, OWNER_PERSONAL_NUMBER, isOwnerPersonalPhone } from './services/routerService';
import { setClientFlowServices } from './services/clientFlowService';
import {
  initWhatsAppConnection,
  getWhatsAppConnectionState,
  requestWhatsAppPairingCode,
  forceReconnectWhatsApp,
  AUTH_FOLDER,
} from './services/whatsappConnection';
import { backupSessionToVault, restoreCatalogFromVault } from './services/whatsappSessionVault';
import { serviceCatalogService } from './services/serviceCatalogService';

dotenv.config();

// Blindagem global de processo para execução 24/7 na nuvem (evita queda por oscilações de socket/rede)
process.on('uncaughtException', (err) => {
  console.error('🛡️ [KEEP-ALIVE] Exceção não tratada interceptada (processo mantido online):', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('🛡️ [KEEP-ALIVE] Promise rejeitada interceptada (processo mantido online):', reason);
});

const app = express();
app.use(cors());
app.use(express.json());

// Rotas de Agendamentos, Disponibilidade Pública e Dashboard com Validação de Sinal
app.use('/api/appointments', appointmentRouter);
app.use('/api/dashboard', appointmentRouter);
app.use('/api/availability', availabilityRouter);

const INITIAL_PORT = parseInt(process.env.PORT || '3000', 10);

// Inicialização dos Serviços e Gerenciador de Sessões
const calendarService = new CalendarService();
export const sessionManager = new SessionManager();
const aiService = new AIService(calendarService, undefined, sessionManager);
const whatsappService = new WhatsAppService();

const handoverActiveSessions = new Set<string>();

// Conecta serviços ao ClientFlowService para uso desacoplado no Roteador
setClientFlowServices({
  aiService,
  sessionManager,
  handoverSessions: handoverActiveSessions,
});

/**
 * Endpoint de Health Check
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'online',
    salon: SALON_CONFIG.name,
    whatsapp: getWhatsAppConnectionState(),
    hasGeminiKey: aiService.hasRealApiKey(),
    timestamp: new Date().toISOString()
  });
});

/**
 * Endpoint para consultar status de conexão, código de pareamento e Cofre na Nuvem 24/7
 */
app.get('/api/whatsapp/status', (req: Request, res: Response) => {
  res.json(getWhatsAppConnectionState());
});

/**
 * Endpoint para gerar Código de Pareamento de 8 Dígitos (Sem precisar ler QR Code com câmera)
 */
app.post('/api/whatsapp/pairing-code', async (req: Request, res: Response) => {
  try {
    const { phone } = req.body || {};
    const result = await requestWhatsAppPairingCode(phone);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * Endpoint para forçar reconexão ou limpar sessão do WhatsApp
 */
app.post('/api/whatsapp/reconnect', async (req: Request, res: Response) => {
  try {
    const clearSession = Boolean(req.body?.clearSession);
    await forceReconnectWhatsApp(clearSession);
    return res.json({
      success: true,
      cleared: clearSession,
      state: getWhatsAppConnectionState(),
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * Endpoint para forçar backup imediato da sessão autenticada no Cofre da Nuvem
 */
app.post('/api/whatsapp/vault-sync', async (req: Request, res: Response) => {
  try {
    const synced = await backupSessionToVault(AUTH_FOLDER);
    return res.json({
      success: synced,
      state: getWhatsAppConnectionState(),
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * Endpoint para disparo direto de mensagem via WhatsApp Oficial conectado (Baileys)
 */
app.post('/api/whatsapp/send', async (req: Request, res: Response) => {
  try {
    const { to = OWNER_PERSONAL_NUMBER, message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'Parâmetro "message" é obrigatório.' });
    }
    const sent = await whatsappService.sendMessage(to, message);
    return res.json({
      success: sent,
      to,
      connection: getWhatsAppConnectionState().status,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error?.message });
  }
});

/**
 * Central de Conexão Permanente 24/7 (Pareamento por Código de 8 Dígitos sem câmera + Cofre na Nuvem + QR Code)
 */
app.get('/qr', (req: Request, res: Response) => {
  const state = getWhatsAppConnectionState();
  const qrHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conexão Permanente 24/7 - ${SALON_CONFIG.name}</title>
  <link rel="icon" type="image/png" href="/logo-jf.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0b141a; color: #e9edef; font-family: 'Segoe UI', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
    .card { background: #182229; padding: 26px 22px; border-radius: 20px; text-align: center; max-width: 480px; width: 100%; box-shadow: 0 16px 40px rgba(0,0,0,0.65); border: 1px solid #2a3942; }
    h1 { font-size: 20px; margin-bottom: 6px; color: #00a884; }
    .subtitle { font-size: 13px; color: #8696a0; line-height: 1.45; margin-bottom: 14px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 999px; font-weight: 700; font-size: 12.5px; margin: 4px 0; }
    .connected { background: #00a88425; color: #34d399; border: 1px solid #00a884; }
    .waiting { background: #f59e0b20; color: #fbbf24; border: 1px solid #f59e0b60; }
    .vault-badge { background: #8b5cf620; color: #c4b5fd; border: 1px solid #8b5cf660; font-size: 11.5px; padding: 5px 12px; }
    .section-box { background: #111b21; border: 1px solid #2a3942; border-radius: 14px; padding: 16px; margin-top: 16px; text-align: left; }
    .section-title { font-size: 14px; font-weight: 700; color: #f472b6; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .section-desc { font-size: 12.5px; color: #94a3b8; line-height: 1.45; margin-bottom: 12px; }
    .input-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .phone-input { flex: 1; background: #202c33; border: 1px solid #374248; color: #fff; padding: 10px 12px; border-radius: 10px; font-size: 14px; font-weight: 600; outline: none; }
    .btn { width: 100%; border: none; border-radius: 10px; padding: 11px 14px; font-weight: 700; font-size: 13.5px; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-pink { background: linear-gradient(135deg, #ec4899, #8b5cf6); color: #fff; box-shadow: 0 4px 15px rgba(236,72,153,0.3); }
    .btn-pink:hover { opacity: 0.95; }
    .btn-secondary { background: #202c33; color: #cbd5e1; border: 1px solid #374248; margin-top: 8px; font-size: 12.5px; padding: 9px 12px; }
    .pairing-code-display { background: #0b141a; border: 2px dashed #ec4899; border-radius: 12px; padding: 14px; text-align: center; margin: 12px 0; }
    .pairing-digits { font-size: 28px; font-weight: 900; letter-spacing: 4px; color: #f472b6; font-family: monospace; }
    .steps { font-size: 12px; color: #cbd5e1; line-height: 1.6; margin-top: 8px; padding-left: 16px; }
    .qr-box { background: #fff; padding: 14px; border-radius: 12px; display: inline-block; margin: 12px auto 6px; }
    .nav-links { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
    .nav-links a { color: #38bdf8; font-size: 12.5px; text-decoration: none; background: #0284c720; border: 1px solid #0284c750; padding: 6px 12px; border-radius: 8px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div style="width:96px; height:96px; margin:0 auto 10px; background:radial-gradient(circle, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.58) 58%, transparent 100%); border-radius:999px; padding:4px; display:flex; align-items:center; justify-content:center;">
      <img src="/logo-jf.png" alt="Logo JF Lash e Designer" style="width:100%; height:100%; object-fit:contain; filter:drop-shadow(0 4px 10px rgba(0,0,0,0.85));" />
    </div>
    <h1>📲 Conexão 24/7 - ${SALON_CONFIG.name}</h1>
    <p class="subtitle">
      WhatsApp Oficial: <strong>${state.officialNumber}</strong> &bull; Admin: <strong>${state.ownerPersonalNumber}</strong>
    </p>

    <div id="statusBadgeContainer">
      ${
        state.isConnected
          ? `<div class="badge connected">✅ Alícia Conectada 24/7 (${state.officialNumber})</div>`
          : `<div class="badge waiting">⏳ Aguardando Conexão do Aparelho (${state.officialNumber})</div>`
      }
    </div>

    <div style="margin-top: 6px;">
      <span class="badge vault-badge" id="vaultBadge">
        ☁️🔒 Cofre de Sessão na Nuvem Ativo (Não pede QR Code após atualizações)
      </span>
    </div>

    <!-- MODO 1: PAREAMENTO POR CÓDIGO DE 8 DÍGITOS (SEM CÂMERA / NO MESMO CELULAR) -->
    <div class="section-box" id="pairingSection" style="${state.isConnected ? 'display:none;' : ''}">
      <div class="section-title">🔑 Opção 1: Conectar por Código de 8 Dígitos (Sem Câmera)</div>
      <p class="section-desc">
        Ideal quando você está no próprio celular e não consegue ler o QR Code. Gere o código abaixo e digite na notificação do seu WhatsApp:
      </p>
      <div class="input-row">
        <input type="text" id="pairingPhoneInput" class="phone-input" value="${state.officialNumber}" placeholder="5521960003154" />
      </div>
      <button class="btn btn-pink" id="btnGenCode" onclick="generatePairingCode()">
        🔑 Gerar Código de 8 Dígitos Agora
      </button>

      <div id="pairingResultBox" style="${state.pairingCode ? 'display:block;' : 'display:none;'}">
        <div class="pairing-code-display">
          <div style="font-size:11px; color:#94a3b8; margin-bottom:4px;">SEU CÓDIGO DE CONEXÃO WHATSAPP:</div>
          <div class="pairing-digits" id="pairingCodeText">${state.pairingCode || '----'}</div>
          <button class="btn btn-secondary" style="margin-top:10px;" onclick="copyPairingCode()">📋 Copiar Código</button>
        </div>
        <ol class="steps">
          <li>Toque na notificação <strong>"Código para conectar um dispositivo"</strong> que chegou no WhatsApp (ou abra o WhatsApp &rarr; <strong>Dispositivos conectados &rarr; Conectar dispositivo &rarr; Conectar com número de telefone</strong>).</li>
          <li>Cole ou digite o código acima.</li>
          <li>Pronto! O <strong>Cofre na Nuvem 24/7</strong> salvará a conexão automaticamente para sempre.</li>
        </ol>
      </div>
    </div>

    <!-- MODO 2: QR CODE TRADICIONAL -->
    <div class="section-box" id="qrSection" style="text-align:center; ${state.isConnected ? 'display:none;' : ''}">
      <div class="section-title" style="justify-content:center; color:#38bdf8;">📷 Opção 2: Escanear QR Code</div>
      <div id="qrImageWrapper">
        ${
          state.qrCode
            ? `<div class="qr-box"><img id="qrImg" src="https://api.qrserver.com/v1/create-qr-code/?size=230x230&data=${encodeURIComponent(state.qrCode)}" alt="QR Code WhatsApp" width="230" height="230" /></div>`
            : `<p style="font-size:12.5px; color:#94a3b8; padding:12px 0;">🔄 Preparando QR Code... Aguarde alguns segundos.</p>`
        }
      </div>
    </div>

    <!-- PAINEL QUANDO JÁ ESTÁ CONECTADO -->
    <div class="section-box" id="connectedSection" style="text-align:center; ${state.isConnected ? 'display:block;' : 'display:none;'}">
      <p style="font-size:14px; color:#34d399; font-weight:700; margin-bottom:6px;">
        ✨ A Alícia está Online em Tempo Integral!
      </p>
      <p style="font-size:12.5px; color:#94a3b8; line-height:1.5;">
        Sua sessão está salva no <strong>Cofre Criptografado na Nuvem</strong>. Mesmo que o servidor seja atualizado ou reiniciado, ela voltará conectada sozinha sem pedir QR Code.
      </p>
      <button class="btn btn-secondary" onclick="syncVaultNow()">☁️ Garantir Backup no Cofre Agora</button>
    </div>

    <div style="display:flex; gap:8px; margin-top:12px;">
      <button class="btn btn-secondary" onclick="triggerReconnect(false)">🔄 Reconectar</button>
      <button class="btn btn-secondary" style="color:#f87171; border-color:#ef444450;" onclick="triggerReconnect(true)">🗑️ Trocar Aparelho</button>
    </div>

    <div class="nav-links">
      <a href="/dashboard">📊 Abrir Dashboard</a>
      <a href="/agendar">🗓️ Página de Clientes</a>
      <a href="/chat">💬 Simulador Alícia</a>
    </div>
  </div>

  <script>
    let currentPairingCode = ${JSON.stringify(state.pairingCode || null)};

    async function generatePairingCode() {
      const btn = document.getElementById('btnGenCode');
      const phone = document.getElementById('pairingPhoneInput').value.trim();
      btn.disabled = true;
      btn.innerText = '⏳ Gerando código no WhatsApp (aguarde 3s)...';

      try {
        const res = await fetch('/api/whatsapp/pairing-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          alert(data.error || 'Erro ao gerar código de pareamento.');
        } else {
          currentPairingCode = data.formattedCode;
          document.getElementById('pairingCodeText').innerText = data.formattedCode;
          document.getElementById('pairingResultBox').style.display = 'block';
        }
      } catch (err) {
        alert('Erro de comunicação: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerText = '🔑 Gerar Novo Código de 8 Dígitos';
      }
    }

    function copyPairingCode() {
      const raw = (document.getElementById('pairingCodeText').innerText || '').replace(/[^A-Z0-9]/gi, '');
      navigator.clipboard.writeText(raw);
      alert('Código ' + raw + ' copiado! Agora cole na notificação do seu WhatsApp.');
    }

    async function syncVaultNow() {
      try {
        const res = await fetch('/api/whatsapp/vault-sync', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('✅ Sessão salva com sucesso no Cofre da Nuvem!');
        } else {
          alert('⚠️ Conecte o WhatsApp primeiro para salvar a sessão no cofre.');
        }
      } catch (e) {
        alert('Erro ao sincronizar cofre.');
      }
    }

    async function triggerReconnect(clearSession) {
      if (clearSession && !confirm('Tem certeza que deseja desconectar a sessão atual e gerar um novo pareamento?')) {
        return;
      }
      await fetch('/api/whatsapp/reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearSession })
      });
      setTimeout(pollStatus, 1500);
    }

    async function pollStatus() {
      try {
        const res = await fetch('/api/whatsapp/status');
        const st = await res.json();
        const badgeBox = document.getElementById('statusBadgeContainer');
        const pairingSec = document.getElementById('pairingSection');
        const qrSec = document.getElementById('qrSection');
        const connSec = document.getElementById('connectedSection');

        if (st.isConnected) {
          badgeBox.innerHTML = '<div class="badge connected">✅ Alícia Conectada 24/7 (' + st.officialNumber + ')</div>';
          pairingSec.style.display = 'none';
          qrSec.style.display = 'none';
          connSec.style.display = 'block';
        } else {
          badgeBox.innerHTML = '<div class="badge waiting">⏳ Aguardando Conexão do Aparelho (' + st.officialNumber + ')</div>';
          pairingSec.style.display = 'block';
          qrSec.style.display = 'block';
          connSec.style.display = 'none';

          if (st.qrCode) {
            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=230x230&data=' + encodeURIComponent(st.qrCode);
            document.getElementById('qrImageWrapper').innerHTML =
              '<div class="qr-box"><img src="' + qrUrl + '" alt="QR Code WhatsApp" width="230" height="230" /></div>';
          }
        }
      } catch {}
    }

    setInterval(pollStatus, 4000);
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(qrHtml);
});

/**
 * Endpoint para listar serviços e preços cadastrados
 */
app.get('/services', (req: Request, res: Response) => {
  res.json({
    salon: SALON_CONFIG.name,
    owner: SALON_CONFIG.ownerName,
    instagram: SALON_CONFIG.instagram,
    address: SALON_CONFIG.address,
    rules: SALON_CONFIG.rules,
    businessHours: SALON_CONFIG.businessHours,
    services: SALON_CONFIG.services
  });
});

/**
 * Endpoint para configurar ou atualizar a GEMINI_API_KEY
 */
app.post('/api/config/gemini-key', (req: Request, res: Response) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    return res.status(400).json({ error: 'Chave de API inválida.' });
  }

  const cleanKey = apiKey.trim();
  aiService.setApiKey(cleanKey);

  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
      if (envContent.includes('GEMINI_API_KEY=')) {
        envContent = envContent.replace(/GEMINI_API_KEY=.*(\r?\n|$)/, `GEMINI_API_KEY=${cleanKey}$1`);
      } else {
        envContent += `\nGEMINI_API_KEY=${cleanKey}\n`;
      }
    } else {
      envContent = `GEMINI_API_KEY=${cleanKey}\nPORT=3000\n`;
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
  } catch (err) {
    console.warn('Não foi possível gravar no .env, mas a chave foi aplicada na sessão atual:', err);
  }

  return res.json({ success: true, message: 'Chave Gemini API configurada com sucesso!' });
});

/**
 * Webhook Principal do WhatsApp
 */
app.post('/webhook/whatsapp', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const isFromMe = payload?.data?.key?.fromMe || false;

    if (isFromMe) {
      return res.status(200).json({ status: 'ignored', reason: 'fromMe' });
    }

    const result = await processIncomingWhatsAppMessage(whatsappService, payload);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Erro no processamento do webhook:', error);
    return res.status(500).json({ error: 'Erro interno ao processar mensagem.' });
  }
});

/**
 * Handler Unificado para Rotas REST do Chat (/test-chat e /api/chat)
 */
async function handleRestChatRequest(req: Request, res: Response) {
  const {
    phone = '5521999998888',
    message,
    sender = 'client',
    senderRole,
    reset = false,
  } = req.body;

  const effectiveRole = senderRole || sender;
  const isOwner = effectiveRole === 'owner' || effectiveRole === 'admin' || isOwnerPersonalPhone(phone);
  const targetPhone = isOwner ? OWNER_PERSONAL_NUMBER : phone;

  if (reset) {
    sessionManager.resetSession(targetPhone);
    handoverActiveSessions.delete(targetPhone);
    return res.json({ message: `Histórico de conversa reiniciado para ${targetPhone}.` });
  }

  if (!message) {
    return res.status(400).json({ error: 'Parâmetro "message" é obrigatório.' });
  }

  const payload = {
    from: targetPhone,
    body: message,
    sender: isOwner ? 'owner' : 'client',
    senderRole: (isOwner ? 'owner' : 'client') as 'owner' | 'client',
  };

  const result = await processIncomingWhatsAppMessage(whatsappService, payload);

  return res.json({
    clientPhone: targetPhone,
    senderRole: isOwner ? 'owner' : 'client',
    userMessage: message,
    aiResponse: result?.reply || result?.message || 'Comando processado com sucesso.',
    action: result?.action || 'flow_executed',
    status: result?.status || 'success',
    isTimeoutReset: !!result?.isTimeoutReset,
    isHandoverTriggered: !!result?.isHandoverTriggered,
    mode: 'simulated',
  });
}

app.post('/test-chat', handleRestChatRequest);
app.post('/api/chat', handleRestChatRequest);

app.post('/test-session-timeout', (req: Request, res: Response) => {
  const { phone = '5521991112222', minutesAgo = 15 } = req.body;
  const targetTime = new Date(Date.now() - minutesAgo * 60 * 1000);
  sessionManager.forceSetLastInteraction(phone, targetTime);
  return res.json({ success: true, phone, simulatedLastInteraction: targetTime.toISOString() });
});

/**
 * Interface Web Interativa (Simulador WhatsApp) com Alternador de Modo [Cliente / Janaína Admin]
 */
app.get(['/', '/chat'], (req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${SALON_CONFIG.name} - Teste do Agente WhatsApp</title>
  <link rel="icon" type="image/png" href="/logo-jf.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Segoe+UI:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    body { background-color: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 12px; }
    .app-container { width: 100%; max-width: 540px; height: 94vh; background: #111b21; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,0.6); border: 1px solid #222e35; }
    .chat-header { background: #202c33; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #222e35; }
    .chat-header-info { display: flex; align-items: center; gap: 12px; }
    .avatar { width: 54px; height: 54px; border-radius: 999px; background: radial-gradient(circle, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.55) 58%, transparent 100%); padding: 2px; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: bold; color: #fff; transition: all 0.3s; overflow: hidden; }
    .avatar.admin { box-shadow: 0 0 12px rgba(245,158,11,0.35); }
    .header-details h1 { font-size: 15px; font-weight: 600; color: #e9edef; }
    .header-details p { font-size: 11.5px; color: #8696a0; display: flex; align-items: center; gap: 4px; }
    .status-dot { width: 8px; height: 8px; background: #00a884; border-radius: 50%; display: inline-block; }
    .badge-status { font-size: 11px; background: #233138; padding: 4px 8px; border-radius: 12px; color: #00a884; border: 1px solid #00a88440; cursor: pointer; transition: all 0.2s; }
    .badge-admin { background: #f59e0b20; border-color: #f59e0b; color: #fbbf24; font-weight: 600; }
    .quick-actions { background: #111b21; padding: 8px 12px; overflow-x: auto; white-space: nowrap; display: flex; gap: 6px; border-bottom: 1px solid #202c33; scrollbar-width: none; }
    .quick-pill { background: #202c33; color: #00a884; border: 1px solid #00a88430; border-radius: 16px; padding: 5px 12px; font-size: 12px; cursor: pointer; transition: all 0.2s; }
    .quick-pill:hover { background: #00a884; color: #fff; }
    .quick-pill.admin-pill { color: #fbbf24; border-color: #f59e0b40; }
    .quick-pill.admin-pill:hover { background: #d97706; color: #fff; }
    .chat-body { flex: 1; padding: 16px; overflow-y: auto; background-image: radial-gradient(#202c33 1px, transparent 1px); background-size: 20px 20px; background-color: #0b141a; display: flex; flex-direction: column; gap: 10px; }
    .message { max-width: 84%; padding: 10px 14px; border-radius: 12px; font-size: 14.5px; line-height: 1.45; word-wrap: break-word; position: relative; animation: fadeIn 0.2s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .message.bot { background: #202c33; color: #e9edef; align-self: flex-start; border-bottom-left-radius: 2px; }
    .message.user { background: #005c4b; color: #e9edef; align-self: flex-end; border-bottom-right-radius: 2px; }
    .message.user.admin-msg { background: #92400e; }
    .message-time { font-size: 10.5px; color: #8696a0; text-align: right; margin-top: 4px; }
    .handover-badge { margin-top: 6px; display: inline-block; background: #eab30820; border: 1px solid #eab308; color: #fde047; font-size: 11px; padding: 2px 6px; border-radius: 6px; }
    .chat-footer { background: #202c33; padding: 10px 14px; display: flex; align-items: center; gap: 8px; }
    .chat-input { flex: 1; background: #2a3942; border: none; outline: none; border-radius: 24px; padding: 11px 18px; color: #e9edef; font-size: 14px; }
    .send-btn { background: #00a884; color: white; border: none; width: 42px; height: 42px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px; transition: background 0.2s; }
    .send-btn:hover { background: #029071; }
  </style>
</head>
<body>
  <div class="app-container">
    <div class="chat-header">
      <div class="chat-header-info">
        <div class="avatar" id="headerAvatar"><img src="/logo-jf.png" alt="JF" style="width:100%; height:100%; object-fit:contain;" /></div>
        <div class="header-details">
          <h1>${SALON_CONFIG.name}</h1>
          <p><span class="status-dot"></span> <span id="statusText">${SALON_CONFIG.assistantName} (Assistente Virtual)</span></p>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        <button id="modeToggleBtn" class="badge-status" onclick="toggleMode()">📱 Modo: Cliente</button>
        <a href="/qr" class="badge-status" style="background:#10b98120; border-color:#10b981; color:#34d399; text-decoration:none;">🔑 Conexão 24/7</a>
        <a href="/dashboard" class="badge-status" style="background:#0284c720; border-color:#0284c7; color:#38bdf8; text-decoration:none;">📊 Dashboard</a>
      </div>
    </div>

    <div class="quick-actions" id="quickContainer"></div>

    <div class="chat-body" id="chatBody">
      <div class="message bot">
        Oi, linda! Tudo bem? Seja muito bem-vinda ao <strong>${SALON_CONFIG.name}</strong>! ✨<br><br>
        Eu sou a <strong>${SALON_CONFIG.assistantName}</strong>, da equipe da ${SALON_CONFIG.ownerName}. Como posso cuidar de você hoje? Fique à vontade para me perguntar sobre nossos cílios, sobrancelhas ou escolhermos um horário perfeito pra você! 💕
        <div class="message-time">Agora</div>
      </div>
    </div>

    <div class="chat-footer">
      <input type="text" id="chatInput" class="chat-input" placeholder="Digite uma mensagem..." onkeydown="handleKey(event)" autofocus>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()">➤</button>
    </div>
  </div>

  <script>
    const chatBody = document.getElementById('chatBody');
    const chatInput = document.getElementById('chatInput');
    const statusText = document.getElementById('statusText');
    const modeToggleBtn = document.getElementById('modeToggleBtn');
    const headerAvatar = document.getElementById('headerAvatar');
    const quickContainer = document.getElementById('quickContainer');

    let currentMode = 'client';
    let clientPhone = '5521999998888';
    let ownerPhone = '${SALON_CONFIG.ownerPersonalNumber}';

    function renderQuickPills() {
      if (currentMode === 'owner') {
        quickContainer.innerHTML = \`
          <button class="quick-pill admin-pill" onclick="sendQuick('Minha agenda')">📋 Minha Agenda</button>
          <button class="quick-pill admin-pill" onclick="sendQuick('Bloquear 20/10 das 14:00 às 16:00')">🔒 Bloquear Vaga (Sigilo)</button>
          <button class="quick-pill admin-pill" onclick="sendQuick('Folga dia 22/10')">🏖️ Folga (Dia Todo)</button>
          <button class="quick-pill admin-pill" onclick="sendQuick('Desmarcar cliente Maria Silva')">❌ Desmarcar Cliente</button>
          <button class="quick-pill admin-pill" onclick="sendQuick('preciso montar a agenda do mês')">🗓️ Montar Agenda do Mês</button>
          <button class="quick-pill admin-pill" style="color:#ef4444; border-color:#ef444450;" onclick="resetChat()">🔄 Limpar</button>
        \`;
      } else {
        quickContainer.innerHTML = \`
          <button class="quick-pill" onclick="sendQuick('Quais são os valores de cílios?')">👁️ Cílios</button>
          <button class="quick-pill" onclick="sendQuick('Como funciona a manutenção de cílios?')">⚠️ Manutenção e Regras</button>
          <button class="quick-pill" onclick="sendQuick('Quais serviços de sobrancelha e depilação vocês fazem?')">💅 Sobrancelha / Depilação</button>
          <button class="quick-pill" onclick="sendQuick('Quero agendar um horário para amanhã')">🗓️ Agendar Horário</button>
          <button class="quick-pill" onclick="sendQuick('Qual é o endereço e instagram?')">📍 Endereço</button>
          <button class="quick-pill" onclick="sendQuick('Quero falar com a Janaína')">🚨 Falar com a Janaína</button>
          <button class="quick-pill" style="color:#ef4444; border-color:#ef444450;" onclick="resetChat()">🔄 Limpar</button>
        \`;
      }
    }

    function toggleMode() {
      if (currentMode === 'client') {
        currentMode = 'owner';
        modeToggleBtn.innerText = '👑 Modo: Janaína (Admin)';
        modeToggleBtn.classList.add('badge-admin');
        headerAvatar.classList.add('admin');
        statusText.innerText = 'Janaína Ferreira (Proprietária / Admin)';
      } else {
        currentMode = 'client';
        modeToggleBtn.innerText = '📱 Modo: Cliente';
        modeToggleBtn.classList.remove('badge-admin');
        headerAvatar.classList.remove('admin');
        statusText.innerText = '${SALON_CONFIG.assistantName} (Assistente Virtual)';
      }
      renderQuickPills();
    }

    function formatWhatsApp(text) {
      return text
        .replace(/\\n/g, '<br>')
        .replace(/\\*([^*]+)\\*/g, '<strong>$1</strong>')
        .replace(/_([^_]+)_/g, '<em>$1</em>');
    }

    function addMessage(sender, text, isHandover = false) {
      const msgDiv = document.createElement('div');
      const isUserAdmin = sender === 'user' && currentMode === 'owner';
      msgDiv.className = 'message ' + sender + (isUserAdmin ? ' admin-msg' : '');
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      let html = formatWhatsApp(text);
      if (isHandover) {
        html += '<br><span class="handover-badge">🚨 Transbordo Humano Acionado (Notificando Janaína)</span>';
      }
      html += '<div class="message-time">' + time + '</div>';
      msgDiv.innerHTML = html;
      chatBody.appendChild(msgDiv);
      chatBody.scrollTop = chatBody.scrollHeight;
    }

    async function sendMessage() {
      const text = chatInput.value.trim();
      if (!text) return;
      
      addMessage('user', text);
      chatInput.value = '';
      chatInput.focus();

      statusText.innerText = '${SALON_CONFIG.assistantName} digitando...';

      const activePhone = currentMode === 'owner' ? ownerPhone : clientPhone;
      const senderRole = currentMode === 'owner' ? 'owner' : 'client';

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: activePhone, message: text, sender: senderRole })
        });
        const data = await res.json();
        statusText.innerText = currentMode === 'owner' ? 'Janaína Ferreira (Proprietária / Admin)' : '${SALON_CONFIG.assistantName} (Assistente Virtual)';
        addMessage('bot', data.aiResponse, data.isHandoverTriggered);
      } catch (err) {
        statusText.innerText = currentMode === 'owner' ? 'Janaína Ferreira (Proprietária / Admin)' : '${SALON_CONFIG.assistantName} (Assistente Virtual)';
        addMessage('bot', '⚠️ Erro ao comunicar com o servidor: ' + err.message);
      }
    }

    function sendQuick(text) {
      chatInput.value = text;
      sendMessage();
    }

    function handleKey(e) {
      if (e.key === 'Enter') sendMessage();
    }

    async function resetChat() {
      const activePhone = currentMode === 'owner' ? ownerPhone : clientPhone;
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: activePhone, reset: true })
      });
      chatBody.innerHTML = '';
      addMessage('bot', 'Conversa reiniciada! Como posso te ajudar hoje? 💕');
    }

    renderQuickPills();
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/**
 * Rota para servir a logo oficial do Studio JF Lash e Designer (/logo-jf.png e /favicon.ico)
 */
app.get(['/logo-jf.png', '/favicon.png', '/favicon.ico'], (req: Request, res: Response) => {
  const distLogo = path.resolve(__dirname, 'views', 'logo-jf.png');
  if (fs.existsSync(distLogo)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(distLogo);
  }
  const srcLogo = path.resolve(process.cwd(), 'src', 'views', 'logo-jf.png');
  if (fs.existsSync(srcLogo)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(srcLogo);
  }
  return res.status(404).end();
});

/**
 * Rota para servir a interface do Dashboard Semanal de Agendamentos & Sinais
 */
app.get('/dashboard', (req: Request, res: Response) => {
  const htmlPath = path.resolve(__dirname, 'views', 'dashboard.html');
  if (fs.existsSync(htmlPath)) {
    return res.sendFile(htmlPath);
  }
  const fallbackPath = path.resolve(process.cwd(), 'src', 'views', 'dashboard.html');
  return res.sendFile(fallbackPath);
});

/**
 * Rota pública para o Painel de Seleção de Horários Interativo das Clientes (/agendar e /booking)
 */
app.get(['/agendar', '/booking'], (req: Request, res: Response) => {
  const htmlPath = path.resolve(__dirname, 'views', 'booking.html');
  if (fs.existsSync(htmlPath)) {
    return res.sendFile(htmlPath);
  }
  const fallbackPath = path.resolve(process.cwd(), 'src', 'views', 'booking.html');
  return res.sendFile(fallbackPath);
});

function getLocalNetworkIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

/**
 * Job de Keep-Alive Automático para Nuvem (Render / Railway / Fly.io):
 * Executa a cada 4 minutos para evitar hibernação por inatividade HTTP (Render Free hiberna após 15 min).
 */
function startCloudKeepAlive(port: number) {
  const externalUrl = (
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_APP_URL ||
    'https://studio-jf-alicia-whatsapp.onrender.com'
  ).replace(/\/+$/, '');
  const targetUrl = externalUrl ? `${externalUrl}/health` : `http://127.0.0.1:${port}/health`;

  setInterval(async () => {
    try {
      await fetch(targetUrl);
    } catch {
      // Ignora falhas transitórias de rede no auto-ping
    }
  }, 4 * 60 * 1000); // A cada 4 minutos
}

/**
 * Função para iniciar o servidor com Fallback Automático de Porta se a porta estiver ocupada
 */
function startServer(port: number) {
  const localIp = getLocalNetworkIp();
  const server = app.listen(port, async () => {
    console.log(`==================================================`);
    console.log(`🚀 Agente WhatsApp do Salão Rodando na porta ${port}`);
    console.log(`📍 Salão: ${SALON_CONFIG.name}`);
    console.log(`💬 Chat Web (PC): http://localhost:${port}/`);
    console.log(`📊 Dashboard (PC): http://localhost:${port}/dashboard`);
    console.log(`🔑 Central Conexão 24/7: http://localhost:${port}/qr`);
    console.log(`==================================================`);

    // Restaura catálogo salvo no Cofre da Nuvem (caso haja alterações prévias em produção)
    await restoreCatalogFromVault().catch(() => {});
    serviceCatalogService.getAllServices();

    startExpirationJob();
    startWeeklyReportJob();
    start24hReminderJob();
    startSessionCleanupJob(sessionManager);
    startCloudKeepAlive(port);

    // Inicializa a conexão oficial do WhatsApp via Baileys (Número: 5521960003154)
    initWhatsAppConnection().catch((err) => {
      console.error('❌ Falha crítica ao iniciar serviço Baileys WhatsApp:', err);
    });
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ Porta ${port} já está em uso. Tentando porta alternativa ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Erro ao iniciar o servidor:', err);
    }
  });
}

startServer(INITIAL_PORT);
