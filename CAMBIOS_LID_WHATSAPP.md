# Cambios en Envío de Mensajes - WhatsApp Service

**Fecha:** 14/09/2026
**Archivos modificados:**
- `src/services/whatsapp.service.js`
- `src/controllers/whatsapp.controller.js`

---

## Problema

El endpoint `POST /api/whatsapp/send-message` solo funcionaba correctamente con **números telefónicos**. Si el CRM enviaba un **JID completo** (`xxx@s.whatsapp.net`) o un **LID** (`xxx@lid`), el flujo no lo manejaba correctamente porque asumía siempre un formato de número telefónico.

---

## Solución

Se modificó `getJidForSending()` para que detecte el tipo de input y lo maneje de forma correcta:

| Tipo de input | Ejemplo | Comportamiento |
|---------------|---------|----------------|
| Número telefónico | `51943383998` | Limpia dígitos → valida con `onWhatsApp()` → retorna `xxx@s.whatsapp.net` |
| JID completo | `51943383998@s.whatsapp.net` | Se usa directamente sin validación adicional |
| LID | `273404951326886@lid` | Se usa directamente (Baileys maneja internamente) |

---

## Cambios detallados

### 1. `getJidForSending()` — Simplificado y completo

**Antes:** Solo validaba números telefónicos. Si recibía un `@lid`, intentaba resolverlo con lógica compleja que fallaba.

**Ahora:** Detecta si el input ya contiene `@` y lo pasa directamente:

```javascript
async getJidForSending(phoneOrLid) {
    // Si ya es un JID completo (contiene @), usarlo directamente
    if (phoneOrLid.includes('@')) {
        return phoneOrLid;
    }

    // Es solo dígitos: número telefónico
    const numberId = phoneOrLid.replace(/\D/g, '');
    const jid = await this.validateNumber(`${numberId}@s.whatsapp.net`);
    if (jid) return jid;

    return null;
}
```

### 2. Controller — Detección de LID en `sendMessage()`

**Antes:** No diferenciaba entre número telefónico y LID.

**Ahora:** Detecta `@lid` y lo envía directamente a `getJidForSending()`:

```javascript
const isLid = phone.includes('@lid');
let jid;

if (isLid) {
    // LID: pasarlo directamente
    jid = await whatsappService.getJidForSending(phone);
} else {
    // Número: limpiar y validar
    const numberId = phone.replace(/\D/g, '');
    if (numberId.length < 10 || numberId.length > 15) {
        return res.status(400).json({ ... });
    }
    jid = await whatsappService.getJidForSending(numberId);
}
```

### 3. `validateNumber()` — Sin cambios

Se mantiene igual. Solo se usa para validar números telefónicos (no LIDs).

### 4. `sendMessage()` — Sin cambios

Se mantiene igual. Baileys recibe el JID (número o LID) y maneja el envío internamente.

---

## Flujo completo

```
CRM envía POST /api/whatsapp/send-message
  body: { phone: "...", message: "..." }
  │
  ├─ phone = "51943383998" (solo dígitos)
  │   → validateNumber("51943383998@s.whatsapp.net")
  │   → sendMessage("51943383998@s.whatsapp.net", text)
  │
  ├─ phone = "51943383998@s.whatsapp.net" (JID completo)
  │   → getJidForSending retorna tal cual
  │   → sendMessage("51943383998@s.whatsapp.net", text)
  │
  └─ phone = "273404951326886@lid" (LID)
      → getJidForSending retorna tal cual
      → sendMessage("273404951326886@lid", text)
```

---

## Compatibilidad

| Método de envío | Estado |
|-----------------|--------|
| Número telefónico (`51943383998`) | Funciona igual |
| JID (`xxx@s.whatsapp.net`) | **Ahora soportado** |
| LID (`xxx@lid`) | **Ahora soportado** |

---

## Cambios eliminados

Se implementó inicialmente un sistema de mapeo LID↔número con eventos de Baileys, pero se descartó porque causaba complejidad innecesaria y no resolvía el problema raíz. Se eliminaron:

- `phoneToLidMap` del constructor
- 4 listeners de eventos (`messaging-history.set`, `contacts.upsert`, `contacts.update`, `chats.phoneNumberShare`)
- Método `populateLidMapFromContacts()`
- Captura de LID en `validateNumber()` y `sendMessage()`
- Resolución compleja en `getJidForSending()` (mapa → store → onWhatsApp → fallback)

---

## Requisitos

- Baileys v6.7.21 (ya instalado)
- No se requieren cambios en el CRM
- No se requieren cambios en la base de datos
