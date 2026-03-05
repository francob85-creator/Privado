const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// ── Credenciales ─────────────────────────────────────────────
const ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER  = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+18205291917';
const API_SECRET   = process.env.API_SECRET || 'gestorrenta-secret';

// ── Firebase Admin ───────────────────────────────────────────
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// ── Content SIDs plantillas aprobadas ────────────────────────
const TEMPLATE_RECORDATORIO = 'HX931102595a26857098874f45b3a2b8d7';
const TEMPLATE_ATRASADO     = 'HX5ea3edefb691731a0e20ab7be110b35f';

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

// ── Auth middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (!secret || secret !== API_SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

function formatNumber(num) {
  const digits = (num || '').replace(/\D/g, '');
  if (digits.length === 10) return `whatsapp:+52${digits}`;
  if (digits.length > 10)   return `whatsapp:+${digits}`;
  return null;
}

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('es-MX');
}

const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function mesNombre(mesStr) {
  if (!mesStr) return '';
  const p = mesStr.split('-');
  return p.length === 2 ? MESES[parseInt(p[1])] + ' ' + p[0] : mesStr;
}

// ── Enviar con plantilla ─────────────────────────────────────
async function sendTemplate(to, tipo, vars) {
  const toFmt = formatNumber(to);
  if (!toFmt) throw new Error('Número inválido: ' + to);
  return await client.messages.create({
    from: FROM_NUMBER,
    to:   toFmt,
    contentSid: tipo === 'atrasado' ? TEMPLATE_ATRASADO : TEMPLATE_RECORDATORIO,
    contentVariables: JSON.stringify(tipo === 'atrasado' ? {
      "1": vars.nombre, "2": vars.monto, "3": vars.mes, "4": vars.saldo, "5": vars.propiedad
    } : {
      "1": vars.nombre, "2": vars.monto, "3": vars.mes, "4": vars.diaVencimiento, "5": vars.propiedad
    }),
  });
}

// ── Lógica principal: evaluar quién recibe mensaje hoy ───────
async function evaluarYEnviarRecordatorios(tenantId) {
  const hoy = new Date();
  const hoyStr = hoy.toISOString().slice(0, 10);
  const mesActual = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0');
  const diaHoy = hoy.getDate();

  // Leer datos del tenant desde Firestore
  const docRef = db.collection('tenants').doc(tenantId);
  const doc = await docRef.get();
  if (!doc.exists) throw new Error('Tenant no encontrado: ' + tenantId);

  const data = doc.data();
  const rentas   = data.rentas   || [];
  const clientes = data.clientes || [];
  const config   = data.configuracion || {};

  // Verificar que WA esté habilitado globalmente
  if (config.waGlobalEnabled === false) {
    return { skipped: true, reason: 'WhatsApp desactivado globalmente' };
  }

  const results = [];

  for (const renta of rentas) {
    if (!renta.clienteId) continue; // propiedad vacía
    const cliente = clientes.find(c => c.id === renta.clienteId);
    if (!cliente || !cliente.tel) continue;

    const wa = cliente.whatsapp;
    if (!wa || !wa.enabled) continue; // WA desactivado para este cliente

    const monto = Number(renta.monto) || 0;
    const diaCobro = Number(renta.dia || 1);
    const diasGracia = Number(config.diasGracia || 5);
    const diaVenc = diaCobro + diasGracia;

    // Calcular pagado este mes
    const pagadoMes = (renta.abonos || [])
      .filter(a => !a.pendientePago && a.mes === mesActual)
      .reduce((s, a) => s + Number(a.monto), 0);

    const saldoPendiente = Math.max(0, monto - pagadoMes);
    const isAtrasado = diaHoy > diaVenc && saldoPendiente > 0;
    const isParcial  = pagadoMes > 0 && saldoPendiente > 0;
    const isAlDia    = saldoPendiente === 0;

    if (isAlDia) continue; // ya pagó, no mandar nada

    // Verificar si ya se mandó mensaje hoy para este cliente+renta
    const sentKey = `wa_sent_${renta.id}_${hoyStr}`;
    const sentLog = data._waLog || {};
    if (sentLog[sentKey]) continue; // ya se mandó hoy

    let debeMandar = false;
    let tipo = 'recordatorio';

    if (isAtrasado || isParcial) {
      // Mensaje 2: pago atrasado
      if (wa.msg2Enabled) {
        // Mandar cada N días después del vencimiento
        const diasDespues = diaHoy - diaVenc;
        if (diasDespues >= 0 && diasDespues % (wa.msg2Days || 3) === 0) {
          debeMandar = true;
          tipo = 'atrasado';
        }
      }
    } else {
      // Mensaje 1: recordatorio previo
      const diasParaVencer = diaCobro - diaHoy;
      const diasConfig = wa.msg1Days || 3;
      if (wa.msg1When === 'antes_vencimiento' && diasParaVencer === diasConfig) {
        debeMandar = true;
        tipo = 'recordatorio';
      } else if (wa.msg1When === 'dia_cobro' && diaHoy === diaCobro) {
        debeMandar = true;
        tipo = 'recordatorio';
      }
    }

    if (!debeMandar) continue;

    // Armar variables del mensaje
    const vars = tipo === 'atrasado' ? {
      nombre: cliente.nombre,
      monto:  fmt(monto),
      mes:    mesNombre(mesActual),
      saldo:  fmt(saldoPendiente),
      propiedad: renta.nombre,
    } : {
      nombre: cliente.nombre,
      monto:  fmt(monto),
      mes:    mesNombre(mesActual),
      diaVencimiento: String(diaVenc),
      propiedad: renta.nombre,
    };

    try {
      const result = await sendTemplate(cliente.tel, tipo, vars);
      // Registrar que se mandó hoy
      await docRef.update({ [`_waLog.${sentKey}`]: true });
      results.push({ cliente: cliente.nombre, tel: cliente.tel, tipo, success: true, sid: result.sid });
    } catch (e) {
      results.push({ cliente: cliente.nombre, tel: cliente.tel, tipo, success: false, error: e.message });
    }

    // Delay entre mensajes
    await new Promise(r => setTimeout(r, 200));
  }

  return { sent: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };
}

