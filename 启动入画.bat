@echo off
chcp 65001 >nul
REM ============================================================
REM  入画 · 一键启动（双击运行）
REM  1) 在下面 = 后面填入你在火山方舟"重置后"的新 API Key
REM     （不填也能用，只是"豆包 AI 扩图增强"开关会置灰）
REM  2) 这个文件包含你的 key：不要外传、不要上传到任何仓库
REM ============================================================
set ARK_API_KEY=ark-7b29ce78-9c88-48cf-89b2-51cad4956652-c9305

start "ruhua-backend" cmd /k "call D:\anaconda\Scripts\activate.bat sharp && cd /d %~dp0 && python backend\local_server.py"
start "ruhua-frontend" cmd /k "cd /d %~dp0 && npm run dev"
timeout /t 6 >nul
start http://localhost:3000
