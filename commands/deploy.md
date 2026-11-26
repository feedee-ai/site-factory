---
description: Задеплоить сайт текущего репо на Vercel и вернуть ссылку
argument-hint: "[prod|preview]"
---
Режим: `$ARGUMENTS` (пусто = prod).

0. **UI-QA (только для prod).** Загрузи скилл `ui-qa`: `node ~/.claude/skills/ui-qa/scripts/ui-qa.mjs site --out qa-report` (полная матрица) + просмотр аркушей глазами. Есть блокеры → исправь и прогони заново; деплой на прод с красным ui-qa запрещён. Для preview можно `--quick`.
1. Всё закоммичено и запушено (`git status`, `git push -u origin <branch>`).
2. `vercel whoami --token "$VERCEL_TOKEN"`. Нет токена / `api.vercel.com` закрыт → одной строкой, что добавить в настройках среды; стоп.
3. Нет `.vercel/project.json` → `vercel link --yes --project <имя-репо> --token "$VERCEL_TOKEN"`, затем `vercel git connect --yes --token "$VERCEL_TOKEN"` (дальше пуш в main = прод).
4. prod: `vercel deploy --prod --yes --token "$VERCEL_TOKEN"`; preview: без `--prod`.
5. `curl -sI <url>` → 200. Вернуть: URL, коммит, режим.
