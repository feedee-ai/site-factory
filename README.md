# site-factory

Общий набор для всех клиентских сайтов: дизайн/motion-скиллы и маркетинговые скиллы (copywriting, cro, offers…), команды `/new-site` и `/deploy`, глобальные правила.

Setup script облачной среды:

```bash
git clone --depth 1 https://github.com/feedee-ai/site-factory /tmp/site-factory && bash /tmp/site-factory/install.sh
```

Новый проект: пустой репо клиента на GitHub → новый чат на нём → `/new-site <ссылки>`.

Проверка перед сдачей — `scripts/qa.cjs` (ставится в `~/.claude/scripts/`): `node ~/.claude/scripts/qa.cjs <url | папка site/> [папка-отчёта]`. Консоль, битые запросы, поперечная прокрутка, ссылки, формы, картинки, скорость на телефоне, доступность (axe-core) на 390/768/1440 → `report.md` и вердикт. Нужен Playwright (в облачной среде стоит).

3D/WebGL/скролл-скиллы (64 шт., MIT) — источники и коммиты в `skills/MANIFEST-3d-motion.txt`, лицензии `skills/LICENSE-*`.

Обновить скиллы: положи/замени папку в `skills/`, запушь — новые сессии подхватят.
