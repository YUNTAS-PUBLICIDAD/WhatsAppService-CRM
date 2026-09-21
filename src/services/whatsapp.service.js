import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import logger from './logger.service.js';
import { WHATSAPP_CONFIG } from '../config/constants.js';

// Cache de la version de Baileys: evita pedirla por red en cada initialize()
let cachedBaileysVersion = null;
let cachedBaileysVersionAt = 0;

class WhatsAppService {
    constructor() {
        this.sock = null;
        this.currentQR = null;
        this.isReady = false;
        this.isInitializing = false;
        this.initializePromise = null;
        this.qrTimeout = null;
        this.eventEmitter = null;
        this.webhookUrl = null;
        this.receivedMessages = [];
        this.maxStoredMessages = 100;
        // Mapa en memoria para resolver LIDs a números de teléfono reales
        // Se pobla cuando se descubre la relación (ej: al recibir mensajes de números conocidos)
        this.lidToPhoneMap = new Map();
    }

    /**
     * Establece el emisor de eventos para Socket.IO
     */
    setEventEmitter(io) {
        this.eventEmitter = io;
    }

    /**
     * Emite evento de actualización de QR
     */
    emitQRUpdate(data) {
        if (this.eventEmitter) {
            this.eventEmitter.emit('qr-update', data);
        }
    }

    /**
     * Emite evento de mensaje entrante por Socket.IO
     */
    emitIncomingMessage(messageData) {
        if (this.eventEmitter) {
            this.eventEmitter.emit('incoming-message', messageData);
        }
    }

