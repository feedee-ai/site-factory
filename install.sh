#!/bin/bash
# Ставит завод в ~/.claude: скиллы, команды, глобальные правила, Vercel CLI.
# Запускается из Setup script облачной среды (один раз на старте каждой сессии).
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p ~/.claude/skills ~/.claude/commands
cp -r "$SRC"/skills/* ~/.claude/skills/
cp "$SRC"/commands/*.md ~/.claude/commands/
cp "$SRC"/global-CLAUDE.md ~/.claude/CLAUDE.md
if [ ! -f ~/.claude/settings.json ]; then
  cp "$SRC"/global-settings.json ~/.claude/settings.json
fi
command -v vercel >/dev/null 2>&1 || npm i -g vercel@latest >/dev/null 2>&1 || echo "vercel CLI install failed" >&2
echo "site-factory installed: $(ls "$SRC"/skills | wc -l) skills"
