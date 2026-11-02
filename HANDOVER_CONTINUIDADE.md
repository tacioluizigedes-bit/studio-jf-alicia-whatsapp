# 📦 Guia de Continuidade & Backup — Studio JF Lash e Designer (Alícia WhatsApp 24/7)

**Data do Backup:** 02/11/2026  
**Último Commit Sincronizado:** `20a7e87` (`main`)

---

## 🌐 1. Endereços de Produção e Repositórios

- **Repositório Principal (Código-Fonte):** `https://github.com/tacioluizigedes-bit/studio-jf-alicia-whatsapp.git` (branch `main`)
- **Cofre Privado de Persistência 24/7 (Sessão WhatsApp + Banco SQLite + Catálogo):** `https://github.com/tacioluizigedes-bit/studio-jf-alicia-vault.git`
- **Autor Git Padrão:** `tacioluizigedes-bit <tacioluiz.igedes@gmail.com>`
- **Servidor em Produção (Render):** `https://studio-jf-alicia-whatsapp.onrender.com`
  - 📊 **Dashboard Operacional:** `https://studio-jf-alicia-whatsapp.onrender.com/dashboard`
  - 🗓️ **Página de Agendamento Online das Clientes:** `https://studio-jf-alicia-whatsapp.onrender.com/agendar`
  - 🔑 **Central de Conexão Permanente 24/7 (Código de 8 Dígitos / QR Code):** `https://studio-jf-alicia-whatsapp.onrender.com/qr`
  - 💬 **Simulador Web da Alícia:** `https://studio-jf-alicia-whatsapp.onrender.com/chat`
- **Render Deploy Hook (Disparo de Deploy via POST):**
  - `https://api.render.com/deploy/srv-dbgvaketlv9c73dfp9d0?key=wU_QeTQ6UsY`

---

## 📱 2. Números Oficiais Configurados

- **WhatsApp Comercial (Alícia):** `5521960003154`
- **WhatsApp Pessoal / Admin (Janaína Ferreira):** `5521993826303`
- **Chave PIX Oficial:** `21960003154`

---

## ✅ 3. Tudo o que já foi implementado e está em produção

1. **Cofre na Nuvem 24/7 (`src/services/whatsappSessionVault.ts` & `src/services/whatsappConnection.ts`):**
   - Criptografia `AES-256-GCM` + compressão `GZIP` salvando automaticamente no repositório privado `studio-jf-alicia-vault`:
     - `baileys-session.enc`: Credenciais da sessão do WhatsApp (evita perda de conexão em novos deploys).
     - `database-sqlite.enc`: Banco SQLite (`dev.db`) com todos os agendamentos e bloqueios.
     - `catalog-services.enc`: Catálogo atualizado de procedimentos, tempos, preços e promoções (`services.json`).
   - Pareamento por **Código de 8 Dígitos sem câmera** na rota `/qr` (`POST /api/whatsapp/pairing-code`), além do QR Code tradicional.
2. **Identidade Visual Oficial (`src/views/logo-jf.png`):**
   - Logo dourada **JF Lash e Designer** com fundo em degradê radial preto suave aplicada em `/dashboard`, `/agendar`, `/qr` e `/chat`.
3. **Fluxo de Agendamento das Clientes (`src/views/booking.html`):**
   - **Passo 1:** Dados de Identificação (Nome Completo e Telefone/WhatsApp) solicitados logo no início.
   - **Passo 2:** Escolha de 1 ou mais procedimentos (com soma automática de tempos e valores em combos).
   - **Passo 3:** Escolha do Dia.
   - **Passo 4:** Escolha do Horário Livre.
4. **Inteligência Executiva da Alícia para a Janaína (`src/services/ownerControlService.ts` & `src/services/nlpEntityExtractor.ts`):**
   - Extração precisa de nome da cliente e procedimento mesmo em frases com hífen, ponto ou ordem invertida (ex: `"Marcar cliente dia 03 às 14hs - Fernanda limpeza de pele"`).
   - Cancelamento flexível por **Horário + Data** (`"Desmarcar o horário das 14hs dia 03/11"`), **apenas Horário** (usando o contexto da última data consultada) ou **Nome da Cliente**.
   - Prevenção automática contra duplicidade quando a Janaína reenvia o agendamento da mesma cliente em seguida para corrigir data, horário ou procedimento.
   - Ocultação imediata de agendamentos cancelados/desmarcados nas abas ativas do Dashboard (`Todos`, `Isentas`, `Confirmados`, `Pendentes`), mantendo-os apenas na aba `❌ Expirados / Cancelados` com botão `🗑️ Excluir`.
5. **Agenda Oficial Sincronizada para 03/11/2026 (Terça-Feira):**
   - `14:00 às 15:30` — **Fernanda** (*Manutenção Cílios Volume Brasileiro* — R$ 60,00) [Isenta]
   - `16:00 às 17:30` — **Larissa** (*Manutenção Cílios Volume Brasileiro* — R$ 60,00) [Isenta]
   - `18:30 às 20:00` — **Sandrinha** (*Manutenção Cílios Volume Brasileiro* — R$ 60,00) [Isenta]
   - `20:00 às 21:30` — **Michele** (*Manutenção Cílios Volume Brasileiro* — R$ 60,00) [Isenta]

---

## 🚀 4. Próximo Passo Planejado (Para Continuar de Onde Paramos)

Transformar a experiência do `/dashboard` no modelo inspirado no app **MinhaAgenda** (*Minha Agenda pra profissionais*):
1. **Seletor Horizontal de Dias no Topo (`Seg 02`, `Ter 03`, `Qua 04`...)** + alternador entre **Visão Diária (Régua Vertical de Horários de 30 em 30 min)** e **Visão Semanal**.
2. **Agendamento/Bloqueio em 1 Toque nos Horários Vagos:** clicar em qualquer linha de horário livre na régua diária (ou no botão flutuante `+`) abre um modal rápido para a Janaína marcar uma cliente ou bloquear o horário diretamente pelo painel.
3. **Gaveta de Ações Rápidas ao Tocar no Agendamento:** chamar no WhatsApp, remarcar horário/procedimento, dar baixa no pagamento ou desmarcar.
4. **Barra de Navegação Inferior (*Bottom Tab Bar*) + PWA Instalável:** abas *Agenda | Clientes | Financeiro | Procedimentos | Conexão 24/7* e manifesto PWA para instalar na tela inicial do iPhone/Android da Janaína com o ícone dourado **JF**.

---

## 💻 5. Como Restaurar e Rodar em Outro Computador

### Opção A — Clonando direto do GitHub
```bash
git clone https://github.com/tacioluizigedes-bit/studio-jf-alicia-whatsapp.git
cd studio-jf-alicia-whatsapp
npm install
npx prisma generate
Copy-Item prisma/seed-agenda.db prisma/dev.db
npm run build
npm test
npm run dev
```

### Opção B — Extraindo o Arquivo ZIP de Backup
```bash
# Extraia o arquivo studio-jf-alicia-backup-2026-11-02.zip, abra o terminal na pasta e execute:
npm install
npx prisma generate
npm run build
npm run dev
```
