# GestorRenta WhatsApp API

Backend para enviar mensajes de WhatsApp automáticamente desde GestorRenta usando Twilio.

---

## Despliegue en Render (gratis)

### Paso 1 — Subir a GitHub
1. Crea un repositorio nuevo en github.com (puede ser privado)
2. Sube estos archivos: `server.js`, `package.json`, `.gitignore`

### Paso 2 — Crear servicio en Render
1. Ve a [render.com](https://render.com) y crea cuenta gratis
2. New → **Web Service**
3. Conecta tu repositorio de GitHub
4. Configura:
   - **Name:** gestorrenta-api
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

### Paso 3 — Variables de entorno en Render
En la sección **Environment** agrega estas variables:

| Variable | Valor |
|---|---|
| `TWILIO_ACCOUNT_SID` | Tu Account SID de Twilio |
| `TWILIO_AUTH_TOKEN` | Tu Auth Token de Twilio |
| `TWILIO_WHATSAPP_NUMBER` | `whatsapp:+18205291917` |
| `API_SECRET` | Una clave secreta que tú elijas (ej. `gr-2026-abc123`) |

### Paso 4 — Copiar la URL
Render te da una URL como: `https://gestorrenta-api.onrender.com`
Esa URL va en la configuración de GestorRenta.

---

## Endpoints

### POST /send
Manda un mensaje a un número.
```json
Headers: { "x-api-secret": "tu-clave" }
Body: {
  "to": "6141234567",
  "message": "Hola, tu renta de $5,000 vence mañana."
}
```

### POST /send-bulk
Manda a varios números con mensaje personalizado por destinatario.
```json
Body: {
  "message": "Recordatorio de pago",
  "recipients": [
    { "to": "6141234567", "message": "Hola Juan, tu renta vence el 5." },
    { "to": "6149876543", "message": "Hola María, tu renta vence el 5." }
  ]
}
```

### GET /status/:sid
Verifica el estado de un mensaje enviado.

### GET /health
Verifica que el servidor está activo.

---

## Números soportados
- 10 dígitos → se asume México (+52)
- Con código de país → se usa tal cual
