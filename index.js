const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

// Enhanced logging configuration
const logger = pino({ 
    level: 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
        }
    }
});

// Configuration for multiple owners and bot settings
const CONFIG = {
    OWNERS: [
        '+917356008536'  // Ensure this is the correct full international number
    ],
    MAX_RECONNECT_ATTEMPTS: 10,
    RECONNECT_DELAY: 5000,
    CONNECTION_TIMEOUT: 60000
};

const CREDENTIALS_PATH = 'auth_info_baileys/creds.json';

// Create Express app for port binding
const app = express();
const PORT = process.env.PORT || 10000;

// Health check route
app.get('/', (req, res) => {
    res.send('WhatsApp Bot is running');
});

// Start Express server
const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});

let reconnectAttempts = 0;
let sock = null;

async function connectToWhatsApp() {
    try {
        // Verify credentials exist
        const credentialsExist = fs.existsSync(CREDENTIALS_PATH);
        logger.info(`Credentials exist: ${credentialsExist}`);

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        sock = makeWASocket({
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['WhatsApp Bot', 'Chrome', '20.0.0'],
            connectTimeoutMs: CONFIG.CONNECTION_TIMEOUT,
            maxRetries: 3,
            retryRequestDelayMs: 5000,
            defaultQueryTimeoutMs: 60000,
        });

        // Connection event handler with improved logging
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            logger.info(`Connection Update: ${connection || 'undefined'}`);

            if (connection === 'close') {
                const shouldReconnect = 
                    lastDisconnect?.error &&
                    (lastDisconnect.error instanceof Boom
                        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                        : true);
                
                logger.warn('Connection closed.', {
                    shouldReconnect,
                    errorCode: lastDisconnect?.error instanceof Boom 
                        ? lastDisconnect.error.output.statusCode 
                        : 'N/A'
                });
                
                if (shouldReconnect && reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    logger.info(`Reconnection attempt ${reconnectAttempts}`);
                    
                    setTimeout(() => {
                        connectToWhatsApp().catch(err => {
                            logger.error('Reconnection failed:', err);
                        });
                    }, CONFIG.RECONNECT_DELAY);
                } else {
                    logger.error('Maximum reconnection attempts reached. Manual intervention required.');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                reconnectAttempts = 0;
                logger.info('Bot is now connected!');
                logger.info(`Bot User ID: ${sock.user.id}`);
            }
        });

        // Credentials update handler
        sock.ev.on('creds.update', saveCreds);

        // Ensure auth directory exists
        if (!fs.existsSync('auth_info_baileys')) {
            fs.mkdirSync('auth_info_baileys');
        }

        return sock;
    } catch (error) {
        logger.error('Fatal error in WhatsApp connection:', error);
        
        if (reconnectAttempts < CONFIG.MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            logger.info(`Reconnection attempt ${reconnectAttempts}`);
            
            setTimeout(() => {
                connectToWhatsApp().catch(err => {
                    logger.error('Reconnection failed:', err);
                });
            }, CONFIG.RECONNECT_DELAY);
        } else {
            logger.error('Maximum reconnection attempts reached. Manual intervention required.');
            process.exit(1);
        }
        
        throw error;
    }
}

// Global error handling
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    // Attempt to restart the bot process
    connectToWhatsApp().catch(err => {
        logger.error('Failed to restart after uncaught exception:', err);
        process.exit(1);
    });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Attempt to restart the bot process
    connectToWhatsApp().catch(err => {
        logger.error('Failed to restart after unhandled rejection:', err);
        process.exit(1);
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully.');
    
    if (sock) {
        sock.logout().catch(err => {
            logger.error('Error during logout:', err);
        });
    }
    
    server.close(() => {
        logger.info('HTTP server closed.');
        process.exit(0);
    });
});

// Start the bot
connectToWhatsApp().catch(err => {
    logger.error('Initial connection error:', err);
    process.exit(1);
});
