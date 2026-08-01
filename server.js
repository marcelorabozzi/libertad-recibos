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

// Función para extraer el banco de cobro de una página de origen
function extractBankText(page, srcDoc) {
  try {
    const contents = page.node.Contents();
    if (!contents) return null;
    
    const refs = contents.size ? Array.from({ length: contents.size() }, (_, idx) => contents.get(idx)) : [contents];
    
    let pageText = '';
    for (const ref of refs) {
      const resolved = srcDoc.context.lookup(ref);
      if (resolved && (resolved.asUint8Array || resolved.getContentsString)) {
        const bytes = resolved.asUint8Array ? resolved.asUint8Array() : resolved.contents;
        if (bytes && bytes.length > 0) {
          let decompressed = bytes;
          if (bytes[0] === 0x78 && bytes[1] === 0x9c) {
            try {
              decompressed = zlib.inflateSync(Buffer.from(bytes));
            } catch (e) {
              // Si falla la descompresión, continuar con los bytes originales
            }
          }
          const textContent = new TextDecoder('latin1').decode(decompressed);
          pageText += textContent + '\n';
        }
      }
    }
    
    const textMatches = [];
    const regex = /\(([^)]+)\)\s*(Tj|TJ|'|")/g;
    let match;
    while ((match = regex.exec(pageText)) !== null) {
      textMatches.push(match[1]);
    }
    
    const tjRegex = /\[([^\]]+)\]\s*TJ/g;
    while ((match = tjRegex.exec(pageText)) !== null) {
      const inner = match[1];
      const strRegex = /\(([^)]+)\)/g;
      let strMatch;
      let tjText = '';
      while ((strMatch = strRegex.exec(inner)) !== null) {
        tjText += strMatch[1];
      }
      if (tjText) textMatches.push(tjText);
    }
    
    const searchTerms = ['importe acreditado en', 'acreditado en', 'acreditacion en', 'banco de cobro'];
    for (let idx = 0; idx < textMatches.length; idx++) {
      const t = textMatches[idx];
      const lowerT = t.toLowerCase();
      
      for (const term of searchTerms) {
        if (lowerT.includes(term)) {
          let result = t.replace(/\\([()])/g, '$1').trim();
          
          const cleanLower = result.toLowerCase().replace(/[^a-z]/g, '');
          const cleanTerm = term.replace(/[^a-z]/g, '');
          
          if (cleanLower === cleanTerm && idx + 1 < textMatches.length) {
            const nextVal = textMatches[idx + 1].replace(/\\([()])/g, '$1').trim();
            if (nextVal && nextVal.length > 1 && !nextVal.includes(':')) {
              result += ' ' + nextVal;
            }
          }
          return result;
        }
      }
    }
  } catch (e) {
    console.error('Error al extraer banco de cobro:', e);
  }
  return null;
}

function findTextCoordinatesSequential(textContent, matchIndex) {
  const btIndex = textContent.lastIndexOf('BT', matchIndex);
  if (btIndex === -1) return null;
  
  const btBlock = textContent.substring(btIndex, matchIndex);
  
  let x_line = 0;
  let y_line = 0;
  let currentX = 0;
  let currentY = 0;
  let currentFontSize = 10;
  
  const tokens = btBlock.match(/-?[0-9.]+|[a-zA-Z*']+|\([^)]*\)|\[[^\]]*\]/g);
  if (!tokens) return null;
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'Tm') {
      if (i >= 6) {
        currentFontSize = Math.abs(parseFloat(tokens[i - 3]));
        x_line = parseFloat(tokens[i - 2]);
        y_line = parseFloat(tokens[i - 1]);
        currentX = x_line;
        currentY = y_line;
      }
    } else if (token === 'Td' || token === 'TD') {
      if (i >= 2) {
        const tx = parseFloat(tokens[i - 2]);
        const ty = parseFloat(tokens[i - 1]);
        x_line += tx;
        y_line += ty;
        currentX = x_line;
        currentY = y_line;
      }
    } else if (token === 'Tf') {
      if (i >= 1) {
        currentFontSize = parseFloat(tokens[i - 1]);
      }
    }
  }
  
  return {
    fontSize: currentFontSize,
    x: currentX,
    y: currentY
  };
}

