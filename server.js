/**
 * Arquivo: server.js
 * Localização: whatsapp_server/
 * Descrição: Micro-serviço de Conexão WhatsApp Baileys 24/7 para Render.com
 * v2.0 - Sincronização Completa de Histórico, Auto-Reconnect e Multi-Dispositivo
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
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://tntgamehouse.com.br/admin/sistema/whatsapp_webhook.php';

let sock = null;
let latestQR = null;
let connectionStatus = 'disconnected';

// Mapas de cache local
const contactsMap = new Map(); // jid/phone -> name
const chatsMap = new Map();    // phone -> { phone, name, lastMessage, timestamp, unreadCount }

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

// Helper para enviar lote de histórico para o webhook PHP
async function sendHistoryToWebhook(chatsArray, messagesArray) {
    if (!chatsArray.length && !messagesArray.length) return;
    try {
        console.log(`📤 Enviando histórico para o Webhook PHP (${chatsArray.length} chats, ${messagesArray.length} msgs)...`);
        const resp = await axios.post(WEBHOOK_URL, {
            action: 'history_sync',
            chats: chatsArray,
            messages: messagesArray
        }, { timeout: 15000 });
        console.log('✅ Histórico sincronizado com sucesso no MySQL:', resp.data);
    } catch (err) {
        console.error('❌ Erro ao enviar histórico para o Webhook:', err.message);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`⚡ Iniciando Baileys v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['TNT Game House', 'Chrome', '124.0.0.0'],
        syncFullHistory: true, // Sincroniza histórico e conversas existentes ao conectar
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            connectionStatus = 'qr_ready';
            console.log('⚡ NOVO QR CODE GERADO E PRONTO PARA ESCANEAR!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = (statusCode !== DisconnectReason.loggedOut);
            console.log(`⚠️ Conexão fechada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`);
            connectionStatus = 'disconnected';
            latestQR = null;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ WHATSAPP CONECTADO COM SUCESSO!');
            connectionStatus = 'connected';
            latestQR = null;
        }
    });

    // 1. Sincronização de Contatos do WhatsApp
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            const id = c.id || '';
            const phone = id.replace(/[^0-9]/g, '');
            const name = c.notify || c.verifiedName || c.name || '';
            if (phone && name) {
                contactsMap.set(phone, name);
                contactsMap.set(id, name);
            }
        }
    });

    // 2. Sincronização de Histórico Completo ao Conectar
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        console.log(`📦 Histórico recebido do WhatsApp: ${chats?.length || 0} chats, ${contacts?.length || 0} contatos, ${messages?.length || 0} msgs`);

        if (contacts && Array.isArray(contacts)) {
            for (const c of contacts) {
                const id = c.id || '';
                const phone = id.replace(/[^0-9]/g, '');
                const name = c.notify || c.verifiedName || c.name || '';
                if (phone && name) {
                    contactsMap.set(phone, name);
                    contactsMap.set(id, name);
                }
            }
        }

        const syncChats = [];
        const syncMessages = [];

        if (chats && Array.isArray(chats)) {
            for (const ch of chats) {
                const jid = ch.id || '';
                if (jid.includes('@g.us') || jid.includes('@newsletter')) continue;

                const phone = jid.replace(/[^0-9]/g, '');
                if (phone.length < 8 || phone.length > 15) continue;

                const name = ch.name || contactsMap.get(phone) || ch.notify || phone;
                const timestamp = ch.conversationTimestamp ? Number(ch.conversationTimestamp) : Math.floor(Date.now() / 1000);
                const unread = Number(ch.unreadCount || 0);

                syncChats.push({
                    telefone: phone,
                    nome: name,
                    timestamp: timestamp,
                    unread_count: unread,
                    ultima_mensagem: ''
                });

                chatsMap.set(phone, { phone, name, timestamp, unread });
            }
        }

        if (messages && Array.isArray(messages)) {
            for (const m of messages) {
                const rawJid = m.key.remoteJid || '';
                if (rawJid.includes('@g.us')) continue;

                const phone = rawJid.replace(/[^0-9]/g, '');
                if (phone.length < 8 || phone.length > 15) continue;

                const text = getMessageText(m);
                if (!text) continue;

                const timestamp = m.messageTimestamp ? Number(m.messageTimestamp) : Math.floor(Date.now() / 1000);
                const pushName = m.pushName || contactsMap.get(phone) || 'Cliente';

                syncMessages.push({
                    telefone: phone,
                    texto: text,
                    fromMe: !!m.key.fromMe,
                    pushName: pushName,
                    timestamp: timestamp
                });

                // Atualizar última mensagem do chat correspondente
                const foundChat = syncChats.find(c => c.telefone === phone);
                if (foundChat && (!foundChat.ultima_mensagem || timestamp >= foundChat.timestamp)) {
                    foundChat.ultima_mensagem = text;
                    foundChat.timestamp = timestamp;
                }
            }
        }

        // Ordenar chats por data mais recente
        syncChats.sort((a, b) => b.timestamp - a.timestamp);

        // Enviar para o banco MySQL via Webhook
        await sendHistoryToWebhook(syncChats.slice(0, 100), syncMessages.slice(-300));
    });

    // 3. Recebimento de Mensagens em Tempo Real
    sock.ev.on('messages.upsert', async (m) => {
        if (!m.messages || !Array.isArray(m.messages)) return;

        for (const msg of m.messages) {
            const rawJid = msg.key.remoteJid || '';
            if (rawJid.includes('@g.us') || rawJid.includes('@newsletter')) continue;

            let targetJid = rawJid;
            if (rawJid.includes('@lid') && msg.key.participant) {
                targetJid = msg.key.participant;
            }

            const phone = targetJid.replace(/[^0-9]/g, '');
            if (phone.length < 8 || phone.length > 15) continue;

            if (!textMessage) continue;

            const isFromMe = !!msg.key.fromMe;
            console.log(`📩 Mensagem (${isFromMe ? 'Enviada pelo Celular' : 'Recebida'}) ${pushName} (${phone}): ${textMessage}`);

            // Disparar Webhook para o PHP na Hostinger
            try {
                const resp = await axios.post(WEBHOOK_URL, {
                    telefone: phone,
                    nome_contato: pushName,
                    mensagem: textMessage,
                    fromMe: isFromMe
                }, { timeout: 8000 });
                console.log(`✅ Webhook entregue para ${phone}:`, resp.data);
            } catch (err) {
                console.error(`❌ Erro ao enviar Webhook para ${phone}:`, err.message);
            }
        }
    });
}

// Endpoint para reiniciar sessão e forçar novo QR Code com download de histórico
const fs = require('fs');
app.get('/reset-session', async (req, res) => {
    try {
        if (sock) {
            try { await sock.logout(); } catch(e) {}
            sock = null;
        }
        if (fs.existsSync('baileys_auth_info')) {
            fs.rmSync('baileys_auth_info', { recursive: true, force: true });
        }
        latestQR = null;
        connectionStatus = 'disconnected';
        setTimeout(connectToWhatsApp, 1000);
        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">
                <h1 style="color: #10b981;">🔄 Sessão Reiniciada!</h1>
                <p style="color: #94a3b8; font-size: 16px;">O servidor vai gerar um novo QR Code para puxar o histórico completo do seu WhatsApp.</p>
                <div style="margin-top: 30px;">
                    <a href="/qr" style="background: #00a884; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Escanear Novo QR Code 📱</a>
                </div>
            </div>
        `);
    } catch(err) {
        res.status(500).send('Erro ao reiniciar sessão: ' + err.message);
    }
});

// REST API Endpoints
app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, has_qr: !!latestQR });
});

// Renderizador de QR Code
app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">
                <h1 style="color: #10b981;">✅ WhatsApp TNT Game House Conectado!</h1>
                <p style="font-size: 18px; color: #94a3b8;">O seu número já está emparelhado e pronto para uso nos 3 notebooks!</p>
                <div style="margin-top: 30px;">
                    <a href="https://tntgamehouse.com.br/admin/sistema/whatsapp_chat.php" style="background: #00a884; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Abrir Painel de Atendimento 🚀</a>
                </div>
            </div>
        `);
    }

    if (!latestQR) {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">
                <h1 style="color: #f59e0b;">⏳ Gerando novo QR Code...</h1>
                <p style="font-size: 16px; color: #94a3b8;">Por favor, aguarde alguns segundos. A página vai recarregar automaticamente.</p>
                <script>setTimeout(() => location.reload(), 3000);</script>
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
                <script>setTimeout(() => location.reload(), 6000);</script>
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
        res.json({ success: true, jid });
    } catch (err) {
        console.error(`❌ Erro ao enviar mensagem para ${phone}:`, err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT} (${HOST})`);
    connectToWhatsApp();
});
