---
"@fragno-dev/telegram-fragment": patch
---

feat: add a `POST /bot-api/:method` route that calls any Telegram Bot API method except the webhook
methods and text sends and edits, which stay on their recorded chat routes.
