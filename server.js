/**
 * Arquivo: server.js
 * Localização: whatsapp_server/
 * Descrição: Micro-serviço de Conexão WhatsApp Baileys 24/7 para Render.com
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://tntgamehouse.com.br/admin/sistema/whatsapp_webhook.php';

let sock = null;
let latestQR = null;
let connectionStatus = 'disconnected';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            connectionStatus = 'qr_ready';
            console.log('--- NOVO QR CODE GERADO ---');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Conexão encerrada. Motivo:', lastDisconnect?.error, 'Reconectando:', shouldReconnect);
            connectionStatus = 'disconnected';
            latestQR = null;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000);
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
            if (msg.key.fromMe) continue; // Ignora mensagens enviadas por si mesmo

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid || remoteJid.includes('@g.us')) continue; // Ignora grupos

            const phone = remoteJid.replace('@s.whatsapp.net', '');
            const pushName = msg.pushName || 'Cliente';
            const textMessage = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

            if (!textMessage) continue;

            console.log(`📩 Mensagem recebida de ${pushName} (${phone}): ${textMessage}`);

            // Disparar Webhook para a Hostinger
            try {
                await axios.post(WEBHOOK_URL, {
                    telefone: phone,
                    nome_contato: pushName,
                    mensagem: textMessage
                });
            } catch (err) {
                console.error('❌ Erro ao enviar para o Webhook TNT:', err.message);
            }
        }
    });
}

// REST API Endpoints

// Status da Conexão
app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        has_qr: !!latestQR
    });
});

// Exibir QR Code na tela do navegador
app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: #10b981;">✅ WhatsApp TNT Game House Conectado!</h1>
                <p>O seu WhatsApp já está emparelhado e pronto para uso nos 3 notebooks!</p>
            </div>
        `);
    }

    if (!latestQR) {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>⏳ Gerando QR Code...</h1>
                <p>Por favor, recarregue a página em alguns segundos.</p>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </div>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 40px; background: #0f172a; color: white; min-height: 100vh;">
                <h1 style="color: #00a884;">📱 Escanear QR Code TNT Game House</h1>
                <p>Abra o WhatsApp no celular da loja > <strong>Aparelhos Conectados</strong> > <strong>Conectar Aparelho</strong></p>
                <div style="background: white; display: inline-block; padding: 20px; border-radius: 16px; margin-top: 20px;">
                    <img src="${qrImage}" style="width: 280px; height: 280px;" />
                </div>
                <p style="margin-top: 20px; font-size: 14px; color: #94a3b8;">A página recarrega automaticamente ao conectar.</p>
                <script>
                    setInterval(() => {
                        fetch('/status').then(r => r.json()).then(data => {
                            if (data.status === 'connected') location.reload();
                        });
                    }, 3000);
                </script>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Erro ao gerar imagem do QR Code');
    }
});

// Enviar Mensagem (Solicitado pelo PHP backend)
app.post('/send-message', async (req, res) => {
    const { phone, text } = req.body;

    if (!sock || connectionStatus !== 'connected') {
        return res.status(400).json({ success: false, message: 'WhatsApp não está conectado' });
    }

    if (!phone || !text) {
        return res.status(400).json({ success: false, message: 'Telefone e texto são obrigatórios' });
    }

    try {
        const formattedJid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(formattedJid, { text });
        console.log(`📤 Mensagem enviada para ${phone}: ${text}`);
        res.json({ success: true, message: 'Mensagem enviada com sucesso' });
    } catch (err) {
        console.error('❌ Erro ao enviar mensagem no WhatsApp:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor WhatsApp TNT rodando na porta ${PORT}`);
    connectToWhatsApp();
});
