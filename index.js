const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

// Configuration for multiple owners and bot settings
const CONFIG = {
    OWNERS: [
        '+917356008536'  // Ensure this is the correct full international number
    ],
    MAX_CONCURRENT_BROADCASTS: 3,
    BROADCAST_DELAY: 2000,
    RATE_LIMIT_DELAY: 5000,
    RATE_LIMIT_WINDOW: 5 * 60 * 1000,
    MAX_BROADCASTS_PER_WINDOW: 50,
    MESSAGE_TIMEOUT: 10000
};

const CREDENTIALS_PATH = 'auth_info_baileys/creds.json';

// Create Express app for port binding
const app = express();
const PORT = process.env.PORT || 3000;

// Global variables to store connection state
let globalSock = null;
let qrCode = null;

// Health check and QR code route
app.get('/', async (req, res) => {
    if (qrCode) {
        // If QR code is available, serve an HTML page with the QR code
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot QR Code</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        display: flex; 
                        flex-direction: column; 
                        align-items: center; 
                        justify-content: center; 
                        height: 100vh; 
                        margin: 0; 
                        background-color: #f0f0f0; 
                    }
                    #qr-code { 
                        max-width: 300px; 
                        margin-bottom: 20px; 
                    }
                    #status {
                        margin-top: 20px;
                        text-align: center;
                    }
                </style>
            </head>
            <body>
                <h1>Scan WhatsApp QR Code</h1>
                <img id="qr-code" src="${qrCode}" alt="WhatsApp QR Code">
                <div id="status">Waiting for QR code to be scanned...</div>
                <script>
                    // Implement QR code status polling
                    function checkConnectionStatus() {
                        fetch('/connection-status')
                            .then(response => response.json())
                            .then(data => {
                                if (data.connected) {
                                    document.getElementById('status').innerHTML = 'Connected! Bot is now running.';
                                    document.getElementById('qr-code').style.display = 'none';
                                }
                            })
                            .catch(error => {
                                console.error('Error checking connection status:', error);
                            });
                    }
                    
                    // Poll every 5 seconds
                    setInterval(checkConnectionStatus, 5000);
                </script>
            </body>
            </html>
        `);
    } else {
        res.send('WhatsApp Bot is running. Initializing connection...');
    }
});

// Connection status route
app.get('/connection-status', (req, res) => {
    res.json({ 
        connected: globalSock !== null,
        qrAvailable: qrCode !== null
    });
});

// Start Express server
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        const sock = makeWASocket({
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['WhatsApp Bot', 'Chrome', '20.0.0'],
            connectTimeoutMs: 60000,
            maxRetries: 5,
            retryRequestDelayMs: 5000,
            defaultQueryTimeoutMs: 60000,
            generateHighQualityLinkPreview: true,
            qrTimeout: 45000, // 45 seconds QR code timeout
        });

        // QR code generation
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Generate QR code if available
            if (qr) {
                qrCode = await QRCode.toDataURL(qr);
                console.log('QR Code Generated');
            }

            if (connection === 'close') {
                const shouldReconnect = 
                    lastDisconnect?.error && 
                    (lastDisconnect.error instanceof Boom 
                        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                        : true);
                
                console.log('Connection closed. Reconnecting:', shouldReconnect);
                
                // Reset global variables
                globalSock = null;
                qrCode = null;
                
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 1000);
                } else {
                    console.log('Connection permanently closed. Manual intervention required.');
                }
            } else if (connection === 'open') {
                console.log('Bot is now connected!');
                console.log('Bot User ID:', sock.user.id);
                
                // Store global socket
                globalSock = sock;
                qrCode = null;

                // Send message to owner
                try {
                    const ownerNumber = CONFIG.OWNERS[0];
                    await sock.sendMessage(ownerNumber + '@s.whatsapp.net', { 
                        text: `🤖 WhatsApp Bot successfully started!\n\nBot is now online and ready to use.\n\nCurrent Bot ID: ${sock.user.id}` 
                    });
                } catch (msgError) {
                    console.error('Error sending startup message:', msgError);
                }
            }
        });

        // Save credentials when they update
        sock.ev.on('creds.update', saveCreds);

        return sock;
    } catch (error) {
        console.error('Fatal error in WhatsApp connection:', error);
        // Attempt to reconnect after a delay
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Global error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Attempt to restart
    globalSock = null;
    qrCode = null;
    setTimeout(connectToWhatsApp, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Attempt to restart
    globalSock = null;
    qrCode = null;
    setTimeout(connectToWhatsApp, 1000);
});

// Start the bot
connectToWhatsApp().catch(err => {
    console.error('Initial connection error:', err);
});
