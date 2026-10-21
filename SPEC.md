# keet-channel — спецификация

Версия плагина: **0.4.0**. Версия протокола stdio: **1.0.0**.

## 1. Назначение

`keet-channel` — платформенный плагин Hermes Agent для P2P-мессенджера
[Keet](https://keet.io). Плагин состоит из Python-адаптера и локального
Node.js-бриджа. Адаптер владеет политикой доступа Hermes и корреляцией
запросов; бридж владеет идентичностью, комнатой, приглашениями и P2P-сетью.

```
Hermes gateway
   │
   ▼
adapter.py  ── stdin/stdout, по одному JSON на строку ──▶  bridge/index.js
                                                             │
                                                             ├── blind-pairing 2.3.1
                                                             ├── Autobase 7.28.2 + Corestore 7.15.0
                                                             └── Hyperswarm 4.17.2
```

Бридж запускается как обычный процесс **Node.js >= 24**. Pear/Bare не
используется и не требуется. Отдельного WebSocket-сервера и порта 5335 нет:
единственный транспорт «адаптер ↔ бридж» — stdio.

## 2. Компоненты

| Компонент | Путь | Ответственность |
| --- | --- | --- |
| Манифест | `plugin.yaml` | Метаданные Hermes, версия 0.4.0 |
| Адаптер | `adapter.py` | Запуск бриджа, протокол, надзор, ACL, cron |
| Точка входа бриджа | `bridge/index.js` | Порядок инициализации и жизненный цикл |
| Идентичность | `bridge/lib/identity.js` | BIP-39 мнемоника, `keet-identity-key`, права файлов |
| Комната | `bridge/lib/room.js` | Autobase, writer membership, append, репликация |
| Pairing | `bridge/lib/pairing.js` | `BlindPairing` member/candidate, pending-запросы |
| Сообщения | `bridge/lib/messages.js` | `compact-encoding`, подписи Ed25519, дедупликация |
| Приглашения | `bridge/lib/invite.js` | Конверт `keet://chat/<z32>` |
| Роутер | `bridge/lib/stdio.js` | Команды, `request_id`, ответы, события |

## 3. Данные

Каталог `KEET_DATA_DIR` (по умолчанию `~/.keet-channel`), права `0700`;
секретные файлы — `0600`, запись атомарная:

```
<data>/
  identity.json   # версия, мнемоника/seed; никогда не логируется
  room.json       # версия, roomKey, encryptionKey, writer key
  allowed.json    # разрешённые identity (переопределяется KEET_ACL_FILE)
  corestore/      # данные Hypercore/Autobase
```

Одна идентичность и одна комната на каталог данных. Тот же каталог после
перезапуска восстанавливает identity, ключ комнаты, allowlist и историю.
Одновременно каталог может открывать только один бридж.

## 4. Комната и сообщения

Комната — шифрованный Autobase, открытый по сохранённым `roomKey` и
`encryptionKey`. Discovery key комнаты (`crypto.discoveryKey(roomKey)`) —
топик Hyperswarm и одновременно discovery key приглашения.

Autobase предоставляет два view:

- `messages` — линеаризованный журнал сообщений;
- `members` — отображение `writerKey -> identityKey`.

Типы узлов: `register`, `add-writer`, `message`. Сообщение кодируется
`compact-encoding` и содержит версию, `roomKey`, `messageId`, `sender`,
`timestamp`, текст (не более 4096 байт UTF-8) и 64-байтовую подпись Ed25519
над каноническими полями. Применяются только сообщения writer'а, у которого
есть запись в `members` и чья identity совпадает с `sender`.

`send_message` сначала выполняет локальный append и подтверждает успех только
после durable-записи. При отсутствии подключённых пиров результат содержит
`queued: true` и `replicated_peers: 0`; отдельной очереди повторов нет —
запись реплицируется, когда появится пир.

## 5. Приглашения и pairing

Приглашение создаётся один раз при старте и имеет вид
`keet://chat/<z32>`. Оно строится из стандартного invite `blind-pairing-core`:
флаги сохраняются и дополняются битами `0x60`, затем добавляется расширение
`[148, encryptionKey]`. `KEET_INVITE_FORMAT=standard` отключает расширение для
диагностики. Активное приглашение одно: создание нового заменяет предыдущее,
поскольку blind-pairing допускает одного активного участника на discovery key.

Member-сторона (`BlindPairing.addMember`) принимает `userData` кандидата
(identity key, writer key, необязательное имя), проверяет его и либо
подтверждает, либо ставит запрос в pending. Перед подтверждением в Autobase
добавляется `add-writer` для writer key кандидата; кандидат становится
writable после репликации этого узла.

Автоподтверждение возможно только для identity из allowlist, из
`KEET_ALLOWED_USERS` или при `KEET_ALLOW_ALL_USERS=true` (development-only,
с предупреждением в stderr, без сохранения). Остальные запросы ждут
`accept_pairing` / `decline_pairing`; pending-запросы живут в памяти и
истекают через `KEET_PAIRING_TIMEOUT_MS` (по умолчанию 5 минут) либо вместе с
приглашением. UI для подтверждения нет — решения приходят через команды
адаптера.

## 6. Протокол stdio

Один JSON-объект на строку, UTF-8, без форматирования. `stdin` — команды,
`stdout` — события и ровно один терминальный ответ на команду, `stderr` —
только диагностика. Каждый запрос содержит `request_id`; ответ Echo
повторяет его. Неподдерживаемые операции возвращают `unsupported_command`,
а не общий `unknown_command`.

Readiness-событие `welcome_room_ready` отправляется ровно один раз — после
готовности identity, Corestore, комнаты, swarm, pairing-листенера и первого
приглашения. Оно содержит `protocol_version`, `identity`, `room_key`,
`invite_url`, `started_at`. Адаптер не считает себя подключённым до этого
события и до проверки identity, room key, версии протокола и
`KEET_HOME_CHANNEL`.

Поддерживаемые команды:

```text
send_message   send_welcome    status          get_identity
create_invite  join_invite     accept_pairing  decline_pairing
cancel_invite  pairing_list    join_room       connect_to_user
shutdown
```

`send_image`, `send_file`, `send_attachment`, `send_voice`, `send_video`
возвращают типизированную ошибку `unsupported_command` и не обращаются к
комнате. Вложения не реализованы; поддерживаются только текстовые сообщения.

Полные схемы запросов, ответов, событий и кодов ошибок — в
[docs/protocol.md](docs/protocol.md).

## 7. Жизненный цикл адаптера

`connect()` запускает `node bridge/index.js`, передавая `KEET_DATA_DIR`,
`KEET_ALLOWED_USERS`, `KEET_ALLOW_ALL_USERS`, `KEET_ACL_FILE`,
`KEET_HOME_CHANNEL` (и `KEET_DHT_BOOTSTRAP`, если задан), и ждёт
`welcome_room_ready` с таймаутом. По таймауту процесс убивается, подключение
не устанавливается.

Монитор процесса при неожиданном завершении бриджа помечает платформу
отключённой, завершает все pending-запросы ошибкой и перезапускает бридж с
задержками `1, 2, 4, 8, 16, 30` секунд (не более 30). После 60 секунд
стабильной готовности задержка сбрасывается. `disconnect()` отправляет
`shutdown`, ждёт до 15 секунд, при необходимости убивает процесс и подавляет
перезапуск.

`_standalone_send()` (cron/уведомления) поднимает адаптер, ждёт readiness,
отправляет сообщение, ждёт коррелированный результат и отключается в
`finally`. `KEET_HOME_CHANNEL` — стабильный 64-hex ключ комнаты, а не invite
URL и не discovery key; отсутствие или неизвестное значение — ошибка
конфигурации, а не мнимый успех.

## 8. Безопасность

Доступ запрещён по умолчанию. Разрешение задаётся списком
`KEET_ALLOWED_USERS` (64-hex identity, через запятую; записи обрезаются,
приводятся к нижнему регистру, некорректные логируются и пропускаются) либо
принятием pairing-запроса, которое сохраняет identity в `allowed.json`.

Политика применяется на двух уровнях: бридж принимает записи только от
writer'ов, добавленных через pairing, и проверяет подпись; адаптер независимо
проверяет identity отправителя перед созданием события для агента.
`member_joined` / `member_left` — только логирование и не дают прав.
Собственные сообщения отфильтровываются сравнением с identity из readiness.
`KEET_ALLOW_ALL_USERS` действует только при литеральном значении `true`, не
сохраняется и логирует предупреждение.

Подробнее — [docs/access-control.md](docs/access-control.md).

## 9. Ограничения

- Совместимость с закрытой app-level схемой чата Keet не заявляется.
  Проверены и поддерживаются открытые примитивы: invite-конверт, pairing,
  identity и репликация Autobase.
- Нет изображений, файлов, голосовых и видеосообщений.
- Нет multi-device identity, ротации ключей и восстановления аккаунта.
- Нет группы/модерации и UI подтверждения pairing.
- Нет WebSocket-транспорта, порта 5335 и runtime Pear/Bare.
- Старые эфемерные invite и `KEET_HOME_CHANNEL` в виде discovery key
  недействительны.

## 10. Конфигурация

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `KEET_DATA_DIR` | Каталог identity, комнаты, allowlist и Corestore | `~/.keet-channel` |
| `KEET_ALLOWED_USERS` | 64-hex identity через запятую | не задано (deny) |
| `KEET_ALLOW_ALL_USERS` | Development-override, только `true` | не задано |
| `KEET_ACL_FILE` | Путь к persist-allowlist | `<data>/allowed.json` |
| `KEET_HOME_CHANNEL` | Стабильный 64-hex ключ комнаты для cron | не задано |
| `KEET_HOME_CHANNEL_NAME` | Отображаемое имя home channel | не задано |
| `KEET_DHT_BOOTSTRAP` | `host:port` через запятую | публичный DHT |
| `KEET_INVITE_FORMAT` | `keet` или `standard` | `keet` |
| `KEET_PAIRING_TIMEOUT_MS` | Время жизни pending-запроса | 5 минут |
| `KEET_NODE_PATH` | Явный путь к Node.js | `node` из `PATH` |

## 11. Команды разработки

```bash
npm install                                  # root postinstall ставит bridge/node_modules
bash scripts/setup.sh                        # проверка Node >= 24 и зависимостей
cd bridge && npm test                        # 67 тестов бриджа
python -m pip install -r requirements-dev.txt
python -m pytest tests/ -q                   # 43 теста адаптера
openspec validate make-keet-channel-interoperable --strict
```

Тесты бриджа используют loopback DHT и не требуют публичной сети или живого
клиента Keet. Ручная проверка с живым Keet 4.24.0 описана в
[docs/protocol-compatibility.md](docs/protocol-compatibility.md).

## 12. История версий

- **0.1** — первый адаптер: WebSocket/порт 5335, Pear-рантайм, эфемерные
  invite, доступ «все разрешены», изображения заявлялись как поддержанные.
- **0.4.0** — текущая версия: Node.js stdio-бридж, `blind-pairing` +
  Autobase, стабильные identity/комната/invite, коррелированный протокол,
  default-deny ACL, надзор и перезапуск. WebSocket, Pear и вложения удалены
  из поддерживаемой поверхности.
