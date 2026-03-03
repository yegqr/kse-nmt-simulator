#!/bin/bash
# KSE NMT — автозапуск

set -e

cd "$(dirname "$0")"

echo "🚀 KSE NMT Simulator — запуск..."

# Встановити залежності якщо node_modules немає
if [ ! -d "node_modules" ]; then
  echo "📦 Встановлення залежностей (npm install)..."
  npm install
fi

# Перевірити чи порт 3000 вільний, якщо ні — вбити стару копію
if lsof -i :3000 -t &>/dev/null; then
  echo "⚠️  Порт 3000 зайнятий — зупиняю старий процес..."
  lsof -i :3000 -t | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "✅ Сервер запущено → http://localhost:3000"
echo "   Адмін-панель  → http://localhost:3000/admin.html"
echo ""
echo "🔑 Адмін логін:"
echo "   Login:    admin"
echo "   Password: kse_admin_2026"
echo ""
echo "   Зупинити: Ctrl+C"
echo ""

# Відкрити браузер (macOS)
sleep 0.8 && open "http://localhost:3000/login.html" &

# Запустити сервер
node server.js
