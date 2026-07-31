@echo off
REM Configura la codificacion a UTF-8 para mostrar caracteres correctamente
chcp 65001 > nul

title Servidor - Libertad Recibos Converter

echo ===================================================
echo      Iniciando Libertad Recibos Converter
echo ===================================================
echo.

REM Verificar si Node.js esta instalado
node -v >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js no esta instalado en este sistema.
    echo Por favor, descargue e instale Node.js desde https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Cambiar al directorio donde se encuentra este archivo .bat
cd /d "%~dp0"

REM Verificar si existe node_modules, de lo contrario instalar dependencias
if not exist "node_modules" (
    echo [INFO] Carpeta 'node_modules' no encontrada.
    echo [INFO] Instalando dependencias del proyecto, por favor espere...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] Hubo un problema al instalar las dependencias.
        pause
        exit /b 1
    )
    echo.
    echo [INFO] Dependencias instaladas correctamente.
    echo.
)

REM Abrir la aplicacion en el navegador predeterminado
echo [INFO] Abriendo el navegador en http://localhost:3000...
start http://localhost:3000

REM Levantar el servidor
echo [INFO] Iniciando el servidor Express...
echo [INFO] Para detener el servidor, cierre esta ventana o presione Ctrl+C.
echo.
call npm start

if %errorlevel% neq 0 (
    echo.
    echo [WARNING] El servidor se detuvo con un codigo de error o fue cancelado.
    pause
)
