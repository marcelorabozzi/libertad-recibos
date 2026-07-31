const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const zlib = require('zlib');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Multer para almacenar archivos en memoria
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // Límite de 50MB
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Almacenamiento de sesiones con persistencia en archivo
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const map = new Map();
      for (const [key, val] of Object.entries(data)) {
        if (Date.now() < val.expiresAt) {
          map.set(key, val);
        }
      }
      return map;
    }
  } catch (error) {
    console.error('Error al cargar sesiones:', error);
  }
  return new Map();
}

function saveSessions(map) {
  try {
    const obj = {};
    for (const [key, val] of map.entries()) {
      if (Date.now() < val.expiresAt) {
        obj[key] = val;
      }
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (error) {
    console.error('Error al guardar sesiones:', error);
  }
}

const sessions = loadSessions();

// Helper para parsear cookies manualmente sin dependencias adicionales
function getSessionFromCookie(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').reduce((acc, c) => {
    const parts = c.trim().split('=');
    const key = parts[0];
    const val = parts.slice(1).join('=');
    acc[key] = val;
    return acc;
  }, {});

  const token = cookies['session_token'];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  // Verificar si la sesión expiró
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    saveSessions(sessions);
    return null;
  }

  return session;
}

// Middleware para requerir autenticación
function authRequired(req, res, next) {
  const session = getSessionFromCookie(req);
  if (!session) {
    return res.status(401).json({ error: 'Acceso denegado. Por favor inicia sesión.' });
  }
  req.user = session;
  next();
}

// Middleware para requerir rol root (admin)
function adminOnly(req, res, next) {
  if (req.user.role !== 'root') {
    return res.status(403).json({ error: 'Acceso denegado. Se requieren permisos de Administrador.' });
  }
  next();
}

// --- Helper de Configuración ---