// ── Obtener todos los tenants activos ────────────────────────
async function getAllTenants() {
  const snap = await db.collection('tenants').get();
  return snap.docs.map(d => d.id);
}

// ── POST /send-recordatorio ──────────────────────────────────
app.post('/send-recordatorio', authMiddleware, async (req, res) => {
  try {
    const { to, nombre, monto, mes, diaVencimiento, propiedad } = req.body;
    if (!to || !nombre) return res.status(400).json({ error: 'Faltan campos' });
    const result = await sendTemplate(to, 'recordatorio', { nombre, monto, mes, diaVencimiento, propiedad });
    res.json({ success: true, sid: result.sid, status: result.status });
  } catch (e) {
    console.error('[/send-recordatorio]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send-atrasado ──────────────────────────────────────
app.post('/send-atrasado', authMiddleware, async (req, res) => {
  try {
    const { to, nombre, monto, mes, saldo, propiedad } = req.body;
    if (!to || !nombre) return res.status(400).json({ error: 'Faltan campos' });
    const result = await sendTemplate(to, 'atrasado', { nombre, monto, mes, saldo, propiedad });
    res.json({ success: true, sid: result.sid, status: result.status });
  } catch (e) {
    console.error('[/send-atrasado]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send-bulk ──────────────────────────────────────────
app.post('/send-bulk', authMiddleware, async (req, res) => {
  try {
    const { recipients } = req.body;
    if (!recipients || !Array.isArray(recipients)) return res.status(400).json({ error: 'Falta recipients[]' });
    const results = [];
    for (const r of recipients) {
      try {
        const result = await sendTemplate(r.to, r.tipo || 'recordatorio', r);
        results.push({ to: r.to, success: true, sid: result.sid });
      } catch (e) {
        results.push({ to: r.to, success: false, error: e.message });
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    res.json({ success: true, sent: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /run-reminders ── Cron job endpoint ──────────────────
// Llamado automáticamente cada día a las 9am por el cron de Render
app.get('/run-reminders', async (req, res) => {
  // Verificar clave secreta via query param o header
  const secret = req.query.secret || req.headers['x-api-secret'];
  if (!secret || secret !== API_SECRET) return res.status(401).json({ error: 'No autorizado' });

  try {
    console.log('[Cron] Iniciando envío automático de recordatorios...');
    const tenants = await getAllTenants();
    console.log(`[Cron] Procesando ${tenants.length} tenants`);

    const allResults = [];
    for (const tenantId of tenants) {
      try {
        const result = await evaluarYEnviarRecordatorios(tenantId);
        allResults.push({ tenantId, ...result });
        console.log(`[Cron] ${tenantId}: ${result.sent || 0} enviados, ${result.failed || 0} fallidos`);
      } catch (e) {
        console.error(`[Cron] Error en tenant ${tenantId}:`, e.message);
        allResults.push({ tenantId, error: e.message });
      }
    }

    const totalSent   = allResults.reduce((s, r) => s + (r.sent || 0), 0);
    const totalFailed = allResults.reduce((s, r) => s + (r.failed || 0), 0);
    console.log(`[Cron] Completado: ${totalSent} enviados, ${totalFailed} fallidos`);

    res.json({ success: true, totalSent, totalFailed, tenants: allResults.length, details: allResults });
  } catch (e) {
    console.error('[Cron] Error general:', e.message);
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
  if (!process.env.FIREBASE_PROJECT_ID) console.warn('⚠️  FIREBASE_PROJECT_ID no configurado');
});