    /**
     * Envía mensaje entrante a webhook URL configurada
     */
    async sendToWebhook(messageData) {
        if (!this.webhookUrl) return;

        try {
            await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(messageData)
            });
        } catch (error) {
            logger.error('Error al enviar webhook', { error: error.message });
        }
    }

    /**
     * Almacena mensaje recibido en memoria
     */
    storeReceivedMessage(messageData) {
        this.receivedMessages.push(messageData);
        if (this.receivedMessages.length > this.maxStoredMessages) {
            this.receivedMessages.shift();
        }
    }

    /**
     * Configura URL del webhook para mensajes entrantes
     */
    setWebhookUrl(url) {
        this.webhookUrl = url;
        logger.info('Webhook URL configurada', { url });
    }

    /**
     * Obtiene mensajes recibidos recientes
     */
    getReceivedMessages(limit = 50) {
        return this.receivedMessages.slice(-limit);
    }

    /**
     * Obtiene la version de Baileys, usando cache de 24h para evitar
     * una petición de red en cada initialize() (esto sumaba latencia
     * cada vez que se pedía un QR nuevo o se reconectaba).
     */
    async getBaileysVersion() {
        const isCacheValid = cachedBaileysVersion &&
            (Date.now() - cachedBaileysVersionAt) < WHATSAPP_CONFIG.baileysVersionCacheMs;

        if (isCacheValid) {
            return cachedBaileysVersion;
        }

        try {
            const { version } = await fetchLatestBaileysVersion();
            cachedBaileysVersion = version;
            cachedBaileysVersionAt = Date.now();
            return version;
        } catch (error) {
            logger.warn('No se pudo obtener la última versión de Baileys, usando cache/fallback', { error: error.message });
            // Si falla la red pero ya teníamos una versión cacheada (aunque vencida), la reusamos
            // en vez de bloquear la inicialización del socket.
            if (cachedBaileysVersion) return cachedBaileysVersion;
            throw error;
        }
    }

    /**
     * Inicializa el cliente de WhatsApp
     */
    async initialize() {
        if (this.sock) {
            logger.warn('Cliente de WhatsApp ya existe, cancelando inicialización');
            return this.sock;
        }

        if (this.isInitializing && this.initializePromise) {
            logger.warn('Inicialización de WhatsApp ya en curso, reutilizando promesa existente');
            return this.initializePromise;
        }

        this.isInitializing = true;
        this.initializePromise = (async () => {
            try {
                // se crea la carpeta de autenticacion si no existe
                if (!fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                    fs.mkdirSync(WHATSAPP_CONFIG.authPath, { recursive: true });
                }

                const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_CONFIG.authPath);

                const version = await this.getBaileysVersion(); // version cacheada (evita red en cada init)

                this.sock = makeWASocket({ // socket de WhatsApp
                    version,
                    logger: pino({ level: 'silent' }),
                    printQRInTerminal: false,
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
                    },
                    browser: [WHATSAPP_CONFIG.sessionName, 'Chrome', '120.0.0'],
                    generateHighQualityLinkPreview: true,
                    syncFullHistory: false,
                    markOnlineOnConnect: false
                });

                // se manejan las actualizaciones de conexión
                this.sock.ev.on('connection.update', async (update) => {
                    await this.handleConnectionUpdate(update);
                });

                // se guarda las credenciales cuando cambien
                this.sock.ev.on('creds.update', saveCreds);

                // Escuchar mensajes entrantes
                this.sock.ev.on('messages.upsert', async (messageUpdate) => {
                    await this.handleIncomingMessages(messageUpdate);
                });

                return this.sock;
            } catch (error) {
                logger.error('Error al inicializar WhatsApp', { error: error.message });
                throw error;
            } finally {
                this.isInitializing = false;
                this.initializePromise = null;
            }
        })();

        return this.initializePromise;
    }

    /**
     * Maneja actualizaciones de conexión
     */
    async handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        // Manejar QR
        if (qr) {
            await this.handleQR(qr);
        }

        // Manejar cambios de conexión
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            logger.warn('Conexión cerrada (esto pasa a veces)', {
                reason: lastDisconnect?.error?.message,
                shouldReconnect
            });

            this.isReady = false;
            this.currentQR = null;

            this.emitQRUpdate({
                connectionStatus: 'disconnected',
                qrData: null
            });

            if (shouldReconnect) {
                logger.info('Reconectando...');
                this.sock = null;
                setTimeout(() => this.initialize(), 3000);
            } else {
                logger.info('Sesión cerrada por el usuario');
                this.sock = null;

                if (fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                    try {
                        const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                        for (const file of files) {
                            const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                            fs.rmSync(filePath, { recursive: true, force: true });
                        }
                    } catch (error) {
                        logger.warn('Error al eliminar contenido de auth_info, reintentando...', { error: error.message });
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                        for (const file of files) {
                            const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                            fs.rmSync(filePath, { recursive: true, force: true });
                        }
                    }
                }
            }
        } else if (connection === 'open') {
            logger.info('Cliente de WhatsApp listo');
            this.isReady = true;
            this.currentQR = null;
            clearTimeout(this.qrTimeout);

            this.emitQRUpdate({
                connectionStatus: 'connected',
                qrData: null
            });
        }
    }

    /**
     * Maneja la generación de QR
     */
    async handleQR(qr) {
        logger.info('Código QR generado - Escanea desde tu teléfono');

        try {
            this.currentQR = await QRCode.toDataURL(qr);

            console.log('\n========================================');
            console.log('  ESCANEA EL CÓDIGO QR CON TU TELÉFONO');
            console.log('========================================\n');
            qrcodeTerminal.generate(qr, { small: true }, (qrcode) => {
                console.log(qrcode);
            });
            console.log('========================================\n');

            clearTimeout(this.qrTimeout);
            this.qrTimeout = setTimeout(() => {
                if (!this.isReady) {
                    this.currentQR = null;
                }
            }, WHATSAPP_CONFIG.qrTimeout);

            this.emitQRUpdate({
                qrData: {
                    image: this.currentQR,
                    // Antes esto decía 60000ms fijo, pero Baileys refresca el QR real
                    // cada ~20s (ver WHATSAPP_CONFIG.qrDisplayDuration). Con 60s el
                    // frontend mostraba un contador que no coincidía con la realidad.
                    expiresAt: Date.now() + WHATSAPP_CONFIG.qrDisplayDuration,
                    createdAt: new Date().toISOString()
                },
                connectionStatus: 'qr-ready'
            });
        } catch (error) {
            logger.error('Error al generar código QR', { error: error.message });
        }
    }

    /**
     * Verifica si un JID es un LID (Linked Identity)
     */
    isLid(jid) {
        return jid && jid.endsWith('@lid');
    }

    /**
     * Extrae el identificador base de un JID (antes del @)
     */
    extractJidBase(jid) {
        if (!jid) return '';
        return jid.split('@')[0];
    }

    /**
     * Resuelve un LID a un número de teléfono real usando el store de Baileys.
     * Si no se puede resolver, retorna null.
     */
    async resolveLidToPhone(lid) {
        if (!this.isReady || !this.sock) {
            return null;
        }

        // Primero verificar el mapa en memoria
        const lidBase = this.extractJidBase(lid);
        if (this.lidToPhoneMap.has(lidBase)) {
            return this.lidToPhoneMap.get(lidBase);
        }

        // Intentar resolver usando el store de contactos de Baileys
        try {
            const store = this.sock.store;
            const contacts = store?.contacts || {};
            const contactKeys = Object.keys(contacts);

            logger.info('Intentando resolver LID desde store', {
                lid,
                lidBase,
                storeExists: !!store,
                storeKeys: store ? Object.keys(store).join(', ') : 'none',
                contactsInStore: contactKeys.length
            });

            // Log de los primeros contactos del store para diagnosticar
            if (contactKeys.length > 0) {
                const sampleKeys = contactKeys.slice(0, 3);
                for (const key of sampleKeys) {
                    const c = contacts[key];
                    logger.info('Contacto en store', {
                        key,
                        jid: c.jid,
                        lid: c.lid,
                        name: c.name || c.notify,
                        hasLid: !!c.lid,
                        allKeys: Object.keys(c).join(', ')
                    });
                }
            }
            
            // Buscar en los contactos por si hay una referencia cruzada
            for (const [jid, contact] of Object.entries(contacts)) {
                if (contact.lid === lidBase || jid.includes(lidBase)) {
                    const phone = this.extractJidBase(jid);
                    if (phone && !phone.includes('@')) {
                        this.lidToPhoneMap.set(lidBase, phone);
                        logger.info('LID resuelto a número desde store', { lid, phone });
                        return phone;
                    }
                }
            }
        } catch (error) {
            logger.warn('Error al resolver LID desde store', { error: error.message, lid });
        }

        return null;
    }

    /**
     * Obtiene el JID correcto para enviar un mensaje.
     * Si el input es un LID (@lid), lo usa directamente (conserva la sesión LID).
     * Si es un JID @s.whatsapp.net, lo valida y retorna.
     * Si es solo dígitos, lo trata como número telefónico.
     */
    async getJidForSending(phoneOrLid) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        // Si es un LID (@lid), enviar directamente al LID para mantener sesión consistente
        if (this.isLid(phoneOrLid)) {
            logger.info('Usando LID directamente para envío', { lid: phoneOrLid });
            return phoneOrLid;
        }

        // Si es un JID @s.whatsapp.net, validar que exista
        if (phoneOrLid.includes('@s.whatsapp.net')) {
            const jid = await this.validateNumber(phoneOrLid);
            if (jid) return jid;
            return null;
        }

        // Es solo dígitos: número telefónico
        const numberId = phoneOrLid.replace(/\D/g, '');
        const jid = await this.validateNumber(`${numberId}@s.whatsapp.net`);
        if (jid) return jid;

        return null;
    }

    /**
     * Maneja mensajes entrantes de WhatsApp
     */
    async handleIncomingMessages(messageUpdate) {
        const { messages, type } = messageUpdate;

        // Solo procesar mensajes nuevos
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignorar mensajes propios
            if (msg.key.fromMe) continue;

            // Ignorar mensajes de grupos
            if (msg.key.remoteJid.includes('@g.us')) continue;

            try {
                const remoteJid = msg.key.remoteJid;
                const isLid = this.isLid(remoteJid);
                const jidBase = this.extractJidBase(remoteJid);

                // Log detallado del mensaje entrante para diagnosticar LIDs
                logger.info('Mensaje entrante raw', {
                    remoteJid,
                    isLid,
                    jidBase,
                    fromMe: msg.key.fromMe,
                    participant: msg.key.participant,
                    pushName: msg.pushName,
                    senderPn: msg.key.senderPn || null,
                    senderLid: msg.key.senderLid || null,
                    messageKeys: msg.message ? Object.keys(msg.message).join(', ') : 'none',
                    keyKeys: Object.keys(msg.key).join(', ')
                });

                // Si es un LID, intentar resolver el número real para enviar al CRM
                let resolvedPhone = null;
                if (isLid) {
                    // Intentar obtener el teléfono desde senderPn del key
                    if (msg.key.senderPn) {
                        const phone = msg.key.senderPn.replace(/\D/g, '');
                        if (phone) {
                            this.lidToPhoneMap.set(jidBase, phone);
                            logger.info('LID mapeado desde senderPn del mensaje entrante', { lid: remoteJid, phone, senderPn: msg.key.senderPn });
                            resolvedPhone = phone;
                        }
                    }
                    if (!resolvedPhone) {
                        resolvedPhone = await this.resolveLidToPhone(remoteJid);
                    }
                }

                const messageData = {
                    messageId: msg.key.id,
                    from: remoteJid,
                    fromName: msg.pushName || 'Desconocido',
                    timestamp: msg.messageTimestamp,
                    text: this.extractMessageText(msg.message),
                    hasMedia: this.hasMedia(msg.message),
                    rawMessage: msg.message,
                    receivedAt: new Date().toISOString(),
                    // Campos adicionales para LIDs
                    isLid,
                    lidBase: isLid ? jidBase : null,
                    resolvedPhone
                };

                logger.info('Mensaje entrante recibido', {
                    from: messageData.from,
                    fromName: messageData.fromName,
                    text: messageData.text,
                    isLid,
                    resolvedPhone
                });

                // Almacenar en memoria
                this.storeReceivedMessage(messageData);

                // Emitir por Socket.IO
                this.emitIncomingMessage(messageData);

                // Enviar a webhook si está configurado
                await this.sendToWebhook(messageData);

            } catch (error) {
                logger.error('Error al procesar mensaje entrante', {
                    error: error.message,
                    messageId: msg.key.id
                });
            }
        }
    }

    /**
     * Extrae el texto del mensaje
     */
    extractMessageText(message) {
        if (!message) return '';

        if (message.conversation) return message.conversation;
        if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
        if (message.imageMessage?.caption) return message.imageMessage.caption;
        if (message.videoMessage?.caption) return message.videoMessage.caption;
        if (message.documentMessage?.caption) return message.documentMessage.caption;

        return '';
    }

    /**
     * Verifica si el mensaje tiene media
     */
    hasMedia(message) {
        if (!message) return false;

        return !!(
            message.imageMessage ||
            message.videoMessage ||
            message.audioMessage ||
            message.documentMessage ||
            message.stickerMessage
        );
    }

    /**
     * Valida si un número está registrado en WhatsApp
     */
    async validateNumber(numberId) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        try {
            const [result] = await this.sock.onWhatsApp(numberId);

            if (result && result.exists) {
                return result.jid;
            }

            return null;
        } catch (error) {
            logger.error('Error al validar número', { error: error.message, numberId });
            return null;
        }
    }

    /**
     * Envía un mensaje de texto
     */
    async sendMessage(jid, text) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        try {
            const result = await this.sock.sendMessage(jid, { text });

            const isLidJid = this.isLid(jid);
            logger.info('Mensaje de texto enviado', {
                jid,
                isLid: isLidJid,
                messageId: result?.key?.id,
                timestamp: result?.messageTimestamp,
                status: result?.status
            });
            return {
                success: true,
                messageId: result.key.id,
                chatId: jid,
                timestamp: result.messageTimestamp
            };
        } catch (error) {
            logger.error('Error al enviar mensaje de texto', { error: error.message, jid });
            throw error;
        }
    }

    /**
     * Envía una imagen con caption (texto)
     */
    async sendImage(jid, imageBuffer, caption = '', mimetype = null) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp no está conectado');
        }

        try {
            let message = {};
            const isGif = mimetype === 'image/gif';

            if (isGif) {
                // Para GIFs, usamos el formato de video con playback automático
                message = {
                    video: imageBuffer,
                    caption: caption || undefined,
                    gifPlayback: true
                };
            } else {
                // Para imágenes normales, volvemos a lo simple que funcionaba
                message = {
                    image: imageBuffer,
                    caption: caption || undefined
                };
            }

            const result = await this.sock.sendMessage(jid, message);
            logger.info('Mensaje enviado con éxito', { jid, isGif });
            return {
                success: true,
                messageId: result.key.id,
                chatId: jid,
                timestamp: result.messageTimestamp
            };
        } catch (error) {
            logger.error('Error al enviar imagen', { error: error.message, jid });
            throw error;
        }
    }

    /**
     * Reinicia la sesión de WhatsApp
     */
    async resetSession() {
        try {
            if (this.isInitializing) {
                throw new Error('Ya hay una operación en progreso');
            }

            this.isInitializing = true;

            await this.destroy(); // destruir recursos y cliente existente

            this.emitQRUpdate({
                connectionStatus: 'disconnected',
                qrData: null
            });

            // Esperar antes de eliminar archivos
            await new Promise(resolve => setTimeout(resolve, 1000));

            if (fs.existsSync(WHATSAPP_CONFIG.authPath)) {
                try {
                    const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                    for (const file of files) {
                        const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                        fs.rmSync(filePath, { recursive: true, force: true });
                    }
                } catch (error) {
                    logger.warn('Error al eliminar contenido de auth_info, reintentando...', { error: error.message });
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    const files = fs.readdirSync(WHATSAPP_CONFIG.authPath);
                    for (const file of files) {
                        const filePath = `${WHATSAPP_CONFIG.authPath}/${file}`;
                        fs.rmSync(filePath, { recursive: true, force: true });
                    }
                }
            }

            this.isInitializing = false;

            logger.info('Sesión reseteada exitosamente');

            // BUG encontrado: antes esto no volvía a llamar a initialize() en el
            // camino exitoso (solo lo hacía en el catch, si algo fallaba). Eso
            // dejaba el servicio sin socket y sin QR después de un reset,
            // y la web se quedaba en "Generando código..." para siempre porque
            // nunca llegaba un nuevo evento 'qr-update'.
            this.initialize().catch(error => {
                logger.error('Error al reinicializar después de resetear sesión', { error: error.message });
            });

            return true;
        } catch (error) {
            this.isInitializing = false;
            logger.error('Error al resetear sesión', { error: error.message });

            // Intentar inicializar
            try {
                await this.initialize();
            } catch (initError) {
                logger.error('Error al reinicializar después de fallo', { error: initError.message });
            }

            throw error;
        }
    }

    /**
     * Destruye el cliente y limpia recursos
     */
    async destroy() {
        if (this.sock) {
            this.sock.ev.removeAllListeners();

            if (this.isReady) {
                // Hay una sesión autenticada de verdad: intentamos cerrarla
                // formalmente, pero con timeout, porque logout() espera un
                // ACK del servidor de WhatsApp que a veces no llega.
                try {
                    await Promise.race([
                        this.sock.logout(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Timeout esperando ACK de logout')), WHATSAPP_CONFIG.logoutTimeoutMs)
                        )
                    ]);
                } catch (error) {
                    logger.warn('No se pudo cerrar sesión limpiamente (logout), forzando cierre del socket', { error: error.message });
                }
            } else {
                // Todavía estábamos en fase de QR (sin sesión autenticada):
                // no hay nada que "logout", así que solo cerramos el socket.
                // Antes esto igual llamaba a logout() y podía quedarse
                // esperando un ACK que nunca iba a llegar, retrasando
                // la generación del siguiente QR.
                logger.info('Cerrando socket sin sesión autenticada (solo fase de QR)');
            }

            try {
                this.sock.end(undefined);
            } catch (error) {
                logger.warn('Error al cerrar el socket', { error: error.message });
            }

            this.sock = null;
        }
        this.isReady = false;
        this.currentQR = null;
        this.initializePromise = null;
        clearTimeout(this.qrTimeout);
    }

    /**
     * Obtiene el estado actual
     */
    getStatus() {
        return {
            isConnected: this.isReady,
            hasActiveQR: !!this.currentQR,
            qrData: this.currentQR ? {
                image: this.currentQR,
                expiresAt: Date.now() + WHATSAPP_CONFIG.qrDisplayDuration
            } : null,
            connectionStatus: this.isReady ? 'connected' : (this.currentQR ? 'qr-ready' : 'disconnected')
        };
    }
}

export default new WhatsAppService();