function getConfig() {
  try {
    const configFile = path.join(__dirname, 'config.json');
    if (fs.existsSync(configFile)) {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  } catch (error) {
    console.error('Error al leer config.json:', error);
  }
  return { showConvertButton: true, showSignatureButton: true };
}

// Endpoint para obtener la configuración general
app.get('/api/config', (req, res) => {
  res.json(getConfig());
});

// Endpoint para obtener la versión del sistema
app.get('/api/version', (req, res) => {
  try {
    const versionFile = path.join(__dirname, 'version.json');
    if (fs.existsSync(versionFile)) {
      const versionData = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      return res.json(versionData);
    }
  } catch (error) {
    console.error('Error al leer version.json:', error);
  }
  res.status(500).json({ error: 'Error al obtener la versión del sistema' });
});

// --- Endpoints de Autenticación ---


// Obtener datos del usuario logueado
app.get('/api/me', (req, res) => {
  const session = getSessionFromCookie(req);
  if (session) {
    res.json({
      authenticated: true,
      username: session.username,
      role: session.role,
      displayName: session.displayName
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Endpoint de Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos.' });
  }

  try {
    const usersFile = path.join(__dirname, 'users.json');
    if (!fs.existsSync(usersFile)) {
      return res.status(500).json({ error: 'Configuración del servidor incompleta (falta users.json).' });
    }

    const usersData = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const user = usersData[username.toLowerCase()];

    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    // Crear sesión y guardar en disco
    const token = crypto.randomUUID();
    sessions.set(token, {
      username: username.toLowerCase(),
      role: user.role,
      displayName: user.displayName,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000 // Expira en 24h
    });
    saveSessions(sessions);

    // Enviar cookie HTTP-Only firma de seguridad
    res.setHeader('Set-Cookie', `session_token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`);
    res.json({
      success: true,
      username: username.toLowerCase(),
      role: user.role,
      displayName: user.displayName
    });
  } catch (error) {
    console.error('Error durante el login:', error);
    res.status(500).json({ error: 'Error del servidor: ' + error.message });
  }
});

// Endpoint de Logout
app.post('/api/logout', (req, res) => {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce((acc, c) => {
      const parts = c.trim().split('=');
      const key = parts[0];
      const val = parts.slice(1).join('=');
      acc[key] = val;
      return acc;
    }, {});

    const token = cookies['session_token'];
    if (token) {
      sessions.delete(token);
      saveSessions(sessions);
    }
  }

  // Eliminar la cookie seteando expiración en el pasado
  res.setHeader('Set-Cookie', 'session_token=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict');
  res.json({ success: true });
});

// --- Endpoints de Administración de Usuarios (Solo Root) ---

// Obtener lista completa de usuarios con sus claves
app.get('/api/admin/users', authRequired, adminOnly, (req, res) => {
  try {
    const usersFile = path.join(__dirname, 'users.json');
    const usersData = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

    const userList = Object.keys(usersData).map(username => ({
      username,
      displayName: usersData[username].displayName,
      role: usersData[username].role,
      password: usersData[username].password
    }));

    res.json(userList);
  } catch (error) {
    res.status(500).json({ error: 'Error al leer usuarios: ' + error.message });
  }
});

// Crear un nuevo usuario
app.post('/api/admin/users', authRequired, adminOnly, (req, res) => {
  const { username, password, displayName, role } = req.body;

  if (!username || !password || !displayName || !role) {
    return res.status(400).json({ error: 'Todos los campos son requeridos.' });
  }

  const normalizedUsername = username.trim().toLowerCase();
  if (normalizedUsername === '') {
    return res.status(400).json({ error: 'Nombre de usuario inválido.' });
  }

  try {
    const usersFile = path.join(__dirname, 'users.json');
    const usersData = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

    if (usersData[normalizedUsername]) {
      return res.status(400).json({ error: 'El usuario ya existe.' });
    }

    usersData[normalizedUsername] = {
      password,
      role,
      displayName
    };

    fs.writeFileSync(usersFile, JSON.stringify(usersData, null, 2), 'utf8');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al crear usuario: ' + error.message });
  }
});

// Cambiar contraseña de cualquier usuario (Admin)
app.put('/api/admin/users/:username/password', authRequired, adminOnly, (req, res) => {
  const { username } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'La nueva contraseña es requerida.' });
  }

  try {
    const usersFile = path.join(__dirname, 'users.json');
    const usersData = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const normalizedUsername = username.trim().toLowerCase();

    if (!usersData[normalizedUsername]) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    usersData[normalizedUsername].password = password;

    fs.writeFileSync(usersFile, JSON.stringify(usersData, null, 2), 'utf8');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar contraseña: ' + error.message });
  }
});

// Eliminar un usuario (Admin)
app.delete('/api/admin/users/:username', authRequired, adminOnly, (req, res) => {
  const { username } = req.params;
  const normalizedUsername = username.trim().toLowerCase();

  if (normalizedUsername === req.user.username) {
    return res.status(400).json({ error: 'No puedes eliminar tu propio usuario activo.' });
  }

  try {
    const usersFile = path.join(__dirname, 'users.json');
    const usersData = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

    if (!usersData[normalizedUsername]) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    delete usersData[normalizedUsername];

    fs.writeFileSync(usersFile, JSON.stringify(usersData, null, 2), 'utf8');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar usuario: ' + error.message });
  }
});

// --- Endpoint de Autoservicio de Contraseña (Cualquier usuario) ---

// Cambiar contraseña del usuario logueado
app.put('/api/users/me/password', authRequired, (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'La nueva contraseña es requerida.' });
  }

  try {
    const usersFile = path.join(__dirname, 'users.json');
    const usersData = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const username = req.user.username;

    if (!usersData[username]) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    usersData[username].password = password;

    fs.writeFileSync(usersFile, JSON.stringify(usersData, null, 2), 'utf8');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar tu propia contraseña: ' + error.message });
  }
});

// --- Lógica del Conversor PDF ---

