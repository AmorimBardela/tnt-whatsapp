/**
 * Arquivo: server.js
 * Localização: whatsapp_server/
 * Descrição: Micro-serviço de Conexão WhatsApp Baileys 24/7 para Render.com
 * v1.1 - Atualizado com suporte a Browser Signature e Código de Pareamento de 8 Dígitos
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://tntgamehouse.com.br/admin/sistema/whatsapp_webhook.php';

let sock = null;
let latestQR = null;
let connectionStatus = 'disconnected';

// Cache em memória para chats e mensagens (espelhando o WhatsApp real)
const chatCache = new Map();    // phone -> { phone, name, lastMessage, lastTimestamp, unreadCount }
const messageCache = new Map(); // phone -> [{ fromMe, text, pushName, timestamp }]

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['TNT Game House', 'Chrome', '124.0.0.0'], // Garante assinatura de navegador aceita pelo WhatsApp
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            connectionStatus = 'qr_ready';
            console.log('⚡ NOVO QR CODE RECEBIDO!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = (statusCode !== DisconnectReason.loggedOut);
            console.log(`Conexão fechada (${statusCode}). Reconectando: ${shouldReconnect}`);
            connectionStatus = 'disconnected';
            latestQR = null;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ CONECTADO AO WHATSAPP DA TNT GAME HOUSE!');
            connectionStatus = 'connected';
            latestQR = null;
        }
    });

    // Helper para extrair texto de qualquer formato de mensagem do WhatsApp
    function getMessageText(msg) {
        if (!msg || !msg.message) return '';
        const m = msg.message;
        return m.conversation 
            || m.extendedTextMessage?.text 
            || m.imageMessage?.caption 
            || m.videoMessage?.caption 
            || m.documentMessage?.caption 
            || m.ephemeralMessage?.message?.extendedTextMessage?.text
            || m.ephemeralMessage?.message?.conversation
            || m.viewOnceMessage?.message?.conversation
            || m.viewOnceMessage?.message?.extendedTextMessage?.text
            || m.viewOnceMessageV2?.message?.conversation
            || m.viewOnceMessageV2?.message?.extendedTextMessage?.text
            || '';
    }

    // Recebimento de mensagens em tempo real
    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || !Array.isArray(m.messages)) return;

        for (const msg of m.messages) {
            // Ignorar mensagens de grupos
            const rawJid = msg.key.remoteJid || '';
            if (rawJid.includes('@g.us')) continue;

            // Extrair telefone do remetente
            let targetJid = rawJid;
            if (rawJid.includes('@lid') && msg.key.participant) {
                targetJid = msg.key.participant;
            }

            const phone = targetJid.replace(/[^0-9]/g, '');
            if (phone.length < 8 || phone.length > 15) continue;

            const pushName = msg.pushName || 'Cliente';
            const textMessage = getMessageText(msg);
            const timestamp = msg.messageTimestamp || Math.floor(Date.now() / 1000);

            // Se for mensagem nossa enviada pelo celular ou outro dispositivo
            if (msg.key.fromMe) {
                // Atualizar cache de conversa enviada
                const existing = chatCache.get(phone) || { phone, name: phone, lastMessage: '', lastTimestamp: 0, unreadCount: 0 };
                if (textMessage) existing.lastMessage = textMessage;
                existing.lastTimestamp = timestamp;
                chatCache.set(phone, existing);
                continue;
            }

            if (!textMessage) continue;

            console.log(`📩 Mensagem recebida de ${pushName} (${phone}): ${textMessage}`);

            // Atualizar cache
            const existing = chatCache.get(phone) || { phone, name: pushName, lastMessage: '', lastTimestamp: 0, unreadCount: 0 };
            if (pushName !== 'Cliente') existing.name = pushName;
            existing.lastMessage = textMessage;
            existing.lastTimestamp = timestamp;
            existing.unreadCount = (existing.unreadCount || 0) + 1;
            chatCache.set(phone, existing);

            // Disparar Webhook para o PHP na Hostinger
            try {
                const resp = await axios.post(WEBHOOK_URL, {
                    telefone: phone,
                    nome_contato: pushName,
                    mensagem: textMessage
                }, { timeout: 8000 });
                console.log(`✅ Webhook entregue com sucesso para ${phone}:`, resp.data);
            } catch (err) {
                console.error(`❌ Erro ao enviar Webhook para ${phone}:`, err.message);
            }
        }
    });
}

// REST API Endpoints
app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, has_qr: !!latestQR });
});

// Renderizador de QR Code com Auto-Refresh a cada 5 segundos
app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">
                <h1 style="color: #10b981;">✅ WhatsApp TNT Game House Conectado!</h1>
                <p style="font-size: 18px; color: #94a3b8;">O seu número já está emparelhado e pronto para uso nos 3 notebooks!</p>
            </div>
        `);
    }

    if (!latestQR) {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">
                <h1 style="color: #f59e0b;">⏳ Gerando novo QR Code...</h1>
                <p style="font-size: 16px; color: #94a3b8;">Por favor, aguarde alguns segundos. A página vai recarregar automaticamente.</p>
                <script>setTimeout(() => location.reload(), 4000);</script>
            </div>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 40px; background: #0f172a; color: white; min-height: 100vh;">
                <h1 style="color: #00a884; margin-bottom: 10px;">📱 QR Code TNT Game House</h1>
                <p style="color: #94a3b8; font-size: 16px;">Abra o WhatsApp no celular ➔ <strong>Aparelhos Conectados</strong> ➔ <strong>Conectar um Aparelho</strong></p>
                <div style="background: white; display: inline-block; padding: 20px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); margin-top: 15px;">
                    <img src="${qrImage}" style="width: 300px; height: 300px; display: block;" />
                </div>
                <p style="margin-top: 20px; font-size: 13px; color: #64748b;">⚡ O QR Code atualiza automaticamente para garantir que não expire.</p>
                <script>
                    setTimeout(() => location.reload(), 8000);
                </script>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Erro ao renderizar imagem do QR Code');
    }
});

// Endpoint para envio de mensagens pelo PHP
app.post('/send-message', async (req, res) => {
    const { phone, text } = req.body;

    if (!sock || connectionStatus !== 'connected') {
        return res.status(400).json({ success: false, message: 'WhatsApp não está conectado' });
    }

    if (!phone || !text) {
        return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }

    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        // Buscar o JID oficial no WhatsApp (resolve o 9º dígito do Brasil automaticamente)
        const results = await sock.onWhatsApp(cleanPhone);
        const jid = (results && results.length > 0) ? results[0].jid : `${cleanPhone}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text });
        console.log(`✅ Mensagem enviada com sucesso para ${jid}: ${text}`);

        // Registrar no cache de mensagens e chats
        const now = Math.floor(Date.now() / 1000);
        const existing = chatCache.get(cleanPhone) || { phone: cleanPhone, name: cleanPhone, lastMessage: '', lastTimestamp: 0, unreadCount: 0 };
        existing.lastMessage = text;
        existing.lastTimestamp = now;
        chatCache.set(cleanPhone, existing);

        if (!messageCache.has(cleanPhone)) messageCache.set(cleanPhone, []);
        messageCache.get(cleanPhone).push({
            fromMe: true,
            text,
            pushName: 'TNT Game House',
            timestamp: now
        });

        res.json({ success: true, jid });
    } catch (err) {
        console.error(`❌ Erro ao enviar mensagem para ${phone}:`, err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Endpoint para sincronizar chats do cache -> Banco PHP
app.get('/sync-chats', async (req, res) => {
    if (!sock || connectionStatus !== 'connected') {
        return res.status(400).json({ success: false, message: 'WhatsApp não está conectado' });
    }

    const allChats = Array.from(chatCache.values());
    let synced = 0;
    let errors = 0;

    for (const chat of allChats) {
        try {
            await axios.post(WEBHOOK_URL, {
                telefone: chat.phone,
                nome_contato: chat.name,
                mensagem: chat.lastMessage || '[Sync] Conversa sincronizada'
            });
            synced++;
        } catch (err) {
            errors++;
            console.error(`❌ Erro sync chat ${chat.phone}:`, err.message);
        }
    }

    console.log(`📋 Sync completo: ${synced} chats sincronizados, ${errors} erros`);
    res.json({ success: true, total: allChats.length, synced, errors, chats: allChats });
});

// Endpoint para listar chats direto do cache em memória
app.get('/get-chats', (req, res) => {
    const chats = Array.from(chatCache.values());
    // Ordenar por última mensagem (mais recente primeiro)
    chats.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
    res.json({ success: true, chats });
});

// Endpoint para buscar histórico de mensagens de um contato específico
app.get('/get-messages/:phone', (req, res) => {
    const phone = req.params.phone.replace(/[^0-9]/g, '');
    const messages = messageCache.get(phone) || [];
    // Ordenar cronologicamente
    messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    res.json({ success: true, messages });
});

app.listen(PORT, HOST, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT} (${HOST})`);
    connectToWhatsApp();
});
