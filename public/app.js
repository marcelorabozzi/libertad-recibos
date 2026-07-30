document.addEventListener('DOMContentLoaded', () => {
  console.log('[DEBUG] DOM completamente cargado.');

  // Autenticación - Elementos
  const loginView = document.getElementById('loginView');
  const appView = document.getElementById('appView');
  const loginForm = document.getElementById('loginForm');
  const loginUsernameInput = document.getElementById('loginUsername');
  const loginPasswordInput = document.getElementById('loginPassword');
  const loginError = document.getElementById('loginError');
  const btnLoginSubmit = document.getElementById('btnLoginSubmit');
  const loginBtnText = btnLoginSubmit ? btnLoginSubmit.querySelector('.btn-text') : null;
  const loginBtnLoader = btnLoginSubmit ? btnLoginSubmit.querySelector('.btn-loader') : null;

  const userRoleBadge = document.getElementById('userRoleBadge');
  const userNameLabel = document.getElementById('userNameLabel');
  const btnLogout = document.getElementById('btnLogout');

  // Sidebar Ruteo - Elementos
  const navConversor = document.getElementById('navConversor');
  const navUsuarios = document.getElementById('navUsuarios');
  const conversorView = document.getElementById('conversorView');
  const usuariosView = document.getElementById('usuariosView');
  const versionLabel = document.getElementById('versionLabel');

  // Conversor - Elementos
  const pdfDropzone = document.getElementById('pdfDropzone');
  const pdfFileInput = document.getElementById('pdfFileInput');
  const dropzoneContentDefault = document.getElementById('dropzoneContentDefault');
  const dropzoneContentActive = document.getElementById('dropzoneContentActive');
  const fileNameDisplay = document.getElementById('fileNameDisplay');
  const fileSizeDisplay = document.getElementById('fileSizeDisplay');
  const btnRemoveFile = document.getElementById('btnRemoveFile');
  
  const settingsSection = document.getElementById('settingsSection');
  const btnConvert = document.getElementById('btnConvert');
  const btnText = btnConvert ? btnConvert.querySelector('.btn-text') : null;
  const btnLoader = btnConvert ? btnConvert.querySelector('.btn-loader') : null;
  
  const previewPlaceholder = document.getElementById('previewPlaceholder');
  const previewIframeContainer = document.getElementById('previewIframeContainer');
  const pdfPreviewIframe = document.getElementById('pdfPreviewIframe');
  const previewActions = document.getElementById('previewActions');
  const btnDownload = document.getElementById('btnDownload');
  const btnFirma = document.getElementById('btnFirma');

  // Administración de Usuarios - Elementos
  const usersTableBody = document.getElementById('usersTableBody');
  const createUserForm = document.getElementById('createUserForm');
  const newUsernameInput = document.getElementById('newUsername');
  const newDisplayNameInput = document.getElementById('newDisplayName');
  const newPasswordInput = document.getElementById('newPassword');
  const newRoleSelect = document.getElementById('newRole');
  const changeOwnPasswordForm = document.getElementById('changeOwnPasswordForm');
  const ownNewPasswordInput = document.getElementById('ownNewPassword');

  // State Variables
  let currentUser = null;
  let uploadedFile = null;
  let convertedPdfUrl = null;
  let appConfig = null;

  // --- Carga de Configuración e Inicio ---
  initialize();

  async function initialize() {
    await fetchConfig();
    await fetchVersion();
    await checkSession();
  }

  async function fetchVersion() {
    try {
      console.log('[DEBUG] Cargando versión...');
      const response = await fetch(`/api/version?t=${Date.now()}`);
      const data = await response.json();
      if (versionLabel) {
        versionLabel.textContent = `${data.version} build ${data.build}`;
      }
    } catch (error) {
      console.error('[DEBUG] Error al cargar la versión:', error);
    }
  }

  async function fetchConfig() {
    try {
      console.log('[DEBUG] Cargando configuración...');
      const response = await fetch(`/api/config?t=${Date.now()}`);
      appConfig = await response.json();
      console.log('[DEBUG] Configuración cargada:', appConfig);
      applyConfig();
    } catch (error) {
      console.error('[DEBUG] Error al cargar configuración:', error);
    }
  }

  function applyConfig() {
    console.log('[DEBUG] applyConfig ejecutado. Config:', appConfig);
    if (!appConfig) return;

    // Controlar botón de Procesar y Convertir PDF (btnConvert)
    const hideConvert = appConfig.showConvertButton === false || String(appConfig.showConvertButton) === 'false';
    if (btnConvert) {
      if (hideConvert) {
        console.log('[DEBUG] Ocultando botón de procesar y convertir');
        btnConvert.style.setProperty('display', 'none', 'important');
        btnConvert.classList.add('hidden');
      } else {
        console.log('[DEBUG] Mostrando botón de procesar y convertir');
        btnConvert.style.removeProperty('display');
        btnConvert.classList.remove('hidden');
      }
    }

    // Controlar botón de firma
    const hideSignature = appConfig.showSignatureButton === false || String(appConfig.showSignatureButton) === 'false';
    if (btnFirma) {
      if (hideSignature) {
        console.log('[DEBUG] Ocultando botón de firma');
        btnFirma.style.setProperty('display', 'none', 'important');
        btnFirma.classList.add('hidden');
      } else {
        console.log('[DEBUG] Mostrando botón de firma');
        btnFirma.style.removeProperty('display');
        btnFirma.classList.remove('hidden');
      }
    }
  }

  async function checkSession() {
    try {
      console.log('[DEBUG] Validando sesión activa...');
      const response = await fetch('/api/me');
      const data = await response.json();

      if (data.authenticated) {
        console.log('[DEBUG] Sesión válida encontrada para:', data.username);
        currentUser = data;
        showApp(data);
      } else {
        console.log('[DEBUG] No hay sesión activa.');
        showLogin();
      }
    } catch (error) {
      console.error('[DEBUG] Error validando sesión:', error);
      showLogin();
    }
  }

  function showApp(user) {
    // Rellenar información de sesión en la Sidebar
    if (userNameLabel) userNameLabel.textContent = user.displayName || user.username;
    if (userRoleBadge) {
      userRoleBadge.textContent = user.role === 'root' ? 'Administrador Root' : 'Operador';
    }

    // Mostrar pestaña de usuarios solo para administradores
    if (user.role === 'root') {
      if (navUsuarios) navUsuarios.classList.remove('hidden');
    } else {
      if (navUsuarios) navUsuarios.classList.add('hidden');
    }

    loginView.classList.add('hidden');
    appView.classList.remove('hidden');

    // Por defecto, mostrar el conversor
    switchTab('conversor');
  }

  function showLogin() {
    appView.classList.add('hidden');
    loginView.classList.remove('hidden');
    currentUser = null;
    resetApp();
  }

  // --- Lógica del Menú de Navegación Lateral (Tabs) ---
  
  function switchTab(tab) {
    if (tab === 'conversor') {
      navConversor.classList.add('active');
      if (navUsuarios) navUsuarios.classList.remove('active');
      conversorView.classList.remove('hidden');
      usuariosView.classList.add('hidden');
    } else if (tab === 'usuarios' && currentUser && currentUser.role === 'root') {
      navConversor.classList.remove('active');
      if (navUsuarios) navUsuarios.classList.add('active');
      conversorView.classList.add('hidden');
      usuariosView.classList.remove('hidden');
      fetchUsers(); // Cargar la tabla de usuarios al entrar en la pestaña
    }
  }

  if (navConversor) {
    navConversor.addEventListener('click', () => switchTab('conversor'));
  }

  if (navUsuarios) {
    navUsuarios.addEventListener('click', () => switchTab('usuarios'));
  }

  // --- Lógica del Formulario de Login ---
  
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const username = loginUsernameInput.value.trim();
      const password = loginPasswordInput.value;

      if (!username || !password) return;

      // Mostrar estado de carga
      btnLoginSubmit.setAttribute('disabled', 'true');
      if (loginBtnText) loginBtnText.style.opacity = '0.5';
      if (loginBtnLoader) loginBtnLoader.classList.remove('hidden');
      loginError.classList.add('hidden');

      try {
        console.log('[DEBUG] Intentando iniciar sesión para:', username);
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Credenciales inválidas.');
        }

        console.log('[DEBUG] Login exitoso para:', data.username);
        currentUser = data;
        showApp(data);

        // Limpiar formulario
        loginUsernameInput.value = '';
        loginPasswordInput.value = '';
      } catch (error) {
        console.error('[DEBUG] Error en login:', error);
        loginError.textContent = error.message;
        loginError.classList.remove('hidden');
      } finally {
        // Restaurar estado del botón
        btnLoginSubmit.removeAttribute('disabled');
        if (loginBtnText) loginBtnText.style.opacity = '1';
        if (loginBtnLoader) loginBtnLoader.classList.add('hidden');
      }
    });
  }

  // --- Lógica de Logout ---
  
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        console.log('[DEBUG] Cerrando sesión...');
        const response = await fetch('/api/logout', {
          method: 'POST'
        });

        if (response.ok) {
          console.log('[DEBUG] Sesión cerrada con éxito.');
          showLogin();
        } else {
          throw new Error('No se pudo cerrar la sesión.');
        }
      } catch (error) {
        console.error('[DEBUG] Error cerrando sesión:', error);
        showLogin();
      }
    });
  }

  // --- ADMINISTRACIÓN DE USUARIOS (CRUD y Clave) ---

  // Obtener lista completa de usuarios y renderizarla
  async function fetchUsers() {
    try {
      console.log('[DEBUG] Obteniendo lista de usuarios...');
      const response = await fetch('/api/admin/users');
      
      if (response.status === 401 || response.status === 403) {
        alert('Acceso no autorizado.');
        showLogin();
        return;
      }

      const users = await response.json();
      renderUsersTable(users);
    } catch (error) {
      console.error('[DEBUG] Error al obtener usuarios:', error);
    }
  }

  function renderUsersTable(users) {
    if (!usersTableBody) return;
    usersTableBody.innerHTML = '';

    users.forEach(user => {
      const tr = document.createElement('tr');

      // Nombre de usuario
      const tdUser = document.createElement('td');
      tdUser.textContent = user.username;
      tdUser.style.fontWeight = '600';
      tr.appendChild(tdUser);

      // Nombre completo a mostrar
      const tdName = document.createElement('td');
      tdName.textContent = user.displayName;
      tr.appendChild(tdName);

      // Rol
      const tdRole = document.createElement('td');
      const roleSpan = document.createElement('span');
      roleSpan.className = 'user-role';
      roleSpan.textContent = user.role === 'root' ? 'Root' : 'Operador';
      if (user.role === 'root') {
        roleSpan.style.background = 'rgba(124, 58, 237, 0.08)';
        roleSpan.style.color = 'var(--accent-cyan)';
      } else {
        roleSpan.style.background = 'rgba(74, 222, 128, 0.1)';
        roleSpan.style.color = '#16a34a';
      }
      tdRole.appendChild(roleSpan);
      tr.appendChild(tdRole);

      // Contraseña (Editable inline)
      const tdPassword = document.createElement('td');
      const passContainer = document.createElement('div');
      passContainer.className = 'password-container-inline';
      
      const passSpan = document.createElement('span');
      passSpan.textContent = user.password;
      passContainer.appendChild(passSpan);
      tdPassword.appendChild(passContainer);
      tr.appendChild(tdPassword);

      // Acciones (Cambiar clave e Inhabilitar/Eliminar)
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'right';

      const btnEdit = document.createElement('button');
      btnEdit.type = 'button';
      btnEdit.className = 'btn-action btn-edit-pwd';
      btnEdit.textContent = 'Cambiar Clave';
      btnEdit.addEventListener('click', () => {
        makePasswordEditable(passContainer, user.username, user.password);
      });
      tdActions.appendChild(btnEdit);

      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'btn-action btn-delete-user';
      btnDelete.textContent = 'Eliminar';
      
      // Bloquear autodeleción del usuario root actual logueado
      if (currentUser && user.username === currentUser.username) {
        btnDelete.setAttribute('disabled', 'true');
      } else {
        btnDelete.addEventListener('click', () => deleteUser(user.username));
      }
      tdActions.appendChild(btnDelete);

      tr.appendChild(tdActions);
      usersTableBody.appendChild(tr);
    });
  }

  // Hacer editable la clave del usuario inline en la tabla
  function makePasswordEditable(container, username, currentPassword) {
    container.innerHTML = '';
    
    const divEdit = document.createElement('div');
    divEdit.className = 'inline-password-edit';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentPassword;
    divEdit.appendChild(input);

    const btnSave = document.createElement('button');
    btnSave.textContent = 'OK';
    btnSave.addEventListener('click', async () => {
      const newPwd = input.value.trim();
      if (!newPwd) return;
      await updateUserPassword(username, newPwd);
    });
    divEdit.appendChild(btnSave);

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'X';
    btnCancel.className = 'btn-cancel';
    btnCancel.addEventListener('click', () => {
      // Revertir a la vista original
      container.innerHTML = '';
      const span = document.createElement('span');
      span.textContent = currentPassword;
      container.appendChild(span);
    });
    divEdit.appendChild(btnCancel);

    container.appendChild(divEdit);
    input.focus();
  }

  // Modificar contraseña de un usuario en el backend
  async function updateUserPassword(username, password) {
    try {
      console.log(`[DEBUG] Actualizando contraseña de ${username}...`);
      const response = await fetch(`/api/admin/users/${username}/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'No se pudo cambiar la contraseña.');
      }

      console.log('[DEBUG] Contraseña cambiada con éxito.');
      fetchUsers();
    } catch (error) {
      alert('Error: ' + error.message);
      fetchUsers();
    }
  }

  // Eliminar un usuario en el backend
  async function deleteUser(username) {
    const confirmDelete = confirm(`¿Estás seguro de que deseas eliminar al usuario "${username}"?`);
    if (!confirmDelete) return;

    try {
      console.log(`[DEBUG] Eliminando usuario ${username}...`);
      const response = await fetch(`/api/admin/users/${username}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'No se pudo eliminar el usuario.');
      }

      console.log('[DEBUG] Usuario eliminado con éxito.');
      fetchUsers();
    } catch (error) {
      alert('Error: ' + error.message);
    }
  }

  // Crear usuario formulario
  if (createUserForm) {
    createUserForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const username = newUsernameInput.value.trim();
      const displayName = newDisplayNameInput.value.trim();
      const password = newPasswordInput.value;
      const role = newRoleSelect.value;

      if (!username || !displayName || !password || !role) return;

      try {
        console.log('[DEBUG] Intentando crear usuario:', username);
        const response = await fetch('/api/admin/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ username, displayName, password, role })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'No se pudo crear el usuario.');
        }

        console.log('[DEBUG] Usuario creado con éxito.');
        
        // Limpiar inputs
        newUsernameInput.value = '';
        newDisplayNameInput.value = '';
        newPasswordInput.value = '';
        newRoleSelect.value = 'operador';

        // Recargar tabla
        fetchUsers();
      } catch (error) {
        alert('Error al crear usuario: ' + error.message);
      }
    });
  }

  // Cambiar contraseña propia
  if (changeOwnPasswordForm) {
    changeOwnPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const newPassword = ownNewPasswordInput.value;
      if (!newPassword) return;

      try {
        console.log('[DEBUG] Intentando cambiar propia contraseña...');
        const response = await fetch('/api/users/me/password', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ password: newPassword })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'No se pudo actualizar la contraseña.');
        }

        console.log('[DEBUG] Contraseña propia actualizada.');
        alert('Tu contraseña se ha modificado exitosamente.');
        ownNewPasswordInput.value = '';
        
        // Recargar tabla de usuarios por si acaso
        if (currentUser && currentUser.role === 'root') {
          fetchUsers();
        }
      } catch (error) {
        alert('Error al cambiar contraseña: ' + error.message);
      }
    });
  }

  // --- Drag and Drop Handlers ---
  
  // Prevent default drag behaviors and handle drag states
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    if (pdfDropzone) {
      pdfDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    }
  });

  if (pdfDropzone) {
    ['dragenter', 'dragover'].forEach(eventName => {
      pdfDropzone.addEventListener(eventName, () => {
        pdfDropzone.classList.add('dragover');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      pdfDropzone.addEventListener(eventName, () => {
        pdfDropzone.classList.remove('dragover');
      }, false);
    });

    // Handle dropped files
    pdfDropzone.addEventListener('drop', (e) => {
      console.log('[DEBUG] Evento "drop" disparado.');
      const dt = e.dataTransfer;
      const files = dt.files;
      if (files.length > 0) {
        handleFile(files[0]);
      }
    });

    // Handle clicked files
    pdfDropzone.addEventListener('click', () => {
      if (!uploadedFile) {
        pdfFileInput.click();
      }
    });
  }

  // Prevent click event bubbling from input to parent dropzone
  if (pdfFileInput) {
    pdfFileInput.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    pdfFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
      }
    });
  }



  // Process the selected file
  function handleFile(file) {
    console.log('[DEBUG] handleFile llamado para:', file.name);

    const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPDF) {
      alert('Por favor, selecciona un archivo PDF válido.');
      return;
    }
    
    uploadedFile = file;
    
    // Update active dropzone layout
    fileNameDisplay.textContent = file.name;
    fileSizeDisplay.textContent = formatBytes(file.size);
    
    dropzoneContentDefault.classList.add('hidden');
    dropzoneContentActive.classList.remove('hidden');
    
    // Enable settings and convert button
    settingsSection.classList.add('active');
    btnConvert.removeAttribute('disabled');
    if (btnFirma) btnFirma.removeAttribute('disabled');
    
    console.log('[DEBUG] Interfaz habilitada para el archivo cargado.');
  }

  // Remove current file
  if (btnRemoveFile) {
    btnRemoveFile.addEventListener('click', (e) => {
      e.stopPropagation();
      resetApp();
    });
  }

  function resetApp() {
    console.log('[DEBUG] Reiniciando la aplicación...');
    uploadedFile = null;
    if (pdfFileInput) pdfFileInput.value = '';
    
    if (dropzoneContentActive) dropzoneContentActive.classList.add('hidden');
    if (dropzoneContentDefault) dropzoneContentDefault.classList.remove('hidden');
    
    if (settingsSection) settingsSection.classList.remove('active');
    
    if (btnConvert) btnConvert.setAttribute('disabled', 'true');
    if (btnFirma) btnFirma.setAttribute('disabled', 'true');

    // Clear previews
    if (convertedPdfUrl) {
      URL.revokeObjectURL(convertedPdfUrl);
      convertedPdfUrl = null;
    }
    if (pdfPreviewIframe) pdfPreviewIframe.src = '';
    if (previewIframeContainer) previewIframeContainer.classList.add('hidden');
    if (previewActions) {
      previewActions.classList.add('hidden');
      previewActions.style.removeProperty('display');
    }
    if (previewPlaceholder) previewPlaceholder.classList.remove('hidden');
  }

  // --- Conversion Request ---

  if (btnConvert) {
    btnConvert.addEventListener('click', async () => {
      console.log('[DEBUG] Iniciando conversión...');
      if (!uploadedFile) return;

      // Show loading state
      btnConvert.setAttribute('disabled', 'true');
      if (btnText) btnText.style.opacity = '0.5';
      if (btnLoader) btnLoader.classList.remove('hidden');
      
      const formData = new FormData();
      formData.append('file', uploadedFile);
      formData.append('mode', 'combine');
      formData.append('splitRatio', '0.5');
      formData.append('margin', '8');
      formData.append('drawDivider', 'true');
      
      // Add crop values
      formData.append('cropTop', '0');
      formData.append('cropBottom', '80');
      formData.append('cropLeft', '20');
      formData.append('cropRight', '20');

      try {
        const response = await fetch('/api/convert', {
          method: 'POST',
          body: formData
        });

        if (response.status === 401) {
          alert('Tu sesión ha expirado. Por favor ingresa de nuevo.');
          showLogin();
          return;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || 'Error procesando el archivo.');
        }

        const pdfBlob = await response.blob();
        
        if (convertedPdfUrl) {
          URL.revokeObjectURL(convertedPdfUrl);
        }

        convertedPdfUrl = URL.createObjectURL(pdfBlob);
        pdfPreviewIframe.src = convertedPdfUrl;
        
        btnDownload.href = convertedPdfUrl;
        btnDownload.download = `horizontal_${uploadedFile.name}`;
        
        previewPlaceholder.classList.add('hidden');
        previewIframeContainer.classList.remove('hidden');
        if (previewActions) {
          previewActions.classList.remove('hidden');
        }
        console.log('[DEBUG] Conversión completada con éxito.');
        
      } catch (error) {
        console.error(error);
        alert(`Error al convertir el PDF: ${error.message}`);
      } finally {
        btnConvert.removeAttribute('disabled');
        if (btnText) btnText.style.opacity = '1';
        if (btnLoader) btnLoader.classList.add('hidden');
      }
    });
  }

  if (btnFirma) {
    btnFirma.addEventListener('click', async () => {
      console.log('[DEBUG] Iniciando conversión para Firma...');
      if (!uploadedFile) return;

      // Show loading state
      btnFirma.setAttribute('disabled', 'true');
      if (btnConvert) btnConvert.setAttribute('disabled', 'true');
      btnFirma.style.opacity = '0.5';

      const formData = new FormData();
      formData.append('file', uploadedFile);
      formData.append('mode', 'combine');
      formData.append('splitRatio', '0.5');
      formData.append('margin', '8');
      formData.append('drawDivider', 'false');
      formData.append('onlyFirstPage', 'true');

      // Add crop values
      formData.append('cropTop', '0');
      formData.append('cropBottom', '80');
      formData.append('cropLeft', '20');
      formData.append('cropRight', '20');

      try {
        const response = await fetch('/api/convert', {
          method: 'POST',
          body: formData
        });

        if (response.status === 401) {
          alert('Tu sesión ha expirado. Por favor ingresa de nuevo.');
          showLogin();
          return;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || 'Error procesando el archivo.');
        }

        const pdfBlob = await response.blob();

        if (convertedPdfUrl) {
          URL.revokeObjectURL(convertedPdfUrl);
        }

        convertedPdfUrl = URL.createObjectURL(pdfBlob);
        pdfPreviewIframe.src = convertedPdfUrl;

        btnDownload.href = convertedPdfUrl;
        btnDownload.download = `firma_${uploadedFile.name}`;

        previewPlaceholder.classList.add('hidden');
        previewIframeContainer.classList.remove('hidden');
        if (previewActions) {
          previewActions.classList.remove('hidden');
        }
        console.log('[DEBUG] Conversión para Firma completada con éxito.');

      } catch (error) {
        console.error(error);
        alert(`Error al generar vista para firma: ${error.message}`);
      } finally {
        btnFirma.removeAttribute('disabled');
        if (btnConvert) btnConvert.removeAttribute('disabled');
        btnFirma.style.opacity = '1';
      }
    });
  }

  // Helper function to format file sizes
  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
});