// Función para transformar el PDF vertical a horizontal en tamaño A4 Landscape con recortes de márgenes
async function convertVerticalToHorizontal(pdfBuffer, options = {}) {
  const mode = options.mode || 'combine'; // 'combine' o 'split'
  const splitRatio = parseFloat(options.splitRatio) || 0.5;
  const margin = parseFloat(options.margin) !== undefined ? parseFloat(options.margin) : 14.17; // Margen de página de destino (~5mm)
  const drawDivider = options.drawDivider === 'true' || options.drawDivider === true;
  const onlyFirstPage = options.onlyFirstPage === 'true' || options.onlyFirstPage === true;

  // Recortes de los márgenes blancos del archivo original
  const cropTop = parseFloat(options.cropTop) || 0;
  const cropBottom = parseFloat(options.cropBottom) || 0;
  const cropLeft = parseFloat(options.cropLeft) || 0;
  const cropRight = parseFloat(options.cropRight) || 0;

  const srcDoc = await PDFDocument.load(pdfBuffer);
  const destDoc = await PDFDocument.create();
  const pages = srcDoc.getPages();

  // Caso especial: Una sola página en disposición vertical (para Firma)
  if (onlyFirstPage) {
    for (let i = 0; i < pages.length; i += 2) {
      const page = pages[i];
      const size = page.getSize();

      // Dimensiones fijas de A4 Portrait (vertical)
      const destWidth = 595.275;
      const destHeight = 841.89;

      const destPage = destDoc.addPage([destWidth, destHeight]);

      const availWidth = destWidth - 2 * margin;
      const availHeight = destHeight - 2 * margin;

      const effectiveWidth = size.width - cropLeft - cropRight;
      const effectiveHeight = size.height - cropTop - cropBottom;

      const scale_w = availWidth / effectiveWidth;
      const scale_h = availHeight / effectiveHeight;
      const scale = Math.min(scale_w, scale_h);

      const drawnWidth = effectiveWidth * scale;
      const drawnHeight = effectiveHeight * scale;

      const x = margin + (availWidth - drawnWidth) / 2;
      const y = margin + (availHeight - drawnHeight) / 2;

      const embeddedPage = await destDoc.embedPage(page, {
        left: cropLeft,
        bottom: cropBottom,
        right: size.width - cropRight,
        top: size.height - cropTop
      });

      destPage.drawPage(embeddedPage, {
        x,
        y,
        width: drawnWidth,
        height: drawnHeight
      });

      // Obtener configuración dinámica
      const config = getConfig();
      const sigConfig = config.signature || {};
      const empConfig = sigConfig.employee || {};

      const divConfig = sigConfig.divider || {};
      const boxConfig = sigConfig.box || {};

      let lineLengthVal = empConfig.lineLength !== undefined ? parseFloat(empConfig.lineLength) : 120;
      let lineXVal = empConfig.lineX !== undefined ? parseFloat(empConfig.lineX) : 255;
      let lineYVal = empConfig.lineY !== undefined ? parseFloat(empConfig.lineY) : 65;
      let textXVal = empConfig.textX !== undefined ? parseFloat(empConfig.textX) : 490;
      let textYVal = empConfig.textY !== undefined ? parseFloat(empConfig.textY) : 56;
      let fontSizeVal = empConfig.fontSize !== undefined ? parseFloat(empConfig.fontSize) : 7;
      let employeeText = empConfig.text || 'Firma Empleado';

      let vLineHeightVal = divConfig.height !== undefined ? parseFloat(divConfig.height) : 0;
      let vLineXVal = divConfig.x !== undefined ? parseFloat(divConfig.x) : 0;
      let vLineYVal = divConfig.y !== undefined ? parseFloat(divConfig.y) : 0;

      let boxWidthVal = boxConfig.width !== undefined ? parseFloat(boxConfig.width) : 0;
      let boxHeightVal = boxConfig.height !== undefined ? parseFloat(boxConfig.height) : 0;
      let boxXVal = boxConfig.x !== undefined ? parseFloat(boxConfig.x) : 0;
      let boxYVal = boxConfig.y !== undefined ? parseFloat(boxConfig.y) : 0;

      // Intentar detectar la posición Y dinámica del cuadro de firma original de la derecha
      let foundDynamicY = false;
      let absTextY = 56; // Valor base predeterminado de textY
      
      try {
        const contents = page.node.Contents();
        if (contents) {
          const ref = contents.size ? contents.get(0) : contents;
          const resolved = srcDoc.context.lookup(ref);
          if (resolved && (resolved.asUint8Array || resolved.getContentsString)) {
            const bytes = resolved.asUint8Array ? resolved.asUint8Array() : resolved.contents;
            if (bytes && bytes.length > 0) {
              let decompressed = bytes;
              if (bytes[0] === 0x78 && bytes[1] === 0x9c) {
                decompressed = zlib.inflateSync(Buffer.from(bytes));
              }
              const textContent = new TextDecoder('latin1').decode(decompressed);
              const searchStr = '(Firma Empleador)';
              const index = textContent.indexOf(searchStr);
              if (index !== -1) {
                const beforeText = textContent.substring(Math.max(0, index - 500), index);
                const tmRegex = /([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+Tm\s*$/;
                const tdRegex = /([0-9.-]+)\s+([0-9.-]+)\s+Td\s*$/;
                const lines = beforeText.split('\n');
                for (let j = lines.length - 1; j >= 0; j--) {
                  const line = lines[j].trim();
                  const tmMatch = line.match(tmRegex);
                  if (tmMatch) {
                    const yVal = parseFloat(tmMatch[6]);
                    absTextY = size.height + yVal;
                    foundDynamicY = true;
                    break;
                  }
                  const tdMatch = line.match(tdRegex);
                  if (tdMatch) {
                    const yVal = parseFloat(tdMatch[2]);
                    absTextY = size.height + yVal;
                    foundDynamicY = true;
                    break;
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('Error al detectar Y dinámica para firma:', e);
      }

      if (foundDynamicY) {
        // La Y dinámica base de la firma original en el espacio recortado es (absTextY - cropBottom)
        const baseDynamicY = absTextY - cropBottom;

        // Ajustar coordenadas de dibujo según la Y detectada y los deltas de la configuración del usuario
        // (por encima o debajo de los valores por defecto: 56 para texto, 65 para línea, 51 para divisor, 55 para box)
        lineYVal = baseDynamicY + 9 + (empConfig.lineY - 65);
        textYVal = baseDynamicY + (empConfig.textY - 56);
        vLineYVal = baseDynamicY - 6.15 + (divConfig.y - 51);
        vLineHeightVal = 116.3 + (divConfig.height - 116);
        boxYVal = baseDynamicY - 1 + (boxConfig.y - 55);
      }



      // Dibujar el rectángulo (box) de la firma si está definido en la configuración
      if (boxWidthVal > 0 && boxHeightVal > 0) {
        destPage.drawRectangle({
          x: x + boxXVal * scale,
          y: y + boxYVal * scale,
          width: boxWidthVal * scale,
          height: boxHeightVal * scale,
          color: rgb(1, 1, 1),        // Blanco
        });
      }

      // 1. Dibujar la línea horizontal para la firma del empleado
      const xStart = x + lineXVal * scale;
      const xEnd = xStart + lineLengthVal * scale;
      const yLine = y + lineYVal * scale;

      destPage.drawLine({
        start: { x: xStart, y: yLine },
        end: { x: xEnd, y: yLine },
        thickness: 0.75,
        color: rgb(0, 0, 0),
      });

      // 2. Escribir el texto "Firma Empleado"
      const helveticaFont = await destDoc.embedFont(StandardFonts.Helvetica);
      const textX = x + textXVal * scale;
      const textY = y + textYVal * scale;

      destPage.drawText(employeeText, {
        x: textX,
        y: textY,
        size: fontSizeVal,
        font: helveticaFont,
        color: rgb(0, 0, 0),
      });

      // 3. Dibujar la línea vertical opcional
      if (vLineHeightVal > 0) {
        const vX = x + vLineXVal * scale;
        const vYStart = y + vLineYVal * scale;
        const vYEnd = vYStart + vLineHeightVal * scale;

        destPage.drawLine({
          start: { x: vX, y: vYStart },
          end: { x: vX, y: vYEnd },
          thickness: 0.75,
          color: rgb(0, 0, 0),
        });
      }
    }

    return await destDoc.save();
  }

  // Dimensiones fijas de A4 Landscape
  const destWidth = 841.89;
  const destHeight = 595.275;

  // Separación de 0.5 cm entre las dos copias
  const gap = 14.17;

  if (mode === 'combine') {
    // MODO COMBINAR: Junta Pág 1 (Original) y Pág 2 (Copia) una al lado de la otra
    for (let i = 0; i < pages.length; i += 2) {
      const pageLeft = pages[i];
      const pageRight = (i + 1 < pages.length) ? pages[i + 1] : null;

      const sizeLeft = pageLeft.getSize();
      const sizeRight = pageRight ? pageRight.getSize() : sizeLeft;

      // Crear página destino A4 Landscape
      const destPage = destDoc.addPage([destWidth, destHeight]);

      // Calcular áreas disponibles en el destino
      const availHeight = destHeight - 2 * margin;
      const availWidth = destWidth - 2 * margin - gap;
      const availWidthPerPage = availWidth / 2;

      // Calcular el tamaño efectivo de la página izquierda (después del recorte)
      const effectiveWidthL = sizeLeft.width - cropLeft - cropRight;
      const effectiveHeightL = sizeLeft.height - cropTop - cropBottom;

      // Calcular escala de la página izquierda
      const scaleL_w = availWidthPerPage / effectiveWidthL;
      const scaleL_h = availHeight / effectiveHeightL;
      const scaleL = Math.min(scaleL_w, scaleL_h);

      const drawnWidthL = effectiveWidthL * scaleL;
      const drawnHeightL = effectiveHeightL * scaleL;

      // Alinear verticalmente al centro
      const yL = margin + (availHeight - drawnHeightL) / 2;
      const xL = margin;

      // Incrustar aplicando recorte y dibujar
      const embeddedLeft = await destDoc.embedPage(pageLeft, {
        left: cropLeft,
        bottom: cropBottom,
        right: sizeLeft.width - cropRight,
        top: sizeLeft.height - cropTop
      });

      destPage.drawPage(embeddedLeft, {
        x: xL,
        y: yL,
        width: drawnWidthL,
        height: drawnHeightL
      });

      // Calcular y dibujar página derecha (Copia)
      if (pageRight) {
        const effectiveWidthR = sizeRight.width - cropLeft - cropRight;
        const effectiveHeightR = sizeRight.height - cropTop - cropBottom;

        const scaleR_w = availWidthPerPage / effectiveWidthR;
        const scaleR_h = availHeight / effectiveHeightR;
        const scaleR = Math.min(scaleR_w, scaleR_h);

        const drawnWidthR = effectiveWidthR * scaleR;
        const drawnHeightR = effectiveHeightR * scaleR;

        const yR = margin + (availHeight - drawnHeightR) / 2;
        const xR = destWidth - margin - drawnWidthR;

        const embeddedRight = await destDoc.embedPage(pageRight, {
          left: cropLeft,
          bottom: cropBottom,
          right: sizeRight.width - cropRight,
          top: sizeRight.height - cropTop
        });

        destPage.drawPage(embeddedRight, {
          x: xR,
          y: yR,
          width: drawnWidthR,
          height: drawnHeightR
        });
      }

      // Dibujar línea divisoria en el centro exacto
      if (drawDivider) {
        const midX = destWidth / 2;
        destPage.drawLine({
          start: { x: midX, y: margin },
          end: { x: midX, y: destHeight - margin },
          thickness: 1,
          color: rgb(0.7, 0.7, 0.7),
          dashArray: [4, 4]
        });
      }
    }
  } else {
    // MODO DIVIDIR: Corta una página al medio verticalmente y pone las mitades lado a lado
    for (let i = 0; i < pages.length; i++) {
      const srcPage = pages[i];
      const { width, height } = srcPage.getSize();

      // Alturas originales de división
      const topHeight = height * (1 - splitRatio);
      const bottomHeight = height * splitRatio;

      // Crear página destino A4 Landscape
      const destPage = destDoc.addPage([destWidth, destHeight]);

      const availHeight = destHeight - 2 * margin;
      const availWidth = destWidth - 2 * margin - gap;
      const availWidthPerPage = availWidth / 2;

      // Calcular el tamaño efectivo aplicando recortes a cada mitad
      const effectiveWidthL = width - cropLeft - cropRight;
      const effectiveHeightL = topHeight - cropTop - (cropBottom * 0.5);

      // Incrustar mitad superior (Original)
      const embeddedTop = await destDoc.embedPage(srcPage, {
        left: cropLeft,
        bottom: (height * splitRatio) + (cropBottom * 0.5),
        right: width - cropRight,
        top: height - cropTop
      });

      const scaleL_w = availWidthPerPage / effectiveWidthL;
      const scaleL_h = availHeight / effectiveHeightL;
      const scaleL = Math.min(scaleL_w, scaleL_h);

      const drawnWidthL = effectiveWidthL * scaleL;
      const drawnHeightL = effectiveHeightL * scaleL;

      const yL = margin + (availHeight - drawnHeightL) / 2;
      const xL = margin;

      destPage.drawPage(embeddedTop, {
        x: xL,
        y: yL,
        width: drawnWidthL,
        height: drawnHeightL
      });

      // Calcular efectivo mitad derecha
      const effectiveWidthR = width - cropLeft - cropRight;
      const effectiveHeightR = bottomHeight - (cropTop * 0.5) - cropBottom;

      // Incrustar mitad inferior (Copia)
      const embeddedBottom = await destDoc.embedPage(srcPage, {
        left: cropLeft,
        bottom: cropBottom,
        right: width - cropRight,
        top: (height * splitRatio) - (cropTop * 0.5)
      });

      const scaleR_w = availWidthPerPage / effectiveWidthR;
      const scaleR_h = availHeight / effectiveHeightR;
      const scaleR = Math.min(scaleR_w, scaleR_h);

      const drawnWidthR = effectiveWidthR * scaleR;
      const drawnHeightR = effectiveHeightR * scaleR;

      const yR = margin + (availHeight - drawnHeightR) / 2;
      const xR = destWidth - margin - drawnWidthR;

      destPage.drawPage(embeddedBottom, {
        x: xR,
        y: yR,
        width: drawnWidthR,
        height: drawnHeightR
      });

      // Dibujar línea divisoria
      if (drawDivider) {
        const midX = destWidth / 2;
        destPage.drawLine({
          start: { x: midX, y: margin },
          end: { x: midX, y: destHeight - margin },
          thickness: 1,
          color: rgb(0.7, 0.7, 0.7),
          dashArray: [4, 4]
        });
      }
    }
  }

  return await destDoc.save();
}

// Endpoint de conversión (Protegido por authRequired)
app.post('/api/convert', authRequired, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ningún archivo PDF.' });
    }

    const { mode, splitRatio, margin, drawDivider, cropTop, cropBottom, cropLeft, cropRight, onlyFirstPage } = req.body;

    const outputPdfBytes = await convertVerticalToHorizontal(req.file.buffer, {
      mode: mode || 'combine',
      splitRatio: splitRatio ? parseFloat(splitRatio) : 0.5,
      margin: margin !== undefined ? parseFloat(margin) : 14.17,
      drawDivider: drawDivider,
      cropTop: cropTop ? parseFloat(cropTop) : 0,
      cropBottom: cropBottom ? parseFloat(cropBottom) : 0,
      cropLeft: cropLeft ? parseFloat(cropLeft) : 0,
      cropRight: cropRight ? parseFloat(cropRight) : 0,
      onlyFirstPage: onlyFirstPage
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="recibo_horizontal.pdf"');
    res.send(Buffer.from(outputPdfBytes));
  } catch (error) {
    console.error('Error durante la conversión:', error);
    res.status(500).json({ error: 'Error interno del servidor al procesar el PDF: ' + error.message });
  }
});

// Endpoint de conversión por lotes (Protegido por authRequired)
app.post('/api/convert-batch', authRequired, async (req, res) => {
  try {
    const {
      directoryPath,
      subDirName,
      mode,
      splitRatio,
      margin,
      drawDivider,
      cropTop,
      cropBottom,
      cropLeft,
      cropRight,
      onlyFirstPage
    } = req.body;

    if (!directoryPath) {
      return res.status(400).json({ error: 'La ruta del directorio es requerida.' });
    }

    const resolvedPath = path.resolve(directoryPath);

    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: `El directorio especificado no existe: ${directoryPath}` });
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'La ruta provista no corresponde a un directorio.' });
    }

    // Crear subdirectorio de destino con timestamp
    const baseSubDirName = subDirName ? subDirName.trim() : 'procesados';
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const nn = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${yyyy}${mm}${dd}${hh}${nn}${ss}`;
    
    const finalSubDirName = `${baseSubDirName}_${timestamp}`;
    const destDirPath = path.join(resolvedPath, finalSubDirName);

    if (!fs.existsSync(destDirPath)) {
      fs.mkdirSync(destDirPath, { recursive: true });
    }

    // Leer archivos del directorio
    const allFiles = fs.readdirSync(resolvedPath);
    const pdfFiles = allFiles.filter(file => {
      const filePath = path.join(resolvedPath, file);
      try {
        return file.toLowerCase().endsWith('.pdf') && fs.statSync(filePath).isFile();
      } catch (e) {
        return false;
      }
    });

    if (pdfFiles.length === 0) {
      return res.json({
        success: true,
        message: 'No se encontraron archivos PDF para procesar.',
        results: [],
        processedCount: 0,
        successCount: 0,
        errorCount: 0,
        outputDirectory: destDirPath
      });
    }

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    const conversionOptions = {
      mode: mode || 'combine',
      splitRatio: splitRatio ? parseFloat(splitRatio) : 0.5,
      margin: margin !== undefined ? parseFloat(margin) : 14.17,
      drawDivider: drawDivider === 'true' || drawDivider === true,
      cropTop: cropTop ? parseFloat(cropTop) : 0,
      cropBottom: cropBottom ? parseFloat(cropBottom) : 0,
      cropLeft: cropLeft ? parseFloat(cropLeft) : 0,
      cropRight: cropRight ? parseFloat(cropRight) : 0,
      onlyFirstPage: onlyFirstPage === 'true' || onlyFirstPage === true
    };

    let totalReceiptsCount = 0;

    for (const file of pdfFiles) {
      const srcFilePath = path.join(resolvedPath, file);
      const destFilePath = path.join(destDirPath, file);

      try {
        const fileBuffer = fs.readFileSync(srcFilePath);
        
        // Cargar el PDF para contar las páginas y calcular el número de recibos
        const srcDoc = await PDFDocument.load(fileBuffer);
        const pageCount = srcDoc.getPageCount();
        const fileReceipts = Math.ceil(pageCount / 2); // 2 paginas = 1 recibo
        
        const outputPdfBytes = await convertVerticalToHorizontal(fileBuffer, conversionOptions);
        fs.writeFileSync(destFilePath, Buffer.from(outputPdfBytes));

        results.push({ file, status: 'success', pageCount, receiptCount: fileReceipts });
        successCount++;
        totalReceiptsCount += fileReceipts;
      } catch (error) {
        console.error(`Error procesando ${file}:`, error);
        results.push({ file, status: 'error', message: error.message });
        errorCount++;
      }
    }

    res.json({
      success: true,
      results,
      processedCount: pdfFiles.length,
      successCount,
      errorCount,
      totalReceiptsCount,
      outputDirectory: destDirPath
    });
  } catch (error) {
    console.error('Error durante la conversión por lote:', error);
    res.status(500).json({ error: 'Error interno del servidor al procesar el lote: ' + error.message });
  }
});

// Endpoint para abrir el diálogo nativo de selección de carpetas (Protegido por authRequired)
app.get('/api/browse-directory', authRequired, (req, res) => {
  // Comando PowerShell para abrir FolderBrowserDialog y devolver la ruta seleccionada
  const psCommand = `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Seleccionar carpeta de recibos'; $f.ShowNewFolderButton = $true; if($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath } else { Write-Output '' }"`;

  exec(psCommand, (error, stdout, stderr) => {
    if (error) {
      console.error('Error al abrir el selector de carpetas:', error);
      return res.status(500).json({ error: 'No se pudo abrir el selector de carpetas: ' + error.message });
    }
    if (stderr && stderr.trim()) {
      console.error('Error de stderr de PowerShell:', stderr);
    }
    
    const selectedPath = stdout.trim();
    res.json({ selectedPath: selectedPath || null });
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
