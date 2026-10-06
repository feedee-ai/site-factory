---
description: Ссылки клиента (Instagram / Google Maps / сайт / название) → парсинг → продающий сайт → Vercel → ссылка
argument-hint: "<ссылки или название бизнеса>"
---
Вход: `$ARGUMENTS`. Цель — готовый продающий сайт на проде, Александр ничего не клацает. Вопросы — только если без ответа нельзя двигаться (и тогда одним сообщением в конце этапа, не по одному).

## 0. Проверка доступов
`APIFY_TOKEN`, `VERCEL_TOKEN` заданы; `curl -sI https://api.apify.com` и `https://api.vercel.com` не 403. Чего нет — одной строкой, что добавить в настройках среды; продолжай всё, что можно без этого.

## 1. Сбор материалов → `materials/`
Если дано только название — найди Instagram и карточку Google Maps (WebSearch).
Apify (REST, `POST /v2/acts/<actor>/run-sync-get-dataset-items`, заголовок `Authorization: Bearer $APIFY_TOKEN`):
- Instagram: `apify~instagram-scraper` — `{"directUrls":["<profile>"],"resultsType":"posts","resultsLimit":100,"addParentData":true}`; профиль — `apify~instagram-profile-scraper` `{"usernames":["<user>"]}`.
- Google Maps: `compass~crawler-google-places` `{"startUrls":[{"url":"<maps>"}],"maxReviews":500,"maxImages":30,"language":"<язык страны>"}` (если отзывов мало в выдаче — `compass~google-maps-reviews-scraper`).
- Run-sync упал по таймауту → запусти обычный run (`/runs`), опрашивай статус, забери dataset.

Сохрани:
- `materials/instagram/posts-raw.json` + `posts.md` (читаемо, от новых к старым: дата, подпись, хэштеги, лайки, список файлов);
- `materials/instagram/media/<shortCode>-<N>.jpg|mp4` — все фото каруселей и видео (displayUrl, images[], childPosts, videoUrl), скачать сразу: ссылки CDN протухают;
- `materials/google-maps/reviews.md` — карточка (адрес, телефон, часы, рейтинг, кол-во отзывов, категория) + все отзывы + раздел «Наблюдения для копирайта»: повторяющиеся похвалы, цитаты, языки клиентов, негатив;
- `materials/google-maps/photos/`.

## 2. Понимание бизнеса
Напиши `CLAUDE.md` проекта (ключевые факты: имя, ниша, адрес, контакты, часы, рейтинг, специализация, позиционирование из отзывов, хронология/достижения из постов, аудитория и языки, открытые вопросы), `PRODUCT.md` (кто клиент, что продаём, какие возражения снимаем, главный CTA) — по формату `impeccable`.

## 3. Концепция и дизайн-система
Загрузи и примени скиллы: `impeccable` (shape → `DESIGN.md`), `taste-skill`, `soft-skill` / `minimalist-skill` по характеру бренда, `brandkit` для визуального мира. Изучи 3–5 референсов топовых игроков ниши (WebSearch). Одна сильная идея-концепция под конкретный бренд, а не шаблон лендинга. Палитра и шрифты — из реального контента клиента.

## 4. Сайт → `site/`
Статический, без сборки, `vercel.json` с `outputDirectory: "site"`, `cleanUrls`, кэш для `/assets`. Обязательно:
- лучшие реальные фото/видео клиента (сжать: webp/avif, srcset, lazy), реальные отзывы и цифры (рейтинг, кол-во отзывов, годы опыта);
- запись/заявка: выбор услуги/даты/времени → готовое сообщение в WhatsApp владельца (номер из карточки); цены из конфига, по умолчанию «по консультации»;
- мультиязычность по аудитории; карта/адрес/часы; SEO (title/description/OG, schema.org LocalBusiness), favicon;
- motion: `emil-design-eng`, `animate`, `apple-design`; потом `find-animation-opportunities` + `review-animations`; `prefers-reduced-motion`.

## 5. Проверка
Открой в Chromium (Playwright, без `playwright install`): десктоп 1440 и мобилка 390, скриншоты каждой секции, консоль без ошибок, форма записи формирует правильную ссылку WhatsApp. Прогони `impeccable` audit/critique и `redesign-skill` как ревью, исправь найденное. Lighthouse-уровень: картинки сжаты, нет горизонтального скролла.

## 6. Публикация
Коммит + пуш. Затем как в `/deploy` (link → git connect → `vercel deploy --prod`). Проверь 200.

## 7. Отчёт Александру (коротко)
Ссылка на прод, 3–5 сильных ходов сайта, что взято из отзывов, открытые вопросы к клиенту (цены, домен, персонал), что стоит проверить глазами.
