# Глобально (site-factory)

Владелец — Александр. Общение на русском, прямо, без воды.

## Сайты для клиентов
Новый проект = новый чат на `site-factory` (репо клиента создаёшь сам, см. `/new-site` шаг 0.5) или на пустом репо клиента. Клиентское никогда не коммитить в site-factory — он публичный. Александр кидает ссылки (Instagram, Google Maps, сайт) или название бизнеса → запускай `/new-site` и доводи до ссылки на прод без лишних вопросов.

- Планка сайта — раздел «Планка» в `~/.claude/commands/new-site.md`: продающий + уровень топов ниши, без напоминаний.
- Маркетинговые скиллы: `customer-research`, `offers`, `copywriting`, `copy-editing`, `marketing-psychology`, `cro`, `schema`.
- Дизайн-, motion- и UI-скиллы лежат в `~/.claude/skills` — используй их на каждом этапе (impeccable, taste-skill, soft-skill, minimalist-skill, redesign-skill, emil-design-eng, animate, apple-design, review-animations, improve-animations, find-animation-opportunities, brandkit, output-skill). Не шаблон: уровень топовых сайтов ниши.
- Стек по умолчанию: статический сайт без сборки в `site/`, `vercel.json` с `outputDirectory: site`. Сборщик — только если реально нужен.
- Цен нет → «по консультации», цены в конфиге. Запись — демо-форма → готовое сообщение в WhatsApp владельца.
- Языки: по аудитории из отзывов/постов (минимум язык страны + EN; RU, если есть русскоязычная аудитория).

## Доступы (переменные среды)
- `APIFY_TOKEN` — парсинг Instagram/Google Maps через REST `https://api.apify.com/v2`, заголовок `Authorization: Bearer $APIFY_TOKEN`.
- `VERCEL_TOKEN` — деплой: `vercel ... --token "$VERCEL_TOKEN"`.
- `GITHUB_PAT` — только если надо создать репо: `GH_TOKEN="$GITHUB_PAT" gh repo create ...`. Встроенный `GH_TOKEN` сессии привязан к текущему репо.
- Нет токена или хост закрыт сетью → одной строкой скажи, что добавить в настройках среды, и делай то, что можно без этого. Токены в чат не просить.

## Никогда без явного «да»
`gh repo delete/archive`, смена видимости репо, `vercel rm/remove`, `vercel domains rm`, `vercel env rm`, `vercel rollback`, force-push. `.vercel/` не коммитить.
