const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// ── Credenciales desde variables de entorno ──────────────────
const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER   = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+18205291917';
const API_SECRET    = process.env.API_SECRET || 'gestorrenta-secret'; // clave para proteger el endpoint

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

// ── Middleware de autenticación ──────────────────────────────
function authMiddleware(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!secret || secret !== API_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ── Helpers ──────────────────────────────────────────────────
function formatNumber(num) {
  // Remove all non-digits
  const digits = num.replace(/\D/g, '');
  // If 10 digits, assume Mexico
  if (digits.length === 10) return `whatsapp:+52${digits}`;
  // If already has country code
  if (digits.length > 10) return `whatsapp:+${digits}`;
  return null;
}

// ── POST /send ── Manda un mensaje a un número ───────────────
app.post('/send', authMiddleware, async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: 'Faltan campos: to, message' });
    }

    const toFormatted = formatNumber(to);
    if (!toFormatted) {
      return res.status(400).json({ error: 'Número inválido: ' + to });
    }

    const result = await client.messages.create({
      from: FROM_NUMBER,
      to:   toFormatted,
      body: message,
    });

    res.json({
      success: true,
      sid:     result.sid,
      status:  result.status,
      to:      toFormatted,
    });

  } catch (e) {
    console.error('[/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send-bulk ── Manda a varios números a la vez ───────
app.post('/send-bulk', authMiddleware, async (req, res) => {
  try {
    const { recipients, message } = req.body;
    // recipients: [{ to: '6141234567', message?: 'override' }, ...]

    if (!recipients || !Array.isArray(recipients) || !message) {
      return res.status(400).json({ error: 'Faltan campos: recipients[], message' });
    }

    const results = [];
    for (const r of recipients) {
      const toFormatted = formatNumber(r.to);
      if (!toFormatted) {
        results.push({ to: r.to, success: false, error: 'Número inválido' });
        continue;
      }
      try {
        const msg = r.message || message; // allow per-recipient custom message
        const result = await client.messages.create({
          from: FROM_NUMBER,
          to:   toFormatted,
          body: msg,
        });
        results.push({ to: r.to, success: true, sid: result.sid, status: result.status });
      } catch (e) {
        results.push({ to: r.to, success: false, error: e.message });
      }
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const sent    = results.filter(r => r.success).length;
    const failed  = results.filter(r => !r.success).length;

    res.json({ success: true, sent, failed, results });

  } catch (e) {
    console.error('[/send-bulk]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /status/:sid ── Verifica estado de un mensaje ────────
app.get('/status/:sid', authMiddleware, async (req, res) => {
  try {
    const msg = await client.messages(req.params.sid).fetch();
    res.json({
      sid:    msg.sid,
      status: msg.status,   // queued, sent, delivered, read, failed
      to:     msg.to,
      body:   msg.body,
      errorCode: msg.errorCode,
      errorMessage: msg.errorMessage,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /health ── Verifica que el servidor está vivo ────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'GestorRenta WhatsApp API',
    from: FROM_NUMBER,
    timestamp: new Date().toISOString(),
  });
});

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GestorRenta WhatsApp API corriendo en puerto ${PORT}`);
  if (!ACCOUNT_SID) console.warn('⚠️  TWILIO_ACCOUNT_SID no configurado');
  if (!AUTH_TOKEN)  console.warn('⚠️  TWILIO_AUTH_TOKEN no configurado');
});
