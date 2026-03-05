const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// ── Credenciales desde variables de entorno ──────────────────
const ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER  = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+18205291917';
const API_SECRET   = process.env.API_SECRET || 'gestorrenta-secret';

// ── Content SIDs de plantillas aprobadas ────────────────────
const TEMPLATE_RECORDATORIO = 'HX931102595a26857098874f45b3a2b8d7';
const TEMPLATE_ATRASADO     = 'HX5ea3edefb691731a0e20ab7be110b35f';

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

function authMiddleware(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!secret || secret !== API_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

function formatNumber(num) {
  const digits = num.replace(/\D/g, '');
  if (digits.length === 10) return `whatsapp:+52${digits}`;
  if (digits.length > 10)   return `whatsapp:+${digits}`;
  return null;
}

// ── POST /send-recordatorio ── Recordatorio de pago ──────────
// Body: { to, nombre, monto, mes, diaVencimiento, propiedad }
app.post('/send-recordatorio', authMiddleware, async (req, res) => {
  try {
    const { to, nombre, monto, mes, diaVencimiento, propiedad } = req.body;
    if (!to || !nombre) return res.status(400).json({ error: 'Faltan campos' });

    const toFormatted = formatNumber(to);
    if (!toFormatted) return res.status(400).json({ error: 'Número inválido: ' + to });

    const result = await client.messages.create({
      from: FROM_NUMBER,
      to:   toFormatted,
      contentSid: TEMPLATE_RECORDATORIO,
      contentVariables: JSON.stringify({
        "1": nombre        || '',
        "2": monto         || '',
        "3": mes           || '',
        "4": diaVencimiento|| '',
        "5": propiedad     || '',
      }),
    });

    res.json({ success: true, sid: result.sid, status: result.status });
  } catch (e) {
    console.error('[/send-recordatorio]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send-atrasado ── Pago atrasado ─────────────────────
// Body: { to, nombre, monto, mes, saldo, propiedad }
app.post('/send-atrasado', authMiddleware, async (req, res) => {
  try {
    const { to, nombre, monto, mes, saldo, propiedad } = req.body;
    if (!to || !nombre) return res.status(400).json({ error: 'Faltan campos' });

    const toFormatted = formatNumber(to);
    if (!toFormatted) return res.status(400).json({ error: 'Número inválido: ' + to });

    const result = await client.messages.create({
      from: FROM_NUMBER,
      to:   toFormatted,
      contentSid: TEMPLATE_ATRASADO,
      contentVariables: JSON.stringify({
        "1": nombre   || '',
        "2": monto    || '',
        "3": mes      || '',
        "4": saldo    || '',
        "5": propiedad|| '',
      }),
    });

    res.json({ success: true, sid: result.sid, status: result.status });
  } catch (e) {
    console.error('[/send-atrasado]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send-bulk ── Envío masivo (detecta tipo automático) ─
// Body: { recipients: [{ to, nombre, monto, mes, saldo, diaVencimiento, propiedad, tipo }] }
// tipo: 'recordatorio' | 'atrasado'
app.post('/send-bulk', authMiddleware, async (req, res) => {
  try {
    const { recipients } = req.body;
    if (!recipients || !Array.isArray(recipients)) {
      return res.status(400).json({ error: 'Falta recipients[]' });
    }

    const results = [];
    for (const r of recipients) {
      const toFormatted = formatNumber(r.to);
      if (!toFormatted) {
        results.push({ to: r.to, success: false, error: 'Número inválido' });
        continue;
      }
      try {
        const isAtrasado = r.tipo === 'atrasado';
        const result = await client.messages.create({
          from: FROM_NUMBER,
          to:   toFormatted,
          contentSid: isAtrasado ? TEMPLATE_ATRASADO : TEMPLATE_RECORDATORIO,
          contentVariables: JSON.stringify(isAtrasado ? {
            "1": r.nombre   || '',
            "2": r.monto    || '',
            "3": r.mes      || '',
            "4": r.saldo    || '',
            "5": r.propiedad|| '',
          } : {
            "1": r.nombre          || '',
            "2": r.monto           || '',
            "3": r.mes             || '',
            "4": r.diaVencimiento  || '',
            "5": r.propiedad       || '',
          }),
        });
        results.push({ to: r.to, success: true, sid: result.sid, status: result.status });
      } catch (e) {
        results.push({ to: r.to, success: false, error: e.message });
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    const sent   = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    res.json({ success: true, sent, failed, results });
  } catch (e) {
    console.error('[/send-bulk]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /status/:sid ─────────────────────────────────────────
app.get('/status/:sid', authMiddleware, async (req, res) => {
  try {
    const msg = await client.messages(req.params.sid).fetch();
    res.json({ sid: msg.sid, status: msg.status, to: msg.to, errorCode: msg.errorCode, errorMessage: msg.errorMessage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /health ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'GestorRenta WhatsApp API', from: FROM_NUMBER, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GestorRenta WhatsApp API en puerto ${PORT}`);
  if (!ACCOUNT_SID) console.warn('⚠️  TWILIO_ACCOUNT_SID no configurado');
  if (!AUTH_TOKEN)  console.warn('⚠️  TWILIO_AUTH_TOKEN no configurado');
});
