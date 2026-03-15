@echo off
:: 设置控制台编码为 UTF-8
chcp 65001 > nul

echo ==========================================
echo   AIS2API 启动脚本 (UTF-8)
echo ==========================================
echo.
echo 正在启动 unified-server.js...
echo.

node app/main.js

if %errorlevel% neq 0 (
    echo.
    echo [错误] 程序异常退出，请检查上方日志。
)

pause
