import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { InotesClient } from "./client.js";

const folder = z.string().trim().min(1).max(128).describe("Имя папки iNotes, например ($Inbox). По умолчанию входящие.");
const unid = z.string().trim().describe("32-символьный UNID документа Notes.");
const limit = z.number().int().min(1).max(100).optional().describe("Сколько записей вернуть. По умолчанию 25.");
const start = z.number().int().min(1).optional().describe("Смещение, с 1, как в ReadViewEntries.");

export function createServer(client: InotesClient): McpServer {
  const server = new McpServer({ name: "inotes", version: "1.0.0" });

  server.registerTool(
    "list_folders",
    {
      title: "Список папок",
      description: "Список папок и представлений почтового файла iNotes.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(() => client.listFolders()),
  );

  server.registerTool(
    "list_messages",
    {
      title: "Список писем",
      description: "Письма из папки iNotes (по умолчанию ($Inbox)): UNID, отправитель, тема, дата, непрочитанное.",
      inputSchema: z.object({
        folder: folder.optional(),
        start,
        limit,
        unreadOnly: z.boolean().optional().describe("Только непрочитанные."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => client.listMessages(args)),
  );

  server.registerTool(
    "read_message",
    {
      title: "Прочитать письмо",
      description:
        "Читает письмо по UNID. Если сервер сообщает, что оно зашифровано и не отдаёт текст, возвращает encrypted=true и подсказку разблокировать Notes ID в iNotes. Текст возвращается только когда его уже отдала веб-сессия.",
      inputSchema: z.object({ unid }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => client.readMessage(args.unid)),
  );

  server.registerTool(
    "search_mail",
    {
      title: "Поиск писем",
      description: "Поиск по папке через iNotes SearchString (PresetFields формы s_ReadViewEntries).",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
        folder: folder.optional(),
        start,
        limit,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => client.searchMail(args)),
  );

  server.registerTool(
    "send_mail",
    {
      title: "Отправить письмо",
      description: "Новое письмо через форму iNotes h_PageUI (Memo). Получатели — адреса или имена Notes.",
      inputSchema: z.object({
        to: z.array(z.string().trim().min(1)).min(1),
        cc: z.array(z.string().trim().min(1)).optional(),
        bcc: z.array(z.string().trim().min(1)).optional(),
        subject: z.string().trim().min(1).max(500),
        body: z.string().min(1).max(200_000),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => run(() => client.sendMail(args)),
  );

  server.registerTool(
    "reply_mail",
    {
      title: "Ответить на письмо",
      description: "Ответ или ответ всем через форму iNotes h_Reply / h_ReplyAll. Новый текст добавляется перед цитатой, если форма её вернула.",
      inputSchema: z.object({
        unid,
        body: z.string().min(1).max(200_000),
        replyAll: z.boolean().optional(),
        folder: folder.optional(),
        to: z.array(z.string().trim().min(1)).optional(),
        subject: z.string().trim().min(1).max(500).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => run(() => client.replyMail(args)),
  );

  server.registerTool(
    "forward_mail",
    {
      title: "Переслать письмо",
      description: "Пересылка через форму iNotes h_Forward.",
      inputSchema: z.object({
        unid,
        to: z.array(z.string().trim().min(1)).min(1),
        comment: z.string().max(200_000).optional(),
        folder: folder.optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => run(() => client.forwardMail(args)),
  );

  server.registerTool(
    "list_contacts",
    {
      title: "Список контактов",
      description:
        "Если задан INOTES_DIRECTORY — контакты этого каталога (имя из окна «Выбрать адреса», поле «Искать в»). Иначе личная книга почтового файла: ($Contacts), затем ($People).",
      inputSchema: z.object({ start, limit }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => client.listContacts(args)),
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Поиск контактов",
      description:
        "Ищет контакт по имени, адресу или компании. Если задан INOTES_DIRECTORY — в этом каталоге, иначе в личной адресной книге.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
        limit,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => client.listContacts(args)),
  );

  server.registerTool(
    "list_events",
    {
      title: "События календаря",
      description: "События ($Calendar) за диапазон дат через s_ReadViewEntries с KeyType=time.",
      inputSchema: z.object({
        start: z.string().trim().describe("Начало диапазона, ISO 8601."),
        end: z.string().trim().describe("Конец диапазона, ISO 8601."),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => client.listEvents(args)),
  );

  server.registerTool(
    "read_event",
    {
      title: "Прочитать событие",
      description: "Одно календарное событие по UNID. Для повторяющегося экземпляра можно передать instanceStart.",
      inputSchema: z.object({
        unid,
        instanceStart: z.string().trim().optional().describe("Начало экземпляра повторения, ISO 8601."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(() => client.readEvent(args.unid, args.instanceStart)),
  );

  server.registerTool(
    "create_event",
    {
      title: "Создать событие",
      description:
        "Создаёт встречу или событие формой iNotes Appointment (h_PageUI), если сервер отдаёт эту форму. Тип 0 — событие, 3 — встреча, 2 — весь день.",
      inputSchema: z.object({
        subject: z.string().trim().min(1).max(500),
        start: z.string().trim().describe("Начало, ISO 8601."),
        end: z.string().trim().describe("Окончание, ISO 8601."),
        body: z.string().max(200_000).optional(),
        location: z.string().max(500).optional(),
        onlineMeetingUrl: z.string().trim().max(2000).optional().describe("Ссылка «Сетевое собрание», https URL."),
        kind: z.enum(["appointment", "meeting"]).optional(),
        allDay: z.boolean().optional(),
        attendees: z.array(z.string().trim().min(1)).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => run(() => client.createEvent(args)),
  );

  return server;
}

export async function startServer(client: InotesClient): Promise<void> {
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function run(work: () => Promise<unknown>) {
  return work()
    .then((data) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Неизвестная ошибка iNotes";
      return { isError: true as const, content: [{ type: "text" as const, text: message }] };
    });
}