async function cleanCuilOnPage(page, destPage, x, y, scale, cropLeft, cropBottom, srcDoc, destDoc, onlyTopHalf = null, splitY = 0) {
  try {
    const contents = page.node.Contents();
    if (!contents) return;

    const refs = contents.size ? Array.from({ length: contents.size() }, (_, idx) => contents.get(idx)) : [contents];
    const helveticaFont = await destDoc.embedFont(StandardFonts.Helvetica);

    for (const ref of refs) {
      const resolved = srcDoc.context.lookup(ref);
      if (!resolved || (!resolved.asUint8Array && !resolved.contents)) continue;

      const bytes = resolved.asUint8Array ? resolved.asUint8Array() : resolved.contents;
      if (!bytes || bytes.length === 0) continue;

      let decompressed = bytes;
      if (bytes[0] === 0x78 && bytes[1] === 0x9c) {
        try {
          decompressed = zlib.inflateSync(Buffer.from(bytes));
        } catch (e) {
          // ignore
        }
      }

      const textContent = new TextDecoder('latin1').decode(decompressed);

      // Buscar cm transform para calcular coordenadas absolutas
      let cmTx = 0;
      let cmTy = 0;
      const cmMatch = textContent.match(/([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+cm/);
      if (cmMatch) {
        cmTx = parseFloat(cmMatch[5]);
        cmTy = parseFloat(cmMatch[6]);
      }

      const cuilRegex = /\((\d{2})\s*-\s*(\d{8})\s*-\s*(\d)\)/g;
      let match;
      while ((match = cuilRegex.exec(textContent)) !== null) {
        const cleanCuil = match[1] + match[2] + match[3];
        const matchIndex = match.index;

        const coords = findTextCoordinatesSequential(textContent, matchIndex);
        if (coords) {
          // Coordenadas absolutas en la página de origen
          const absX = coords.x + cmTx;
          const absY = coords.y + cmTy;

          // Si estamos en modo split, verificar si pertenece a la mitad correspondiente
          if (onlyTopHalf !== null) {
            if (onlyTopHalf && absY < splitY) continue;
            if (!onlyTopHalf && absY >= splitY) continue;
          }

          // Mapear coordenadas a la página de destino
          const destX = x + (absX - cropLeft) * scale;
          const destY = y + (absY - cropBottom) * scale;
          const scaledFontSize = coords.fontSize * scale;

          // Dibujar rectángulo blanco para tapar el CUIL anterior
          const coverWidth = coords.fontSize * 7.5; 
          const coverHeight = coords.fontSize * 1.2;

          destPage.drawRectangle({
            x: destX - 1 * scale,
            y: destY - 1 * scale,
            width: coverWidth * scale,
            height: coverHeight * scale,
            color: rgb(1, 1, 1), // Blanco
          });

          // Dibujar el CUIL limpio
          destPage.drawText(cleanCuil, {
            x: destX,
            y: destY,
            size: scaledFontSize,
            font: helveticaFont,
            color: rgb(0, 0, 0),
          });
        }
      }
    }
  } catch (e) {
    console.error('Error al limpiar CUIL de la página:', e);
  }
}

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

  // Obtener configuración dinámica
  const config = getConfig();
  const sigConfig = config.signature || {};
  const bankConfig = sigConfig.bank || {};
  const bankTextX = bankConfig.textX !== undefined ? parseFloat(bankConfig.textX) : 15;
  const bankTextY = bankConfig.textY !== undefined ? parseFloat(bankConfig.textY) : 12;

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

      // Limpiar los guiones del CUIL en el recibo generado
      await cleanCuilOnPage(page, destPage, x, y, scale, cropLeft, cropBottom, srcDoc, destDoc);

      // Tapar el cuadro de firma original con un rectángulo blanco
      destPage.drawRectangle({
        x,
        y,
        width: drawnWidth,
        height: 35 * scale,
        color: rgb(1, 1, 1),
      });

      // Obtener configuración dinámica
      const config = getConfig();
      const sigConfig = config.signature || {};
      const empConfig = sigConfig.employee || {};
      const empConfig2 = sigConfig.employee2 || {};
      const boxConfig = sigConfig.box || {};

      let lineLengthVal = empConfig.lineLength !== undefined ? parseFloat(empConfig.lineLength) : 120;
      let lineXVal = empConfig.lineX !== undefined ? parseFloat(empConfig.lineX) : 255;
      let lineYVal = empConfig.lineY !== undefined ? parseFloat(empConfig.lineY) : 65;
      let textXVal = empConfig.textX !== undefined ? parseFloat(empConfig.textX) : 290;
      let textYVal = empConfig.textY !== undefined ? parseFloat(empConfig.textY) : 55;
      let fontSizeVal = empConfig.fontSize !== undefined ? parseFloat(empConfig.fontSize) : 7;
      let employeeText = empConfig.text || 'Firma Empleador';

      let lineLengthVal2 = empConfig2.lineLength !== undefined ? parseFloat(empConfig2.lineLength) : 120;
      let lineXVal2 = empConfig2.lineX !== undefined ? parseFloat(empConfig2.lineX) : 455;
      let lineYVal2 = empConfig2.lineY !== undefined ? parseFloat(empConfig2.lineY) : 65;
      let textXVal2 = empConfig2.textX !== undefined ? parseFloat(empConfig2.textX) : 490;
      let textYVal2 = empConfig2.textY !== undefined ? parseFloat(empConfig2.textY) : 55;
      let fontSizeVal2 = empConfig2.fontSize !== undefined ? parseFloat(empConfig2.fontSize) : 7;
      let employeeText2 = empConfig2.text || 'Firma Empleado';

      let boxWidthVal = boxConfig.width !== undefined ? parseFloat(boxConfig.width) : 0;
      let boxHeightVal = boxConfig.height !== undefined ? parseFloat(boxConfig.height) : 0;
      let boxXVal = boxConfig.x !== undefined ? parseFloat(boxConfig.x) : 0;
      let boxYVal = boxConfig.y !== undefined ? parseFloat(boxConfig.y) : 0;
      let boxShowBorder = boxConfig.showBorder === true || boxConfig.showBorder === 'true';

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

        // Ajustar la Y del recuadro de firma según la Y detectada y la configuración
        boxYVal = baseDynamicY - 1 + (boxConfig.y - 55);
      }

      // Dibujar el recuadro blanco configurable si está definido en la configuración
      if (boxWidthVal > 0 && boxHeightVal > 0) {
        const drawOptions = {
          x: x + boxXVal * scale,
          y: y + boxYVal * scale,
          width: boxWidthVal * scale,
          height: boxHeightVal * scale,
          color: rgb(1, 1, 1),        // Blanco
        };
        if (boxShowBorder) {
          drawOptions.borderColor = rgb(0, 0, 0); // Negro
          drawOptions.borderWidth = 0.75;          // Ancho de borde estándar para firmas
        }
        destPage.drawRectangle(drawOptions);
      }

      // 1. Dibujar la línea horizontal para la firma del empleado (employee 1)
      const xStart = x + lineXVal * scale;
      const xEnd = xStart + lineLengthVal * scale;
      const yLine = y + lineYVal * scale;

      destPage.drawLine({
        start: { x: xStart, y: yLine },
        end: { x: xEnd, y: yLine },
        thickness: 0.75,
        color: rgb(0, 0, 0),
      });

      // 2. Escribir el texto "Firma Empleador" (employee 1)
      const helveticaFont = await destDoc.embedFont(StandardFonts.Helvetica);
      const textX = x + textXVal * scale;
      const textY = y + bankTextY * scale;

      destPage.drawText(employeeText, {
        x: textX,
        y: textY,
        size: fontSizeVal,
        font: helveticaFont,
        color: rgb(0, 0, 0),
      });

      // 3. Dibujar la línea horizontal para la firma del empleado 2 (employee 2)
      const xStart2 = x + lineXVal2 * scale;
      const xEnd2 = xStart2 + lineLengthVal2 * scale;
      const yLine2 = y + lineYVal2 * scale;

      destPage.drawLine({
        start: { x: xStart2, y: yLine2 },
        end: { x: xEnd2, y: yLine2 },
        thickness: 0.75,
        color: rgb(0, 0, 0),
      });

      // 4. Escribir el texto "Firma Empleado" (employee 2)
      const textX2 = x + textXVal2 * scale;
      const textY2 = y + bankTextY * scale;

      destPage.drawText(employeeText2, {
        x: textX2,
        y: textY2,
        size: fontSizeVal2,
        font: helveticaFont,
        color: rgb(0, 0, 0),
      });

      // 5. Dibujar el texto del banco de cobro al pie del recibo
      const bankText = extractBankText(page, srcDoc);
      if (bankText) {
        destPage.drawText(bankText, {
          x: x + bankTextX * scale,
          y: y + bankTextY * scale,
          size: 8,
          font: helveticaFont,
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

      // Limpiar los guiones del CUIL en el recibo (mitad izquierda / original)
      await cleanCuilOnPage(pageLeft, destPage, xL, yL, scaleL, cropLeft, cropBottom, srcDoc, destDoc);

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

        // Limpiar los guiones del CUIL en el recibo (mitad derecha / copia)
        await cleanCuilOnPage(pageRight, destPage, xR, yR, scaleR, cropLeft, cropBottom, srcDoc, destDoc);
      }

      // Dibujar el texto del banco de cobro al pie de cada copia
      const bankTextL = extractBankText(pageLeft, srcDoc);
      const bankTextR = pageRight ? (extractBankText(pageRight, srcDoc) || bankTextL) : null;
      if (bankTextL || bankTextR) {
        const helveticaFont = await destDoc.embedFont(StandardFonts.Helvetica);
        if (bankTextL) {
          destPage.drawText(bankTextL, {
            x: xL + bankTextX,
            y: yL + bankTextY,
            size: 8,
            font: helveticaFont,
            color: rgb(0, 0, 0)
          });
        }
        if (bankTextR) {
          destPage.drawText(bankTextR, {
            x: xR + bankTextX,
            y: yR + bankTextY,
            size: 8,
            font: helveticaFont,
            color: rgb(0, 0, 0)
          });
        }
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

      // Limpiar los guiones del CUIL en el recibo (mitad izquierda / original)
      await cleanCuilOnPage(srcPage, destPage, xL, yL, scaleL, cropLeft, (height * splitRatio) + (cropBottom * 0.5), srcDoc, destDoc, true, height * splitRatio);

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

      // Limpiar los guiones del CUIL en el recibo (mitad derecha / copia)
      await cleanCuilOnPage(srcPage, destPage, xR, yR, scaleR, cropLeft, cropBottom, srcDoc, destDoc, false, height * splitRatio);

      // Dibujar el texto del banco de cobro al pie de cada copia
      const bankText = extractBankText(srcPage, srcDoc);
      if (bankText) {
        const helveticaFont = await destDoc.embedFont(StandardFonts.Helvetica);
        destPage.drawText(bankText, {
          x: xL + bankTextX,
          y: yL + bankTextY,
          size: 8,
          font: helveticaFont,
          color: rgb(0, 0, 0)
        });
        destPage.drawText(bankText, {
          x: xR + bankTextX,
          y: yR + bankTextY,
          size: 8,
          font: helveticaFont,
          color: rgb(0, 0, 0)
        });
      }

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

// Endpoint para visualizar un PDF procesado de un lote (Protegido por authRequired)
app.get('/api/view-pdf', authRequired, (req, res) => {
  const { dir, file } = req.query;

  if (!dir || !file) {
    return res.status(400).json({ error: 'La ruta del directorio (dir) y el archivo (file) son requeridos.' });
  }

  if (!file.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'Solo se permite visualizar archivos PDF.' });
  }

  const absolutePath = path.resolve(dir, file);

  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: 'El archivo PDF solicitado no existe.' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file)}"`);
  res.sendFile(absolutePath);
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
