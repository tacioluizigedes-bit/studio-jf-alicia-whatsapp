import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
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
import { initWhatsAppConnection, getWhatsAppConnectionState } from './services/whatsappConnection';

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
 * Endpoint para consultar status de conexão e QR Code do WhatsApp (Baileys)
 */
app.get('/api/whatsapp/status', (req: Request, res: Response) => {
  res.json(getWhatsAppConnectionState());
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
 * Painel visual de pareamento QR Code no navegador (auto-refresh)
 */
app.get('/qr', (req: Request, res: Response) => {
  const state = getWhatsAppConnectionState();
  const qrHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="5">
  <title>Pareamento WhatsApp - ${SALON_CONFIG.name}</title>
  <style>
    body { background: #0b141a; color: #e9edef; font-family: 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #202c33; padding: 32px; border-radius: 16px; text-align: center; max-width: 440px; width: 90%; box-shadow: 0 12px 32px rgba(0,0,0,0.5); border: 1px solid #2a3942; }
    h1 { font-size: 20px; margin-bottom: 8px; color: #00a884; }
    p { font-size: 14px; color: #8696a0; line-height: 1.5; }
    .qr-box { background: #fff; padding: 16px; border-radius: 12px; display: inline-block; margin: 18px 0; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 13px; margin-top: 10px; }
    .connected { background: #00a88425; color: #00a884; border: 1px solid #00a884; }
    .waiting { background: #f59e0b25; color: #fbbf24; border: 1px solid #f59e0b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📲 WhatsApp Oficial - ${SALON_CONFIG.name}</h1>
    <p>Canal Comercial: <strong>${state.officialNumber}</strong><br>Admin (Janaína): <strong>${state.ownerPersonalNumber}</strong></p>
    ${
      state.isConnected
        ? `<div class="badge connected">✅ [WhatsApp Conectado: ${state.officialNumber}]</div><p style="margin-top:16px;">A atendente virtual <strong>Alícia</strong> já está ativa e escutando mensagens em tempo real!</p>`
        : state.qrCode
        ? `<div class="qr-box"><img src="https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(state.qrCode)}" alt="QR Code WhatsApp" width="260" height="260" /></div><br><div class="badge waiting">⏳ Aguardando leitura do QR Code no aparelho 21 96000-3154...</div>`
        : `<div class="badge waiting">🔄 Inicializando socket Baileys... (atualiza em 5s)</div>`
    }
  </div>
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
 * Webhook Principal do WhatsApp:
 * Roteamento Inteligente e Seguro:
 * - Linha Oficial (5521993826303): Atendimento e agendamentos de clientes pela Alícia
 * - Linha Pessoal da Janaína (OWNER_PERSONAL_NUMBER): Painel executivo da dona
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
 * Totalmente compatível com o simulador web, alternando entre Canal Cliente e Canal Executivo Janaína
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

/**
 * Endpoint de Teste Direto REST (/test-chat e /api/chat)
 */
app.post('/test-chat', handleRestChatRequest);
app.post('/api/chat', handleRestChatRequest);

/**
 * Endpoint para Simular Inatividade / Timeout de Sessão nos Testes
 */
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
  const hasKey = aiService.hasRealApiKey();
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${SALON_CONFIG.name} - Teste do Agente WhatsApp</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Segoe+UI:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    body { background-color: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 12px; }
    .app-container { width: 100%; max-width: 540px; height: 94vh; background: #111b21; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,0.6); border: 1px solid #222e35; }
    
    /* Header */
    .chat-header { background: #202c33; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #222e35; }
    .chat-header-info { display: flex; align-items: center; gap: 12px; }
    .avatar { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(135deg, #ec4899, #8b5cf6); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: bold; color: #fff; transition: all 0.3s; }
    .avatar.admin { background: linear-gradient(135deg, #f59e0b, #d97706); }
    .header-details h1 { font-size: 15px; font-weight: 600; color: #e9edef; }
    .header-details p { font-size: 11.5px; color: #8696a0; display: flex; align-items: center; gap: 4px; }
    .status-dot { width: 8px; height: 8px; background: #00a884; border-radius: 50%; display: inline-block; }
    .badge-status { font-size: 11px; background: #233138; padding: 4px 8px; border-radius: 12px; color: #00a884; border: 1px solid #00a88440; cursor: pointer; transition: all 0.2s; }
    .badge-admin { background: #f59e0b20; border-color: #f59e0b; color: #fbbf24; font-weight: 600; }

    /* Quick Pills */
    .quick-actions { background: #111b21; padding: 8px 12px; overflow-x: auto; white-space: nowrap; display: flex; gap: 6px; border-bottom: 1px solid #202c33; scrollbar-width: none; }
    .quick-pill { background: #202c33; color: #00a884; border: 1px solid #00a88430; border-radius: 16px; padding: 5px 12px; font-size: 12px; cursor: pointer; transition: all 0.2s; }
    .quick-pill:hover { background: #00a884; color: #fff; }
    .quick-pill.admin-pill { color: #fbbf24; border-color: #f59e0b40; }
    .quick-pill.admin-pill:hover { background: #d97706; color: #fff; }

    /* Messages Area */
    .chat-body { flex: 1; padding: 16px; overflow-y: auto; background-image: radial-gradient(#202c33 1px, transparent 1px); background-size: 20px 20px; background-color: #0b141a; display: flex; flex-direction: column; gap: 10px; }
    .message { max-width: 84%; padding: 10px 14px; border-radius: 12px; font-size: 14.5px; line-height: 1.45; word-wrap: break-word; position: relative; animation: fadeIn 0.2s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .message.bot { background: #202c33; color: #e9edef; align-self: flex-start; border-bottom-left-radius: 2px; }
    .message.user { background: #005c4b; color: #e9edef; align-self: flex-end; border-bottom-right-radius: 2px; }
    .message.user.admin-msg { background: #92400e; }
    .message-time { font-size: 10.5px; color: #8696a0; text-align: right; margin-top: 4px; }
    .handover-badge { margin-top: 6px; display: inline-block; background: #eab30820; border: 1px solid #eab308; color: #fde047; font-size: 11px; padding: 2px 6px; border-radius: 6px; }

    /* Footer Input */
    .chat-footer { background: #202c33; padding: 10px 14px; display: flex; align-items: center; gap: 8px; }
    .chat-input { flex: 1; background: #2a3942; border: none; outline: none; border-radius: 24px; padding: 11px 18px; color: #e9edef; font-size: 14px; }
    .send-btn { background: #00a884; color: white; border: none; width: 42px; height: 42px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px; transition: background 0.2s; }
    .send-btn:hover { background: #029071; }
    
    /* Key Modal */
    .modal-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
    .modal-card { background: #202c33; border-radius: 12px; width: 90%; max-width: 420px; padding: 20px; box-shadow: 0 8px 30px rgba(0,0,0,0.6); }
    .modal-card h3 { font-size: 16px; margin-bottom: 8px; color: #00a884; }
    .modal-card p { font-size: 12.5px; color: #8696a0; margin-bottom: 12px; line-height: 1.4; }
    .modal-input { width: 100%; background: #111b21; border: 1px solid #2a3942; border-radius: 8px; padding: 10px; color: #fff; font-size: 13px; margin-bottom: 14px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .btn-secondary { background: #2a3942; color: #e9edef; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
    .btn-primary { background: #00a884; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; }
  </style>
</head>
<body>
  <div class="app-container">
    <div class="chat-header">
      <div class="chat-header-info">
        <div class="avatar" id="headerAvatar">✨</div>
        <div class="header-details">
          <h1>${SALON_CONFIG.name}</h1>
          <p><span class="status-dot"></span> <span id="statusText">${SALON_CONFIG.assistantName} (Assistente Virtual)</span></p>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        <button id="modeToggleBtn" class="badge-status" onclick="toggleMode()">📱 Modo: Cliente</button>
        <a href="/agendar" class="badge-status" style="background:#ec489920; border-color:#ec4899; color:#f472b6; text-decoration:none;">🗓️ Horários</a>
        <a href="/dashboard" class="badge-status" style="background:#0284c720; border-color:#0284c7; color:#38bdf8; text-decoration:none;">📊 Dashboard</a>
      </div>
    </div>

    <div class="quick-actions" id="quickContainer">
      <!-- Injetado dinamicamente via JS conforme o modo selecionado -->
    </div>

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

    let currentMode = 'client'; // 'client' | 'owner'
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
        headerAvatar.innerText = '👑';
        headerAvatar.classList.add('admin');
        statusText.innerText = 'Janaína Ferreira (Proprietária / Admin)';
      } else {
        currentMode = 'client';
        modeToggleBtn.innerText = '📱 Modo: Cliente';
        modeToggleBtn.classList.remove('badge-admin');
        headerAvatar.innerText = '✨';
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

import os from 'os';

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
 * Evita que instâncias gratuitas (como Render Free) entrem em hibernação por inatividade HTTP.
 */
function startCloudKeepAlive(port: number) {
  const externalUrl = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  const targetUrl = externalUrl ? `${externalUrl}/health` : `http://127.0.0.1:${port}/health`;

  setInterval(async () => {
    try {
      await fetch(targetUrl);
    } catch {
      // Ignora falhas transitórias de rede no auto-ping
    }
  }, 10 * 60 * 1000); // A cada 10 minutos
}

/**
 * Função para iniciar o servidor com Fallback Automático de Porta se a porta estiver ocupada
 */
function startServer(port: number) {
  const localIp = getLocalNetworkIp();
  const server = app.listen(port, () => {
    console.log(`==================================================`);
    console.log(`🚀 Agente WhatsApp do Salão Rodando na porta ${port}`);
    console.log(`📍 Salão: ${SALON_CONFIG.name}`);
    console.log(`💬 Chat Web (PC): http://localhost:${port}/`);
    console.log(`📊 Dashboard (PC): http://localhost:${port}/dashboard`);
    console.log(`📱 Chat Web (Smartphone Wi-Fi): http://${localIp}:${port}/`);
    console.log(`📱 Dashboard (Smartphone Wi-Fi): http://${localIp}:${port}/dashboard`);
    console.log(`📍 Webhook WhatsApp: http://localhost:${port}/webhook/whatsapp`);
    console.log(`==================================================`);

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
