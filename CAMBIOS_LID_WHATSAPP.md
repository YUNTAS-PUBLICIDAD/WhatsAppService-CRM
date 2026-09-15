# Cambios en Manejo de LIDs - WhatsApp Service

**Fecha:** 14/09/2026
**Archivo modificado:** `src/services/whatsapp.service.js`

---

## Problema anterior

Cuando el CRM enviaba un mensaje a un contacto identificado por su **LID (Linked Identity)**, el servicio no resolvía correctamente el LID a número telefónico. Si el contacto nunca había interactuado con la sesión actual, el mapa estaba vacío y el LID se usaba directamente, causando que el mensaje apareciera como "Esperando Mensaje" en WhatsApp.

## Solución implementada

Se creó un sistema de **mapeo bidireccional LID ↔ número telefónico** que se actualiza automáticamente desde múltiples fuentes de Baileys.

---

## Fuentes de mapeo

| Fuente | Evento | Cuándo se ejecuta |
|--------|--------|-------------------|
| Historial de contactos | `messaging-history.set` | Al conectar la sesión |
| Contactos nuevos | `contacts.upsert` | Cuando se agrega un contacto |
| Contactos actualizados | `contacts.update` | Cuando se modifica un contacto |
| Compartir teléfono | `chats.phoneNumberShare` | Cuando WhatsApp provee el mapeo directo |
| Validación de números | `onWhatsApp()` | Al validar un número telefónico |
| Envío de mensajes | `sendMessage()` resultado | Después de enviar un mensaje exitosamente |

---

## Flujo de resolución para LIDs

```
CRM envía a "xxx@lid"
  │
  ├─ 1. Buscar en lidToPhoneMap (memoria)
  │     → Si encuentra: envía a "51943383998@s.whatsapp.net" ✓
  │
  ├─ 2. Buscar en sock.store.contacts (store Baileys)
  │     → Si encuentra: envía a "51943383998@s.whatsapp.net" ✓
  │
  └─ 3. Fallback: enviar al LID directamente
        → Baileys puede enviar a @lid como último recurso
```

---

## Cambios detallados

### 1. Constructor — Nuevo mapa inverso

```javascript
this.lidToPhoneMap = new Map();   // LID → número (ya existía)
this.phoneToLidMap = new Map();   // número → LID (NUEVO)
```

### 2. initialize() — Listeners de eventos

```javascript
// Poblar mapa desde historial al conectar
this.sock.ev.on('messaging-history.set', async (history) => {
    this.populateLidMapFromContacts(history.contacts);
});

// Actualizar cuando se agregan contactos
this.sock.ev.on('contacts.upsert', async (contacts) => {
    this.populateLidMapFromContacts(contacts);
});

// Actualizar cuando se modifican contactos
this.sock.ev.on('contacts.update', async (contacts) => {
    this.populateLidMapFromContacts(contacts);
});

// Mapeo directo LID→número
this.sock.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
    if (lid && jid) {
        const phone = jid.split('@')[0];
        const lidBase = lid.split('@')[0] || lid;
        this.lidToPhoneMap.set(lidBase, phone);
        this.phoneToLidMap.set(phone, lidBase);
    }
});
```

### 3. Nuevo método populateLidMapFromContacts()

```javascript
populateLidMapFromContacts(contacts) {
    if (!contacts || !Array.isArray(contacts)) return;

    for (const contact of contacts) {
        const lid = contact.lid;
        const jid = contact.jid;

        if (lid && jid && jid.includes('@s.whatsapp.net')) {
            const phone = jid.split('@')[0];
            const lidBase = lid.split('@')[0] || lid;

            if (phone && lidBase) {
                this.lidToPhoneMap.set(lidBase, phone);
                this.phoneToLidMap.set(phone, lidBase);
            }
        }
    }
}
```

### 4. validateNumber() — Captura LID de Baileys

```javascript
if (result && result.exists) {
    // Capturar mapeo LID↔número si Baileys lo provee
    if (result.lid) {
        const phone = result.jid.split('@')[0];
        const lidBase = result.lid.split('@')[0] || result.lid;
        if (phone && lidBase) {
            this.lidToPhoneMap.set(lidBase, phone);
            this.phoneToLidMap.set(phone, lidBase);
        }
    }
    return result.jid;
}
```

### 5. getJidForSending() — Resolución mejorada

```javascript
if (this.isLid(phoneOrLid)) {
    const lidBase = this.extractJidBase(phoneOrLid);

    // 1. Buscar en mapa en memoria
    if (this.lidToPhoneMap.has(lidBase)) {
        const phone = this.lidToPhoneMap.get(lidBase);
        return `${phone}@s.whatsapp.net`;
    }

    // 2. Resolver desde store de contactos
    const resolvedPhone = await this.resolveLidToPhone(phoneOrLid);
    if (resolvedPhone) {
        return `${resolvedPhone}@s.whatsapp.net`;
    }

    // 3. Usar LID directamente
    return phoneOrLid;
}
```

### 6. sendMessage() — Captura LID del resultado

```javascript
const result = await this.sock.sendMessage(jid, { text });

// Capturar LID del resultado para futuras referencias
if (result.key?.remoteJid?.includes('@s.whatsapp.net') && result.key?.participant) {
    const phone = result.key.remoteJid.split('@')[0];
    const lid = result.key.participant;
    if (lid && lid.includes('@lid')) {
        const lidBase = lid.split('@')[0];
        if (phone && lidBase) {
            this.lidToPhoneMap.set(lidBase, phone);
            this.phoneToLidMap.set(phone, lidBase);
        }
    }
}
```

---

## Compatibilidad

- **Envío por número telefónico** (`51943383998`): sin cambios, funciona igual
- **Envío por JID completo** (`xxx@s.whatsapp.net`): sin cambios, funciona igual
- **Envío por LID** (`xxx@lid`): ahora resuelve correctamente a número real

## Requisitos

- Baileys v6.7.21 (ya instalado)
- No se requieren cambios en el CRM
- No se requieren cambios en la base de datos
