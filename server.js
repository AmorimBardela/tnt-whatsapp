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

    // Recebimento de mensagens em tempo real
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('@lid')) continue;

            const phone = remoteJid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
            if (phone.length > 15 || phone.length < 8) continue;

            const pushName = msg.pushName || 'Cliente';
            const textMessage = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

            if (!textMessage) continue;

            console.log(`📩 Mensagem de ${pushName} (${phone}): ${textMessage}`);

            try {
                await axios.post(WEBHOOK_URL, {
                    telefone: phone,
                    nome_contato: pushName,
                    mensagem: textMessage
                });
            } catch (err) {
                console.error('❌ Erro no Webhook:', err.message);
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
