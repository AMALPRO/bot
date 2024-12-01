const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

const CONFIG = {
    OWNERS: ['+917356008536'],
    MAX_RECONNECT_ATTEMPTS: 5,
    RECONNECT_DELAY: 5000
};

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        const sock = makeWASocket({
            logger: pino({ level: 'warn' }),
            printQRInTerminal: true,
            auth: state,
            browser: ['WhatsApp Bot', 'Chrome', '20.0.0'],
            connectTimeoutMs: 60000,
            maxRetries: CONFIG.MAX_RECONNECT_ATTEMPTS,
            retryRequestDelayMs: CONFIG.RECONNECT_DELAY,
            defaultQueryTimeoutMs: 60000,
            generateHighQualityLinkPreview: false, // Disable to reduce errors
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('QR Code Generated. Please scan.');
                const qrCodeImage = await QRCode.toDataURL(qr);
                // Optionally store or process qr code
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error instanceof Boom 
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                
                console.log('Connection closed. Reconnecting:', shouldReconnect);
                
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, CONFIG.RECONNECT_DELAY);
                } else {
                    console.log('Permanent disconnection. Manual intervention needed.');
                }
            } else if (connection === 'open') {
                console.log('Bot connected successfully!');
                console.log('Bot User:', sock.user);
                
                // Optional: Send startup message to owner
                try {
                    await sock.sendMessage(`${CONFIG.OWNERS[0]}@s.whatsapp.net`, { 
                        text: '🤖 Bot is online and ready!' 
                    });
                } catch (error) {
                    console.error('Startup message failed:', error);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('error', (err) => {
            console.error('Socket Error:', err);
        });

        return sock;
    } catch (error) {
        console.error('Connection Error:', error);
        setTimeout(connectToWhatsApp, CONFIG.RECONNECT_DELAY);
    }
}

// Global error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

connectToWhatsApp();
