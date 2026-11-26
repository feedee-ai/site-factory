# site-factory

Общий набор для всех клиентских сайтов: дизайн/motion-скиллы и маркетинговые скиллы (copywriting, cro, offers…), команды `/new-site` и `/deploy`, глобальные правила.

Setup script облачной среды:

```bash
git clone --depth 1 https://github.com/feedee-ai/site-factory /tmp/site-factory && bash /tmp/site-factory/install.sh
```

Новый проект: пустой репо клиента на GitHub → новый чат на нём → `/new-site <ссылки>`.

3D/WebGL/скролл-скиллы (64 шт., MIT) — источники и коммиты в `skills/MANIFEST-3d-motion.txt`, лицензии `skills/LICENSE-*`.

UI-QA перед каждым продом: скилл `ui-qa` (`skills/ui-qa/scripts/ui-qa.mjs`) — 20 разрешений от 320 до 2560, горизонтальный скролл, наложения, контраст по пикселям, иконки, зоны нажатия, режимы без анимаций и без JS. Встроен в `/new-site` (шаг 5.9), `/deploy` и `/rebuild-site`.

Обновить скиллы: положи/замени папку в `skills/`, запушь — новые сессии подхватят.
