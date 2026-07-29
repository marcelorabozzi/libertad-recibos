const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument, rgb } = require('pdf-lib');

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

// Almacenamiento de sesiones en memoria
const sessions = new Map();

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

    // Crear sesión en memoria
    const token = crypto.randomUUID();
    sessions.set(token, {
      username: username.toLowerCase(),
      role: user.role,
      displayName: user.displayName,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000 // Expira en 24h
    });

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

  // Recortes de los márgenes blancos del archivo original
  const cropTop = parseFloat(options.cropTop) || 0;
  const cropBottom = parseFloat(options.cropBottom) || 0;
  const cropLeft = parseFloat(options.cropLeft) || 0;
  const cropRight = parseFloat(options.cropRight) || 0;

  const srcDoc = await PDFDocument.load(pdfBuffer);
  const destDoc = await PDFDocument.create();
  const pages = srcDoc.getPages();

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

    const { mode, splitRatio, margin, drawDivider, cropTop, cropBottom, cropLeft, cropRight } = req.body;

    const outputPdfBytes = await convertVerticalToHorizontal(req.file.buffer, {
      mode: mode || 'combine',
      splitRatio: splitRatio ? parseFloat(splitRatio) : 0.5,
      margin: margin !== undefined ? parseFloat(margin) : 14.17,
      drawDivider: drawDivider,
      cropTop: cropTop ? parseFloat(cropTop) : 0,
      cropBottom: cropBottom ? parseFloat(cropBottom) : 0,
      cropLeft: cropLeft ? parseFloat(cropLeft) : 0,
      cropRight: cropRight ? parseFloat(cropRight) : 0
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="recibo_horizontal.pdf"');
    res.send(Buffer.from(outputPdfBytes));
  } catch (error) {
    console.error('Error durante la conversión:', error);
    res.status(500).json({ error: 'Error interno del servidor al procesar el PDF: ' + error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
