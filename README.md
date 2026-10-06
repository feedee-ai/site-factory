# site-factory

Общий набор для всех клиентских сайтов: дизайн/motion-скиллы и маркетинговые скиллы (copywriting, cro, offers…), команды `/new-site`, `/feedback` и `/deploy`, глобальные правила.

Setup script облачной среды:

```bash
git clone --depth 1 https://github.com/feedee-ai/site-factory /tmp/site-factory && bash /tmp/site-factory/install.sh
```

Новый проект: `/new-site <ссылки>` → сайт на проде + готовое сообщение клиенту. Ответ клиента (текст или расшифровка голосового) → `/feedback <текст>` → правки на проде.

Обновить скиллы: положи/замени папку в `skills/`, запушь — новые сессии подхватят.
