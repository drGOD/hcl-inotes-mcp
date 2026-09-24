# MCP-сервер HCL iNotes

Сервер [MCP](https://modelcontextprotocol.io) для своего почтового ящика HCL iNotes / Domino. Он ходит в тот же веб-интерфейс, что и браузер: форма входа `names.nsf?Login`, сессионные cookie (`DomAuthSessId`, `LtpaToken`) и команды iNotes (`ReadViewEntries`, `iNotes/Proxy`, формы `h_PageUI`). Прав администратора Domino и Domino REST API не нужно.

Почтовый файл и хост задаются переменными окружения. В комплекте нет паролей и cookie.

## Настройка

```bash
cp .env.example .env
```

Заполните `.env` и экспортируйте переменные в процесс, который запускает сервер. Сам сервер файл `.env` не читает.

| Переменная | Назначение |
| --- | --- |
| `INOTES_BASE_URL` | Хост iNotes, без завершающего слэша. Пример: `https://mail.example.com` |
| `INOTES_MAIL_PATH` | Путь к почтовому NSF. Пример: `/mail/MAILFILE.nsf` |
| `INOTES_USERNAME` | Имя с формы входа iNotes (поле `Username`) |
| `INOTES_PASSWORD` | Пароль с той же формы |
| `INOTES_COOKIE` | Вместо имени и пароля: заголовок `Cookie` уже открытой своей сессии |
| `INOTES_DIRECTORY` | Имя каталога из окна iNotes «Выбрать адреса», поле «Искать в». Пример: `Example Directory`. Пустое значение оставляет личную книгу `($Contacts)` |

Достаточно одного способа входа.

`INOTES_DIRECTORY` заполните именем, которое iNotes показывает в окне «Выбрать адреса» в поле «Искать в». Пример: `Example Directory`. Берите имя из своего окна, а не из чужого описания. Если переменная пустая или не задана, `search_contacts` и `list_contacts` читают личную адресную книгу почтового файла.

Форма на `mail.example.com` — стандартный вход Domino: `POST /names.nsf?Login`, поля `Username`, `Password`, `RedirectTo`, скрытое `%%ModDate`. Имя — то же, что вы вводите в браузере, а не обязательно краткое имя файла.

Готовую cookie можно взять в браузере, где вы уже вошли в свой ящик: инструменты разработчика → Network → запрос к почте → заголовок `Cookie`. Вставьте его в `INOTES_COOKIE`. Не сохраняйте это значение в git.

Для отправки, ответа и создания событий сервер подставляет `%%Nonce` из cookie `ShimmerS` (параметр `N:`) или из скрытого поля формы. Так же делает веб-клиент iNotes начиная с 8.5.2.

## Запуск

Нужен Node.js 20 или новее.

```bash
npm install
npm test
npm run build
set -a && . ./.env && set +a
npm start
```

`npm start` поднимает MCP по stdio. В Cursor сервер подключается так:

```json
{
  "mcpServers": {
    "inotes": {
      "command": "node",
      "args": ["/абсолютный/путь/к/репозиторию/dist/index.js"],
      "env": {
        "INOTES_BASE_URL": "https://mail.example.com",
        "INOTES_MAIL_PATH": "/mail/MAILFILE.nsf",
        "INOTES_USERNAME": "имя с формы входа",
        "INOTES_PASSWORD": "пароль",
        "INOTES_DIRECTORY": "Example Directory"
      }
    }
  }
}
```

Проверка типов: `npm run typecheck`. Тесты читают фикстуры и не ходят на почтовый сервер.

## Инструменты

| Инструмент | Что делает |
| --- | --- |
| `list_folders` | Папки и представления почтового файла |
| `list_messages` | Список писем папки, по умолчанию `($Inbox)` |
| `read_message` | Письмо по UNID |
| `search_mail` | Поиск в папке (`SearchString` у `s_ReadViewEntries`) |
| `send_mail` | Новое письмо, форма Memo / `h_PageUI` |
| `reply_mail` | Ответ или ответ всем (`h_Reply`, `h_ReplyAll`) |
| `forward_mail` | Пересылка (`h_Forward`) через `($Drafts)/$new` |
| `list_contacts` | Каталог из `INOTES_DIRECTORY`, если он задан; иначе личная книга `($Contacts)`, затем `($People)` |
| `search_contacts` | Поиск в том же каталоге или в личной книге |
| `list_events` | События `($Calendar)` за диапазон дат |
| `read_event` | Одно событие по UNID; для повторения можно указать начало экземпляра |
| `create_event` | Событие, встреча или день целиком через форму Appointment, если iNotes её отдаёт |

`list_messages` возвращает UNID, признак непрочитанного, отправителя, тему, дату и размер. Смещение `start` начинается с 1, как у `ReadViewEntries`.

Новое письмо, ответ и пересылка повторяют отправку формы iNotes. Письмо открывает `($Drafts)/$new`. Ответ открывает тот же черновик с `s_MailActionType=h_ReplyTo` и UNID исходного письма. Пересылка открывает его с `s_MailActionType=h_Forward` и тем же UNID родителя. Оба поставят `h_ShimmerSendMail` вместе с `h_SetParentUnid`, `%%Nonce` и адресом возврата `l_CallListenerWithUnid`. Успех — ответ сервера с `DhU.onDatasetComplete`. Страница «Form processed» и любой другой HTTP 200 без этого вызова не считаются отправкой. Это не квитанция о доставке.

Календарь запрашивается так, как описано для iNotes: `Form=s_ReadViewEntries`, `FolderName;($Calendar)`, `KeyType=time`, `StartKey` / `UntilKey`. Создание события пишет тип `0` (событие), `3` (встреча) или `2` (весь день).

## Зашифрованная почта

Часть внутренних писем зашифрована Notes или S/MIME. Сервер не расшифровывает их и не подбирает ключи.

`read_message` смотрит на ответ уже аутентифицированной сессии — тот же ответ, который получил бы браузер:

- Если в ответе есть текст письма, он возвращается. Флаг `encrypted: true` при этом может остаться, когда ID в этой сессии уже разблокирован и Domino отдал тело.
- Если Domino помечает документ как зашифрованный (`Encrypt`, `$Seal` и похожие поля) или вместо текста пишет, что нужно ввести пароль Notes ID, результат такой: `encrypted: true`, `bodyAvailable: false`, текста нет, в `hint` написано, что сделать.

Чтобы прочитать такое письмо, откройте его в iNotes и введите пароль файла Notes ID. Когда эта веб-сессия начнёт отдавать тело (как браузер после разблокировки), повторите `read_message`.

## Что проверено на mail.example.com

Без учётных данных открыта только страница входа по адресу почтового ящика. Сервер ответил `Lotus-Domino` и формой `POST /names.nsf?Login` с полями `Username`, `Password`, `RedirectTo`, `%%ModDate`. Пароль не отправлялся.

С живой сессией не проверялись список писем, чтение, поиск, отправка, ответ, пересылка, контакты, календарь и фактический текст, которым сервер закрывает зашифрованное письмо. Разбор списка и признака шифрования покрыт фикстурами в `test/fixtures` по публичному формату `ReadViewEntries` (`OutputFormat=JSON` и XML `s_ReadViewEntries`) и по текстам, которыми iNotes сообщает о шифровании.
